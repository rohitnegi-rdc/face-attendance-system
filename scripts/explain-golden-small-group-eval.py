"""Generate deterministic visual review reports for golden small-group evals.

This script does not call the AI service and does not run an LLM grader. It
reads frozen evaluation artifacts, recomputes threshold decisions from saved
similarity rows, and writes a human-reviewable HTML report with images.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET_DIR = ROOT / "datasets" / "golden-small-groups-v1"
DEFAULT_OUTPUT_ROOT = ROOT / "test-output" / "evaluations"
DEFAULT_TARGET_THRESHOLD = 0.68
CROP_SIZE = (220, 220)
DASHBOARD_IMAGE_THUMB_SIZE = (900, 620)
DASHBOARD_CROP_THUMB_SIZE = (160, 160)
RESAMPLE_FILTER = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
THUMBNAIL_CACHE: dict[tuple[str, str, str, tuple[int, int]], str] = {}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in fields})


def parse_float(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if text == "" or text.lower() in {"none", "null", "nan"}:
        return None
    return float(text)


def parse_int(value: Any) -> int:
    parsed = parse_float(value)
    if parsed is None:
        return 0
    return int(parsed)


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes"}


def pct(value: Any) -> str:
    parsed = parse_float(value)
    if parsed is None:
        return "n/a"
    return f"{parsed * 100:.1f}%"


def score(value: Any) -> str:
    parsed = parse_float(value)
    if parsed is None:
        return "n/a"
    return f"{parsed:.3f}"


def threshold_value(value: Any) -> float:
    parsed = parse_float(value)
    if parsed is None:
        raise ValueError(f"Invalid threshold: {value!r}")
    return round(parsed, 2)


def threshold_label(value: float) -> str:
    return f"{value:.2f}"


def threshold_slug(value: float) -> str:
    return threshold_label(value).replace(".", "_")


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip())
    return cleaned.strip("-") or "item"


def repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def html_path(from_dir: Path, target: Path) -> str:
    return os.path.relpath(target.resolve(), from_dir.resolve()).replace("\\", "/")


def create_dashboard_thumbnail(
    *,
    source_path: Path | None,
    report_dir: Path,
    group: str,
    max_size: tuple[int, int],
) -> str:
    if source_path is None or not source_path.exists():
        return ""
    resolved = source_path.resolve()
    cache_key = (str(resolved), str(report_dir.resolve()), group, max_size)
    cached = THUMBNAIL_CACHE.get(cache_key)
    if cached:
        return cached
    digest = hashlib.sha1(str(resolved).encode("utf-8")).hexdigest()[:12]
    thumb_dir = report_dir / "thumbnails" / safe_name(group)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    thumb_path = thumb_dir / f"{safe_name(resolved.stem)}-{digest}.jpg"
    if not thumb_path.exists() or thumb_path.stat().st_mtime < resolved.stat().st_mtime:
        with Image.open(resolved) as raw:
            image = ImageOps.exif_transpose(raw).convert("RGB")
            image.thumbnail(max_size, RESAMPLE_FILTER)
            image.save(thumb_path, "JPEG", quality=72, optimize=True, progressive=True)
    relative = html_path(report_dir, thumb_path)
    THUMBNAIL_CACHE[cache_key] = relative
    return relative


def find_latest_run(output_root: Path, dataset_version: str) -> Path:
    candidates: list[Path] = []
    if not output_root.exists():
        raise FileNotFoundError(f"Evaluation output root does not exist: {output_root}")
    for path in output_root.iterdir():
        metrics_path = path / "metrics.json"
        if not path.is_dir() or not metrics_path.exists():
            continue
        try:
            metrics = load_json(metrics_path)
        except Exception:
            continue
        if metrics.get("dataset", {}).get("version") == dataset_version:
            candidates.append(path)
    if not candidates:
        raise FileNotFoundError(f"No eval run found for dataset {dataset_version!r} under {output_root}")
    return max(candidates, key=lambda item: (item.stat().st_mtime, item.name))


def normalize_pair_rows(pair_rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for row in pair_rows:
        normalized.append(
            {
                "case_id": row["case_id"],
                "scenario": row["scenario"],
                "morning_worker_id": row["morning_worker_id"],
                "evening_label_type": row["evening_label_type"],
                "evening_label_id": row["evening_label_id"],
                "same_worker": parse_bool(row["same_worker"]),
                "similarity": parse_float(row["similarity"]) or 0.0,
            }
        )
    return normalized


def worker_sort_key(worker_id: str) -> tuple[int, str]:
    match = re.search(r"(\d+)$", worker_id)
    if not match:
        return (999999, worker_id)
    return (int(match.group(1)), worker_id)


def rows_by_threshold(rows: list[dict[str, str]]) -> dict[float, list[dict[str, str]]]:
    grouped: dict[float, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[threshold_value(row["threshold"])].append(row)
    return dict(grouped)


def row_for_threshold(rows: list[dict[str, str]], threshold: float) -> dict[str, str] | None:
    for row in rows:
        if threshold_value(row["threshold"]) == threshold:
            return row
    return None


def select_thresholds(args: argparse.Namespace, metrics: dict[str, Any], sweep_rows: list[dict[str, str]]) -> list[float]:
    selected: list[float] = []

    requested = args.threshold or [metrics.get("run", {}).get("match_threshold", DEFAULT_TARGET_THRESHOLD)]
    for value in requested:
        threshold = threshold_value(value)
        if threshold not in selected:
            selected.append(threshold)

    recommended = metrics.get("recommended_threshold", {}) or {}
    recommended_value = recommended.get("threshold")
    if recommended_value is not None:
        threshold = threshold_value(recommended_value)
        if threshold not in selected:
            selected.append(threshold)

    if args.compare_threshold:
        for value in args.compare_threshold:
            threshold = threshold_value(value)
            if threshold not in selected:
                selected.append(threshold)

    available = {threshold_value(row["threshold"]) for row in sweep_rows}
    missing = [value for value in selected if value not in available]
    if missing:
        missing_list = ", ".join(threshold_label(value) for value in missing)
        print(f"Warning: thresholds not present in threshold-sweep.csv: {missing_list}", file=sys.stderr)
    return selected


def load_workers(dataset_dir: Path) -> dict[str, dict[str, Any]]:
    workers_path = dataset_dir / "workers.json"
    if not workers_path.exists():
        return {}
    return {row["worker_id"]: row for row in load_json(workers_path)}


def session_photo_path(dataset_dir: Path, case_meta: dict[str, Any], session_name: str) -> Path:
    key = f"{session_name}_photo"
    return dataset_dir / case_meta[key]


def labelled_preview_path(dataset_dir: Path, case_meta: dict[str, Any], gt: dict[str, Any], session_name: str) -> Path:
    ground_truth_path = dataset_dir / case_meta["ground_truth"]
    filename = gt["sessions"][session_name].get("labeled_preview")
    return ground_truth_path.parent / filename


def image_row_lookup(image_rows: list[dict[str, str]]) -> dict[tuple[str, str], dict[str, str]]:
    return {(row["case_id"], row["session"]): row for row in image_rows}


def overlay_path(row: dict[str, str]) -> Path | None:
    raw = row.get("overlay_path")
    if not raw:
        return None
    path = Path(raw)
    if path.is_absolute():
        return path
    return ROOT / raw


def region_indexes(gt: dict[str, Any]) -> dict[str, dict[str, dict[str, dict[str, Any]]]]:
    indexes: dict[str, dict[str, dict[str, dict[str, Any]]]] = {}
    for session_name in ("morning", "evening"):
        session = gt["sessions"][session_name]
        workers = {
            region.get("worker_id") or region.get("id"): region
            for region in session.get("worker_regions", [])
        }
        unknown = {
            region.get("id"): region
            for region in session.get("unknown_regions", [])
        }
        indexes[session_name] = {"worker": workers, "unknown": unknown}
    return indexes


def quality_tags(gt: dict[str, Any], session_name: str) -> list[str]:
    quality = gt["sessions"][session_name].get("quality", {})
    tags: list[str] = []
    variant = quality.get("variant") or quality.get("manual_quality_label")
    if variant and variant != "normal":
        tags.append(str(variant))
    for key in ("low_light", "blur", "occlusion"):
        if parse_bool(quality.get(key)):
            tags.append(key)
    face_size = quality.get("face_size_label")
    if face_size and face_size != "medium":
        tags.append(f"face_size_{face_size}")
    return sorted(set(tags))


def square_crop_box(bbox: list[int], image_size: tuple[int, int], pad_ratio: float = 0.28) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = bbox
    width = max(1, x2 - x1)
    height = max(1, y2 - y1)
    side = int(max(width, height) * (1 + pad_ratio))
    center_x = (x1 + x2) // 2
    center_y = (y1 + y2) // 2
    left = max(0, center_x - side // 2)
    top = max(0, center_y - side // 2)
    right = min(image_size[0], left + side)
    bottom = min(image_size[1], top + side)
    left = max(0, right - side)
    top = max(0, bottom - side)
    return (left, top, right, bottom)


def create_crop(
    dataset_dir: Path,
    case_meta: dict[str, Any],
    session_name: str,
    label_type: str,
    label_id: str,
    region: dict[str, Any],
    report_dir: Path,
) -> str:
    crop_dir = report_dir / "crops" / safe_name(case_meta["case_id"])
    crop_dir.mkdir(parents=True, exist_ok=True)
    crop_path = crop_dir / f"{session_name}_{safe_name(label_type)}_{safe_name(label_id)}.jpg"

    image_path = session_photo_path(dataset_dir, case_meta, session_name)
    with Image.open(image_path) as raw:
        image = ImageOps.exif_transpose(raw).convert("RGB")
        crop_box = square_crop_box([int(value) for value in region["bbox"]], image.size)
        crop = image.crop(crop_box).resize(CROP_SIZE)
        crop.save(crop_path, "JPEG", quality=88, optimize=True)
    return repo_relative(crop_path)


def build_crop_lookup(
    dataset_dir: Path,
    cases: list[dict[str, Any]],
    ground_truth: dict[str, dict[str, Any]],
    report_dir: Path,
) -> dict[tuple[str, str, str, str], str]:
    crops: dict[tuple[str, str, str, str], str] = {}
    for case_meta in cases:
        gt = ground_truth[case_meta["case_id"]]
        indexes = region_indexes(gt)
        for session_name in ("morning", "evening"):
            for label_type, regions in indexes[session_name].items():
                for label_id, region in regions.items():
                    if not label_id:
                        continue
                    crops[(case_meta["case_id"], session_name, label_type, label_id)] = create_crop(
                        dataset_dir,
                        case_meta,
                        session_name,
                        label_type,
                        label_id,
                        region,
                        report_dir,
                    )
    return crops


def best_pair(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not rows:
        return None
    return max(rows, key=lambda row: row["similarity"])


def predict_evening_workers(
    case_pairs: list[dict[str, Any]],
    threshold: float,
) -> tuple[dict[str, dict[str, Any]], dict[tuple[str, str], dict[str, Any]]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in case_pairs:
        grouped[(row["evening_label_type"], row["evening_label_id"])].append(row)

    best_by_evening: dict[tuple[str, str], dict[str, Any]] = {}
    predicted_by_worker: dict[str, dict[str, Any]] = {}
    for label, rows in grouped.items():
        best = best_pair(rows)
        if best is None:
            continue
        best_by_evening[label] = best
        if best["similarity"] < threshold:
            continue
        worker_id = best["morning_worker_id"]
        current = predicted_by_worker.get(worker_id)
        if current is None or best["similarity"] > current["similarity"]:
            predicted_by_worker[worker_id] = {
                "worker_id": worker_id,
                "evening_label_type": label[0],
                "evening_label_id": label[1],
                "similarity": best["similarity"],
                "same_worker": best["same_worker"],
            }
    return predicted_by_worker, best_by_evening


def same_worker_pair(
    case_pairs: list[dict[str, Any]],
    worker_id: str,
) -> dict[str, Any] | None:
    matches = [
        row
        for row in case_pairs
        if row["morning_worker_id"] == worker_id
        and row["evening_label_type"] == "worker"
        and row["evening_label_id"] == worker_id
    ]
    return best_pair(matches)


def source_folder(indexes: dict[str, dict[str, dict[str, dict[str, Any]]]], session_name: str, worker_id: str) -> str:
    region = indexes[session_name]["worker"].get(worker_id)
    if not region:
        return ""
    return str(region.get("source_identity_folder") or "")


def source_image(indexes: dict[str, dict[str, dict[str, dict[str, Any]]]], session_name: str, worker_id: str) -> str:
    region = indexes[session_name]["worker"].get(worker_id)
    if not region:
        return ""
    return str(region.get("source_image") or "")


def classify_decision(
    *,
    session_name: str,
    expected_present: bool,
    predicted_present: bool,
    worker_id: str,
    morning_worker_ids: set[str],
    evening_rows_for_worker: list[dict[str, Any]],
    same_pair: dict[str, Any] | None,
    best_evening_pair: dict[str, Any] | None,
    predicted_evidence: dict[str, Any] | None,
    threshold: float,
    comparison_threshold: float | None,
    same_source: bool,
) -> str:
    if expected_present == predicted_present:
        return "correct_present" if expected_present else "correct_absent"

    if not same_source:
        return "data_identity_source_mismatch"

    if session_name == "morning":
        if expected_present and not predicted_present:
            return "morning_detection_or_assignment_missing"
        return "unexpected_morning_worker_detected"

    if expected_present and not predicted_present:
        if worker_id not in morning_worker_ids:
            return "morning_detection_or_assignment_missing"
        if not evening_rows_for_worker:
            return "evening_detection_or_assignment_missing"
        if best_evening_pair and best_evening_pair["morning_worker_id"] != worker_id and best_evening_pair["similarity"] >= threshold:
            return "wrong_top1_match_above_threshold"
        if same_pair and same_pair["similarity"] < threshold:
            if comparison_threshold is not None and same_pair["similarity"] >= comparison_threshold:
                return "threshold_too_strict"
            return "embedding_similarity_below_threshold"
        return "no_evening_match_above_threshold"

    if predicted_evidence:
        if predicted_evidence["evening_label_type"] == "unknown":
            return "absent_worker_matched_to_unknown_evening_face"
        return "absent_worker_matched_to_other_evening_face"
    return "unexpected_evening_worker_detected"


def build_worker_decisions(
    *,
    cases: list[dict[str, Any]],
    ground_truth: dict[str, dict[str, Any]],
    pair_rows_by_case: dict[str, list[dict[str, Any]]],
    crop_lookup: dict[tuple[str, str, str, str], str],
    thresholds: list[float],
    comparison_threshold: float | None,
    workers: dict[str, dict[str, Any]],
) -> dict[float, list[dict[str, Any]]]:
    decisions_by_threshold: dict[float, list[dict[str, Any]]] = {}
    for threshold in thresholds:
        decisions: list[dict[str, Any]] = []
        for case_meta in cases:
            case_id = case_meta["case_id"]
            gt = ground_truth[case_id]
            indexes = region_indexes(gt)
            case_pairs = pair_rows_by_case.get(case_id, [])
            morning_worker_ids = {row["morning_worker_id"] for row in case_pairs}
            predicted_evening, best_by_evening = predict_evening_workers(case_pairs, threshold)

            worker_ids = sorted(gt.get("expected_attendance", {}).keys(), key=worker_sort_key)
            for worker_id in worker_ids:
                expected = gt["expected_attendance"][worker_id]
                worker_info = workers.get(worker_id, {})
                morning_source = source_folder(indexes, "morning", worker_id)
                evening_source = source_folder(indexes, "evening", worker_id)
                same_source = not evening_source or not morning_source or morning_source == evening_source

                for session_name in ("morning", "evening"):
                    expected_present = expected.get(session_name) == "present"
                    if session_name == "morning":
                        predicted_present = worker_id in morning_worker_ids
                        evening_rows_for_worker: list[dict[str, Any]] = []
                        same_pair_row = None
                        best_evening = None
                        predicted_evidence = None
                        best_candidate = ""
                        best_similarity = None
                    else:
                        predicted_evidence = predicted_evening.get(worker_id)
                        predicted_present = predicted_evidence is not None
                        evening_rows_for_worker = [
                            row
                            for row in case_pairs
                            if row["evening_label_type"] == "worker" and row["evening_label_id"] == worker_id
                        ]
                        same_pair_row = same_worker_pair(case_pairs, worker_id)
                        best_evening = best_by_evening.get(("worker", worker_id))
                        best_candidate = best_evening["morning_worker_id"] if best_evening else ""
                        best_similarity = best_evening["similarity"] if best_evening else None

                    same_similarity = same_pair_row["similarity"] if same_pair_row else None
                    reason = classify_decision(
                        session_name=session_name,
                        expected_present=expected_present,
                        predicted_present=predicted_present,
                        worker_id=worker_id,
                        morning_worker_ids=morning_worker_ids,
                        evening_rows_for_worker=evening_rows_for_worker,
                        same_pair=same_pair_row,
                        best_evening_pair=best_evening,
                        predicted_evidence=predicted_evidence,
                        threshold=threshold,
                        comparison_threshold=comparison_threshold,
                        same_source=same_source,
                    )
                    error_type = ""
                    if expected_present and not predicted_present:
                        error_type = "false_absent"
                    elif not expected_present and predicted_present:
                        error_type = "false_present"

                    threshold_gap = None
                    if session_name == "evening" and expected_present and same_similarity is not None:
                        threshold_gap = round(threshold - same_similarity, 6)

                    decisions.append(
                        {
                            "threshold": threshold_label(threshold),
                            "case_id": case_id,
                            "scenario": case_meta["scenario"],
                            "pump_id": case_meta["pump_id"],
                            "attendance_date": case_meta["attendance_date"],
                            "session": session_name,
                            "worker_id": worker_id,
                            "worker_name": worker_info.get("source_display_name", worker_id),
                            "source_identity_folder": worker_info.get("source_identity_folder", morning_source or evening_source),
                            "expected_status": "present" if expected_present else "absent",
                            "predicted_status": "present" if predicted_present else "absent",
                            "decision_correct": expected_present == predicted_present,
                            "error_type": error_type,
                            "reason": reason,
                            "same_worker_similarity": same_similarity,
                            "best_evening_candidate": best_candidate,
                            "best_evening_similarity": best_similarity,
                            "threshold_gap": threshold_gap,
                            "morning_quality_tags": ",".join(quality_tags(gt, "morning")),
                            "evening_quality_tags": ",".join(quality_tags(gt, "evening")),
                            "morning_crop": crop_lookup.get((case_id, "morning", "worker", worker_id), ""),
                            "evening_crop": crop_lookup.get((case_id, "evening", "worker", worker_id), ""),
                            "morning_source_image": source_image(indexes, "morning", worker_id),
                            "evening_source_image": source_image(indexes, "evening", worker_id),
                        }
                    )
        decisions_by_threshold[threshold] = decisions
    return decisions_by_threshold


def build_pair_errors(
    *,
    pair_rows: list[dict[str, Any]],
    crop_lookup: dict[tuple[str, str, str, str], str],
    thresholds: list[float],
) -> dict[float, list[dict[str, Any]]]:
    errors_by_threshold: dict[float, list[dict[str, Any]]] = {}
    for threshold in thresholds:
        rows: list[dict[str, Any]] = []
        for pair in pair_rows:
            predicted_match = pair["similarity"] >= threshold
            if predicted_match == pair["same_worker"]:
                continue
            pair_error = "pair_false_match" if predicted_match else "pair_false_non_match"
            rows.append(
                {
                    "threshold": threshold_label(threshold),
                    "case_id": pair["case_id"],
                    "scenario": pair["scenario"],
                    "morning_worker_id": pair["morning_worker_id"],
                    "evening_label_type": pair["evening_label_type"],
                    "evening_label_id": pair["evening_label_id"],
                    "same_worker": pair["same_worker"],
                    "similarity": pair["similarity"],
                    "predicted_match": predicted_match,
                    "pair_error": pair_error,
                    "morning_crop": crop_lookup.get((pair["case_id"], "morning", "worker", pair["morning_worker_id"]), ""),
                    "evening_crop": crop_lookup.get(
                        (
                            pair["case_id"],
                            "evening",
                            pair["evening_label_type"],
                            pair["evening_label_id"],
                        ),
                        "",
                    ),
                }
            )
        errors_by_threshold[threshold] = rows
    return errors_by_threshold


def build_case_reviews(
    *,
    cases: list[dict[str, Any]],
    ground_truth: dict[str, dict[str, Any]],
    image_lookup: dict[tuple[str, str], dict[str, str]],
    threshold_case_by_threshold: dict[float, list[dict[str, str]]],
    decisions: list[dict[str, Any]],
    threshold: float,
    report_dir: Path,
    dataset_dir: Path,
) -> list[dict[str, Any]]:
    errors_by_case: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for decision in decisions:
        if not parse_bool(decision["decision_correct"]):
            errors_by_case[decision["case_id"]].append(decision)

    threshold_case_lookup = {
        row["case_id"]: row
        for row in threshold_case_by_threshold.get(threshold, [])
    }
    case_reviews: list[dict[str, Any]] = []
    for case_meta in cases:
        case_errors = sorted(
            errors_by_case.get(case_meta["case_id"], []),
            key=lambda row: (row["session"], worker_sort_key(row["worker_id"])),
        )
        if not case_errors:
            continue
        gt = ground_truth[case_meta["case_id"]]
        images: dict[str, dict[str, str]] = {}
        for session_name in ("morning", "evening"):
            metrics_row = image_lookup.get((case_meta["case_id"], session_name), {})
            input_path = session_photo_path(dataset_dir, case_meta, session_name)
            labelled_path = labelled_preview_path(dataset_dir, case_meta, gt, session_name)
            overlay = overlay_path(metrics_row)
            images[session_name] = {
                "input": html_path(report_dir, input_path),
                "labelled": html_path(report_dir, labelled_path),
                "overlay": html_path(report_dir, overlay) if overlay else "",
                "expected_faces": str(gt["sessions"][session_name].get("expected_face_count", "")),
                "detected_faces": metrics_row.get("detected_faces", ""),
                "matched_faces": metrics_row.get("matched_faces", ""),
                "missed_faces": metrics_row.get("missed_faces", ""),
                "extra_faces": metrics_row.get("extra_faces", ""),
                "mean_box_iou": metrics_row.get("mean_box_iou", ""),
                "quality_tags": ",".join(quality_tags(gt, session_name)),
            }
        case_reviews.append(
            {
                "case_id": case_meta["case_id"],
                "scenario": case_meta["scenario"],
                "pump_id": case_meta["pump_id"],
                "attendance_date": case_meta["attendance_date"],
                "fraud_group_id": case_meta.get("fraud_group_id") or "",
                "fraud_worker_id": case_meta.get("fraud_worker_id") or "",
                "metrics": threshold_case_lookup.get(case_meta["case_id"], {}),
                "images": images,
                "errors": case_errors,
            }
        )
    return case_reviews


def threshold_case_summary(
    threshold_case_rows: list[dict[str, str]],
    selected_threshold: float,
) -> list[dict[str, Any]]:
    rows = [row for row in threshold_case_rows if threshold_value(row["threshold"]) == selected_threshold]
    return sorted(
        rows,
        key=lambda row: (
            parse_float(row.get("attendance_accuracy")) or 0,
            parse_float(row.get("expected_match_recall")) or 0,
            row.get("case_id", ""),
        ),
    )


def decision_csv_fields() -> list[str]:
    return [
        "threshold",
        "case_id",
        "scenario",
        "pump_id",
        "attendance_date",
        "session",
        "worker_id",
        "worker_name",
        "source_identity_folder",
        "expected_status",
        "predicted_status",
        "decision_correct",
        "error_type",
        "reason",
        "same_worker_similarity",
        "best_evening_candidate",
        "best_evening_similarity",
        "threshold_gap",
        "morning_quality_tags",
        "evening_quality_tags",
        "morning_crop",
        "evening_crop",
        "morning_source_image",
        "evening_source_image",
    ]


def pair_error_csv_fields() -> list[str]:
    return [
        "threshold",
        "case_id",
        "scenario",
        "morning_worker_id",
        "evening_label_type",
        "evening_label_id",
        "same_worker",
        "similarity",
        "predicted_match",
        "pair_error",
        "morning_crop",
        "evening_crop",
    ]


def case_summary_fields() -> list[str]:
    return [
        "threshold",
        "case_id",
        "scenario",
        "pump_id",
        "attendance_date",
        "attendance_accuracy",
        "expected_match_recall",
        "top1_accuracy",
        "pair_precision",
        "pair_recall",
        "pair_f1",
        "pair_false_match_rate",
        "pair_false_non_match_rate",
        "false_absent_rate",
        "false_present_rate",
        "unknown_handling_accuracy",
        "attendance_correct",
        "attendance_total",
        "false_absent",
        "false_present",
        "expected_matches",
        "correct_expected_matches",
        "missed_expected_matches",
        "wrong_expected_matches",
        "pair_tp",
        "pair_fp",
        "pair_tn",
        "pair_fn",
    ]


def threshold_comparison_fields() -> list[str]:
    return [
        "threshold",
        "cases",
        "attendance_accuracy",
        "expected_match_recall",
        "top1_accuracy",
        "pair_precision",
        "pair_recall",
        "pair_f1",
        "pair_false_match_rate",
        "pair_false_non_match_rate",
        "false_absent_rate",
        "false_present_rate",
        "unknown_handling_accuracy",
        "fraud_duplicate_recall",
        "cross_pump_false_duplicate_rate",
        "attendance_correct",
        "attendance_total",
        "false_absent",
        "false_present",
        "expected_matches",
        "correct_expected_matches",
        "missed_expected_matches",
        "wrong_expected_matches",
        "pair_tp",
        "pair_fp",
        "pair_tn",
        "pair_fn",
    ]


def summarize_decisions(decisions: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(decisions)
    correct = sum(1 for row in decisions if parse_bool(row["decision_correct"]))
    error_rows = [row for row in decisions if not parse_bool(row["decision_correct"])]
    reason_counts = Counter(row["reason"] for row in error_rows)
    error_type_counts = Counter(row["error_type"] for row in error_rows)
    scenario_counts = Counter(row["scenario"] for row in error_rows)
    return {
        "decision_total": total,
        "decision_correct": correct,
        "decision_errors": len(error_rows),
        "reason_counts": dict(sorted(reason_counts.items())),
        "error_type_counts": dict(sorted(error_type_counts.items())),
        "scenario_error_counts": dict(sorted(scenario_counts.items())),
    }


def compare_worker_decisions(
    target_decisions: list[dict[str, Any]],
    comparison_decisions: list[dict[str, Any]],
) -> dict[tuple[str, str, str], dict[str, Any]]:
    lookup = {
        (row["case_id"], row["session"], row["worker_id"]): row
        for row in comparison_decisions
    }
    return {
        (row["case_id"], row["session"], row["worker_id"]): lookup.get((row["case_id"], row["session"], row["worker_id"]), {})
        for row in target_decisions
    }


def metric_table_html(rows: list[dict[str, Any]], fields: list[tuple[str, str, str]], selected: set[float]) -> str:
    header = "".join(f"<th>{html.escape(label)}</th>" for _, label, _ in fields)
    body: list[str] = []
    for row in rows:
        threshold = parse_float(row.get("threshold"))
        class_name = " class=\"selected\"" if threshold is not None and round(threshold, 2) in selected else ""
        cells: list[str] = []
        for key, _, kind in fields:
            value = row.get(key)
            if kind == "pct":
                text = pct(value)
            elif kind == "score":
                text = score(value)
            else:
                text = "" if value is None else str(value)
            cells.append(f"<td>{html.escape(text)}</td>")
        body.append(f"<tr{class_name}>{''.join(cells)}</tr>")
    return f"<table><thead><tr>{header}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def small_metric(label: str, value: str, note: str = "") -> str:
    return (
        "<div class=\"metric\">"
        f"<span>{html.escape(label)}</span>"
        f"<strong>{html.escape(value)}</strong>"
        f"<em>{html.escape(note)}</em>"
        "</div>"
    )


def image_figure(src: str, label: str, note: str = "") -> str:
    if not src:
        return ""
    return (
        "<figure>"
        f"<img src=\"{html.escape(src)}\" alt=\"{html.escape(label)}\">"
        f"<figcaption><strong>{html.escape(label)}</strong>{html.escape(note)}</figcaption>"
        "</figure>"
    )


def reason_count_html(summary: dict[str, Any]) -> str:
    rows = []
    for reason, count in summary["reason_counts"].items():
        rows.append(f"<tr><td>{html.escape(reason)}</td><td>{count}</td></tr>")
    if not rows:
        rows.append("<tr><td>No errors</td><td>0</td></tr>")
    return "<table><thead><tr><th>Deterministic reason</th><th>Error decisions</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>"


def render_case_reviews(
    case_reviews: list[dict[str, Any]],
    report_dir: Path,
    comparison_lookup: dict[tuple[str, str, str], dict[str, Any]],
    target_threshold: float,
    comparison_threshold: float | None,
) -> str:
    sections: list[str] = []
    for index, case in enumerate(case_reviews):
        metrics = case["metrics"]
        open_attr = " open" if index < 8 else ""
        morning = case["images"]["morning"]
        evening = case["images"]["evening"]
        figures = "".join(
            [
                image_figure(morning["input"], "Morning input", f" - {morning['detected_faces']} detected / {morning['expected_faces']} expected"),
                image_figure(morning["labelled"], "Morning golden labels"),
                image_figure(morning["overlay"], "Morning AI overlay", f" - IoU {score(morning['mean_box_iou'])}"),
                image_figure(evening["input"], "Evening input", f" - {evening['detected_faces']} detected / {evening['expected_faces']} expected"),
                image_figure(evening["labelled"], "Evening golden labels"),
                image_figure(evening["overlay"], "Evening AI overlay", f" - IoU {score(evening['mean_box_iou'])}"),
            ]
        )
        failure_rows: list[str] = []
        for decision in case["errors"]:
            compare = comparison_lookup.get((decision["case_id"], decision["session"], decision["worker_id"]), {})
            compare_text = ""
            if comparison_threshold is not None and compare:
                compare_text = (
                    f"At {threshold_label(comparison_threshold)}: "
                    f"{compare.get('predicted_status', 'n/a')} "
                    f"({compare.get('reason', 'n/a')})"
                )
            morning_crop = decision.get("morning_crop")
            evening_crop = decision.get("evening_crop")
            failure_rows.append(
                f"""
                <tr class="decision-row" data-scenario="{html.escape(decision['scenario'])}" data-reason="{html.escape(decision['reason'])}" data-case="{html.escape(decision['case_id'])}">
                  <td>
                    <div class="crop-pair">
                      {image_figure(html_path(report_dir, ROOT / morning_crop) if morning_crop else "", "Morning crop")}
                      {image_figure(html_path(report_dir, ROOT / evening_crop) if evening_crop else "", "Evening crop")}
                    </div>
                  </td>
                  <td>
                    <strong>{html.escape(decision['worker_id'])}</strong><br>
                    {html.escape(str(decision.get('worker_name') or ''))}<br>
                    <span class="muted">{html.escape(str(decision.get('source_identity_folder') or ''))}</span>
                  </td>
                  <td>{html.escape(decision['session'])}</td>
                  <td>{html.escape(decision['expected_status'])}</td>
                  <td>{html.escape(decision['predicted_status'])}</td>
                  <td>{score(decision.get('same_worker_similarity'))}</td>
                  <td>{html.escape(str(decision.get('best_evening_candidate') or ''))}<br><span class="muted">{score(decision.get('best_evening_similarity'))}</span></td>
                  <td><code>{html.escape(decision['reason'])}</code><br><span class="muted">{html.escape(compare_text)}</span></td>
                </tr>
                """
            )
        fraud_text = ""
        if case.get("fraud_group_id"):
            fraud_text = f" Fraud group: {case['fraud_group_id']} / {case['fraud_worker_id']}."
        sections.append(
            f"""
            <details class="case-block" data-case="{html.escape(case['case_id'])}" data-scenario="{html.escape(case['scenario'])}"{open_attr}>
              <summary>
                <span><strong>{html.escape(case['case_id'])}</strong> - {html.escape(case['scenario'])}</span>
                <span>{len(case['errors'])} error decisions</span>
              </summary>
              <div class="case-meta">
                Pump {html.escape(case['pump_id'])} - {html.escape(case['attendance_date'])}.{html.escape(fraud_text)}
                Attendance {pct(metrics.get('attendance_accuracy'))} ({metrics.get('attendance_correct', '')}/{metrics.get('attendance_total', '')}),
                false absent {metrics.get('false_absent', '')}, false present {metrics.get('false_present', '')},
                expected match recall {pct(metrics.get('expected_match_recall'))}.
              </div>
              <div class="image-grid">{figures}</div>
              <table class="decision-table">
                <thead>
                  <tr>
                    <th>Visual evidence</th>
                    <th>Worker</th>
                    <th>Session</th>
                    <th>Expected</th>
                    <th>Predicted</th>
                    <th>Same-worker score</th>
                    <th>Best candidate</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>{''.join(failure_rows)}</tbody>
              </table>
            </details>
            """
        )
    if not sections:
        return "<p>No worker-level attendance errors were found at this threshold.</p>"
    return "".join(sections)


def render_fraud_table(fraud_groups: list[dict[str, Any]], thresholds: list[float]) -> str:
    rows: list[str] = []
    for group in fraud_groups:
        best = parse_float(group.get("best_cross_pump_similarity"))
        for threshold in thresholds:
            detected = best is not None and best >= threshold
            rows.append(
                "<tr>"
                f"<td>{html.escape(str(group.get('fraud_group_id', '')))}</td>"
                f"<td>{html.escape(str(group.get('worker_id', '')))}</td>"
                f"<td>{html.escape(str(group.get('cases', '')))}</td>"
                f"<td>{threshold_label(threshold)}</td>"
                f"<td>{score(best)}</td>"
                f"<td>{'detected' if detected else 'missed'}</td>"
                "</tr>"
            )
    if not rows:
        rows.append("<tr><td colspan=\"6\">No known fraud duplicate groups in this dataset.</td></tr>")
    return (
        "<table><thead><tr><th>Fraud group</th><th>Worker</th><th>Cases</th><th>Threshold</th>"
        "<th>Best cross-pump score</th><th>Decision</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def render_pair_error_preview(pair_errors: list[dict[str, Any]], report_dir: Path, limit: int = 60) -> str:
    rows: list[str] = []
    for pair in pair_errors[:limit]:
        morning_crop = pair.get("morning_crop")
        evening_crop = pair.get("evening_crop")
        rows.append(
            f"""
            <tr>
              <td>
                <div class="crop-pair">
                  {image_figure(html_path(report_dir, ROOT / morning_crop) if morning_crop else "", "Morning")}
                  {image_figure(html_path(report_dir, ROOT / evening_crop) if evening_crop else "", "Evening")}
                </div>
              </td>
              <td>{html.escape(pair['case_id'])}<br><span class="muted">{html.escape(pair['scenario'])}</span></td>
              <td>{html.escape(pair['morning_worker_id'])}</td>
              <td>{html.escape(pair['evening_label_type'])}:{html.escape(pair['evening_label_id'])}</td>
              <td>{score(pair['similarity'])}</td>
              <td><code>{html.escape(pair['pair_error'])}</code></td>
            </tr>
            """
        )
    if not rows:
        return "<p>No pair-level errors at this threshold.</p>"
    extra = ""
    if len(pair_errors) > limit:
        extra = f"<p class=\"muted\">Showing first {limit} of {len(pair_errors)} pair errors. Use the pair-errors CSV for the complete list.</p>"
    return (
        extra
        + "<table><thead><tr><th>Visual pair</th><th>Case</th><th>Morning worker</th><th>Evening face</th><th>Similarity</th><th>Error</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def compact_metric_row(row: dict[str, Any]) -> dict[str, Any]:
    keys = threshold_comparison_fields()
    return {key: row.get(key) for key in keys if key in row}


def compact_scenario_row(row: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "threshold",
        "scenario",
        "cases",
        "attendance_accuracy",
        "expected_match_recall",
        "pair_precision",
        "pair_recall",
        "pair_false_match_rate",
        "pair_false_non_match_rate",
        "false_absent_rate",
        "false_present_rate",
        "attendance_correct",
        "attendance_total",
        "false_absent",
        "false_present",
    ]
    return {key: row.get(key) for key in keys if key in row}


def build_case_assets(
    *,
    cases: list[dict[str, Any]],
    ground_truth: dict[str, dict[str, Any]],
    image_lookup: dict[tuple[str, str], dict[str, str]],
    report_dir: Path,
    dataset_dir: Path,
) -> dict[str, dict[str, Any]]:
    assets: dict[str, dict[str, Any]] = {}
    for case_meta in cases:
        case_id = case_meta["case_id"]
        gt = ground_truth[case_id]
        sessions: dict[str, dict[str, Any]] = {}
        for session_name in ("morning", "evening"):
            metrics_row = image_lookup.get((case_id, session_name), {})
            overlay = overlay_path(metrics_row)
            input_path = session_photo_path(dataset_dir, case_meta, session_name)
            labelled_path = labelled_preview_path(dataset_dir, case_meta, gt, session_name)
            sessions[session_name] = {
                "input": create_dashboard_thumbnail(
                    source_path=input_path,
                    report_dir=report_dir,
                    group="case-images",
                    max_size=DASHBOARD_IMAGE_THUMB_SIZE,
                ),
                "input_full": html_path(report_dir, input_path),
                "labelled": create_dashboard_thumbnail(
                    source_path=labelled_path,
                    report_dir=report_dir,
                    group="case-images",
                    max_size=DASHBOARD_IMAGE_THUMB_SIZE,
                ),
                "labelled_full": html_path(report_dir, labelled_path),
                "overlay": create_dashboard_thumbnail(
                    source_path=overlay,
                    report_dir=report_dir,
                    group="case-images",
                    max_size=DASHBOARD_IMAGE_THUMB_SIZE,
                )
                if overlay
                else "",
                "overlay_full": html_path(report_dir, overlay) if overlay else "",
                "expected_faces": gt["sessions"][session_name].get("expected_face_count"),
                "detected_faces": metrics_row.get("detected_faces", ""),
                "matched_faces": metrics_row.get("matched_faces", ""),
                "missed_faces": metrics_row.get("missed_faces", ""),
                "extra_faces": metrics_row.get("extra_faces", ""),
                "mean_box_iou": metrics_row.get("mean_box_iou", ""),
                "quality_tags": quality_tags(gt, session_name),
            }
        assets[case_id] = {
            "case_id": case_id,
            "scenario": case_meta["scenario"],
            "pump_id": case_meta["pump_id"],
            "attendance_date": case_meta["attendance_date"],
            "fraud_group_id": case_meta.get("fraud_group_id") or "",
            "fraud_worker_id": case_meta.get("fraud_worker_id") or "",
            "sessions": sessions,
        }
    return assets


def compact_decision(
    decision: dict[str, Any],
    report_dir: Path,
    comparison_lookup: dict[tuple[str, str, str], dict[str, Any]],
) -> dict[str, Any]:
    key = (decision["case_id"], decision["session"], decision["worker_id"])
    comparison = comparison_lookup.get(key, {})
    morning_crop = decision.get("morning_crop")
    evening_crop = decision.get("evening_crop")
    morning_crop_path = ROOT / morning_crop if morning_crop else None
    evening_crop_path = ROOT / evening_crop if evening_crop else None
    return {
        "case_id": decision["case_id"],
        "scenario": decision["scenario"],
        "session": decision["session"],
        "worker_id": decision["worker_id"],
        "worker_name": decision.get("worker_name", ""),
        "source_identity_folder": decision.get("source_identity_folder", ""),
        "expected_status": decision["expected_status"],
        "predicted_status": decision["predicted_status"],
        "error_type": decision["error_type"],
        "reason": decision["reason"],
        "same_worker_similarity": decision.get("same_worker_similarity"),
        "best_evening_candidate": decision.get("best_evening_candidate", ""),
        "best_evening_similarity": decision.get("best_evening_similarity"),
        "threshold_gap": decision.get("threshold_gap"),
        "morning_quality_tags": decision.get("morning_quality_tags", ""),
        "evening_quality_tags": decision.get("evening_quality_tags", ""),
        "morning_crop": create_dashboard_thumbnail(
            source_path=morning_crop_path,
            report_dir=report_dir,
            group="crops",
            max_size=DASHBOARD_CROP_THUMB_SIZE,
        ),
        "morning_crop_full": html_path(report_dir, morning_crop_path) if morning_crop_path else "",
        "evening_crop": create_dashboard_thumbnail(
            source_path=evening_crop_path,
            report_dir=report_dir,
            group="crops",
            max_size=DASHBOARD_CROP_THUMB_SIZE,
        ),
        "evening_crop_full": html_path(report_dir, evening_crop_path) if evening_crop_path else "",
        "morning_source_image": decision.get("morning_source_image", ""),
        "evening_source_image": decision.get("evening_source_image", ""),
        "comparison_predicted_status": comparison.get("predicted_status", ""),
        "comparison_reason": comparison.get("reason", ""),
    }


def compact_pair_error(pair: dict[str, Any], report_dir: Path) -> dict[str, Any]:
    morning_crop = pair.get("morning_crop")
    evening_crop = pair.get("evening_crop")
    morning_crop_path = ROOT / morning_crop if morning_crop else None
    evening_crop_path = ROOT / evening_crop if evening_crop else None
    return {
        "case_id": pair["case_id"],
        "scenario": pair["scenario"],
        "morning_worker_id": pair["morning_worker_id"],
        "evening_label_type": pair["evening_label_type"],
        "evening_label_id": pair["evening_label_id"],
        "same_worker": pair["same_worker"],
        "similarity": pair["similarity"],
        "predicted_match": pair["predicted_match"],
        "pair_error": pair["pair_error"],
        "morning_crop": create_dashboard_thumbnail(
            source_path=morning_crop_path,
            report_dir=report_dir,
            group="crops",
            max_size=DASHBOARD_CROP_THUMB_SIZE,
        ),
        "morning_crop_full": html_path(report_dir, morning_crop_path) if morning_crop_path else "",
        "evening_crop": create_dashboard_thumbnail(
            source_path=evening_crop_path,
            report_dir=report_dir,
            group="crops",
            max_size=DASHBOARD_CROP_THUMB_SIZE,
        ),
        "evening_crop_full": html_path(report_dir, evening_crop_path) if evening_crop_path else "",
    }


def build_fraud_evidence(
    *,
    fraud_groups: list[dict[str, Any]],
    crop_lookup: dict[tuple[str, str, str, str], str],
    case_assets: dict[str, dict[str, Any]],
    report_dir: Path,
) -> dict[str, dict[str, Any]]:
    evidence: dict[str, dict[str, Any]] = {}
    for group in fraud_groups:
        group_id = str(group.get("fraud_group_id") or "")
        worker_id = str(group.get("worker_id") or "")
        if not group_id or not worker_id:
            continue

        items: list[dict[str, Any]] = []
        case_ids = [
            case_id.strip()
            for case_id in str(group.get("cases") or "").split(",")
            if case_id.strip()
        ]
        for case_id in case_ids:
            case_asset = case_assets.get(case_id, {})
            item: dict[str, Any] = {
                "case_id": case_id,
                "scenario": case_asset.get("scenario", ""),
                "pump_id": case_asset.get("pump_id", ""),
                "attendance_date": case_asset.get("attendance_date", ""),
            }
            for session_name in ("morning", "evening"):
                crop = crop_lookup.get((case_id, session_name, "worker", worker_id), "")
                crop_path = ROOT / crop if crop else None
                item[f"{session_name}_crop"] = create_dashboard_thumbnail(
                    source_path=crop_path,
                    report_dir=report_dir,
                    group="crops",
                    max_size=DASHBOARD_CROP_THUMB_SIZE,
                )
                item[f"{session_name}_crop_full"] = html_path(report_dir, crop_path) if crop_path else ""
            items.append(item)

        evidence[group_id] = {
            "fraud_group_id": group_id,
            "worker_id": worker_id,
            "best_cross_pump_similarity": group.get("best_cross_pump_similarity"),
            "cases": case_ids,
            "items": items,
        }
    return evidence


def json_for_script(value: Any) -> str:
    return (
        json.dumps(value, separators=(",", ":"), ensure_ascii=True)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


def build_dashboard_data(
    *,
    report_dir: Path,
    run_dir: Path,
    metrics: dict[str, Any],
    sweep_rows: list[dict[str, str]],
    threshold_scenario_rows: list[dict[str, str]],
    all_thresholds: list[float],
    target_threshold: float,
    comparison_threshold: float | None,
    decisions_by_threshold: dict[float, list[dict[str, Any]]],
    pair_errors_by_threshold: dict[float, list[dict[str, Any]]],
    case_assets: dict[str, dict[str, Any]],
    fraud_groups: list[dict[str, Any]],
    fraud_evidence: dict[str, dict[str, Any]],
    generated_files: dict[str, str],
) -> dict[str, Any]:
    comparison_decisions = decisions_by_threshold.get(comparison_threshold, []) if comparison_threshold is not None else []
    comparison_by_threshold = {}
    for threshold in all_thresholds:
        comparison_by_threshold[threshold] = compare_worker_decisions(
            decisions_by_threshold[threshold],
            comparison_decisions,
        ) if comparison_decisions else {}

    errors_by_threshold: dict[str, list[dict[str, Any]]] = {}
    summaries_by_threshold: dict[str, dict[str, Any]] = {}
    pair_preview_by_threshold: dict[str, list[dict[str, Any]]] = {}
    pair_error_counts_by_threshold: dict[str, int] = {}
    for threshold in all_thresholds:
        key = threshold_label(threshold)
        decisions = decisions_by_threshold[threshold]
        summaries_by_threshold[key] = summarize_decisions(decisions)
        errors = [row for row in decisions if not parse_bool(row["decision_correct"])]
        errors.sort(key=lambda row: (row["case_id"], row["session"], worker_sort_key(row["worker_id"])))
        errors_by_threshold[key] = [
            compact_decision(row, report_dir, comparison_by_threshold[threshold])
            for row in errors
        ]
        pair_errors = pair_errors_by_threshold[threshold]
        pair_errors.sort(key=lambda row: (row["case_id"], row["pair_error"], -float(row["similarity"])))
        pair_error_counts_by_threshold[key] = len(pair_errors)
        pair_preview_by_threshold[key] = [
            compact_pair_error(row, report_dir)
            for row in pair_errors[:80]
        ]

    scenario_rows_by_threshold: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in threshold_scenario_rows:
        scenario_rows_by_threshold[threshold_label(threshold_value(row["threshold"]))].append(compact_scenario_row(row))

    return {
        "schema_version": 2,
        "render_mode": "dynamic-threshold-dashboard",
        "determinism_contract": {
            "ai_service_called": False,
            "llm_grader_used": False,
            "random_sampling_used": False,
            "source_artifacts": [
                "metrics.json",
                "match-pairs.csv",
                "image-metrics.csv",
                "threshold-sweep.csv",
                "threshold-case-metrics.csv",
                "threshold-scenario-metrics.csv",
                "golden ground_truth.json files",
            ],
        },
        "run": {
            "id": run_dir.name,
            **metrics.get("run", {}),
        },
        "dataset": metrics.get("dataset", {}),
        "target_threshold": threshold_label(target_threshold),
        "comparison_threshold": threshold_label(comparison_threshold) if comparison_threshold is not None else None,
        "thresholds": [threshold_label(value) for value in all_thresholds],
        "sweep_rows": [compact_metric_row(row) for row in sweep_rows],
        "scenario_rows_by_threshold": dict(sorted(scenario_rows_by_threshold.items())),
        "summaries_by_threshold": summaries_by_threshold,
        "errors_by_threshold": errors_by_threshold,
        "pair_error_counts_by_threshold": pair_error_counts_by_threshold,
        "pair_preview_by_threshold": pair_preview_by_threshold,
        "case_assets": case_assets,
        "fraud_groups": fraud_groups,
        "fraud_evidence": fraud_evidence,
        "generated_files": generated_files,
    }


def write_dashboard_js_assets(report_dir: Path, dashboard_data: dict[str, Any]) -> None:
    chunk_dir = report_dir / "threshold-data"
    chunk_dir.mkdir(parents=True, exist_ok=True)

    chunk_files: dict[str, str] = {}
    errors_by_threshold = dashboard_data.get("errors_by_threshold", {})
    pair_preview_by_threshold = dashboard_data.get("pair_preview_by_threshold", {})
    pair_error_counts_by_threshold = dashboard_data.get("pair_error_counts_by_threshold", {})

    for threshold in dashboard_data.get("thresholds", []):
        filename = f"threshold-{threshold.replace('.', '_')}.js"
        chunk_path = chunk_dir / filename
        chunk_files[threshold] = html_path(report_dir, chunk_path)
        chunk = {
            "threshold": threshold,
            "errors": errors_by_threshold.get(threshold, []),
            "pair_error_count": pair_error_counts_by_threshold.get(threshold, 0),
            "pair_preview": pair_preview_by_threshold.get(threshold, []),
        }
        chunk_path.write_text(
            "window.__thresholdChunks=window.__thresholdChunks||{};"
            f"window.__thresholdChunks[{json.dumps(threshold)}]={json_for_script(chunk)};\n",
            encoding="utf-8",
        )

    summary = {
        key: value
        for key, value in dashboard_data.items()
        if key not in {"errors_by_threshold", "pair_preview_by_threshold", "pair_error_counts_by_threshold"}
    }
    summary["threshold_chunk_files"] = chunk_files
    (report_dir / "dashboard-summary.js").write_text(
        f"window.__dashboardSummary={json_for_script(summary)};\n",
        encoding="utf-8",
    )


def write_html_report(
    *,
    report_dir: Path,
    run_dir: Path,
    dataset_dir: Path,
    metrics: dict[str, Any],
    sweep_rows: list[dict[str, str]],
    threshold_scenario_rows: list[dict[str, str]],
    selected_thresholds: list[float],
    target_threshold: float,
    comparison_threshold: float | None,
    target_summary: dict[str, Any],
    target_decisions: list[dict[str, Any]],
    target_pair_errors: list[dict[str, Any]],
    case_reviews: list[dict[str, Any]],
    comparison_lookup: dict[tuple[str, str, str], dict[str, Any]],
    fraud_groups: list[dict[str, Any]],
    generated_files: dict[str, str],
) -> None:
    report_dir.mkdir(parents=True, exist_ok=True)
    target_sweep = row_for_threshold(sweep_rows, target_threshold) or {}
    comparison_sweep = row_for_threshold(sweep_rows, comparison_threshold) if comparison_threshold is not None else None
    wrong = parse_int(target_sweep.get("attendance_total")) - parse_int(target_sweep.get("attendance_correct"))

    selected_set = set(selected_thresholds)
    threshold_fields = [
        ("threshold", "Threshold", "text"),
        ("attendance_accuracy", "Attendance", "pct"),
        ("expected_match_recall", "Match recall", "pct"),
        ("top1_accuracy", "Top-1", "pct"),
        ("pair_precision", "Pair precision", "pct"),
        ("pair_recall", "Pair recall", "pct"),
        ("pair_f1", "Pair F1", "score"),
        ("pair_false_match_rate", "False match", "pct"),
        ("pair_false_non_match_rate", "False non-match", "pct"),
        ("false_absent_rate", "False absent", "pct"),
        ("false_present_rate", "False present", "pct"),
        ("fraud_duplicate_recall", "Fraud recall", "pct"),
        ("attendance_correct", "Attendance correct", "text"),
        ("attendance_total", "Total", "text"),
    ]
    scenario_rows = [
        row
        for row in threshold_scenario_rows
        if threshold_value(row["threshold"]) == target_threshold
    ]
    scenario_fields = [
        ("scenario", "Scenario", "text"),
        ("cases", "Cases", "text"),
        ("attendance_accuracy", "Attendance", "pct"),
        ("expected_match_recall", "Match recall", "pct"),
        ("pair_precision", "Pair precision", "pct"),
        ("pair_recall", "Pair recall", "pct"),
        ("false_absent_rate", "False absent", "pct"),
        ("false_present_rate", "False present", "pct"),
    ]
    cards = "".join(
        [
            small_metric("Target threshold", threshold_label(target_threshold), "fixed explanation threshold"),
            small_metric("Attendance", pct(target_sweep.get("attendance_accuracy")), f"{target_sweep.get('attendance_correct', 'n/a')}/{target_sweep.get('attendance_total', 'n/a')} correct"),
            small_metric("Wrong decisions", str(wrong), f"{target_sweep.get('false_absent', '0')} false absent, {target_sweep.get('false_present', '0')} false present"),
            small_metric("Expected match recall", pct(target_sweep.get("expected_match_recall")), f"{target_sweep.get('correct_expected_matches', '0')}/{target_sweep.get('expected_matches', '0')} matches"),
            small_metric("Pair false match", pct(target_sweep.get("pair_false_match_rate")), f"{target_sweep.get('pair_fp', '0')} FP"),
            small_metric("Pair false non-match", pct(target_sweep.get("pair_false_non_match_rate")), f"{target_sweep.get('pair_fn', '0')} FN"),
        ]
    )
    comparison_note = ""
    if comparison_sweep is not None and comparison_threshold is not None:
        comparison_note = (
            f"<p>Comparison threshold <code>{threshold_label(comparison_threshold)}</code> gives "
            f"{pct(comparison_sweep.get('attendance_accuracy'))} attendance and "
            f"{pct(comparison_sweep.get('expected_match_recall'))} expected match recall. "
            "Cards below show whether the same worker decision would pass there.</p>"
        )

    html_doc = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deterministic Golden Evaluation Review</title>
  <style>
    :root {{
      --ink: #09272b;
      --muted: #385457;
      --line: #BBBFBF;
      --soft: #f3f6f6;
      --accent: #05AD98;
      --white: #FFFFFF;
      --gray: #878787;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: Arial, sans-serif;
      color: var(--ink);
      background: var(--soft);
      line-height: 1.45;
    }}
    header, main {{
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
    }}
    header {{
      background: var(--white);
      border-bottom: 1px solid var(--line);
    }}
    h1, h2, h3, p {{ margin-top: 0; }}
    h1 {{ font-size: 32px; margin-bottom: 8px; }}
    h2 {{ margin: 30px 0 12px; font-size: 24px; }}
    h3 {{ margin: 16px 0 8px; }}
    code {{
      background: #e8eeee;
      padding: 2px 5px;
      border-radius: 4px;
    }}
    a {{ color: #007f70; }}
    table {{
      width: 100%;
      border-collapse: collapse;
      background: var(--white);
      margin: 12px 0 22px;
      border: 1px solid var(--line);
    }}
    th, td {{
      border: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }}
    th {{ background: #e7eded; }}
    tr.selected {{ outline: 3px solid rgba(5, 173, 152, 0.38); }}
    .metrics {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }}
    .metric {{
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 104px;
    }}
    .metric span, .metric em {{
      display: block;
      color: var(--muted);
      font-style: normal;
      font-size: 13px;
    }}
    .metric strong {{
      display: block;
      font-size: 28px;
      margin: 5px 0;
    }}
    .callout {{
      background: var(--white);
      border: 1px solid var(--line);
      border-left: 6px solid var(--accent);
      padding: 16px;
      border-radius: 8px;
      margin: 16px 0 24px;
    }}
    .files {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px;
    }}
    .file-pill {{
      display: block;
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      text-decoration: none;
    }}
    .toolbar {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: end;
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      margin: 12px 0 18px;
      position: sticky;
      top: 0;
      z-index: 10;
    }}
    label {{
      display: grid;
      gap: 4px;
      font-size: 13px;
      color: var(--muted);
    }}
    select, input {{
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
      background: var(--white);
      color: var(--ink);
    }}
    details.case-block {{
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin: 16px 0;
      overflow: hidden;
    }}
    details.case-block[hidden] {{ display: none; }}
    summary {{
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 15px 18px;
      border-bottom: 1px solid var(--line);
      background: #fbfdfd;
    }}
    .case-meta {{
      padding: 14px 18px 0;
      color: var(--muted);
    }}
    .image-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
      padding: 16px 18px;
    }}
    figure {{
      margin: 0;
      background: #f8fbfb;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }}
    figure img {{
      display: block;
      width: 100%;
      height: auto;
    }}
    figcaption {{
      padding: 8px 10px;
      color: var(--muted);
      font-size: 13px;
    }}
    .decision-table {{
      margin: 0 18px 18px;
      width: calc(100% - 36px);
    }}
    .crop-pair {{
      display: grid;
      grid-template-columns: repeat(2, minmax(92px, 1fr));
      gap: 8px;
      min-width: 210px;
    }}
    .crop-pair figure {{
      border-radius: 6px;
    }}
    .crop-pair figcaption {{
      padding: 5px;
      font-size: 12px;
    }}
    .muted {{ color: var(--muted); font-size: 13px; }}
    .hidden-row {{ display: none; }}
    @media (max-width: 760px) {{
      header, main {{ padding: 16px; }}
      h1 {{ font-size: 26px; }}
      summary {{ display: block; }}
      table {{ display: block; overflow-x: auto; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>Deterministic Golden Evaluation Review</h1>
    <p>Run <code>{html.escape(run_dir.name)}</code> over dataset <code>{html.escape(str(metrics.get('dataset', {}).get('version', 'unknown')))}</code>.</p>
    <div class="callout">
      <h2>Determinism Contract</h2>
      <p>This report does not rerun the AI service, does not resample data, and does not use an LLM judge. It rebuilds every decision from saved artifacts: <code>match-pairs.csv</code>, <code>threshold-sweep.csv</code>, <code>threshold-case-metrics.csv</code>, <code>image-metrics.csv</code>, and fixed golden labels.</p>
    </div>
    <div class="metrics">{cards}</div>
  </header>
  <main>
    <section class="callout">
      <h2>Why {pct(target_sweep.get('attendance_accuracy'))} Attendance?</h2>
      <p>Attendance accuracy is <code>attendance_correct / attendance_total</code>. At threshold <code>{threshold_label(target_threshold)}</code>, this run has <code>{target_sweep.get('attendance_correct', 'n/a')} / {target_sweep.get('attendance_total', 'n/a')}</code> correct decisions. That means <code>{wrong}</code> wrong worker-session decisions, made from <code>{target_sweep.get('false_absent', '0')}</code> false absences and <code>{target_sweep.get('false_present', '0')}</code> false presents.</p>
      {comparison_note}
    </section>

    <h2>Generated Files</h2>
    <div class="files">
      {''.join(f'<a class="file-pill" href="{html.escape(path)}">{html.escape(name)}</a>' for name, path in generated_files.items())}
    </div>

    <h2>Threshold Comparison</h2>
    {metric_table_html(sweep_rows, threshold_fields, selected_set)}

    <h2>Scenario Breakdown At {threshold_label(target_threshold)}</h2>
    {metric_table_html(scenario_rows, scenario_fields, set())}

    <h2>Root Cause Counts At {threshold_label(target_threshold)}</h2>
    {reason_count_html(target_summary)}

    <h2>Known Fraud Duplicate Checks</h2>
    {render_fraud_table(fraud_groups, selected_thresholds)}

    <h2>Worker-Level Visual Error Review</h2>
    <div class="toolbar">
      <label>Scenario
        <select id="scenarioFilter">
          <option value="">All scenarios</option>
          {scenario_filter_options(case_reviews)}
        </select>
      </label>
      <label>Reason
        <select id="reasonFilter">
          <option value="">All reasons</option>
          {reason_filter_options(target_decisions)}
        </select>
      </label>
      <label>Case search
        <input id="caseFilter" type="search" placeholder="SG-001 or worker_010">
      </label>
    </div>
    {render_case_reviews(case_reviews, report_dir, comparison_lookup, target_threshold, comparison_threshold)}

    <h2>Pair-Level Error Preview At {threshold_label(target_threshold)}</h2>
    <p class="muted">Pair errors explain similarity threshold behavior directly. A pair false non-match means the two crops are the same worker, but their similarity was below the selected threshold.</p>
    {render_pair_error_preview(target_pair_errors, report_dir)}

    <h2>Data Audit Rules</h2>
    <div class="callout">
      <p>Use the visible crops and labelled previews to check data quality. If the morning and evening crops for the same worker do not visually look like the same identity, treat it as a golden-data issue. If they do look like the same identity but the score is below threshold, it is a threshold/model issue. If a labelled face is missing from the AI overlay, it is a detection or bbox-assignment issue.</p>
    </div>
  </main>
  <script>
    const scenarioFilter = document.getElementById('scenarioFilter');
    const reasonFilter = document.getElementById('reasonFilter');
    const caseFilter = document.getElementById('caseFilter');
    function applyFilters() {{
      const scenario = scenarioFilter.value;
      const reason = reasonFilter.value;
      const text = caseFilter.value.trim().toLowerCase();
      for (const block of document.querySelectorAll('.case-block')) {{
        let visibleRows = 0;
        const blockCase = block.dataset.case.toLowerCase();
        const blockScenario = block.dataset.scenario;
        for (const row of block.querySelectorAll('.decision-row')) {{
          const rowText = row.innerText.toLowerCase();
          const matchesScenario = !scenario || blockScenario === scenario;
          const matchesReason = !reason || row.dataset.reason === reason;
          const matchesText = !text || blockCase.includes(text) || rowText.includes(text);
          const visible = matchesScenario && matchesReason && matchesText;
          row.classList.toggle('hidden-row', !visible);
          if (visible) visibleRows += 1;
        }}
        block.hidden = visibleRows === 0;
      }}
    }}
    scenarioFilter.addEventListener('change', applyFilters);
    reasonFilter.addEventListener('change', applyFilters);
    caseFilter.addEventListener('input', applyFilters);
  </script>
</body>
</html>
"""
    (report_dir / "index.html").write_text(html_doc, encoding="utf-8")


