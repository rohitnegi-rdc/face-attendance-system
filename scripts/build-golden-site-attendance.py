"""Build golden-site-attendance-v2: pumps run for a week, the way the app sees them.

Why a new set (the v1 sets are kept):
- v1 faces are Western celebrities (Pins, LFW); the workforce is Indian. This set uses IMFDB
  (Indian Movie Face Database, IIIT Hyderabad: 100 Indian actors, frames from 100+ films, with
  pose, illumination, occlusion and age annotations). Download: scripts/download-imfdb.py.
- golden-camera-attendance-v1 reuses the same source image for morning and evening, so a match
  only proves the same picture was found again. Here every appearance uses a different frame
  (a different scene of a film made within the same few years, so the person is the same age).
- v1 cases are one morning + one evening on one date. Here each pump runs 7 days with a shift
  start and end photo plus the required operator photo, so the gallery (5 faces, anchor kept),
  the operator tagging, new joiners, transfers and same-day cross-pump fraud are all exercised.
- v1 photos are portrait cards on a plain canvas. Here faces sit on bodies in an outdoor site
  scene: hard hats (some low over the eyebrows), two rows at different depths, near/normal/far
  framing, harsh sun, backlight, dusk and floodlight, sensor noise, blur and JPEG loss.
- Hard negatives: the most alike pairs of different people (by the model's own embeddings)
  are put in the same pump (wrong-match risk) or in two pumps of one Area (false fraud flags).

Curation uses the local AI service (default http://127.0.0.1:6102, never a remote server):
frames it cannot find a face in on their own are dropped, frames far from the person's other
frames (probable IMFDB mislabels, similarity < CURATION_MIN_SIM to the medoid) are dropped, and
near-duplicate frames (> CURATION_DUP_SIM) are dropped so no two appearances are the same shot.
Embeddings stay in memory; only counts are cached (datasets/imfdb/curation-cache.json).

Output (biometric data, under datasets/, ignored by git):
  datasets/golden-site-attendance-v2/
    dataset.json         pumps, areas, sessions in time order, scenario counts
    workers.json         who is who (source identity, role, home pump, look-alike pairs)
    sessions/<id>/       photo.jpg, operator.jpg, preview.jpg (labelled), truth.json
    review/<pump>.jpg    one contact sheet per pump, day by day, labelled
Run: python scripts/run-golden-site-eval.py
"""

from __future__ import annotations

import argparse
import io
import json
import random
import shutil
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
IMFDB_ROOT = ROOT / "datasets" / "imfdb" / "IMFDB_final"
CACHE_PATH = ROOT / "datasets" / "imfdb" / "curation-cache.json"
OUTPUT_ROOT = ROOT / "datasets" / "golden-site-attendance-v2"
DATASET_VERSION = "golden-site-attendance-v2"
SEED = 20261023
# 1920 px long side: the AI service does not resize it (AI_MAX_IMAGE_LONG_SIDE), so its boxes
# are in photo coordinates and can be compared with the truth boxes directly.
PHOTO_SIZE = (1920, 1440)
OPERATOR_SIZE = (1080, 1440)
START_DATE = date(2026, 9, 7)  # Monday
DAYS = 7
CURATION_MIN_SIM = 0.15
CURATION_DUP_SIM = 0.92
MIN_CROP_SIDE = 48
RICH_MIN_IMAGES = 18
YEAR_WINDOW = 8
RESAMPLE = Image.Resampling.LANCZOS

UNIFORMS = [(232, 112, 28), (32, 78, 160), (40, 120, 70), (90, 96, 104), (200, 170, 30), (150, 40, 40)]
HELMET_COLORS = [(245, 245, 240), (250, 204, 21), (249, 115, 22), (37, 99, 235)]
START_LIGHT = [("day", 0.55), ("harsh_sun", 0.25), ("backlit", 0.20)]
END_LIGHT = [("dusk", 0.45), ("floodlight", 0.35), ("day", 0.20)]
DISTANCE = [("near", 0.25), ("normal", 0.50), ("far", 0.25)]
FACE_WIDTH = {  # (front row, back row) face width in px
    "near": ((140, 170), (110, 130)),
    "normal": ((100, 125), (76, 94)),
    "far": ((64, 80), (46, 58)),
}
DARK = {"dusk", "floodlight", "backlit"}


def font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("arial.ttf", size)
    except Exception:
        return ImageFont.load_default()


FONT_S, FONT_M, FONT_L = font(20), font(26), font(34)


# ---------------------------------------------------------------- IMFDB index


@dataclass
class Frame:
    path: Path
    actor: str
    movie: str
    year: int | None
    gender: str
    illumination: str
    pose: str
    occlusion: str
    side: int
    score: float = 0.0  # similarity to the person's medoid frame after curation


@dataclass
class Identity:
    actor: str
    gender: str
    frames: list[Frame]
    window: tuple[int, int] | None = None
    centroid: np.ndarray | None = None
    used: Counter = field(default_factory=Counter)


