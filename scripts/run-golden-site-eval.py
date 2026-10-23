"""Replay the golden site dataset through a copy of the production matcher.

The dataset (scripts/build-golden-site-attendance.py) is a set of pumps that each run for several
days. Every shift start and end has a group photo and an operator photo. This runner sends each
photo to the AI service once (embeddings are cached in memory), then replays every session in time
order the way worker/index.js does:

  1. operator photo: largest face; no face fails the session (OperatorPhotoError)
  2. withOperatorFace: tag the matching group face, else add the operator face
  3. cross-pump check (findCrossPumpMatch): same Area, same date, other pumps' session faces
  4. local candidates (findLocalCandidates): this pump's in-gallery faces, best per person
  5. assignFaces: one face per person, strongest match first
  6. keepsInGallery + gallery trim to GALLERY_SIZE (anchor kept)

Each detected face is linked to its ground-truth worker by box overlap, so every decision can be
scored: right person, wrong person (false accept), new person for a known worker (split), fraud
flag raised or missed. The replay is repeated for a range of thresholds from the same embeddings.

Writes test-output/evaluations/<run-id>/ (summary.json, summary.md, threshold-sweep.csv,
decisions.csv). Raw embeddings are never written. Only talks to the AI service URL it is given
(default: the local stack, http://127.0.0.1:6102).

  python scripts/run-golden-site-eval.py
  python scripts/run-golden-site-eval.py --match-threshold 0.30 --limit-pumps 4
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import requests


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET_DIR = ROOT / "datasets" / "golden-site-attendance-v2"
DEFAULT_AI_URL = os.getenv("AI_SERVICE_URL", "http://127.0.0.1:6102")
DEFAULT_OUTPUT_ROOT = ROOT / "test-output" / "evaluations"
# Same defaults and parsing as worker/index.js and worker/faceQueries.js.
DEFAULT_MATCH_THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.28"))
GALLERY_ADD_THRESHOLD = float(os.getenv("GALLERY_ADD_THRESHOLD", "0.40"))
GALLERY_ADD_MARGIN = float(os.getenv("GALLERY_ADD_MARGIN", "0.10"))
GALLERY_SIZE = 5
IOU_LINK = 0.30
SWEEP = [round(value / 100, 2) for value in range(18, 52, 2)]
IMAGE_TIMEOUT_SECONDS = 180


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def iou(a: list[float], b: list[float]) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def area(box: list[float]) -> float:
    return (box[2] - box[0]) * (box[3] - box[1])


def rate(num: float, den: float) -> float | None:
    return round(num / den, 4) if den else None


# ---------------------------------------------------------------- AI service


def extract(path: Path, ai_url: str) -> dict[str, Any]:
    start = time.perf_counter()
    with path.open("rb") as handle:
        response = requests.post(
            f"{ai_url}/internal/face/extract",
            files={"file": (path.name, handle, "image/jpeg")},
            headers={"X-Request-Id": f"golden-site-{path.stem}"},
            timeout=IMAGE_TIMEOUT_SECONDS,
        )
    response.raise_for_status()
    payload = response.json()
    faces = [
        {"bbox": face["bbox"], "embedding": np.asarray(face["embedding"], dtype=np.float32)}
        for face in payload.get("faces", [])
    ]
    for face in faces:
        norm = float(np.linalg.norm(face["embedding"]))
        if norm > 0:
            face["embedding"] = face["embedding"] / norm
    return {"faces": faces, "ms": round((time.perf_counter() - start) * 1000, 1)}


def link_faces(detected: list[dict[str, Any]], truth: list[dict[str, Any]]) -> list[str | None]:
    """Ground-truth worker for each detected face (greedy by overlap), None for a phantom face."""
    pairs = sorted(
        ((iou(d["bbox"], t["bbox"]), di, ti) for di, d in enumerate(detected) for ti, t in enumerate(truth)),
        reverse=True,
    )
    linked: list[str | None] = [None] * len(detected)
    used_truth: set[int] = set()
    for score, di, ti in pairs:
        if score < IOU_LINK:
            break
        if linked[di] is not None or ti in used_truth:
            continue
        linked[di] = truth[ti]["worker_id"]
        used_truth.add(ti)
    return linked


# ---------------------------------------------------------------- matcher copy


@dataclass
class Person:
    person_id: str
    pump_id: str
    anchor_worker: str | None  # ground truth of the face the person was created from
    gallery: list[tuple[np.ndarray, bool, int]] = field(default_factory=list)  # (vec, is_anchor, seq)


@dataclass
class SavedFace:
    person_id: str
    pump_id: str
    area_id: str
    date: str
    vec: np.ndarray


def assign_faces(candidates: list[list[tuple[str, float]]], threshold: float) -> list[dict[str, Any] | None]:
    """worker/faceQueries.js assignFaces."""
    pairs = [
        (sim, face, rank, pid)
        for face, lst in enumerate(candidates)
        for rank, (pid, sim) in enumerate(lst)
        if sim >= threshold
    ]
    pairs.sort(key=lambda p: -p[0])
    assigned: list[dict[str, Any] | None] = [None] * len(candidates)
    taken: set[str] = set()
    for sim, face, rank, pid in pairs:
        if assigned[face] is not None or pid in taken:
            continue
        taken.add(pid)
        lst = candidates[face]
        runner_up = (lst[1][1] if len(lst) > 1 else None) if rank == 0 else lst[0][1]
        assigned[face] = {"person_id": pid, "similarity": sim, "runner_up": runner_up}
    return assigned


def keeps_in_gallery(match: dict[str, Any], add_threshold: float, margin: float) -> bool:
    if match["similarity"] < add_threshold:
        return False
    return match["runner_up"] is None or match["similarity"] - match["runner_up"] >= margin


class Matcher:
    def __init__(self, threshold: float):
        self.threshold = threshold
        self.add_threshold = max(GALLERY_ADD_THRESHOLD, threshold)
        self.persons: dict[str, Person] = {}
        self.saved: list[SavedFace] = []
        self.seq = 0

    def _new_person(self, pump_id: str, worker: str | None) -> Person:
        person = Person(f"P{len(self.persons) + 1:04d}", pump_id, worker)
        self.persons[person.person_id] = person
        return person

    def _save(self, person: Person, vec: np.ndarray, in_gallery: bool, anchor: bool) -> None:
        self.seq += 1
        if in_gallery:
            person.gallery.append((vec, anchor, self.seq))
            if len(person.gallery) > GALLERY_SIZE:
                # Trim: newest first, anchors kept (ORDER BY is_anchor DESC, created_at DESC OFFSET 5).
                person.gallery.sort(key=lambda g: (not g[1], -g[2]))
                person.gallery = person.gallery[:GALLERY_SIZE]

    def cross_pump(self, vec: np.ndarray, area_id: str, pump_id: str, date: str) -> tuple[str, str, float] | None:
        best = None
        for face in self.saved:
            if face.area_id != area_id or face.pump_id == pump_id or face.date != date:
                continue
            sim = float(vec @ face.vec)
            if best is None or sim > best[2]:
                best = (face.person_id, face.pump_id, sim)
        return best

    def local(self, vec: np.ndarray, pump_id: str, limit: int) -> list[tuple[str, float]]:
        scored = []
        for person in self.persons.values():
            if person.pump_id != pump_id or not person.gallery:
                continue
            scored.append((person.person_id, max(float(vec @ g[0]) for g in person.gallery)))
        scored.sort(key=lambda s: -s[1])
        return scored[:limit]

    def run_session(self, session: dict[str, Any], faces: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """faces: [{vec, truth, is_operator}] after withOperatorFace. Returns one decision per face."""
        decisions: list[dict[str, Any]] = []
        local_faces = []
        for face in faces:
            cross = self.cross_pump(face["vec"], session["area_id"], session["pump_id"], session["date"])
            if cross and cross[2] >= self.threshold:
                other = self.persons[cross[0]]
                decisions.append(
                    {**face, "outcome_raw": "fraud_flag", "person_id": cross[0], "similarity": cross[2],
                     "flag_pump": cross[1], "flag_worker": other.anchor_worker}
                )
                continue
            local_faces.append((face, self.local(face["vec"], session["pump_id"], len(faces) + 1)))

        assigned = assign_faces([c for _, c in local_faces], self.threshold)
        pending_saves = []
        for (face, _), match in zip(local_faces, assigned):
            if match:
                person = self.persons[match["person_id"]]
                in_gallery = keeps_in_gallery(match, self.add_threshold, GALLERY_ADD_MARGIN)
                pending_saves.append((person, face["vec"], in_gallery, False))
                decisions.append(
                    {**face, "outcome_raw": "matched", "person_id": person.person_id,
                     "similarity": match["similarity"], "runner_up": match["runner_up"], "in_gallery": in_gallery}
                )
            else:
                person = self._new_person(session["pump_id"], face["truth"])
                pending_saves.append((person, face["vec"], True, True))
                decisions.append({**face, "outcome_raw": "new_person", "person_id": person.person_id})
        for person, vec, in_gallery, anchor in pending_saves:
            self._save(person, vec, in_gallery, anchor)
            self.saved.append(SavedFace(person.person_id, session["pump_id"], session["area_id"], session["date"], vec))
        return decisions


def with_operator_face(group: list[dict[str, Any]], operator: dict[str, Any], threshold: float) -> list[dict[str, Any]]:
    """worker/index.js withOperatorFace."""
    faces = [dict(face, is_operator=False) for face in group]
    if not faces:
        return [dict(operator, is_operator=True)]
    sims = [float(face["vec"] @ operator["vec"]) for face in faces]
    best = int(np.argmax(sims))
    if sims[best] >= threshold:
        faces[best]["is_operator"] = True
    else:
        faces.append(dict(operator, is_operator=True))
    return faces


# ---------------------------------------------------------------- replay + scoring


def replay(sessions: list[dict[str, Any]], extracted: dict[str, Any], threshold: float) -> dict[str, Any]:
    matcher = Matcher(threshold)
    home: dict[tuple[str, str], str] = {}  # (pump, worker) -> first person created for them
    rows: list[dict[str, Any]] = []
    session_rows: list[dict[str, Any]] = []
    for session in sessions:
        gt = session["gt"]
        group = extracted[session["photo"]]
        op = extracted[session["operator_photo"]]
        expected_status = gt.get("expected_status", "completed")
        if not op["faces"]:
            session_rows.append({"session_id": session["session_id"], "status": "failed_operator_photo",
                                 "expected_status": expected_status})
            continue
        op_face = max(op["faces"], key=lambda f: area(f["bbox"]))
        group_links = link_faces(group["faces"], gt["faces"])
        # A face found in an operator photo that has none (expected to fail) is a phantom.
        op_truth = (
            link_faces([op_face], [gt["operator"]])[0] or gt["operator"]["worker_id"]
            if gt["operator"].get("has_face", True) else None
        )
        group_faces = [{"vec": f["embedding"], "truth": t, "bbox": f["bbox"]} for f, t in zip(group["faces"], group_links)]
        faces = with_operator_face(group_faces, {"vec": op_face["embedding"], "truth": op_truth, "bbox": None}, threshold)
        decisions = matcher.run_session(session, faces)

        roles = {f["worker_id"]: f for f in gt["faces"]}
        roles[gt["operator"]["worker_id"]] = roles.get(gt["operator"]["worker_id"], gt["operator"])
        expected_flags = {f["worker_id"] for f in gt.get("expected_fraud_flags", [])}
        for d in decisions:
            truth = d["truth"]
            person = matcher.persons.get(d["person_id"])
            key = (session["pump_id"], truth)
            if d["outcome_raw"] == "fraud_flag":
                if truth in expected_flags and d["flag_worker"] == truth:
                    outcome = "fraud_caught"
                elif truth is None:
                    outcome = "phantom_flag"
                else:
                    outcome = "false_fraud_flag"
            elif truth is None:
                outcome = "phantom_face"
            elif d["outcome_raw"] == "new_person":
                if key in home:
                    outcome = "split"  # a known worker became a second person
                else:
                    outcome = "new_ok"
                    home[key] = d["person_id"]
            else:
                if person.anchor_worker == truth:
                    outcome = "match_ok"
                elif key not in home:
                    outcome = "stranger_accepted"  # first sighting matched someone else
                else:
                    outcome = "wrong_match"
            if truth in expected_flags and outcome != "fraud_caught":
                outcome = "fraud_missed:" + outcome
            polluted = d["outcome_raw"] == "matched" and d.get("in_gallery") and person.anchor_worker != truth
            info = roles.get(truth, {})
            rows.append(
                {
                    "threshold": threshold,
                    "session_id": session["session_id"],
                    "pump_id": session["pump_id"],
                    "date": session["date"],
                    "kind": session["kind"],
                    "scenario_tags": ";".join(gt.get("tags", [])),
                    "truth_worker": truth or "",
                    "role": info.get("role", ""),
                    "is_operator": d["is_operator"],
                    "helmet": info.get("helmet", ""),
                    "lighting": gt.get("lighting", ""),
                    "face_px": info.get("face_px", ""),
                    "outcome": outcome,
                    "gallery": "polluted" if polluted else "",
                    "similarity": round(d["similarity"], 4) if d.get("similarity") is not None else "",
                    "runner_up": round(d["runner_up"], 4) if d.get("runner_up") is not None else "",
                    "person_id": d["person_id"],
                }
            )
        expected_present = {f["worker_id"] for f in gt["faces"]} | {gt["operator"]["worker_id"]}
        detected_truths = {d["truth"] for d in decisions if d["truth"]}
        session_rows.append(
            {
                "session_id": session["session_id"],
                "status": "completed",
                "expected_status": expected_status,
                "expected_people": len(expected_present),
                "faces_detected": len(group["faces"]),
                "truth_faces": len(gt["faces"]),
                "missed_people": len(expected_present - detected_truths),
                "operator_counted_twice": sum(
                    1 for w in expected_present if sum(1 for d in decisions if d["truth"] == w) > 1
                ),
            }
        )
    return {"rows": rows, "sessions": session_rows, "matcher": matcher}


def summarize(result: dict[str, Any], threshold: float) -> dict[str, Any]:
    rows = result["rows"]
    outcomes = Counter(r["outcome"] for r in rows if not r["outcome"].startswith("fraud_missed"))
    missed_fraud = sum(1 for r in rows if r["outcome"].startswith("fraud_missed"))
    known = [r for r in rows if r["outcome"] in ("match_ok", "wrong_match", "split")]
    first = [r for r in rows if r["outcome"] in ("new_ok", "stranger_accepted")]
    sessions = result["sessions"]
    persons = result["matcher"].persons
    per_worker: dict[tuple[str, str], set[str]] = defaultdict(set)
    person_truths: dict[str, Counter[str]] = defaultdict(Counter)
    for r in rows:
        if r["truth_worker"] and r["outcome"] not in ("fraud_caught", "false_fraud_flag"):
            per_worker[(r["pump_id"], r["truth_worker"])].add(r["person_id"])
            person_truths[r["person_id"]][r["truth_worker"]] += 1
    return {
        "threshold": threshold,
        "faces_scored": len(rows),
        "match_ok": outcomes["match_ok"],
        "wrong_match": outcomes["wrong_match"],
        "split": outcomes["split"],
        "new_ok": outcomes["new_ok"],
        "stranger_accepted": outcomes["stranger_accepted"],
        "fraud_caught": outcomes["fraud_caught"],
        "fraud_missed": missed_fraud,
        "false_fraud_flag": outcomes["false_fraud_flag"],
        "phantom_face": outcomes["phantom_face"] + outcomes["phantom_flag"],
        "known_worker_correct_rate": rate(outcomes["match_ok"], len(known)),
        "false_accept_rate": rate(outcomes["wrong_match"], len(known)),
        "split_rate": rate(outcomes["split"], len(known)),
        "stranger_accept_rate": rate(outcomes["stranger_accepted"], len(first)),
        "gallery_polluted_faces": sum(1 for r in rows if r["gallery"] == "polluted"),
        "gallery_faces_end": sum(len(p.gallery) for p in persons.values()),
        "persons_created": len(persons),
        "workers_split_into_2plus": sum(1 for ids in per_worker.values() if len(ids) > 1),
        "persons_mixing_workers": sum(1 for c in person_truths.values() if len(c) > 1),
        "missed_people": sum(s.get("missed_people", 0) for s in sessions),
        "operator_counted_twice": sum(s.get("operator_counted_twice", 0) for s in sessions),
        "failed_operator_photo": sum(1 for s in sessions if s["status"] == "failed_operator_photo"),
        "session_status_wrong": sum(1 for s in sessions if s["status"] != s["expected_status"]),
    }


def breakdown(rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        if r["outcome"] in ("match_ok", "wrong_match", "split"):
            groups[str(r[key])].append(r)
    out = []
    for value, items in sorted(groups.items()):
        c = Counter(r["outcome"] for r in items)
        out.append(
            {key: value, "faces": len(items), "correct": rate(c["match_ok"], len(items)),
             "wrong": c["wrong_match"], "split": c["split"]}
        )
    return out


def detection_breakdown(sessions: list[dict[str, Any]], extracted: dict[str, Any]) -> dict[str, Any]:
    """Share of ground-truth faces the detector found, by helmet, lighting and face size."""
    found: dict[str, Counter[str]] = defaultdict(Counter)
    for session in sessions:
        gt = session["gt"]
        links = set(t for t in link_faces(extracted[session["photo"]]["faces"], gt["faces"]) if t)
        for f in gt["faces"]:
            size = "small <60px" if f["face_px"] < 60 else "medium 60-110px" if f["face_px"] < 110 else "large 110px+"
            for k, v in (("helmet", f["helmet"]), ("lighting", gt["lighting"]), ("face size", size)):
                found[f"{k}={v}"]["total"] += 1
                found[f"{k}={v}"]["found"] += int(f["worker_id"] in links)
    return {k: {"found": v["found"], "total": v["total"], "recall": rate(v["found"], v["total"])} for k, v in sorted(found.items())}


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def markdown(report: dict[str, Any]) -> str:
    s, run = report["summary"], report["run"]
    lines = [
        f"# Golden site eval ({run['dataset_version']}), threshold {s['threshold']}",
        "",
        f"{run['pump_count']} pumps, {run['session_count']} sessions, {s['faces_scored']} faces replayed "
        "through a copy of the production matcher.",
        "",
        "## Known workers (seen before at this pump)",
        f"- Right person: {pct(s['known_worker_correct_rate'])}",
        f"- Wrong person (false accept): {s['wrong_match']} ({pct(s['false_accept_rate'])})",
        f"- New person instead (split): {s['split']} ({pct(s['split_rate'])}); "
        f"workers split into 2+ people: {s['workers_split_into_2plus']}",
        "",
        "## First sightings (new joiners, visitors, transfers)",
        f"- Correctly made a new person: {s['new_ok']}",
        f"- Matched to someone else instead: {s['stranger_accepted']} ({pct(s['stranger_accept_rate'])})",
        "",
        "## Fraud (same worker at two pumps, same date)",
        f"- Caught: {s['fraud_caught']}, missed: {s['fraud_missed']}, false flags: {s['false_fraud_flag']}",
        "",
        "## Other",
        f"- People missed in a photo: {s['missed_people']}; operator counted twice: {s['operator_counted_twice']}; "
        f"operator photo failures: {s['failed_operator_photo']} (sessions ending in the wrong status: "
        f"{s['session_status_wrong']})",
        f"- Faces with no ground truth (phantoms): {s['phantom_face']}",
        f"- Wrong faces saved into a gallery: {s['gallery_polluted_faces']}; "
        f"people holding 2+ workers: {s['persons_mixing_workers']}",
        "",
        "## Threshold sweep",
        "| Threshold | Right person | Wrong person | Split | Stranger accepted | Fraud caught / missed | False flags |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in report["sweep"]:
        lines.append(
            f"| {r['threshold']:.2f} | {pct(r['known_worker_correct_rate'])} | {r['wrong_match']} | {r['split']} | "
            f"{r['stranger_accepted']} | {r['fraud_caught']} / {r['fraud_missed']} | {r['false_fraud_flag']} |"
        )
    lines += ["", "## Face detection (ground-truth faces found)", "| Bucket | Found | Recall |", "|---|---|---|"]
    for k, v in report["detection"].items():
        lines.append(f"| {k} | {v['found']}/{v['total']} | {pct(v['recall'])} |")
    for title, key in (("lighting", "lighting"), ("helmet", "helmet"), ("role", "role")):
        lines += ["", f"## Known-worker matching by {title}", f"| {title} | Faces | Right | Wrong | Split |",
                  "|---|---|---|---|---|"]
        for r in report[f"by_{key}"]:
            lines.append(f"| {r[key]} | {r['faces']} | {pct(r['correct'])} | {r['wrong']} | {r['split']} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset-dir", default=str(DEFAULT_DATASET_DIR))
    parser.add_argument("--ai-url", default=DEFAULT_AI_URL)
    parser.add_argument("--match-threshold", type=float, default=DEFAULT_MATCH_THRESHOLD)
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    parser.add_argument("--limit-pumps", type=int, default=0)
    args = parser.parse_args()

    dataset_dir = Path(args.dataset_dir).resolve()
    dataset = load_json(dataset_dir / "dataset.json")
    sessions = dataset["sessions"]
    if args.limit_pumps:
        keep = {p["pump_id"] for p in dataset["pumps"][: args.limit_pumps]}
        sessions = [s for s in sessions if s["pump_id"] in keep]
    for s in sessions:
        s["gt"] = load_json(dataset_dir / s["ground_truth"])

    ai_url = args.ai_url.rstrip("/")
    extracted: dict[str, Any] = {}
    photos = list(dict.fromkeys(p for s in sessions for p in (s["photo"], s["operator_photo"])))
    started = time.perf_counter()
    for i, photo in enumerate(photos, start=1):
        extracted[photo] = extract(dataset_dir / photo, ai_url)
        if i % 50 == 0:
            print(f"  extracted {i}/{len(photos)} photos ({time.perf_counter() - started:.0f}s)", flush=True)

    main_result = replay(sessions, extracted, args.match_threshold)
    rows = main_result["rows"]
    report = {
        "run": {
            "ai_url": ai_url,
            "match_threshold": args.match_threshold,
            "gallery_add_threshold": GALLERY_ADD_THRESHOLD,
            "gallery_add_margin": GALLERY_ADD_MARGIN,
            "dataset_version": dataset["dataset_version"],
            "pump_count": len({s["pump_id"] for s in sessions}),
            "session_count": len(sessions),
            "extract_ms_median": float(np.median([e["ms"] for e in extracted.values()])) if extracted else None,
        },
        "summary": summarize(main_result, args.match_threshold),
        "detection": detection_breakdown(sessions, extracted),
        "by_lighting": breakdown(rows, "lighting"),
        "by_helmet": breakdown(rows, "helmet"),
        "by_role": breakdown(rows, "role"),
        "sweep": [summarize(replay(sessions, extracted, t), t) for t in SWEEP],
    }

    run_dir = Path(args.output_root) / f"{datetime.now():%Y%m%d-%H%M%S}__golden-site__{dataset['dataset_version']}"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (run_dir / "summary.md").write_text(markdown(report), encoding="utf-8")
    write_csv(run_dir / "decisions.csv", rows)
    write_csv(run_dir / "threshold-sweep.csv", report["sweep"])
    write_csv(run_dir / "sessions.csv", main_result["sessions"])
    print(markdown(report))
    print(run_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