def write_dynamic_html_report(report_dir: Path, dashboard_data: dict[str, Any]) -> None:
    write_dashboard_js_assets(report_dir, dashboard_data)
    html_doc = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dynamic Golden Evaluation Review</title>
  <style>
    :root {
      --ink: #09272b;
      --muted: #385457;
      --line: #BBBFBF;
      --soft: #f3f6f6;
      --accent: #05AD98;
      --white: #FFFFFF;
      --gray: #878787;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      color: var(--ink);
      background: var(--soft);
      line-height: 1.45;
    }
    header, main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
    }
    header {
      background: var(--white);
      border-bottom: 1px solid var(--line);
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: 32px; margin-bottom: 8px; }
    h2 { margin: 30px 0 12px; font-size: 24px; }
    code {
      background: #e8eeee;
      padding: 2px 5px;
      border-radius: 4px;
    }
    a { color: #007f70; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--white);
      margin: 12px 0 22px;
      border: 1px solid var(--line);
    }
    th, td {
      border: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    th { background: #e7eded; }
    tr.selected { outline: 3px solid rgba(5, 173, 152, 0.38); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .metric {
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 104px;
    }
    .metric span, .metric em {
      display: block;
      color: var(--muted);
      font-style: normal;
      font-size: 13px;
    }
    .metric strong {
      display: block;
      font-size: 28px;
      margin: 5px 0;
    }
    .callout {
      background: var(--white);
      border: 1px solid var(--line);
      border-left: 6px solid var(--accent);
      padding: 16px;
      border-radius: 8px;
      margin: 16px 0 24px;
    }
    .files {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px;
    }
    .file-pill {
      display: block;
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      text-decoration: none;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: end;
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      margin: 12px 0 18px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    label {
      display: grid;
      gap: 4px;
      font-size: 13px;
      color: var(--muted);
    }
    select, input, button {
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
      background: var(--white);
      color: var(--ink);
    }
    button { cursor: pointer; }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #062827;
      font-weight: 700;
    }
    button.link-action {
      color: var(--accent-strong);
      text-decoration: underline;
      border: 0;
      background: transparent;
      padding: 0;
      min-height: auto;
      font-weight: 700;
    }
    .case-list {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
    }
    .case-row {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 12px;
      align-items: center;
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .case-row strong {
      display: block;
      margin-bottom: 3px;
    }
    .evidence-panel {
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin: 16px 0;
      overflow: hidden;
    }
    .evidence-heading {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 15px 18px;
      border-bottom: 1px solid var(--line);
      background: #fbfdfd;
    }
    details.case-block {
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin: 16px 0;
      overflow: hidden;
    }
    summary {
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 15px 18px;
      border-bottom: 1px solid var(--line);
      background: #fbfdfd;
    }
    .case-meta {
      padding: 14px 18px 0;
      color: var(--muted);
    }
    .image-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
      padding: 16px 18px;
    }
    figure {
      margin: 0;
      background: #f8fbfb;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    figure a {
      display: block;
      color: inherit;
    }
    figure img {
      display: block;
      width: 100%;
      height: min(42vh, 420px);
      object-fit: contain;
      background: #eef3f3;
    }
    figcaption {
      padding: 8px 10px;
      color: var(--muted);
      font-size: 13px;
    }
    .decision-table {
      margin: 0 18px 18px;
      width: calc(100% - 36px);
    }
    .crop-pair {
      display: grid;
      grid-template-columns: repeat(2, minmax(92px, 1fr));
      gap: 8px;
      min-width: 210px;
    }
    .pair-evidence {
      margin-top: 12px;
    }
    .crop-pair figcaption {
      padding: 5px;
      font-size: 12px;
    }
    .crop-pair figure img {
      aspect-ratio: 1;
      height: auto;
      object-fit: cover;
    }
    .muted { color: var(--muted); font-size: 13px; }
    .count-note { margin: 0 0 14px; color: var(--muted); }
    @media (max-width: 760px) {
      header, main { padding: 16px; }
      h1 { font-size: 26px; }
      summary { display: block; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Dynamic Golden Evaluation Review</h1>
    <p id="runIntro"></p>
    <div class="callout">
      <h2>Determinism Contract</h2>
      <p>This dashboard does not rerun the AI service, does not resample data, and does not use an LLM judge. Threshold changes are recalculated from frozen similarity rows and golden labels already saved in this eval run.</p>
    </div>
    <div class="metrics" id="metricCards"></div>
  </header>
  <main>
    <div class="toolbar">
      <label>Threshold
        <select id="thresholdSelect"></select>
      </label>
      <label>Scenario
        <select id="scenarioFilter"><option value="">All scenarios</option></select>
      </label>
      <label>Reason
        <select id="reasonFilter"><option value="">All reasons</option></select>
      </label>
      <label>Case or worker search
        <input id="caseFilter" type="search" placeholder="SG-001 or worker_010">
      </label>
      <button id="resetButton">Reset</button>
    </div>

    <section class="callout">
      <h2 id="whyTitle"></h2>
      <p id="whyText"></p>
      <p id="comparisonText"></p>
    </section>

    <h2>Generated Files</h2>
    <div class="files" id="generatedFiles"></div>

    <h2>Threshold Comparison</h2>
    <div id="thresholdTable"></div>

    <h2 id="scenarioTitle"></h2>
    <div id="scenarioTable"></div>

    <h2 id="rootCauseTitle"></h2>
    <div id="rootCauseTable"></div>
    <div id="rootCauseDetail"></div>

    <h2>Known Fraud Duplicate Checks</h2>
    <div id="fraudTable"></div>
    <div id="fraudDetail"></div>

    <h2>Worker-Level Visual Error Review</h2>
    <p class="count-note" id="caseCountNote"></p>
    <div id="caseReview"></div>
    <div id="caseDetail"></div>
    <button class="primary" id="showMoreButton">Show more cases</button>

    <h2 id="pairTitle"></h2>
    <p class="muted">Pair errors explain threshold behavior directly. A pair false non-match means the two crops are the same worker, but their similarity was below the selected threshold.</p>
    <div id="pairPreview"></div>
    <div id="pairDetail"></div>

    <h2>Data Audit Rules</h2>
    <div class="callout">
      <p>If morning and evening crops for the same worker do not visually look like the same identity, treat it as a golden-data issue. If they do look like the same identity but the score is below threshold, it is a threshold/model issue. If a labelled face is missing from the AI overlay, it is a detection or bbox-assignment issue.</p>
    </div>
  </main>
  <script src="dashboard-summary.js"></script>
  <script>
    const data = window.__dashboardSummary;
    window.__thresholdChunks = window.__thresholdChunks || {};
    const thresholdChunkPromises = {};
    let currentChunk = { errors: [], pair_preview: [], pair_error_count: 0 };
    let renderToken = 0;
    const thresholdSelect = document.getElementById('thresholdSelect');
    const scenarioFilter = document.getElementById('scenarioFilter');
    const reasonFilter = document.getElementById('reasonFilter');
    const caseFilter = document.getElementById('caseFilter');
    const resetButton = document.getElementById('resetButton');
    const showMoreButton = document.getElementById('showMoreButton');
    let visibleCaseLimit = 12;
    let selectedCaseId = '';
    let selectedPairIndex = null;
    let selectedRootCause = '';
    let selectedFraudGroupId = '';

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[char]));
    }
    function pct(value) {
      if (value === null || value === undefined || value === '') return 'n/a';
      const number = Number(value);
      return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : 'n/a';
    }
    function score(value) {
      if (value === null || value === undefined || value === '') return 'n/a';
      const number = Number(value);
      return Number.isFinite(number) ? number.toFixed(3) : 'n/a';
    }
    function thresholdKey() {
      return thresholdSelect.value || data.target_threshold;
    }
    function loadThresholdChunk(threshold) {
      if (window.__thresholdChunks[threshold]) {
        return Promise.resolve(window.__thresholdChunks[threshold]);
      }
      if (thresholdChunkPromises[threshold]) {
        return thresholdChunkPromises[threshold];
      }
      const src = data.threshold_chunk_files[threshold];
      if (!src) {
        return Promise.reject(new Error(`Missing threshold chunk for ${threshold}`));
      }
      thresholdChunkPromises[threshold] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve(window.__thresholdChunks[threshold]);
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
      });
      return thresholdChunkPromises[threshold];
    }
    function sweepRow(threshold) {
      return data.sweep_rows.find((row) => Number(row.threshold).toFixed(2) === threshold) || {};
    }
    function metric(label, value, note = '') {
      return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><em>${escapeHtml(note)}</em></div>`;
    }
    function figure(src, label, note = '', fullSrc = '') {
      if (!src) return '';
      const image = `<img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async">`;
      const linked = fullSrc ? `<a href="${escapeHtml(fullSrc)}" target="_blank" rel="noopener">${image}</a>` : image;
      return `<figure>${linked}<figcaption><strong>${escapeHtml(label)}</strong>${escapeHtml(note)}</figcaption></figure>`;
    }
    function renderMetricCards(threshold) {
      const row = sweepRow(threshold);
      const wrong = Number(row.attendance_total || 0) - Number(row.attendance_correct || 0);
      document.getElementById('metricCards').innerHTML = [
        metric('Selected threshold', threshold, 'change it anytime'),
        metric('Attendance', pct(row.attendance_accuracy), `${row.attendance_correct ?? 'n/a'}/${row.attendance_total ?? 'n/a'} correct`),
        metric('Wrong decisions', String(wrong), `${row.false_absent ?? 0} false absent, ${row.false_present ?? 0} false present`),
        metric('Expected match recall', pct(row.expected_match_recall), `${row.correct_expected_matches ?? 0}/${row.expected_matches ?? 0} matches`),
        metric('Pair false match', pct(row.pair_false_match_rate), `${row.pair_fp ?? 0} FP`),
        metric('Pair false non-match', pct(row.pair_false_non_match_rate), `${row.pair_fn ?? 0} FN`)
      ].join('');
      document.getElementById('whyTitle').textContent = `Why ${pct(row.attendance_accuracy)} Attendance?`;
      document.getElementById('whyText').innerHTML = `Attendance accuracy is <code>attendance_correct / attendance_total</code>. At threshold <code>${escapeHtml(threshold)}</code>, this run has <code>${escapeHtml(row.attendance_correct ?? 'n/a')} / ${escapeHtml(row.attendance_total ?? 'n/a')}</code> correct decisions. That means <code>${escapeHtml(wrong)}</code> wrong worker-session decisions, from <code>${escapeHtml(row.false_absent ?? 0)}</code> false absences and <code>${escapeHtml(row.false_present ?? 0)}</code> false presents.`;
      const comparison = data.comparison_threshold ? sweepRow(data.comparison_threshold) : null;
      document.getElementById('comparisonText').innerHTML = comparison && data.comparison_threshold !== threshold
        ? `Recommended comparison threshold <code>${escapeHtml(data.comparison_threshold)}</code> gives ${pct(comparison.attendance_accuracy)} attendance and ${pct(comparison.expected_match_recall)} expected match recall.`
        : '';
    }
    function renderGeneratedFiles() {
      document.getElementById('generatedFiles').innerHTML = Object.entries(data.generated_files)
        .map(([name, path]) => `<a class="file-pill" href="${escapeHtml(path)}">${escapeHtml(name)}</a>`)
        .join('');
    }
    function renderThresholdTable(threshold) {
      const fields = [
        ['threshold', 'Threshold', 'text'], ['attendance_accuracy', 'Attendance', 'pct'],
        ['expected_match_recall', 'Match recall', 'pct'], ['pair_precision', 'Pair precision', 'pct'],
        ['pair_recall', 'Pair recall', 'pct'], ['pair_f1', 'Pair F1', 'score'],
        ['pair_false_match_rate', 'False match', 'pct'], ['false_absent_rate', 'False absent', 'pct'],
        ['false_present_rate', 'False present', 'pct'], ['fraud_duplicate_recall', 'Fraud recall', 'pct'],
        ['attendance_correct', 'Correct', 'text'], ['attendance_total', 'Total', 'text']
      ];
      const head = fields.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('');
      const body = data.sweep_rows.map((row) => {
        const rowThreshold = Number(row.threshold).toFixed(2);
        const cells = fields.map(([key, , kind]) => {
          const value = kind === 'pct' ? pct(row[key]) : kind === 'score' ? score(row[key]) : (row[key] ?? '');
          return `<td>${escapeHtml(value)}</td>`;
        }).join('');
        return `<tr class="${rowThreshold === threshold ? 'selected' : ''}">${cells}</tr>`;
      }).join('');
      document.getElementById('thresholdTable').innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    function renderScenarioTable(threshold) {
      const rows = data.scenario_rows_by_threshold[threshold] || [];
      document.getElementById('scenarioTitle').textContent = `Scenario Breakdown At ${threshold}`;
      const fields = [
        ['scenario', 'Scenario', 'text'], ['cases', 'Cases', 'text'],
        ['attendance_accuracy', 'Attendance', 'pct'], ['expected_match_recall', 'Match recall', 'pct'],
        ['pair_precision', 'Pair precision', 'pct'], ['pair_recall', 'Pair recall', 'pct'],
        ['false_absent_rate', 'False absent', 'pct'], ['false_present_rate', 'False present', 'pct']
      ];
      const head = fields.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('');
      const body = rows.map((row) => `<tr>${fields.map(([key, , kind]) => `<td>${escapeHtml(kind === 'pct' ? pct(row[key]) : row[key] ?? '')}</td>`).join('')}</tr>`).join('');
      document.getElementById('scenarioTable').innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    function renderRootCauses(threshold) {
      const summary = data.summaries_by_threshold[threshold] || { reason_counts: {} };
      document.getElementById('rootCauseTitle').textContent = `Root Cause Counts At ${threshold}`;
      const rows = Object.entries(summary.reason_counts || {});
      const body = rows.length ? rows.map(([reason, count]) => `<tr>
        <td><code>${escapeHtml(reason)}</code></td>
        <td>${escapeHtml(count)}</td>
        <td><button class="link-action" data-open-root-cause="${escapeHtml(reason)}">View examples</button></td>
      </tr>`).join('') : '<tr><td>No errors</td><td>0</td><td></td></tr>';
      document.getElementById('rootCauseTable').innerHTML = `<table><thead><tr><th>Deterministic reason</th><th>Error decisions</th><th>Evidence</th></tr></thead><tbody>${body}</tbody></table>`;
      if (selectedRootCause && rows.some(([reason]) => reason === selectedRootCause)) {
        renderRootCauseDetail(selectedRootCause);
      } else {
        selectedRootCause = '';
        document.getElementById('rootCauseDetail').innerHTML = '<p class="muted">Click a root cause to load example crop pairs.</p>';
      }
    }
    function renderRootCauseDetail(reason) {
      const examples = (currentChunk.errors || []).filter((row) => row.reason === reason);
      const visible = examples.slice(0, 12);
      if (!visible.length) {
        document.getElementById('rootCauseDetail').innerHTML = '<p class="muted">No examples for this root cause at the selected threshold.</p>';
        return;
      }
      const rows = visible.map((decision) => {
        const comparison = data.comparison_threshold && decision.comparison_predicted_status
          ? `At ${data.comparison_threshold}: ${decision.comparison_predicted_status} (${decision.comparison_reason})` : '';
        return `<tr>
          <td><div class="crop-pair">${figure(decision.morning_crop, 'Morning crop', '', decision.morning_crop_full)}${figure(decision.evening_crop, 'Evening crop', '', decision.evening_crop_full)}</div></td>
          <td>${escapeHtml(decision.case_id)}<br><span class="muted">${escapeHtml(decision.scenario)}</span></td>
          <td><strong>${escapeHtml(decision.worker_id)}</strong><br>${escapeHtml(decision.worker_name)}</td>
          <td>${escapeHtml(decision.session)}</td>
          <td>${escapeHtml(decision.expected_status)} -> ${escapeHtml(decision.predicted_status)}</td>
          <td>${score(decision.same_worker_similarity)}</td>
          <td>${escapeHtml(decision.best_evening_candidate || '')}<br><span class="muted">${score(decision.best_evening_similarity)}</span></td>
          <td><span class="muted">${escapeHtml(comparison)}</span></td>
        </tr>`;
      }).join('');
      const note = examples.length > visible.length ? `<p class="muted">Showing first ${visible.length} of ${examples.length} examples for this root cause.</p>` : `<p class="muted">Showing ${visible.length} examples for this root cause.</p>`;
      document.getElementById('rootCauseDetail').innerHTML = `<section class="evidence-panel">
        <div class="evidence-heading">
          <div><strong>${escapeHtml(reason)}</strong><br><span class="muted">Examples at threshold ${escapeHtml(thresholdKey())}</span></div>
          <button data-close-root-cause="1">Close examples</button>
        </div>
        <div class="case-meta">Images are loaded only after clicking a root-cause row.</div>
        ${note}
        <table class="decision-table"><thead><tr><th>Pair preview</th><th>Case</th><th>Worker</th><th>Session</th><th>Decision</th><th>Same-worker score</th><th>Best candidate</th><th>Comparison</th></tr></thead><tbody>${rows}</tbody></table>
      </section>`;
    }
    function renderFraud(threshold) {
      const rows = data.fraud_groups || [];
      const body = rows.length ? rows.map((group) => {
        const best = Number(group.best_cross_pump_similarity);
        const detected = Number.isFinite(best) && best >= Number(threshold);
        return `<tr>
          <td>${escapeHtml(group.fraud_group_id)}</td><td>${escapeHtml(group.worker_id)}</td><td>${escapeHtml(group.cases)}</td>
          <td>${escapeHtml(threshold)}</td><td>${score(best)}</td><td>${detected ? 'detected' : 'missed'}</td>
          <td><button class="link-action" data-open-fraud="${escapeHtml(group.fraud_group_id)}">View fraud pair</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="7">No known fraud duplicate groups in this dataset.</td></tr>';
      document.getElementById('fraudTable').innerHTML = '<table><thead><tr><th>Fraud group</th><th>Worker</th><th>Cases</th><th>Threshold</th><th>Best cross-pump score</th><th>Decision</th><th>Evidence</th></tr></thead><tbody>' + body + '</tbody></table>';
      if (selectedFraudGroupId && rows.some((group) => group.fraud_group_id === selectedFraudGroupId)) {
        renderFraudDetail(selectedFraudGroupId, threshold);
      } else {
        selectedFraudGroupId = '';
        document.getElementById('fraudDetail').innerHTML = '<p class="muted">Click a fraud row to load cross-pump worker crop evidence.</p>';
      }
    }
    function renderFraudDetail(groupId, threshold) {
      const evidence = data.fraud_evidence?.[groupId];
      if (!evidence || !evidence.items?.length) {
        document.getElementById('fraudDetail').innerHTML = '<p class="muted">No crop evidence is available for this fraud group.</p>';
        return;
      }
      const best = Number(evidence.best_cross_pump_similarity);
      const detected = Number.isFinite(best) && best >= Number(threshold);
      const rows = evidence.items.map((item) => `<tr>
        <td>${escapeHtml(item.case_id)}<br><span class="muted">${escapeHtml(item.scenario)} - ${escapeHtml(item.pump_id)} - ${escapeHtml(item.attendance_date)}</span></td>
        <td><div class="crop-pair">${figure(item.morning_crop, 'Morning crop', '', item.morning_crop_full)}${figure(item.evening_crop, 'Evening crop', '', item.evening_crop_full)}</div></td>
      </tr>`).join('');
      document.getElementById('fraudDetail').innerHTML = `<section class="evidence-panel">
        <div class="evidence-heading">
          <div><strong>${escapeHtml(groupId)} / ${escapeHtml(evidence.worker_id)}</strong><br><span class="muted">Best score ${score(best)} at threshold ${escapeHtml(threshold)}: ${detected ? 'detected' : 'missed'}</span></div>
          <button data-close-fraud="1">Close fraud pair</button>
        </div>
        <div class="case-meta">These are the known cross-pump worker crops for this fraud group. Click any thumbnail for the full crop.</div>
        <table class="decision-table"><thead><tr><th>Case</th><th>Known worker crop evidence</th></tr></thead><tbody>${rows}</tbody></table>
      </section>`;
    }
    function resetFilterOptions(threshold) {
      const errors = currentChunk.errors || [];
      const scenarios = [...new Set(errors.map((row) => row.scenario))].sort();
      const reasons = [...new Set(errors.map((row) => row.reason))].sort();
      scenarioFilter.innerHTML = '<option value="">All scenarios</option>' + scenarios.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
      reasonFilter.innerHTML = '<option value="">All reasons</option>' + reasons.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    }
    function filteredErrors(threshold) {
      const scenario = scenarioFilter.value;
      const reason = reasonFilter.value;
      const text = caseFilter.value.trim().toLowerCase();
      return (currentChunk.errors || []).filter((row) => {
        const rowText = `${row.case_id} ${row.worker_id} ${row.worker_name} ${row.reason}`.toLowerCase();
        return (!scenario || row.scenario === scenario) && (!reason || row.reason === reason) && (!text || rowText.includes(text));
      });
    }
    function renderCaseReview(threshold) {
      const errors = filteredErrors(threshold);
      const grouped = new Map();
      for (const error of errors) {
        if (!grouped.has(error.case_id)) grouped.set(error.case_id, []);
        grouped.get(error.case_id).push(error);
      }
      const caseEntries = [...grouped.entries()].slice(0, visibleCaseLimit);
      document.getElementById('caseCountNote').textContent = `Showing ${caseEntries.length} of ${grouped.size} error cases, from ${errors.length} worker-session errors.`;
      showMoreButton.hidden = grouped.size <= visibleCaseLimit;
      const sections = caseEntries.map(([caseId, caseErrors]) => {
        const asset = data.case_assets[caseId] || {};
        const fraudText = asset.fraud_group_id ? ` Fraud group: ${asset.fraud_group_id} / ${asset.fraud_worker_id}.` : '';
        return `<div class="case-row">
          <div>
            <strong>${escapeHtml(caseId)} - ${escapeHtml(asset.scenario || '')}</strong>
            <span class="muted">Pump ${escapeHtml(asset.pump_id || '')} - ${escapeHtml(asset.attendance_date || '')}.${escapeHtml(fraudText)} ${caseErrors.length} error decisions.</span>
          </div>
          <button class="primary" data-open-case="${escapeHtml(caseId)}">${selectedCaseId === caseId ? 'Refresh evidence' : 'Open evidence'}</button>
        </div>`;
      }).join('');
      document.getElementById('caseReview').innerHTML = sections ? `<div class="case-list">${sections}</div>` : '<p>No worker-level attendance errors for this threshold/filter.</p>';
      if (selectedCaseId && grouped.has(selectedCaseId)) {
        renderCaseDetail(selectedCaseId, grouped.get(selectedCaseId));
      } else {
        selectedCaseId = '';
        document.getElementById('caseDetail').innerHTML = '<p class="muted">Click a case to load group photos, overlays, and crop evidence.</p>';
      }
    }
    function renderCaseDetail(caseId, caseErrors) {
      const asset = data.case_assets[caseId] || {};
      const morning = asset.sessions?.morning || {};
      const evening = asset.sessions?.evening || {};
      const figures = [
        figure(morning.input, 'Morning input', ` - ${morning.detected_faces ?? ''} detected / ${morning.expected_faces ?? ''} expected`, morning.input_full),
        figure(morning.labelled, 'Morning golden labels', '', morning.labelled_full),
        figure(morning.overlay, 'Morning AI overlay', ` - IoU ${score(morning.mean_box_iou)}`, morning.overlay_full),
        figure(evening.input, 'Evening input', ` - ${evening.detected_faces ?? ''} detected / ${evening.expected_faces ?? ''} expected`, evening.input_full),
        figure(evening.labelled, 'Evening golden labels', '', evening.labelled_full),
        figure(evening.overlay, 'Evening AI overlay', ` - IoU ${score(evening.mean_box_iou)}`, evening.overlay_full)
      ].join('');
      const rows = caseErrors.map((decision) => {
        const comparison = data.comparison_threshold && decision.comparison_predicted_status
          ? `At ${data.comparison_threshold}: ${decision.comparison_predicted_status} (${decision.comparison_reason})` : '';
        return `<tr>
          <td><div class="crop-pair">${figure(decision.morning_crop, 'Morning crop', '', decision.morning_crop_full)}${figure(decision.evening_crop, 'Evening crop', '', decision.evening_crop_full)}</div></td>
          <td><strong>${escapeHtml(decision.worker_id)}</strong><br>${escapeHtml(decision.worker_name)}<br><span class="muted">${escapeHtml(decision.source_identity_folder)}</span></td>
          <td>${escapeHtml(decision.session)}</td><td>${escapeHtml(decision.expected_status)}</td><td>${escapeHtml(decision.predicted_status)}</td>
          <td>${score(decision.same_worker_similarity)}</td>
          <td>${escapeHtml(decision.best_evening_candidate || '')}<br><span class="muted">${score(decision.best_evening_similarity)}</span></td>
          <td><code>${escapeHtml(decision.reason)}</code><br><span class="muted">${escapeHtml(comparison)}</span></td>
        </tr>`;
      }).join('');
      document.getElementById('caseDetail').innerHTML = `<section class="evidence-panel">
        <div class="evidence-heading">
          <div><strong>${escapeHtml(caseId)}</strong><br><span class="muted">${escapeHtml(asset.scenario || '')}</span></div>
          <button data-close-case="1">Close evidence</button>
        </div>
        <div class="case-meta">Images are loaded only for this selected case.</div>
        <div class="image-grid">${figures}</div>
        <table class="decision-table"><thead><tr><th>Visual evidence</th><th>Worker</th><th>Session</th><th>Expected</th><th>Predicted</th><th>Same-worker score</th><th>Best candidate</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>
      </section>`;
    }
    function renderPairPreview(threshold) {
      const pairErrors = currentChunk.pair_preview || [];
      const count = currentChunk.pair_error_count || 0;
      document.getElementById('pairTitle').textContent = `Pair-Level Error Preview At ${threshold}`;
      if (!pairErrors.length) {
        document.getElementById('pairPreview').innerHTML = '<p>No pair-level errors at this threshold.</p>';
        document.getElementById('pairDetail').innerHTML = '';
        return;
      }
      const note = count > pairErrors.length ? `<p class="muted">Showing first ${pairErrors.length} of ${count} pair errors.</p>` : '';
      const rows = pairErrors.map((pair, index) => `<tr>
        <td><button class="link-action" data-open-pair="${index}">View images</button></td>
        <td>${escapeHtml(pair.case_id)}<br><span class="muted">${escapeHtml(pair.scenario)}</span></td>
        <td>${escapeHtml(pair.morning_worker_id)}</td><td>${escapeHtml(pair.evening_label_type)}:${escapeHtml(pair.evening_label_id)}</td>
        <td>${score(pair.similarity)}</td><td><code>${escapeHtml(pair.pair_error)}</code></td>
      </tr>`).join('');
      document.getElementById('pairPreview').innerHTML = `${note}<table><thead><tr><th>Evidence</th><th>Case</th><th>Morning worker</th><th>Evening face</th><th>Similarity</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>`;
      if (selectedPairIndex !== null && pairErrors[selectedPairIndex]) {
        renderPairDetail(selectedPairIndex);
      } else {
        selectedPairIndex = null;
        document.getElementById('pairDetail').innerHTML = '<p class="muted">Click a pair row to load its crop images.</p>';
      }
    }
    function renderPairDetail(index) {
      const pair = (currentChunk.pair_preview || [])[index];
      if (!pair) {
        selectedPairIndex = null;
        document.getElementById('pairDetail').innerHTML = '';
        return;
      }
      document.getElementById('pairDetail').innerHTML = `<section class="evidence-panel pair-evidence">
        <div class="evidence-heading">
          <div><strong>${escapeHtml(pair.case_id)}</strong><br><span class="muted">${escapeHtml(pair.pair_error)} - similarity ${score(pair.similarity)}</span></div>
          <button data-close-pair="1">Close pair images</button>
        </div>
        <div class="image-grid">${figure(pair.morning_crop, 'Morning crop', '', pair.morning_crop_full)}${figure(pair.evening_crop, 'Evening crop', '', pair.evening_crop_full)}</div>
      </section>`;
    }
    async function renderAll(resetOptions = false) {
      const threshold = thresholdKey();
      const token = ++renderToken;
      document.getElementById('caseReview').innerHTML = '<p>Loading threshold data...</p>';
      document.getElementById('caseDetail').innerHTML = '';
      document.getElementById('rootCauseDetail').innerHTML = '';
      document.getElementById('pairPreview').innerHTML = '<p>Loading threshold data...</p>';
      document.getElementById('pairDetail').innerHTML = '';
      document.getElementById('fraudDetail').innerHTML = '';
      try {
        const chunk = await loadThresholdChunk(threshold);
        if (token !== renderToken) return;
        currentChunk = chunk || { errors: [], pair_preview: [], pair_error_count: 0 };
      } catch (error) {
        document.getElementById('caseReview').innerHTML = `<p>Could not load threshold data: ${escapeHtml(error.message)}</p>`;
        document.getElementById('pairPreview').innerHTML = '';
        return;
      }
      if (resetOptions) resetFilterOptions(threshold);
      renderMetricCards(threshold);
      renderThresholdTable(threshold);
      renderScenarioTable(threshold);
      renderRootCauses(threshold);
      renderFraud(threshold);
      renderCaseReview(threshold);
      renderPairPreview(threshold);
    }
    function init() {
      document.getElementById('runIntro').innerHTML = `Run <code>${escapeHtml(data.run.id)}</code> over dataset <code>${escapeHtml(data.dataset.version || 'unknown')}</code>.`;
      thresholdSelect.innerHTML = data.thresholds.map((threshold) => `<option value="${escapeHtml(threshold)}">${escapeHtml(threshold)}</option>`).join('');
      thresholdSelect.value = data.target_threshold;
      renderGeneratedFiles();
      renderAll(true);
    }
    thresholdSelect.addEventListener('change', () => {
      visibleCaseLimit = 12;
      selectedCaseId = '';
      selectedPairIndex = null;
      selectedRootCause = '';
      selectedFraudGroupId = '';
      renderAll(true);
    });
    function applyFilters() {
      visibleCaseLimit = 12;
      selectedCaseId = '';
      renderCaseReview(thresholdKey());
    }
    scenarioFilter.addEventListener('change', applyFilters);
    reasonFilter.addEventListener('change', applyFilters);
    caseFilter.addEventListener('input', applyFilters);
    resetButton.addEventListener('click', () => {
      scenarioFilter.value = '';
      reasonFilter.value = '';
      caseFilter.value = '';
      visibleCaseLimit = 12;
      selectedCaseId = '';
      renderCaseReview(thresholdKey());
    });
    showMoreButton.addEventListener('click', () => {
      visibleCaseLimit += 12;
      renderCaseReview(thresholdKey());
    });
    document.getElementById('caseReview').addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-case]');
      if (!button) return;
      selectedCaseId = button.dataset.openCase;
      renderCaseReview(thresholdKey());
      document.getElementById('caseDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('caseDetail').addEventListener('click', (event) => {
      if (!event.target.closest('[data-close-case]')) return;
      selectedCaseId = '';
      document.getElementById('caseDetail').innerHTML = '<p class="muted">Click a case to load group photos, overlays, and crop evidence.</p>';
    });
    document.getElementById('rootCauseTable').addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-root-cause]');
      if (!button) return;
      selectedRootCause = button.dataset.openRootCause;
      renderRootCauseDetail(selectedRootCause);
      document.getElementById('rootCauseDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('rootCauseDetail').addEventListener('click', (event) => {
      if (!event.target.closest('[data-close-root-cause]')) return;
      selectedRootCause = '';
      document.getElementById('rootCauseDetail').innerHTML = '<p class="muted">Click a root cause to load example crop pairs.</p>';
    });
    document.getElementById('fraudTable').addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-fraud]');
      if (!button) return;
      selectedFraudGroupId = button.dataset.openFraud;
      renderFraudDetail(selectedFraudGroupId, thresholdKey());
      document.getElementById('fraudDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('fraudDetail').addEventListener('click', (event) => {
      if (!event.target.closest('[data-close-fraud]')) return;
      selectedFraudGroupId = '';
      document.getElementById('fraudDetail').innerHTML = '<p class="muted">Click a fraud row to load cross-pump worker crop evidence.</p>';
    });
    document.getElementById('pairPreview').addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-pair]');
      if (!button) return;
      selectedPairIndex = Number(button.dataset.openPair);
      renderPairDetail(selectedPairIndex);
      document.getElementById('pairDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('pairDetail').addEventListener('click', (event) => {
      if (!event.target.closest('[data-close-pair]')) return;
      selectedPairIndex = null;
      document.getElementById('pairDetail').innerHTML = '<p class="muted">Click a pair row to load its crop images.</p>';
    });
    init();
  </script>
</body>
</html>
"""
    (report_dir / "index.html").write_text(
        html_doc,
        encoding="utf-8",
    )


def update_parent_index(review_dir: Path, report_dir: Path) -> None:
    index_path = review_dir / "index.html"
    if not index_path.exists():
        return
    marker = "<!-- deterministic-decision-review-link -->"
    content = index_path.read_text(encoding="utf-8")
    link = html_path(review_dir, report_dir / "index.html")
    block = (
        f"\n  {marker}\n"
        "  <section style=\"background:#fff;border:1px solid #BBBFBF;border-left:6px solid #05AD98;"
        "padding:16px;margin:18px 0;\">\n"
        "    <h2>Deterministic Decision Review</h2>\n"
        f"    <p><a href=\"{html.escape(link)}\">Open the worker-level visual threshold report</a></p>\n"
        "  </section>\n"
    )
    if marker in content:
        content = re.sub(r"\n\s*" + re.escape(marker) + r".*?</section>\n", block, content, flags=re.DOTALL)
    else:
        content = content.replace("<body>", "<body>" + block, 1)
    index_path.write_text(content, encoding="utf-8")


def validate_required_files(run_dir: Path) -> None:
    required = [
        "metrics.json",
        "match-pairs.csv",
        "image-metrics.csv",
        "threshold-sweep.csv",
        "threshold-case-metrics.csv",
        "threshold-scenario-metrics.csv",
    ]
    missing = [name for name in required if not (run_dir / name).exists()]
    if missing:
        raise FileNotFoundError(f"Run directory is missing required eval artifacts: {', '.join(missing)}")


def run(args: argparse.Namespace) -> int:
    dataset_dir = Path(args.dataset_dir).resolve()
    manifest = load_json(dataset_dir / "manifest.json")
    dataset_version = manifest.get("dataset_version", "golden-small-groups-v1")

    run_dir = Path(args.run_dir).resolve() if args.run_dir else find_latest_run(Path(args.output_root).resolve(), dataset_version)
    validate_required_files(run_dir)

    metrics = load_json(run_dir / "metrics.json")
    cases = manifest["cases"]
    ground_truth = {
        case_meta["case_id"]: load_json(dataset_dir / case_meta["ground_truth"])
        for case_meta in cases
    }
    workers = load_workers(dataset_dir)
    image_rows = read_csv(run_dir / "image-metrics.csv")
    pair_rows = normalize_pair_rows(read_csv(run_dir / "match-pairs.csv"))
    sweep_rows = read_csv(run_dir / "threshold-sweep.csv")
    threshold_case_rows = read_csv(run_dir / "threshold-case-metrics.csv")
    threshold_scenario_rows = read_csv(run_dir / "threshold-scenario-metrics.csv")
    fraud_groups = load_json(run_dir / "fraud-groups.json") if (run_dir / "fraud-groups.json").exists() else []

    selected_thresholds = select_thresholds(args, metrics, sweep_rows)
    target_threshold = threshold_value(args.target_threshold or selected_thresholds[0])
    if target_threshold not in selected_thresholds:
        selected_thresholds.insert(0, target_threshold)
    comparison_threshold = None
    if len(selected_thresholds) > 1:
        comparison_threshold = selected_thresholds[1]
    all_thresholds = sorted({threshold_value(row["threshold"]) for row in sweep_rows})

    report_dir = run_dir / "review" / "decision-review"
    crop_lookup = build_crop_lookup(dataset_dir, cases, ground_truth, report_dir)
    pair_rows_by_case: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in pair_rows:
        pair_rows_by_case[row["case_id"]].append(row)

    decisions_by_threshold = build_worker_decisions(
        cases=cases,
        ground_truth=ground_truth,
        pair_rows_by_case=pair_rows_by_case,
        crop_lookup=crop_lookup,
        thresholds=all_thresholds,
        comparison_threshold=comparison_threshold,
        workers=workers,
    )
    pair_errors_by_threshold = build_pair_errors(pair_rows=pair_rows, crop_lookup=crop_lookup, thresholds=all_thresholds)

    threshold_case_by_threshold = rows_by_threshold(threshold_case_rows)
    target_decisions = decisions_by_threshold[target_threshold]
    target_errors = [row for row in target_decisions if not parse_bool(row["decision_correct"])]
    target_pair_errors = pair_errors_by_threshold[target_threshold]
    target_summary = summarize_decisions(target_decisions)
    comparison_lookup = {}
    if comparison_threshold is not None:
        comparison_lookup = compare_worker_decisions(target_decisions, decisions_by_threshold[comparison_threshold])

    generated_files: dict[str, str] = {}
    for threshold in selected_thresholds:
        slug = threshold_slug(threshold)
        decisions = decisions_by_threshold[threshold]
        errors = [row for row in decisions if not parse_bool(row["decision_correct"])]
        pair_errors = pair_errors_by_threshold[threshold]
        case_summary = threshold_case_summary(threshold_case_rows, threshold)

        decision_path = report_dir / f"threshold-{slug}-worker-decisions.csv"
        errors_path = report_dir / f"threshold-{slug}-attendance-errors.csv"
        pair_errors_path = report_dir / f"threshold-{slug}-pair-errors.csv"
        case_summary_path = report_dir / f"threshold-{slug}-case-summary.csv"
        write_csv(decision_path, decisions, decision_csv_fields())
        write_csv(errors_path, errors, decision_csv_fields())
        write_csv(pair_errors_path, pair_errors, pair_error_csv_fields())
        write_csv(case_summary_path, case_summary, case_summary_fields())
        generated_files[f"{threshold_label(threshold)} worker decisions CSV"] = html_path(report_dir, decision_path)
        generated_files[f"{threshold_label(threshold)} attendance errors CSV"] = html_path(report_dir, errors_path)
        generated_files[f"{threshold_label(threshold)} pair errors CSV"] = html_path(report_dir, pair_errors_path)
        generated_files[f"{threshold_label(threshold)} case summary CSV"] = html_path(report_dir, case_summary_path)

    comparison_path = report_dir / "threshold-comparison.csv"
    write_csv(comparison_path, sweep_rows, threshold_comparison_fields())
    generated_files["threshold comparison CSV"] = html_path(report_dir, comparison_path)
    dashboard_path = report_dir / "dashboard-data.json"
    generated_files["dashboard data JSON"] = html_path(report_dir, dashboard_path)
    generated_files["dashboard summary JS"] = "dashboard-summary.js"
    generated_files["threshold data chunks"] = "threshold-data/"
    generated_files["dashboard thumbnails"] = "thumbnails/"

    trace = {
        "schema_version": 1,
        "determinism_contract": {
            "ai_service_called": False,
            "llm_grader_used": False,
            "random_sampling_used": False,
            "source_artifacts": [
                "metrics.json",
                "match-pairs.csv",
                "image-metrics.csv",
                "threshold-sweep.csv",
                "threshold-case-metrics.csv",
                "threshold-scenario-metrics.csv",
                "golden ground_truth.json files",
            ],
        },
        "run": metrics.get("run", {}),
        "dataset": metrics.get("dataset", {}),
        "selected_thresholds": [threshold_label(value) for value in selected_thresholds],
        "target_threshold": threshold_label(target_threshold),
        "comparison_threshold": threshold_label(comparison_threshold) if comparison_threshold is not None else None,
        "target_summary": target_summary,
        "threshold_summaries": {
            threshold_label(threshold): summarize_decisions(decisions)
            for threshold, decisions in decisions_by_threshold.items()
        },
    }
    trace_path = report_dir / "decision-trace.json"
    write_json(trace_path, trace)
    generated_files["decision trace JSON"] = html_path(report_dir, trace_path)

    case_assets = build_case_assets(
        cases=cases,
        ground_truth=ground_truth,
        image_lookup=image_row_lookup(image_rows),
        report_dir=report_dir,
        dataset_dir=dataset_dir,
    )
    fraud_evidence = build_fraud_evidence(
        fraud_groups=fraud_groups,
        crop_lookup=crop_lookup,
        case_assets=case_assets,
        report_dir=report_dir,
    )
    dashboard_data = build_dashboard_data(
        report_dir=report_dir,
        run_dir=run_dir,
        metrics=metrics,
        sweep_rows=sweep_rows,
        threshold_scenario_rows=threshold_scenario_rows,
        all_thresholds=all_thresholds,
        target_threshold=target_threshold,
        comparison_threshold=comparison_threshold,
        decisions_by_threshold=decisions_by_threshold,
        pair_errors_by_threshold=pair_errors_by_threshold,
        case_assets=case_assets,
        fraud_groups=fraud_groups,
        fraud_evidence=fraud_evidence,
        generated_files=generated_files,
    )
    write_json(dashboard_path, dashboard_data)
    write_dynamic_html_report(report_dir, dashboard_data)
    update_parent_index(run_dir / "review", report_dir)

    target_sweep = row_for_threshold(sweep_rows, target_threshold) or {}
    print(f"Deterministic report: {repo_relative(report_dir / 'index.html')}")
    print(
        "Target threshold "
        f"{threshold_label(target_threshold)}: "
        f"attendance {pct(target_sweep.get('attendance_accuracy'))}, "
        f"errors {target_summary['decision_errors']}, "
        f"pair errors {len(target_pair_errors)}"
    )
    if target_errors:
        most_common = Counter(row["reason"] for row in target_errors).most_common(5)
        print("Top deterministic reasons: " + ", ".join(f"{reason}={count}" for reason, count in most_common))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Explain a golden small-group eval run without rerunning the AI service.")
    parser.add_argument("--dataset-dir", default=str(DEFAULT_DATASET_DIR))
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    parser.add_argument("--run-dir", default=None)
    parser.add_argument("--threshold", action="append", default=None, help="Threshold to include. Defaults to run threshold.")
    parser.add_argument("--compare-threshold", action="append", default=None, help="Additional threshold to include.")
    parser.add_argument("--target-threshold", default=None, help="Threshold used for the main visual error review.")
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(run(parse_args()))