def index_imfdb() -> dict[str, list[Frame]]:
    """Parse every annotation file. Some files leave out the shot column, so each row is anchored
    on the column naming an existing image and on the gender column."""
    if not IMFDB_ROOT.exists():
        raise SystemExit(f"IMFDB not found at {IMFDB_ROOT}. Run: python scripts/download-imfdb.py")
    by_actor: dict[str, list[Frame]] = defaultdict(list)
    for txt in sorted(IMFDB_ROOT.glob("*/*/*.txt")):
        images = txt.parent / "images"
        if not images.is_dir():
            continue
        files = {p.name for p in images.iterdir()}
        actor, movie = txt.parents[1].name, txt.parent.name
        for line in txt.read_text(encoding="utf-8", errors="replace").splitlines():
            cols = [c.strip() for c in line.split("\t")]
            fi = next((i for i, c in enumerate(cols) if c in files), None)
            gi = next((i for i, c in enumerate(cols) if c in ("MALE", "FEMALE")), None)
            if fi is None or gi is None or gi < 3:
                continue
            gender, _expr, occlusion, illumination, _age, pose = (cols[gi : gi + 6] + [""] * 6)[:6]
            if pose not in ("FRONTAL", "LEFT", "RIGHT", "DOWN") or occlusion in ("HAND", "OTHERS"):
                continue
            path = images / cols[fi]
            with Image.open(path) as im:
                side = min(im.size)
            if side < MIN_CROP_SIDE:
                continue
            try:
                year = int(cols[gi - 2])
            except ValueError:
                year = None
            by_actor[actor].append(Frame(path, actor, movie, year, gender, illumination, pose, occlusion, side))
    return by_actor


def best_window(frames: list[Frame]) -> tuple[tuple[int, int] | None, list[Frame]]:
    """Frames from films made within YEAR_WINDOW years of each other (same age on screen)."""
    best: tuple[tuple[int, int] | None, list[Frame]] = (None, [])
    for y0 in sorted({f.year for f in frames if f.year}):
        chosen = [f for f in frames if f.year and y0 <= f.year <= y0 + YEAR_WINDOW]
        if len(chosen) > len(best[1]):
            best = ((y0, y0 + YEAR_WINDOW), chosen)
    return best


# ---------------------------------------------------------------- curation (local AI service)


def solo_embedding(path: Path, ai_url: str) -> np.ndarray | None:
    # A crop that fills the frame is not detected; pad it the way a face sits in a photo.
    canvas = Image.new("RGB", (640, 640), (140, 150, 160))
    crop = Image.open(path).convert("RGB")
    crop = crop.resize((150, max(1, round(150 * crop.height / crop.width))), RESAMPLE)
    canvas.paste(crop, ((640 - crop.width) // 2, (640 - crop.height) // 2))
    buf = io.BytesIO()
    canvas.save(buf, "JPEG", quality=92)
    r = requests.post(f"{ai_url}/internal/face/extract", files={"file": ("c.jpg", buf.getvalue(), "image/jpeg")}, timeout=120)
    r.raise_for_status()
    faces = r.json().get("faces", [])
    if not faces:
        return None
    biggest = max(faces, key=lambda f: (f["bbox"][2] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][1]))
    v = np.asarray(biggest["embedding"], dtype=np.float32)
    return v / (np.linalg.norm(v) or 1.0)


def curate(identities: list[Identity], ai_url: str, cap: int) -> dict[tuple[str, str], float]:
    """Drop undetectable, mislabelled and near-duplicate frames; returns centroid similarities."""
    cache = json.loads(CACHE_PATH.read_text(encoding="utf-8")) if CACHE_PATH.exists() else {}
    total = sum(min(cap, len(i.frames)) for i in identities)
    done = 0
    for ident in identities:
        rng = random.Random(f"{SEED}:{ident.actor}")
        frames = sorted(ident.frames, key=lambda f: (f.movie, f.path.name))
        rng.shuffle(frames)
        frames = sorted(frames[: cap * 2], key=lambda f: -f.side)[:cap]  # prefer larger crops
        vecs = []
        for f in frames:
            v = solo_embedding(f.path, ai_url)
            if v is not None:
                vecs.append((f, v))
            done += 1
            if done % 200 == 0:
                print(f"  curation {done}/{total}", flush=True)
        if len(vecs) < 2:
            ident.frames = [f for f, _ in vecs]
            ident.centroid = vecs[0][1] if vecs else None
            continue
        m = np.stack([v for _, v in vecs])
        sims = m @ m.T
        medoid = int(np.argmax(sims.mean(axis=1)))
        kept: list[tuple[Frame, np.ndarray]] = []
        for (f, v), s in sorted(zip(vecs, sims[medoid]), key=lambda x: -x[1]):
            if s < CURATION_MIN_SIM or any(float(v @ kv) > CURATION_DUP_SIM for _, kv in kept):
                continue
            f.score = round(float(s), 4)
            kept.append((f, v))
        ident.frames = [f for f, _ in kept]
        c = np.mean([v for _, v in kept], axis=0)
        ident.centroid = c / (np.linalg.norm(c) or 1.0)
        cache[ident.actor] = {"kept": len(kept), "tried": len(frames)}
    CACHE_PATH.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
    usable = [i for i in identities if i.centroid is not None]
    return {
        (a.actor, b.actor): float(a.centroid @ b.centroid)
        for a in usable for b in usable if a.actor < b.actor
    }


# ---------------------------------------------------------------- plan


@dataclass
class Worker:
    worker_id: str
    identity: Identity
    role: str  # regular | new_joiner | visitor
    home_pump: str | None
    notes: list[str] = field(default_factory=list)


@dataclass
class Appearance:
    worker_id: str
    role: str  # regular | operator | new_joiner | visitor | transfer | proxy | cross_area
    expected: str  # match | new_person | fraud_flag


@dataclass
class SessionPlan:
    session_id: str
    pump_id: str
    area_id: str
    day: int
    kind: str  # start | end
    time: str
    lighting: str
    distance: str
    blur: bool
    jpeg: int
    group: list[Appearance]
    operator_id: str
    operator_in_group: bool
    operator_photo_has_face: bool = True
    tags: list[str] = field(default_factory=list)
    expected_fraud: list[dict[str, str]] = field(default_factory=list)


def weighted(rng: random.Random, options: list[tuple[str, float]]) -> str:
    return rng.choices([o for o, _ in options], weights=[w for _, w in options])[0]


def build_plan(rich: list[Identity], poor: list[Identity], pair_sims: dict[tuple[str, str], float]):
    rng = random.Random(SEED)
    areas = {"AREA-A": [f"PUMP-A{i}" for i in range(1, 7)], "AREA-B": [f"PUMP-B{i}" for i in range(1, 5)]}
    pumps = [p for ps in areas.values() for p in ps]
    area_of = {p: a for a, ps in areas.items() for p in ps}
    roster_size = {p: (6 if i % 2 == 0 else 5) for i, p in enumerate(pumps)}

    male = [i for i in rich if i.gender == "MALE"]
    female = [i for i in rich if i.gender == "FEMALE"]
    # Look-alikes: the most alike different men, disjoint pairs.
    lookalikes: list[tuple[str, str, float]] = []
    taken: set[str] = set()
    male_names = {i.actor for i in male}
    for (a, b), s in sorted(pair_sims.items(), key=lambda x: -x[1]):
        if a in male_names and b in male_names and a not in taken and b not in taken:
            lookalikes.append((a, b, round(s, 4)))
            taken |= {a, b}
        if len(lookalikes) == 4:
            break
    by_actor = {i.actor: i for i in rich + poor}

    workers: dict[str, Worker] = {}
    rosters: dict[str, list[str]] = {p: [] for p in pumps}
    counter = iter(range(1, 1000))

    def add(identity: Identity, role: str, pump: str | None, note: str | None = None) -> str:
        wid = f"W{next(counter):03d}"
        workers[wid] = Worker(wid, identity, role, pump, [note] if note else [])
        if pump and role == "regular":
            rosters[pump].append(wid)
        return wid

    # Pairs 1-2 share a pump (wrong-match risk); pairs 3-4 are split over two pumps of AREA-A
    # that work the same days (false fraud flag risk).
    placements = [("PUMP-A1", "PUMP-A1"), ("PUMP-B1", "PUMP-B1"), ("PUMP-A2", "PUMP-A3"), ("PUMP-A4", "PUMP-A5")]
    used_actors: set[str] = set()
    for (a, b, s), (pa, pb) in zip(lookalikes, placements):
        add(by_actor[a], "regular", pa, f"look-alike of imfdb:{b} (centroid similarity {s})")
        add(by_actor[b], "regular", pb, f"look-alike of imfdb:{a} (centroid similarity {s})")
        used_actors |= {a, b}
    pool = [i for i in male if i.actor not in used_actors]
    rng.shuffle(pool)
    fem = list(female)
    rng.shuffle(fem)
    for pump in pumps:
        while len(rosters[pump]) < roster_size[pump]:
            # About 1 in 12 regulars is a woman; concrete pump crews are mostly men.
            source = fem if (fem and rng.random() < 0.08) or not pool else pool
            add(source.pop(), "regular", pump)
    # The regular with the most frames operates the pump (the operator appears in every session).
    operators = {p: max(rosters[p], key=lambda w: len(workers[w].identity.frames)) for p in pumps}
    joiners: dict[str, tuple[str, int]] = {}
    for pump, start_day in zip(["PUMP-A2", "PUMP-A6", "PUMP-B2", "PUMP-B3", "PUMP-A4"], [2, 3, 3, 4, 5]):
        source = pool if pool else fem
        wid = add(source.pop(), "new_joiner", pump, f"joins on day {start_day + 1}")
        joiners[wid] = (pump, start_day)
    visitor_pool = [i for i in poor if i.frames] + pool + fem
    rng.shuffle(visitor_pool)

    def non_operator(pump: str, index: int) -> str:
        others = [w for w in rosters[pump] if w != operators[pump]]
        return others[index % len(others)]

    day_off = {p: (6 if i % 3 == 0 else i % 6) for i, p in enumerate(pumps)}
    leavers = {non_operator("PUMP-A3", -1): 4, non_operator("PUMP-B4", -1): 3, non_operator("PUMP-A6", -1): 5}
    transfers = {non_operator("PUMP-A1", 2): ("PUMP-A1", "PUMP-A6", 4), non_operator("PUMP-B2", 1): ("PUMP-B2", "PUMP-B3", 5)}
    for w, (_, _, d) in transfers.items():
        workers[w].notes.append(f"transfers on day {d + 1}")
    for w, d in leavers.items():
        workers[w].notes.append(f"leaves after day {d}")

    # Who is in each pump's start and end photo, before the same-day events.
    present: dict[tuple[str, int], dict[str, set[str]]] = {}
    for pump in pumps:
        for day in range(DAYS):
            if day == day_off[pump]:
                continue
            start, end = set(), set()
            for w in rosters[pump]:
                if (w in leavers and day >= leavers[w]) or (w in transfers and day >= transfers[w][2]):
                    continue
                r = rng.random()
                if r < 0.10:
                    continue  # absent all day
                if r < 0.16:
                    start.add(w)  # left before the end photo
                elif r < 0.20:
                    end.add(w)  # came late
                else:
                    start.add(w)
                    end.add(w)
            for w, (_, to_pump, d) in transfers.items():
                if to_pump == pump and day >= d:
                    start.add(w)
                    end.add(w)
            for w, (jp, d) in joiners.items():
                if jp == pump and day >= d:
                    start.add(w)
                    if rng.random() < 0.9:
                        end.add(w)
            start.add(operators[pump])
            end.add(operators[pump])
            present[(pump, day)] = {"start": start, "end": end}

    extras: dict[tuple[str, int, str], list[tuple[str, str]]] = defaultdict(list)
    fraud_events = []
    # Proxy: a worker in their own pump's start photo is also in another pump's start photo of the
    # same Area on the same date. Their own pump starts first (start times rise with pump order).
    for src, dst, day in [("PUMP-A1", "PUMP-A3", 1), ("PUMP-A2", "PUMP-A5", 2), ("PUMP-B1", "PUMP-B3", 4), ("PUMP-A4", "PUMP-A6", 5)]:
        candidates = sorted(
            w for w in present.get((src, day), {}).get("start", set())
            if w != operators[src] and workers[w].role == "regular"
        )
        if (dst, day) not in present or not candidates:
            continue
        w = rng.choice(candidates)
        extras[(dst, day, "start")].append((w, "proxy"))
        fraud_events.append({"worker_id": w, "home_pump": src, "pump_id": dst, "day": day + 1})
    # Cross-area, same date: the fraud check is Area-scoped, so this is a new person, not a flag.
    cross_area = []
    for src, dst, day in [("PUMP-A2", "PUMP-B2", 3), ("PUMP-A5", "PUMP-B4", 1)]:
        candidates = sorted(w for w in present.get((src, day), {}).get("start", set()) if w != operators[src])
        if (dst, day) in present and candidates:
            w = rng.choice(candidates)
            extras[(dst, day, "start")].append((w, "cross_area"))
            cross_area.append({"worker_id": w, "home_pump": src, "pump_id": dst, "day": day + 1})
    # One-off visitors (driver, supervisor, site staff).
    keys = sorted(present)
    for n in range(18):
        pump, day = keys[(n * 7 + 3) % len(keys)]
        kind = "start" if n % 3 else "end"
        wid = add(visitor_pool.pop(), "visitor", None, f"visits {pump} on day {day + 1}")
        extras[(pump, day, kind)].append((wid, "visitor"))
    # A relief operator on one day at four pumps; two operator photos with no face (fail at once).
    relief = {"PUMP-A3": 3, "PUMP-B2": 1, "PUMP-A6": 2, "PUMP-B4": 5}
    no_face_operator = {("PUMP-A5", 4, "end"), ("PUMP-B3", 2, "start")}

    sessions: list[SessionPlan] = []
    seen: set[tuple[str, str]] = set()  # (pump, worker) already a person at that pump
    for day in range(DAYS):
        for kind in ("start", "end"):
            for pump_index, pump in enumerate(pumps):
                if (pump, day) not in present:
                    continue
                members = set(present[(pump, day)][kind])
                op = operators[pump]
                tags: list[str] = []
                if relief.get(pump) == day:
                    alternatives = sorted(m for m in members if m != op and workers[m].role == "regular")
                    if alternatives:
                        op = alternatives[0]
                        tags.append("relief_operator")
                failed_op = (pump, day, kind) in no_face_operator
                in_group = rng.random() < 0.5
                group_ids = sorted(m for m in members if m != op or in_group)
                rng.shuffle(group_ids)
                group: list[Appearance] = []
                expected_fraud: list[dict[str, str]] = []
                if failed_op:
                    tags.append("operator_photo_no_face")
                if not in_group:
                    tags.append("operator_not_in_group")
                for w in group_ids:
                    role = "operator" if w == op else workers[w].role
                    if w in transfers and pump == transfers[w][1]:
                        role = "transfer"
                    group.append(Appearance(w, role, "match" if (pump, w) in seen else "new_person"))
                for w, role in extras.get((pump, day, kind), []):
                    if role == "proxy":
                        group.append(Appearance(w, role, "fraud_flag"))
                        expected_fraud.append({"worker_id": w, "home_pump": workers[w].home_pump})
                    else:
                        group.append(Appearance(w, role, "match" if (pump, w) in seen else "new_person"))
                    tags.append(role)
                if any(a.role == "transfer" and a.expected == "new_person" for a in group):
                    tags.append("transfer_first_day")
                if any(a.role == "new_joiner" and a.expected == "new_person" for a in group):
                    tags.append("new_joiner_first_day")
                if any(any("look-alike" in n for n in workers[a.worker_id].notes) for a in group):
                    tags.append("lookalike_present")
                if not failed_op:
                    seen.update((pump, a.worker_id) for a in group if a.expected != "fraud_flag")
                    seen.add((pump, op))
                minutes = (7 * 60 + 30 + pump_index * 9) if kind == "start" else (18 * 60 + 40 + pump_index * 9)
                sessions.append(
                    SessionPlan(
                        session_id=f"D{day + 1}-{pump}-{kind}",
                        pump_id=pump,
                        area_id=area_of[pump],
                        day=day,
                        kind=kind,
                        time=f"{minutes // 60:02d}:{minutes % 60:02d}",
                        lighting=weighted(rng, START_LIGHT if kind == "start" else END_LIGHT),
                        distance=weighted(rng, DISTANCE),
                        blur=kind == "end" and rng.random() < 0.18,
                        jpeg=rng.randint(70, 90),
                        group=group,
                        operator_id=op,
                        operator_in_group=in_group,
                        operator_photo_has_face=not failed_op,
                        tags=tags,
                        expected_fraud=expected_fraud,
                    )
                )
    sessions.sort(key=lambda s: (s.day, s.time, s.pump_id))
    meta = {
        "areas": areas,
        "rosters": rosters,
        "operators": operators,
        "day_off": {p: d + 1 for p, d in day_off.items()},
        "events": {
            "lookalikes": [{"a": f"imfdb:{a}", "b": f"imfdb:{b}", "similarity": s} for a, b, s in lookalikes],
            "joiners": {w: {"pump": p, "from_day": d + 1} for w, (p, d) in joiners.items()},
            "leavers": {w: {"last_day": d} for w, d in leavers.items()},
            "transfers": {w: {"from": a, "to": b, "from_day": d + 1} for w, (a, b, d) in transfers.items()},
            "fraud_events": fraud_events,
            "cross_area_same_day": cross_area,
            "relief_operator_days": {p: d + 1 for p, d in relief.items()},
        },
    }
    return workers, sessions, meta


# ---------------------------------------------------------------- rendering


def pick_frame(identity: Identity, rng: random.Random, dark: bool, min_side: int) -> Frame:
    """An unused frame if any is left (least used otherwise), lit to suit the photo, big enough."""
    least = min(identity.used[str(f.path)] for f in identity.frames)
    pool = [f for f in identity.frames if identity.used[str(f.path)] == least]
    suited = [f for f in pool if (f.illumination == "BAD") == dark] or pool
    big = [f for f in suited if f.side >= min_side] or suited
    frame = rng.choice(sorted(big, key=lambda f: str(f.path)))
    identity.used[str(frame.path)] += 1
    return frame


def sky_and_site(size: tuple[int, int], lighting: str, rng: random.Random) -> Image.Image:
    w, h = size
    tops = {"day": ((120, 170, 225), (205, 220, 235)), "harsh_sun": ((90, 150, 230), (215, 230, 245)),
            "backlit": ((250, 250, 245), (235, 238, 240)), "dusk": ((60, 60, 110), (230, 140, 90)),
            "floodlight": ((12, 14, 26), (40, 40, 55))}[lighting]
    night = lighting in ("dusk", "floodlight")
    img = Image.new("RGB", size)
    d = ImageDraw.Draw(img)
    horizon = int(h * 0.58)
    for y in range(horizon):
        t = y / horizon
        d.line([(0, y), (w, y)], fill=tuple(int(tops[0][i] * (1 - t) + tops[1][i] * t) for i in range(3)))
    ground = (70, 62, 55) if night else (150, 135, 115)
    for y in range(horizon, h):
        t = (y - horizon) / (h - horizon)
        d.line([(0, y), (w, y)], fill=tuple(min(255, int(c * (0.9 + 0.2 * t))) for c in ground))
    # Far buildings, a concrete pump truck with its boom, a mixer drum.
    for _ in range(9):
        bx, bw, bh = rng.randint(0, w), rng.randint(80, 220), rng.randint(60, 260)
        shade = rng.randint(30, 60) if night else rng.randint(120, 175)
        d.rectangle((bx, horizon - bh, bx + bw, horizon), fill=(shade, shade, shade + 5))
    tx = rng.randint(int(w * 0.05), int(w * 0.55))
    d.rectangle((tx, horizon - 150, tx + 620, horizon + 30), fill=(90, 90, 88) if night else (230, 230, 225))
    d.rectangle((tx + 620, horizon - 120, tx + 760, horizon + 30), fill=(200, 60, 40))
    d.line([(tx + 120, horizon - 150), (tx + 420, horizon - 520), (tx + 900, horizon - 600)], fill=(240, 180, 30), width=26)
    d.ellipse((tx + 1000, horizon - 170, tx + 1260, horizon + 10), fill=(180, 180, 175))
    for x in (tx + 80, tx + 260, tx + 520, tx + 690):
        d.ellipse((x - 40, horizon - 10, x + 40, horizon + 70), fill=(25, 25, 25))
    if lighting == "floodlight":
        glow = Image.new("L", size, 0)
        gx = rng.randint(int(w * 0.2), int(w * 0.8))
        ImageDraw.Draw(glow).ellipse((gx - 900, -700, gx + 900, 900), fill=120)
        img = Image.composite(Image.new("RGB", size, (255, 190, 110)), img, glow.filter(ImageFilter.GaussianBlur(200)))
    return img


def face_tile(frame: Frame, width: int, rng: random.Random) -> tuple[Image.Image, Image.Image, tuple[int, ...]]:
    crop = Image.open(frame.path).convert("RGB")
    height = max(1, round(width * crop.height / crop.width))
    crop = crop.resize((width, height), RESAMPLE)
    mask = Image.new("L", crop.size, 0)
    inset = max(1, width // 18)
    ImageDraw.Draw(mask).ellipse((inset, 0, width - inset, height), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(1, width / 22)))
    lower = crop.crop((width // 3, int(height * 0.6), 2 * width // 3, int(height * 0.85)))
    skin = tuple(int(c) for c in np.asarray(lower).reshape(-1, 3).mean(axis=0))
    angle = rng.uniform(-6, 6)
    crop = crop.rotate(angle, resample=Image.Resampling.BICUBIC)
    mask = mask.rotate(angle, resample=Image.Resampling.BICUBIC)
    return crop, mask, skin


def draw_person(canvas: Image.Image, cx: int, cy: int, frame: Frame, width: int, uniform: tuple[int, ...],
                helmet: str, helmet_color: tuple[int, ...], dim: float, rng: random.Random) -> list[int]:
    """Body, head and face centred at (cx, cy). Returns the face box [x1, y1, x2, y2]."""
    face, mask, skin = face_tile(frame, width, rng)
    if dim != 1.0:
        face = ImageEnhance.Brightness(face).enhance(dim)
        skin = tuple(int(c * dim) for c in skin)
        uniform = tuple(int(c * dim) for c in uniform)
        helmet_color = tuple(int(c * dim) for c in helmet_color)
    fw, fh = face.size
    x1, y1 = cx - fw // 2, cy - fh // 2
    d = ImageDraw.Draw(canvas)
    # Shoulders and chest in the pump's uniform with a reflective band, then neck and hair.
    sw, sh = int(fw * 3.0), int(fh * 2.6)
    top = y1 + int(fh * 1.05)
    d.rounded_rectangle((cx - sw // 2, top, cx + sw // 2, top + sh), radius=int(fw * 0.6), fill=uniform)
    band = int(200 * dim)
    d.rectangle((cx - sw // 2, top + int(sh * 0.35), cx + sw // 2, top + int(sh * 0.45)), fill=(band, band, band))
    d.rectangle((cx - int(fw * 0.22), y1 + int(fh * 0.8), cx + int(fw * 0.22), top + int(fh * 0.15)), fill=skin)
    hair = tuple(int(c * dim) for c in (28, 24, 22))
    d.ellipse((x1 - int(fw * 0.08), y1 - int(fh * 0.22), x1 + fw + int(fw * 0.08), y1 + int(fh * 0.75)), fill=hair)
    canvas.paste(face, (x1, y1), mask)
    if helmet != "none":
        # "hat" sits on the hairline; "low" comes down to the eyebrows.
        brim_y = y1 + int(fh * (0.06 if helmet == "hat" else 0.24))
        dome_w, dome_h = int(fw * 1.3), int(fh * 0.95)
        d.chord((cx - dome_w // 2, brim_y - dome_h, cx + dome_w // 2, brim_y + dome_h // 3), 180, 360, fill=helmet_color)
        d.rectangle((cx - dome_w // 2, brim_y - dome_h // 3 - 2, cx + dome_w // 2, brim_y), fill=helmet_color)
        d.rounded_rectangle((cx - int(fw * 0.72), brim_y - int(fh * 0.04), cx + int(fw * 0.72), brim_y + int(fh * 0.06)),
                            radius=4, fill=tuple(int(c * 0.85) for c in helmet_color))
    return [x1, y1, x1 + fw, y1 + fh]


def apply_light(img: Image.Image, lighting: str, rng: random.Random, blur: bool) -> Image.Image:
    if lighting == "harsh_sun":
        img = ImageEnhance.Contrast(img).enhance(1.25)
        img = ImageEnhance.Brightness(img).enhance(1.06)
    elif lighting == "dusk":
        img = ImageEnhance.Brightness(img).enhance(0.5)
        img = ImageEnhance.Color(img).enhance(0.8)
        img = Image.blend(img, Image.new("RGB", img.size, (255, 140, 60)), 0.12)
    elif lighting == "floodlight":
        img = ImageEnhance.Brightness(img).enhance(0.55)
        img = Image.blend(img, Image.new("RGB", img.size, (255, 170, 70)), 0.2)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(0.9))
    if lighting in DARK:
        sigma = {"dusk": 6, "floodlight": 9, "backlit": 4}[lighting]
        arr = np.asarray(img).astype(np.int16)
        arr = arr + np.random.default_rng(rng.randint(0, 2**31)).normal(0, sigma, arr.shape).astype(np.int16)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return img


def render_group(plan: SessionPlan, workers: dict[str, Worker], uniform: tuple[int, ...], rng: random.Random):
    canvas = sky_and_site(PHOTO_SIZE, plan.lighting, rng)
    people = list(plan.group)
    w, h = PHOTO_SIZE
    back_n = len(people) // 2 if len(people) > 4 else 0
    front_range, back_range = FACE_WIDTH[plan.distance]
    dim = 0.5 if plan.lighting == "backlit" else 1.0
    faces: list[dict[str, Any]] = []
    for row, members in (("back", people[:back_n]), ("front", people[back_n:])):
        if not members:
            continue
        lo, hi = back_range if row == "back" else front_range
        if plan.distance == "near":
            cy = int(h * (0.36 if row == "back" else 0.56))
        else:
            cy = int(h * (0.42 if row == "back" else 0.58))
        span = w * (0.78 if row == "front" else 0.62)
        step = span / len(members)
        start_x = (w - span) / 2 + step / 2
        for i, a in enumerate(members):
            width = rng.randint(lo, hi)
            frame = pick_frame(workers[a.worker_id].identity, rng, plan.lighting in DARK, width)
            r = rng.random()
            helmet = "none" if r < 0.5 else ("low" if r < 0.6 else "hat")
            cx = int(start_x + i * step + rng.uniform(-step * 0.08, step * 0.08))
            box = draw_person(canvas, cx, cy + rng.randint(-14, 14), frame, width, uniform, helmet,
                              rng.choice(HELMET_COLORS), dim, rng)
            faces.append({
                "worker_id": a.worker_id, "role": a.role, "expected": a.expected, "bbox": box,
                "face_px": box[2] - box[0], "helmet": helmet, "row": row, "pose": frame.pose,
                "source_illumination": frame.illumination, "source_occlusion": frame.occlusion,
                "source_image": frame.path.relative_to(ROOT).as_posix(), "source_film": frame.movie,
                "source_year": frame.year, "curation_score": frame.score,
            })
    return apply_light(canvas, plan.lighting, rng, plan.blur), faces


def render_operator(plan: SessionPlan, workers: dict[str, Worker], uniform: tuple[int, ...], rng: random.Random):
    canvas = sky_and_site(OPERATOR_SIZE, plan.lighting, rng)
    w, h = OPERATOR_SIZE
    if not plan.operator_photo_has_face:
        # The operator's head turned away from the phone: hair and shoulders, no face.
        d = ImageDraw.Draw(canvas)
        d.rounded_rectangle((w // 2 - 330, int(h * 0.62), w // 2 + 330, h + 40), radius=120, fill=uniform)
        d.ellipse((w // 2 - 150, int(h * 0.30), w // 2 + 150, int(h * 0.66)), fill=(28, 24, 22))
        return apply_light(canvas, plan.lighting, rng, False), {"worker_id": plan.operator_id, "has_face": False,
                                                                "in_group": plan.operator_in_group}
    width = rng.randint(250, 320)
    frame = pick_frame(workers[plan.operator_id].identity, rng, plan.lighting in DARK, 110)
    r = rng.random()
    helmet = "none" if r < 0.6 else ("low" if r < 0.68 else "hat")
    box = draw_person(canvas, w // 2, int(h * 0.42), frame, width, uniform, helmet, rng.choice(HELMET_COLORS),
                      0.6 if plan.lighting == "backlit" else 1.0, rng)
    return apply_light(canvas, plan.lighting, rng, False), {
        "worker_id": plan.operator_id, "has_face": True, "bbox": box, "face_px": box[2] - box[0], "helmet": helmet,
        "role": "operator", "in_group": plan.operator_in_group, "pose": frame.pose,
        "source_image": frame.path.relative_to(ROOT).as_posix(), "source_film": frame.movie,
    }


def labelled(photo: Image.Image, plan: SessionPlan, faces: list[dict[str, Any]]) -> Image.Image:
    img = photo.copy()
    d = ImageDraw.Draw(img)
    colors = {"match": (16, 185, 129), "new_person": (59, 130, 246), "fraud_flag": (239, 68, 68)}
    for f in faces:
        c = colors[f["expected"]]
        d.rectangle(f["bbox"], outline=c, width=4)
        label = f"{f['worker_id']} {f['role']} > {f['expected']}"
        d.rectangle((f["bbox"][0], f["bbox"][1] - 26, f["bbox"][0] + 11 * len(label), f["bbox"][1]), fill=c)
        d.text((f["bbox"][0] + 4, f["bbox"][1] - 24), label, fill="white", font=FONT_S)
    head = (f"{plan.session_id}  {plan.time}  {plan.lighting}/{plan.distance}{' blur' if plan.blur else ''}  "
            f"operator {plan.operator_id}{'' if plan.operator_in_group else ' (not in group)'}")
    d.rectangle((0, 0, PHOTO_SIZE[0], 52), fill=(15, 23, 42))
    d.text((16, 10), head + ("  | " + ", ".join(plan.tags) if plan.tags else ""), fill="white", font=FONT_M)
    return img


def contact_sheet(pump: str, entries: list[tuple[SessionPlan, Path]], out: Path) -> None:
    thumb = (480, 360)
    days = sorted({p.day for p, _ in entries})
    sheet = Image.new("RGB", (60 + 2 * (thumb[0] + 20), 80 + len(days) * (thumb[1] + 50)), (245, 247, 247))
    d = ImageDraw.Draw(sheet)
    d.text((20, 20), f"{DATASET_VERSION}  {pump}  (start | end)", fill=(16, 37, 41), font=FONT_L)
    for plan, preview in entries:
        x = 30 + (0 if plan.kind == "start" else 1) * (thumb[0] + 20)
        y = 80 + days.index(plan.day) * (thumb[1] + 50)
        im = Image.open(preview)
        im.thumbnail(thumb)
        sheet.paste(im, (x, y + 30))
        d.text((x, y + 4), f"Day {plan.day + 1} {plan.kind} {plan.time}", fill=(16, 37, 41), font=FONT_S)
    sheet.save(out, quality=85)


# ---------------------------------------------------------------- main


def readme(dataset: dict[str, Any], workers_json: list[dict[str, Any]]) -> str:
    roles = Counter(w["role"] for w in workers_json)
    return f"""# Golden Site Attendance V2

{len(dataset['pumps'])} pumps in 2 Areas, {len(dataset['dates'])} days ({dataset['dates'][0]} to {dataset['dates'][-1]}),
{dataset['session_count']} shift photos, each with its operator photo. {dataset['face_count']} faces in group photos.
Workers: {roles['regular']} regulars, {roles['new_joiner']} new joiners, {roles['visitor']} one-off visitors.

Source: {dataset['source']}. Internal evaluation only: never commit, publish or share these images.

- Inputs per session: `sessions/<id>/photo.jpg` and `operator.jpg`. Labels: `truth.json`.
- Check labels by eye: `review/<pump>.jpg` (day by day) or `sessions/<id>/preview.jpg`
  (green = should match, blue = should become a new person, red = should raise a fraud flag).
- Every appearance is a different film frame where possible; frame reuse: {json.dumps(dataset['frame_reuse'])}.
- Run: `python scripts/run-golden-site-eval.py` (replays the production matcher, sweeps thresholds).

Events:
```json
{json.dumps(dataset['events'], indent=2)}
```

Tags: {json.dumps(dataset['tag_counts'])}
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ai-url", default="http://127.0.0.1:6102", help="local AI service used for curation")
    parser.add_argument("--frames-per-identity", type=int, default=40)
    args = parser.parse_args()
    ai_url = args.ai_url.rstrip("/")

    print("Indexing IMFDB ...", flush=True)
    rich: list[Identity] = []
    poor: list[Identity] = []
    for actor, frames in sorted(index_imfdb().items()):
        window, chosen = best_window(frames)
        gender = Counter(f.gender for f in frames).most_common(1)[0][0]
        (rich if len(chosen) >= RICH_MIN_IMAGES else poor).append(Identity(actor, gender, chosen, window))
    poor = [i for i in poor if i.frames]
    print(f"  {len(rich)} identities with {RICH_MIN_IMAGES}+ frames, {len(poor)} with fewer", flush=True)

    print("Curating frames with the local AI service ...", flush=True)
    pair_sims = curate(rich, ai_url, args.frames_per_identity)
    curate(poor, ai_url, 6)
    rich = [i for i in rich if len(i.frames) >= 12]
    poor = [i for i in poor if i.frames]
    print(f"  usable after curation: {len(rich)} rich, {len(poor)} for one-off visitors", flush=True)

    workers, sessions, meta = build_plan(rich, poor, pair_sims)

    resolved = OUTPUT_ROOT.resolve()
    if ROOT.resolve() not in resolved.parents:
        raise SystemExit(f"Refusing to write outside the repo: {resolved}")
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    (OUTPUT_ROOT / "sessions").mkdir(parents=True)
    (OUTPUT_ROOT / "review").mkdir()

    pumps = [p for ps in meta["areas"].values() for p in ps]
    uniform_of = {p: UNIFORMS[i % len(UNIFORMS)] for i, p in enumerate(pumps)}
    previews: dict[str, list[tuple[SessionPlan, Path]]] = defaultdict(list)
    index_rows = []
    tag_counts: Counter[str] = Counter()
    expected_counts: Counter[str] = Counter()
    for plan in sessions:
        rng = random.Random(f"{SEED}:{plan.session_id}")
        folder = OUTPUT_ROOT / "sessions" / plan.session_id
        folder.mkdir()
        photo, faces = render_group(plan, workers, uniform_of[plan.pump_id], rng)
        photo.save(folder / "photo.jpg", quality=plan.jpeg)
        op_photo, operator = render_operator(plan, workers, uniform_of[plan.pump_id], rng)
        op_photo.save(folder / "operator.jpg", quality=plan.jpeg)
        labelled(photo, plan, faces).save(folder / "preview.jpg", quality=85)
        previews[plan.pump_id].append((plan, folder / "preview.jpg"))
        truth = {
            "schema_version": 2,
            "dataset_version": DATASET_VERSION,
            "session_id": plan.session_id,
            "pump_id": plan.pump_id,
            "area_id": plan.area_id,
            "date": (START_DATE + timedelta(days=plan.day)).isoformat(),
            "time": plan.time,
            "kind": plan.kind,
            "lighting": plan.lighting,
            "distance": plan.distance,
            "blur": plan.blur,
            "jpeg_quality": plan.jpeg,
            "tags": plan.tags,
            "expected_status": "completed" if plan.operator_photo_has_face else "failed_operator_photo",
            "faces": faces,
            "operator": operator,
            "expected_fraud_flags": plan.expected_fraud,
            "notes": [
                "photo.jpg and operator.jpg are the inputs; preview.jpg is for people checking labels only.",
                "expected: match = this pump already has this worker; new_person = first time at this pump; "
                "fraud_flag = same worker at another pump of this Area on this date.",
            ],
        }
        (folder / "truth.json").write_text(json.dumps(truth, indent=2) + "\n", encoding="utf-8")
        tag_counts.update(plan.tags)
        expected_counts.update(f["expected"] for f in faces)
        index_rows.append({
            "session_id": plan.session_id, "pump_id": plan.pump_id, "area_id": plan.area_id,
            "date": truth["date"], "time": plan.time, "kind": plan.kind,
            "photo": f"sessions/{plan.session_id}/photo.jpg",
            "operator_photo": f"sessions/{plan.session_id}/operator.jpg",
            "ground_truth": f"sessions/{plan.session_id}/truth.json",
        })
    for pump, entries in previews.items():
        contact_sheet(pump, entries, OUTPUT_ROOT / "review" / f"{pump}.jpg")

    reuse: Counter[int] = Counter()
    for wk in workers.values():
        reuse.update(min(c, 3) for c in wk.identity.used.values())
    workers_json = [
        {
            "worker_id": wk.worker_id, "role": wk.role, "home_pump": wk.home_pump,
            "source": f"imfdb:{wk.identity.actor}", "gender": wk.identity.gender,
            "film_years": wk.identity.window, "curated_frames": len(wk.identity.frames),
            "frames_used": len(wk.identity.used), "appearances": sum(wk.identity.used.values()), "notes": wk.notes,
        }
        for wk in workers.values()
    ]
    dataset = {
        "schema_version": 2,
        "dataset_version": DATASET_VERSION,
        "created_by": "scripts/build-golden-site-attendance.py",
        "seed": SEED,
        "source": "IMFDB (Indian Movie Face Database, CVIT IIIT Hyderabad; cite Setty et al., NCVPRIPG 2013)",
        "dates": [(START_DATE + timedelta(days=d)).isoformat() for d in range(DAYS)],
        "pumps": [{"pump_id": p, "area_id": a, "operator": meta["operators"][p], "roster": meta["rosters"][p],
                   "day_off": meta["day_off"][p]} for a, ps in meta["areas"].items() for p in ps],
        "session_count": len(sessions),
        "face_count": sum(expected_counts.values()),
        "expected_counts": dict(expected_counts),
        "tag_counts": dict(sorted(tag_counts.items())),
        "events": meta["events"],
        "frame_reuse": {"used once": reuse[1], "used twice": reuse[2], "used 3+ times": reuse[3]},
        "sessions": index_rows,
    }
    (OUTPUT_ROOT / "dataset.json").write_text(json.dumps(dataset, indent=2) + "\n", encoding="utf-8")
    (OUTPUT_ROOT / "workers.json").write_text(json.dumps(workers_json, indent=2) + "\n", encoding="utf-8")
    (OUTPUT_ROOT / "README.md").write_text(readme(dataset, workers_json), encoding="utf-8")
    print(json.dumps({k: dataset[k] for k in ("session_count", "face_count", "expected_counts", "tag_counts", "frame_reuse")}, indent=2))
    print(OUTPUT_ROOT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
