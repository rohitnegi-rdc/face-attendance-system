"""Evaluate golden small-group attendance cases against the live AI service.

The runner uses the deterministic golden dataset under
datasets/golden-small-groups-v1 and writes compact, reusable metrics under
test-output/evaluations/<run-id>/.

Raw embeddings are kept in memory only. Reports include scores, case tables,
and overlay images with expected/detected bounding boxes.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import os
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET_DIR = ROOT / "datasets" / "golden-small-groups-v1"
DEFAULT_AI_URL = os.getenv("AI_SERVICE_URL", "http://127.0.0.1:6102")
DEFAULT_OUTPUT_ROOT = ROOT / "test-output" / "evaluations"
IMAGE_TIMEOUT_SECONDS = 180
DEFAULT_MATCH_THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.68"))
DEFAULT_IOU_THRESHOLD = 0.5
THRESHOLDS = [round(value / 100, 2) for value in range(20, 87, 2)]


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def rate(numerator: float, denominator: float) -> float | None:
    if denominator == 0:
        return None
    return round(numerator / denominator, 6)


def f1_score(precision: float | None, recall: float | None) -> float | None:
    if precision is None or recall is None or precision + recall <= 0:
        return None
    return round(2 * precision * recall / (precision + recall), 6)


def pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.1f}%"


def metric_value(value: float | int | None) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, int):
        return str(value)
    return f"{value:.4f}"


def percentile(values: list[float], pct_value: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    rank = (len(ordered) - 1) * pct_value
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return round(ordered[lower], 3)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower), 3)


def cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        return vector
    return [value / norm for value in vector]


def bbox_iou(left: list[int], right: list[int]) -> float:
    lx1, ly1, lx2, ly2 = left
    rx1, ry1, rx2, ry2 = right
    ix1 = max(lx1, rx1)
    iy1 = max(ly1, ry1)
    ix2 = min(lx2, rx2)
    iy2 = min(ly2, ry2)
    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = iw * ih
    left_area = max(0, lx2 - lx1) * max(0, ly2 - ly1)
    right_area = max(0, rx2 - rx1) * max(0, ry2 - ry1)
    union = left_area + right_area - inter
    if union <= 0:
        return 0.0
    return inter / union


def relative(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def extract_faces(image_path: Path, ai_url: str, request_id: str) -> dict[str, Any]:
    start = time.perf_counter()
    with image_path.open("rb") as handle:
        response = requests.post(
            f"{ai_url}/internal/face/extract",
            files={"file": (image_path.name, handle, "image/jpeg")},
            headers={"X-Request-Id": request_id},
            timeout=IMAGE_TIMEOUT_SECONDS,
        )
    wall_ms = round((time.perf_counter() - start) * 1000, 1)
    response.raise_for_status()
    payload = response.json()
    payload["wall_ms"] = wall_ms
    return payload


def expected_regions(session: dict[str, Any]) -> list[dict[str, Any]]:
    regions: list[dict[str, Any]] = []
    for region in session.get("worker_regions", []):
        regions.append(
            {
                "label_type": "worker",
                "label_id": str(region.get("worker_id") or region.get("id")),
                "bbox": [int(v) for v in region["bbox"]],
                "source_image": region.get("source_image"),
            }
        )
    for index, region in enumerate(session.get("unknown_regions", []), start=1):
        regions.append(
            {
                "label_type": "unknown",
                "label_id": str(region.get("id") or f"unknown_{index:03d}"),
                "bbox": [int(v) for v in region["bbox"]],
                "source_image": region.get("source_image"),
            }
        )
    return regions


def face_contract_errors(face: dict[str, Any], image_width: int, image_height: int) -> list[str]:
    errors: list[str] = []
    bbox = face.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        errors.append("bbox_not_four_values")
    else:
        try:
            x1, y1, x2, y2 = [int(value) for value in bbox]
            if x1 < 0 or y1 < 0 or x2 > image_width or y2 > image_height or x2 <= x1 or y2 <= y1:
                errors.append("bbox_out_of_bounds")
        except Exception:
            errors.append("bbox_non_numeric")
    embedding = face.get("embedding")
    if not isinstance(embedding, list) or len(embedding) != 512:
        errors.append("embedding_not_512")
    elif not all(isinstance(value, (int, float)) and math.isfinite(float(value)) for value in embedding):
        errors.append("embedding_non_finite")
    crop = face.get("crop_base64")
    if not isinstance(crop, str) or not crop:
        errors.append("crop_missing")
    return errors


def assign_detections(
    detections: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    iou_threshold: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], float]:
    pairs: list[tuple[float, int, int]] = []
    for detection_index, detection in enumerate(detections):
        bbox = detection.get("bbox")
        if not bbox:
            continue
        for region_index, region in enumerate(regions):
            score = bbox_iou([int(v) for v in bbox], region["bbox"])
            if score >= iou_threshold:
                pairs.append((score, detection_index, region_index))

    pairs.sort(reverse=True, key=lambda item: item[0])
    matched_detections: set[int] = set()
    matched_regions: set[int] = set()
    iou_sum = 0.0

    for score, detection_index, region_index in pairs:
        if detection_index in matched_detections or region_index in matched_regions:
            continue
        detection = detections[detection_index]
        region = regions[region_index]
        detection["assignment"] = {
            "label_type": region["label_type"],
            "label_id": region["label_id"],
            "iou": round(score, 6),
        }
        region["detected"] = True
        region["matched_detection_index"] = detection_index
        region["matched_iou"] = round(score, 6)
        matched_detections.add(detection_index)
        matched_regions.add(region_index)
        iou_sum += score

    return detections, regions, iou_sum


def normalize_detections(
    payload: dict[str, Any],
    image_width: int,
    image_height: int,
) -> tuple[list[dict[str, Any]], int]:
    normalized: list[dict[str, Any]] = []
    contract_error_count = 0
    for index, face in enumerate(payload.get("faces") or [], start=1):
        errors = face_contract_errors(face, image_width, image_height)
        contract_error_count += len(errors)
        embedding = face.get("embedding")
        normalized.append(
            {
                "detection_id": f"d{index:02d}",
                "bbox": [int(v) for v in face.get("bbox", [])] if isinstance(face.get("bbox"), list) else [],
                "embedding": normalize([float(v) for v in embedding])
                if isinstance(embedding, list) and len(embedding) == 512
                else None,
                "contract_errors": errors,
                "assignment": None,
            }
        )
    return normalized, contract_error_count


def draw_label(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, fill: tuple[int, int, int]) -> None:
    font = ImageFont.load_default()
    x, y = xy
    try:
        text_box = draw.textbbox((x, y), text, font=font)
        width = text_box[2] - text_box[0]
        height = text_box[3] - text_box[1]
    except Exception:
        width = len(text) * 7
        height = 12
    draw.rectangle([x, max(0, y - height - 4), x + width + 6, y], fill=fill)
    draw.text((x + 3, max(0, y - height - 2)), text, fill=(255, 255, 255), font=font)


def draw_overlay(
    image_path: Path,
    output_path: Path,
    title: str,
    detections: list[dict[str, Any]],
    regions: list[dict[str, Any]],
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path) as image:
        canvas = image.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    expected_color = (5, 173, 152)
    missed_color = (220, 50, 47)
    detected_color = (40, 95, 190)
    extra_color = (230, 126, 34)

    draw.rectangle([0, 0, canvas.width, 34], fill=(0, 0, 0))
    draw.text((10, 10), title, fill=(255, 255, 255), font=ImageFont.load_default())

    for region in regions:
        color = expected_color if region.get("detected") else missed_color
        x1, y1, x2, y2 = region["bbox"]
        draw.rectangle([x1, y1, x2, y2], outline=color, width=4)
        prefix = "expected" if region.get("detected") else "missed"
        draw_label(draw, (x1, y1), f"{prefix}: {region['label_id']}", color)

    for detection in detections:
        bbox = detection.get("bbox")
        if not bbox:
            continue
        x1, y1, x2, y2 = bbox
        assignment = detection.get("assignment")
        color = detected_color if assignment else extra_color
        draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
        label = f"detected: {assignment['label_id']} {assignment['iou']:.2f}" if assignment else "extra detection"
        draw_label(draw, (x1, max(38, y2 + 15)), label, color)
    canvas.save(output_path, quality=92)


def evaluate_image(
    *,
    dataset_dir: Path,
    case_meta: dict[str, Any],
    gt: dict[str, Any],
    session_name: str,
    ai_url: str,
    run_id: str,
    review_dir: Path,
    iou_threshold: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    case_dir = dataset_dir / "cases" / case_meta["case_id"]
    session = gt["sessions"][session_name]
    image_path = case_dir / session["photo"]
    with Image.open(image_path) as image:
        width, height = image.size

    error = ""
    payload: dict[str, Any] = {"faces": [], "processing_ms": None, "wall_ms": None}
    try:
        payload = extract_faces(image_path, ai_url, f"golden-{run_id}-{case_meta['case_id']}-{session_name}")
    except Exception as exc:
        error = str(exc)

    detections, contract_errors = normalize_detections(payload, width, height)
    regions = expected_regions(session)
    detections, regions, iou_sum = assign_detections(detections, regions, iou_threshold)

    expected_count = int(session.get("expected_face_count") or len(regions))
    detected_count = len(detections)
    matched_count = sum(1 for detection in detections if detection.get("assignment"))
    missed_count = max(0, expected_count - matched_count)
    extra_count = max(0, detected_count - matched_count)
    processing_ms = payload.get("processing_ms")
    wall_ms = payload.get("wall_ms")
    quality = session.get("quality", {})
    overlay_path = review_dir / "overlays" / case_meta["case_id"] / f"{session_name}.jpg"

    draw_overlay(
        image_path=image_path,
        output_path=overlay_path,
        title=f"{case_meta['case_id']} / {session_name}",
        detections=detections,
        regions=regions,
    )

    image_row = {
        "case_id": case_meta["case_id"],
        "scenario": case_meta["scenario"],
        "pump_id": case_meta["pump_id"],
        "attendance_date": case_meta["attendance_date"],
        "session": session_name,
        "image_path": relative(image_path),
        "overlay_path": relative(overlay_path),
        "expected_faces": expected_count,
        "detected_faces": detected_count,
        "matched_faces": matched_count,
        "missed_faces": missed_count,
        "extra_faces": extra_count,
        "face_detection_recall": rate(matched_count, expected_count),
        "face_detection_precision": rate(matched_count, detected_count),
        "face_count_exact": detected_count == expected_count,
        "mean_box_iou": rate(iou_sum, matched_count),
        "iou_sum": round(iou_sum, 6),
        "contract_errors": contract_errors,
        "processing_ms": processing_ms,
        "wall_ms": wall_ms,
        "error": error,
        "quality_variant": quality.get("variant"),
        "brightness_mean": quality.get("brightness_mean"),
        "sharpness_edges_variance": quality.get("sharpness_edges_variance"),
        "face_size_label": quality.get("face_size_label"),
        "low_light": quality.get("low_light"),
        "blur": quality.get("blur"),
        "occlusion": quality.get("occlusion"),
    }
    result = {
        "row": image_row,
        "detections": detections,
        "regions": regions,
        "path": image_path,
        "overlay_path": overlay_path,
        "error": error,
    }
    return image_row, result


def assigned_worker_detections(session_result: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for detection in session_result["detections"]:
        assignment = detection.get("assignment")
        if not assignment or assignment["label_type"] != "worker":
            continue
        if detection.get("embedding") is None or detection.get("contract_errors"):
            continue
        rows.append(detection)
    return rows


def assigned_evening_detections(session_result: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for detection in session_result["detections"]:
        assignment = detection.get("assignment")
        if not assignment:
            continue
        if detection.get("embedding") is None or detection.get("contract_errors"):
            continue
        rows.append(detection)
    return rows


def predict_evening_identities(
    morning_detections: list[dict[str, Any]],
    evening_detections: list[dict[str, Any]],
    match_threshold: float,
) -> list[dict[str, Any]]:
    predictions: list[dict[str, Any]] = []
    for evening in evening_detections:
        best: tuple[float, dict[str, Any]] | None = None
        for morning in morning_detections:
            score = cosine(evening["embedding"], morning["embedding"])
            if best is None or score > best[0]:
                best = (score, morning)
        if best is None:
            predictions.append({"evening_detection": evening, "best_score": None, "predicted_worker_id": None})
            continue
        best_score, best_morning = best
        predicted_worker_id = None
        if best_score >= match_threshold:
            predicted_worker_id = best_morning["assignment"]["label_id"]
        predictions.append(
            {
                "evening_detection": evening,
                "best_score": round(best_score, 6),
                "predicted_worker_id": predicted_worker_id,
                "best_morning_worker_id": best_morning["assignment"]["label_id"],
            }
        )
    return predictions


def evaluate_case_threshold(
    case_meta: dict[str, Any],
    gt: dict[str, Any],
    session_results: dict[str, dict[str, Any]],
    match_threshold: float,
) -> dict[str, Any]:
    morning_workers = assigned_worker_detections(session_results["morning"])
    evening_all = assigned_evening_detections(session_results["evening"])
    evening_predictions = predict_evening_identities(morning_workers, evening_all, match_threshold)
    predicted_evening_workers = {
        prediction["predicted_worker_id"]
        for prediction in evening_predictions
        if prediction.get("predicted_worker_id")
    }
    predicted_morning_workers = {
        detection["assignment"]["label_id"]
        for detection in morning_workers
    }

    attendance_correct = 0
    attendance_total = 0
    false_absent = 0
    false_present = 0
    expected_present_total = 0
    expected_absent_total = 0

    for worker_id, expected in gt.get("expected_attendance", {}).items():
        for session_name in ("morning", "evening"):
            expected_present = expected.get(session_name) == "present"
            if session_name == "morning":
                predicted_present = worker_id in predicted_morning_workers
            else:
                predicted_present = worker_id in predicted_evening_workers
            attendance_total += 1
            if expected_present:
                expected_present_total += 1
                if not predicted_present:
                    false_absent += 1
            else:
                expected_absent_total += 1
                if predicted_present:
                    false_present += 1
            if expected_present == predicted_present:
                attendance_correct += 1

    pair_tp = pair_fp = pair_tn = pair_fn = 0
    for morning in morning_workers:
        for evening in evening_all:
            morning_id = morning["assignment"]["label_id"]
            evening_assignment = evening["assignment"]
            same_worker = evening_assignment["label_type"] == "worker" and morning_id == evening_assignment["label_id"]
            predicted_match = cosine(morning["embedding"], evening["embedding"]) >= match_threshold
            if same_worker and predicted_match:
                pair_tp += 1
            elif same_worker and not predicted_match:
                pair_fn += 1
            elif not same_worker and predicted_match:
                pair_fp += 1
            else:
                pair_tn += 1

    expected_matches = [match for match in gt.get("expected_matches", []) if match.get("should_match")]
    correct_expected_matches = 0
    missed_expected_matches = 0
    wrong_expected_matches = 0
    top1_total = 0
    top1_correct = 0

    morning_by_worker: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for detection in morning_workers:
        morning_by_worker[detection["assignment"]["label_id"]].append(detection)

    predictions_by_evening_label: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for prediction in evening_predictions:
        assignment = prediction["evening_detection"].get("assignment")
        if assignment and assignment["label_type"] == "worker":
            predictions_by_evening_label[assignment["label_id"]].append(prediction)

    for expected_match in expected_matches:
        morning_worker_id = expected_match["morning_worker_id"]
        evening_worker_id = expected_match["evening_worker_id"]
        morning_available = morning_worker_id in morning_by_worker
        evening_available = evening_worker_id in predictions_by_evening_label
        if not morning_available or not evening_available:
            missed_expected_matches += 1
            continue
        top1_total += 1
        best_prediction = max(
            predictions_by_evening_label[evening_worker_id],
            key=lambda item: item.get("best_score") if item.get("best_score") is not None else -999,
        )
        if best_prediction.get("predicted_worker_id") == evening_worker_id:
            correct_expected_matches += 1
            top1_correct += 1
        else:
            wrong_expected_matches += 1

    expected_unknown = len(gt["sessions"]["evening"].get("unknown_regions", []))
    unknown_correct = 0
    for prediction in evening_predictions:
        assignment = prediction["evening_detection"].get("assignment")
        if assignment and assignment["label_type"] == "unknown" and not prediction.get("predicted_worker_id"):
            unknown_correct += 1

    pair_precision = rate(pair_tp, pair_tp + pair_fp)
    pair_recall = rate(pair_tp, pair_tp + pair_fn)
    return {
        "threshold": match_threshold,
        "case_id": case_meta["case_id"],
        "scenario": case_meta["scenario"],
        "pump_id": case_meta["pump_id"],
        "attendance_date": case_meta["attendance_date"],
        "fraud_group_id": case_meta.get("fraud_group_id"),
        "fraud_worker_id": case_meta.get("fraud_worker_id"),
        "attendance_correct": attendance_correct,
        "attendance_total": attendance_total,
        "attendance_accuracy": rate(attendance_correct, attendance_total),
        "false_absent": false_absent,
        "expected_present_total": expected_present_total,
        "false_absent_rate": rate(false_absent, expected_present_total),
        "false_present": false_present,
        "expected_absent_total": expected_absent_total,
        "false_present_rate": rate(false_present, expected_absent_total),
        "expected_matches": len(expected_matches),
        "correct_expected_matches": correct_expected_matches,
        "missed_expected_matches": missed_expected_matches,
        "wrong_expected_matches": wrong_expected_matches,
        "expected_match_recall": rate(correct_expected_matches, len(expected_matches)),
        "top1_total": top1_total,
        "top1_correct": top1_correct,
        "top1_accuracy": rate(top1_correct, top1_total),
        "pair_tp": pair_tp,
        "pair_fp": pair_fp,
        "pair_tn": pair_tn,
        "pair_fn": pair_fn,
        "pair_precision": pair_precision,
        "pair_recall": pair_recall,
        "pair_f1": f1_score(pair_precision, pair_recall),
        "pair_accuracy": rate(pair_tp + pair_tn, pair_tp + pair_fp + pair_tn + pair_fn),
        "pair_false_match_rate": rate(pair_fp, pair_fp + pair_tn),
        "pair_false_non_match_rate": rate(pair_fn, pair_fn + pair_tp),
        "expected_unknown_evening": expected_unknown,
        "unknown_correct": unknown_correct,
        "unknown_handling_accuracy": rate(unknown_correct, expected_unknown),
    }


def evaluate_case(
    case_meta: dict[str, Any],
    gt: dict[str, Any],
    session_results: dict[str, dict[str, Any]],
    match_threshold: float,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    morning_workers = assigned_worker_detections(session_results["morning"])
    evening_all = assigned_evening_detections(session_results["evening"])
    evening_predictions = predict_evening_identities(morning_workers, evening_all, match_threshold)
    predicted_evening_workers = {
        prediction["predicted_worker_id"]
        for prediction in evening_predictions
        if prediction.get("predicted_worker_id")
    }
    predicted_morning_workers = {
        detection["assignment"]["label_id"]
        for detection in morning_workers
    }

    attendance_correct = 0
    attendance_total = 0
    false_absent = 0
    false_present = 0
    expected_present_total = 0
    expected_absent_total = 0

    for worker_id, expected in gt.get("expected_attendance", {}).items():
        for session_name in ("morning", "evening"):
            expected_present = expected.get(session_name) == "present"
            if session_name == "morning":
                predicted_present = worker_id in predicted_morning_workers
            else:
                predicted_present = worker_id in predicted_evening_workers
            attendance_total += 1
            if expected_present:
                expected_present_total += 1
                if not predicted_present:
                    false_absent += 1
            else:
                expected_absent_total += 1
                if predicted_present:
                    false_present += 1
            if expected_present == predicted_present:
                attendance_correct += 1

    pair_rows: list[dict[str, Any]] = []
    pair_tp = pair_fp = pair_tn = pair_fn = 0
    evening_worker_detections = assigned_worker_detections(session_results["evening"])
    for morning in morning_workers:
        for evening in evening_all:
            morning_id = morning["assignment"]["label_id"]
            evening_assignment = evening["assignment"]
            evening_id = evening_assignment["label_id"]
            same_worker = evening_assignment["label_type"] == "worker" and morning_id == evening_id
            score = cosine(morning["embedding"], evening["embedding"])
            predicted_match = score >= match_threshold
            if same_worker and predicted_match:
                pair_tp += 1
            elif same_worker and not predicted_match:
                pair_fn += 1
            elif not same_worker and predicted_match:
                pair_fp += 1
            else:
                pair_tn += 1
            pair_rows.append(
                {
                    "case_id": case_meta["case_id"],
                    "scenario": case_meta["scenario"],
                    "morning_worker_id": morning_id,
                    "evening_label_type": evening_assignment["label_type"],
                    "evening_label_id": evening_id,
                    "same_worker": same_worker,
                    "similarity": round(score, 6),
                    "predicted_match": predicted_match,
                }
            )

    expected_matches = [match for match in gt.get("expected_matches", []) if match.get("should_match")]
    correct_expected_matches = 0
    missed_expected_matches = 0
    wrong_expected_matches = 0
    top1_total = 0
    top1_correct = 0

    morning_by_worker: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for detection in morning_workers:
        morning_by_worker[detection["assignment"]["label_id"]].append(detection)

    predictions_by_evening_label: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for prediction in evening_predictions:
        assignment = prediction["evening_detection"].get("assignment")
        if assignment and assignment["label_type"] == "worker":
            predictions_by_evening_label[assignment["label_id"]].append(prediction)

    for expected_match in expected_matches:
        morning_worker_id = expected_match["morning_worker_id"]
        evening_worker_id = expected_match["evening_worker_id"]
        morning_available = morning_worker_id in morning_by_worker
        evening_available = evening_worker_id in predictions_by_evening_label
        if not morning_available or not evening_available:
            missed_expected_matches += 1
            continue
        top1_total += 1
        best_prediction = max(
            predictions_by_evening_label[evening_worker_id],
            key=lambda item: item.get("best_score") if item.get("best_score") is not None else -999,
        )
        if best_prediction.get("predicted_worker_id") == evening_worker_id:
            correct_expected_matches += 1
            top1_correct += 1
        else:
            wrong_expected_matches += 1

    expected_unknown = len(gt["sessions"]["evening"].get("unknown_regions", []))
    unknown_correct = 0
    for prediction in evening_predictions:
        assignment = prediction["evening_detection"].get("assignment")
        if assignment and assignment["label_type"] == "unknown" and not prediction.get("predicted_worker_id"):
            unknown_correct += 1

    case_row = {
        "case_id": case_meta["case_id"],
        "scenario": case_meta["scenario"],
        "pump_id": case_meta["pump_id"],
        "attendance_date": case_meta["attendance_date"],
        "fraud_group_id": case_meta.get("fraud_group_id"),
        "fraud_worker_id": case_meta.get("fraud_worker_id"),
        "morning_expected_faces": gt["sessions"]["morning"].get("expected_face_count"),
        "morning_detected_faces": session_results["morning"]["row"]["detected_faces"],
        "evening_expected_faces": gt["sessions"]["evening"].get("expected_face_count"),
        "evening_detected_faces": session_results["evening"]["row"]["detected_faces"],
        "attendance_correct": attendance_correct,
        "attendance_total": attendance_total,
        "attendance_accuracy": rate(attendance_correct, attendance_total),
        "false_absent": false_absent,
        "expected_present_total": expected_present_total,
        "false_absent_rate": rate(false_absent, expected_present_total),
        "false_present": false_present,
        "expected_absent_total": expected_absent_total,
        "false_present_rate": rate(false_present, expected_absent_total),
        "expected_matches": len(expected_matches),
        "correct_expected_matches": correct_expected_matches,
        "missed_expected_matches": missed_expected_matches,
        "wrong_expected_matches": wrong_expected_matches,
        "expected_match_recall": rate(correct_expected_matches, len(expected_matches)),
        "top1_total": top1_total,
        "top1_correct": top1_correct,
        "top1_accuracy": rate(top1_correct, top1_total),
        "pair_tp": pair_tp,
        "pair_fp": pair_fp,
        "pair_tn": pair_tn,
        "pair_fn": pair_fn,
        "pair_precision": rate(pair_tp, pair_tp + pair_fp),
        "pair_recall": rate(pair_tp, pair_tp + pair_fn),
        "pair_false_match_rate": rate(pair_fp, pair_fp + pair_tn),
        "expected_unknown_evening": expected_unknown,
        "unknown_correct": unknown_correct,
        "unknown_handling_accuracy": rate(unknown_correct, expected_unknown),
    }

    all_worker_detections: list[dict[str, Any]] = []
    for session_name, session_result in session_results.items():
        for detection in assigned_worker_detections(session_result):
            all_worker_detections.append(
                {
                    "case_id": case_meta["case_id"],
                    "scenario": case_meta["scenario"],
                    "pump_id": case_meta["pump_id"],
                    "attendance_date": case_meta["attendance_date"],
                    "session": session_name,
                    "worker_id": detection["assignment"]["label_id"],
                    "embedding": detection["embedding"],
                    "fraud_group_id": case_meta.get("fraud_group_id"),
                    "fraud_worker_id": case_meta.get("fraud_worker_id"),
                }
            )
    return case_row, pair_rows, all_worker_detections


def latency_values(image_rows: list[dict[str, Any]]) -> list[float]:
    values: list[float] = []
    for row in image_rows:
        value = row.get("processing_ms")
        if isinstance(value, (int, float)):
            values.append(float(value))
    return values


def aggregate_metrics(case_rows: list[dict[str, Any]], image_rows: list[dict[str, Any]]) -> dict[str, Any]:
    expected_faces = sum(int(row["expected_faces"]) for row in image_rows)
    detected_faces = sum(int(row["detected_faces"]) for row in image_rows)
    matched_faces = sum(int(row["matched_faces"]) for row in image_rows)
    missed_faces = sum(int(row["missed_faces"]) for row in image_rows)
    extra_faces = sum(int(row["extra_faces"]) for row in image_rows)
    face_count_exact = sum(1 for row in image_rows if row["face_count_exact"])
    iou_sum = sum(float(row["iou_sum"]) for row in image_rows)
    contract_errors = sum(int(row["contract_errors"]) for row in image_rows)
    failed_images = sum(1 for row in image_rows if row.get("error"))
    latency = latency_values(image_rows)

    attendance_correct = sum(int(row["attendance_correct"]) for row in case_rows)
    attendance_total = sum(int(row["attendance_total"]) for row in case_rows)
    false_absent = sum(int(row["false_absent"]) for row in case_rows)
    expected_present_total = sum(int(row["expected_present_total"]) for row in case_rows)
    false_present = sum(int(row["false_present"]) for row in case_rows)
    expected_absent_total = sum(int(row["expected_absent_total"]) for row in case_rows)

    expected_matches = sum(int(row["expected_matches"]) for row in case_rows)
    correct_expected_matches = sum(int(row["correct_expected_matches"]) for row in case_rows)
    missed_expected_matches = sum(int(row["missed_expected_matches"]) for row in case_rows)
    wrong_expected_matches = sum(int(row["wrong_expected_matches"]) for row in case_rows)
    top1_total = sum(int(row["top1_total"]) for row in case_rows)
    top1_correct = sum(int(row["top1_correct"]) for row in case_rows)
    pair_tp = sum(int(row["pair_tp"]) for row in case_rows)
    pair_fp = sum(int(row["pair_fp"]) for row in case_rows)
    pair_tn = sum(int(row["pair_tn"]) for row in case_rows)
    pair_fn = sum(int(row["pair_fn"]) for row in case_rows)

    expected_unknown = sum(int(row["expected_unknown_evening"]) for row in case_rows)
    unknown_correct = sum(int(row["unknown_correct"]) for row in case_rows)

    return {
        "cases": len(case_rows),
        "images": len(image_rows),
        "expected_faces": expected_faces,
        "detected_faces": detected_faces,
        "matched_faces": matched_faces,
        "missed_faces": missed_faces,
        "extra_faces": extra_faces,
        "face_detection_recall": rate(matched_faces, expected_faces),
        "face_detection_precision": rate(matched_faces, detected_faces),
        "face_count_exact_rate": rate(face_count_exact, len(image_rows)),
        "mean_box_iou": rate(iou_sum, matched_faces),
        "contract_errors": contract_errors,
        "failed_images": failed_images,
        "attendance_accuracy": rate(attendance_correct, attendance_total),
        "false_absent_rate": rate(false_absent, expected_present_total),
        "false_present_rate": rate(false_present, expected_absent_total),
        "expected_match_recall": rate(correct_expected_matches, expected_matches),
        "missed_expected_matches": missed_expected_matches,
        "wrong_expected_matches": wrong_expected_matches,
        "top1_accuracy": rate(top1_correct, top1_total),
        "pair_precision": rate(pair_tp, pair_tp + pair_fp),
        "pair_recall": rate(pair_tp, pair_tp + pair_fn),
        "pair_false_match_rate": rate(pair_fp, pair_fp + pair_tn),
        "unknown_handling_accuracy": rate(unknown_correct, expected_unknown),
        "avg_processing_ms": round(statistics.mean(latency), 3) if latency else None,
        "p95_processing_ms": percentile(latency, 0.95),
    }


def scenario_metrics(case_rows: list[dict[str, Any]], image_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    scenarios = sorted({row["scenario"] for row in case_rows})
    rows: list[dict[str, Any]] = []
    for scenario in scenarios:
        scenario_case_rows = [row for row in case_rows if row["scenario"] == scenario]
        scenario_image_rows = [row for row in image_rows if row["scenario"] == scenario]
        rows.append({"scenario": scenario, **aggregate_metrics(scenario_case_rows, scenario_image_rows)})
    return rows


def evaluate_fraud(
    detections: list[dict[str, Any]],
    case_rows: list[dict[str, Any]],
    match_threshold: float,
) -> dict[str, Any]:
    fraud_groups: dict[str, dict[str, Any]] = {}
    for row in case_rows:
        group_id = row.get("fraud_group_id")
        worker_id = row.get("fraud_worker_id")
        if group_id and worker_id:
            fraud_groups.setdefault(str(group_id), {"worker_id": worker_id, "cases": set()})
            fraud_groups[str(group_id)]["cases"].add(row["case_id"])

    detected_groups = 0
    fraud_group_rows: list[dict[str, Any]] = []
    for group_id, group in fraud_groups.items():
        worker_id = group["worker_id"]
        group_detections = [
            detection
            for detection in detections
            if detection["worker_id"] == worker_id and detection.get("fraud_group_id") == group_id
        ]
        best_score = None
        detected = False
        for left_index, left in enumerate(group_detections):
            for right in group_detections[left_index + 1 :]:
                if left["pump_id"] == right["pump_id"]:
                    continue
                score = cosine(left["embedding"], right["embedding"])
                best_score = score if best_score is None else max(best_score, score)
                if score >= match_threshold:
                    detected = True
        if detected:
            detected_groups += 1
        fraud_group_rows.append(
            {
                "fraud_group_id": group_id,
                "worker_id": worker_id,
                "cases": ",".join(sorted(group["cases"])),
                "detected": detected,
                "best_cross_pump_similarity": round(best_score, 6) if best_score is not None else None,
            }
        )

    false_comparisons = 0
    true_negative_comparisons = 0
    comparisons_total = 0
    for left_index, left in enumerate(detections):
        for right in detections[left_index + 1 :]:
            if left["pump_id"] == right["pump_id"]:
                continue
            if left["attendance_date"] != right["attendance_date"]:
                continue
            if left["worker_id"] == right["worker_id"]:
                continue
            comparisons_total += 1
            score = cosine(left["embedding"], right["embedding"])
            if score >= match_threshold:
                false_comparisons += 1
            else:
                true_negative_comparisons += 1

    return {
        "known_fraud_groups": len(fraud_groups),
        "known_fraud_groups_detected": detected_groups,
        "fraud_duplicate_recall": rate(detected_groups, len(fraud_groups)),
        "cross_pump_different_worker_comparisons": comparisons_total,
        "cross_pump_false_duplicate_count": false_comparisons,
        "cross_pump_false_duplicate_rate": rate(false_comparisons, false_comparisons + true_negative_comparisons),
        "groups": fraud_group_rows,
    }


def aggregate_threshold_case_rows(case_rows: list[dict[str, Any]]) -> dict[str, Any]:
    attendance_correct = sum(int(row["attendance_correct"]) for row in case_rows)
    attendance_total = sum(int(row["attendance_total"]) for row in case_rows)
    false_absent = sum(int(row["false_absent"]) for row in case_rows)
    expected_present_total = sum(int(row["expected_present_total"]) for row in case_rows)
    false_present = sum(int(row["false_present"]) for row in case_rows)
    expected_absent_total = sum(int(row["expected_absent_total"]) for row in case_rows)

    expected_matches = sum(int(row["expected_matches"]) for row in case_rows)
    correct_expected_matches = sum(int(row["correct_expected_matches"]) for row in case_rows)
    missed_expected_matches = sum(int(row["missed_expected_matches"]) for row in case_rows)
    wrong_expected_matches = sum(int(row["wrong_expected_matches"]) for row in case_rows)
    top1_total = sum(int(row["top1_total"]) for row in case_rows)
    top1_correct = sum(int(row["top1_correct"]) for row in case_rows)

    pair_tp = sum(int(row["pair_tp"]) for row in case_rows)
    pair_fp = sum(int(row["pair_fp"]) for row in case_rows)
    pair_tn = sum(int(row["pair_tn"]) for row in case_rows)
    pair_fn = sum(int(row["pair_fn"]) for row in case_rows)
    pair_precision = rate(pair_tp, pair_tp + pair_fp)
    pair_recall = rate(pair_tp, pair_tp + pair_fn)

    expected_unknown = sum(int(row["expected_unknown_evening"]) for row in case_rows)
    unknown_correct = sum(int(row["unknown_correct"]) for row in case_rows)

    return {
        "cases": len(case_rows),
        "attendance_correct": attendance_correct,
        "attendance_total": attendance_total,
        "attendance_accuracy": rate(attendance_correct, attendance_total),
        "false_absent": false_absent,
        "expected_present_total": expected_present_total,
        "false_absent_rate": rate(false_absent, expected_present_total),
        "false_present": false_present,
        "expected_absent_total": expected_absent_total,
        "false_present_rate": rate(false_present, expected_absent_total),
        "expected_matches": expected_matches,
        "correct_expected_matches": correct_expected_matches,
        "missed_expected_matches": missed_expected_matches,
        "wrong_expected_matches": wrong_expected_matches,
        "expected_match_recall": rate(correct_expected_matches, expected_matches),
        "top1_total": top1_total,
        "top1_correct": top1_correct,
        "top1_accuracy": rate(top1_correct, top1_total),
        "pair_tp": pair_tp,
        "pair_fp": pair_fp,
        "pair_tn": pair_tn,
        "pair_fn": pair_fn,
        "pair_precision": pair_precision,
        "pair_recall": pair_recall,
        "pair_f1": f1_score(pair_precision, pair_recall),
        "pair_accuracy": rate(pair_tp + pair_tn, pair_tp + pair_fp + pair_tn + pair_fn),
        "pair_false_match_rate": rate(pair_fp, pair_fp + pair_tn),
        "pair_false_non_match_rate": rate(pair_fn, pair_fn + pair_tp),
        "expected_unknown_evening": expected_unknown,
        "unknown_correct": unknown_correct,
        "unknown_handling_accuracy": rate(unknown_correct, expected_unknown),
    }


def threshold_sweep(
    threshold_case_rows: list[dict[str, Any]],
    worker_detections: list[dict[str, Any]],
    case_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    thresholds = sorted({float(row["threshold"]) for row in threshold_case_rows})
    for threshold in thresholds:
        rows_for_threshold = [row for row in threshold_case_rows if float(row["threshold"]) == threshold]
        aggregate = aggregate_threshold_case_rows(rows_for_threshold)
        fraud = evaluate_fraud(worker_detections, case_rows, threshold)
        rows.append(
            {
                "threshold": threshold,
                **aggregate,
                "known_fraud_groups": fraud["known_fraud_groups"],
                "known_fraud_groups_detected": fraud["known_fraud_groups_detected"],
                "fraud_duplicate_recall": fraud["fraud_duplicate_recall"],
                "cross_pump_false_duplicate_count": fraud["cross_pump_false_duplicate_count"],
                "cross_pump_different_worker_comparisons": fraud["cross_pump_different_worker_comparisons"],
                "cross_pump_false_duplicate_rate": fraud["cross_pump_false_duplicate_rate"],
            }
        )
    return rows


def threshold_scenario_metrics(threshold_case_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    thresholds = sorted({float(row["threshold"]) for row in threshold_case_rows})
    scenarios = sorted({row["scenario"] for row in threshold_case_rows})
    for threshold in thresholds:
        for scenario in scenarios:
            matching_rows = [
                row
                for row in threshold_case_rows
                if float(row["threshold"]) == threshold and row["scenario"] == scenario
            ]
            rows.append({"threshold": threshold, "scenario": scenario, **aggregate_threshold_case_rows(matching_rows)})
    return rows


def similarity_distribution(pair_rows: list[dict[str, Any]]) -> dict[str, Any]:
    same_scores = [float(row["similarity"]) for row in pair_rows if row["same_worker"]]
    different_scores = [float(row["similarity"]) for row in pair_rows if not row["same_worker"]]
    return {
        "same_worker": {
            "count": len(same_scores),
            "min": round(min(same_scores), 6) if same_scores else None,
            "p05": percentile(same_scores, 0.05),
            "p50": percentile(same_scores, 0.50),
            "p95": percentile(same_scores, 0.95),
            "max": round(max(same_scores), 6) if same_scores else None,
            "mean": round(statistics.mean(same_scores), 6) if same_scores else None,
        },
        "different_worker": {
            "count": len(different_scores),
            "min": round(min(different_scores), 6) if different_scores else None,
            "p05": percentile(different_scores, 0.05),
            "p50": percentile(different_scores, 0.50),
            "p95": percentile(different_scores, 0.95),
            "max": round(max(different_scores), 6) if different_scores else None,
            "mean": round(statistics.mean(different_scores), 6) if different_scores else None,
        },
    }


def recommended_threshold(sweep_rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [
        row
        for row in sweep_rows
        if (row.get("pair_false_match_rate") or 0) <= 0.01
        and (row.get("false_present_rate") or 0) <= 0.02
        and (row.get("cross_pump_false_duplicate_rate") or 0) <= 0.01
    ]
    candidates = eligible or sweep_rows
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda row: (
            row.get("attendance_accuracy") if row.get("attendance_accuracy") is not None else -1,
            row.get("expected_match_recall") if row.get("expected_match_recall") is not None else -1,
            row.get("pair_f1") if row.get("pair_f1") is not None else -1,
            row.get("fraud_duplicate_recall") if row.get("fraud_duplicate_recall") is not None else -1,
            -(row.get("pair_false_match_rate") if row.get("pair_false_match_rate") is not None else 1),
            -(row.get("cross_pump_false_duplicate_rate") if row.get("cross_pump_false_duplicate_rate") is not None else 1),
        ),
    )


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if fields is None:
        fields = sorted({key for row in rows for key in row.keys()})
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def html_metric_table(title: str, rows: list[dict[str, Any]], fields: list[tuple[str, str, str]]) -> str:
    head = "".join(f"<th>{html.escape(label)}</th>" for _, label, _ in fields)
    body = []
    for row in rows:
        cells = []
        for key, _, kind in fields:
            value = row.get(key)
            if kind == "pct":
                text = pct(value)
            elif kind == "ms":
                text = "n/a" if value is None else f"{float(value):.1f} ms"
            else:
                text = "" if value is None else str(value)
            cells.append(f"<td>{html.escape(text)}</td>")
        body.append(f"<tr>{''.join(cells)}</tr>")
    return f"<h2>{html.escape(title)}</h2><table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def write_report(
    run_dir: Path,
    dataset: dict[str, Any],
    overall: dict[str, Any],
    scenarios: list[dict[str, Any]],
    case_rows: list[dict[str, Any]],
    image_rows: list[dict[str, Any]],
    fraud: dict[str, Any],
    sweep_rows: list[dict[str, Any]],
    threshold_scenarios: list[dict[str, Any]],
    similarity: dict[str, Any],
) -> None:
    review_dir = run_dir / "review"
    review_dir.mkdir(parents=True, exist_ok=True)
    worst_cases = sorted(
        case_rows,
        key=lambda row: (
            row.get("attendance_accuracy") if row.get("attendance_accuracy") is not None else -1,
            row.get("expected_match_recall") if row.get("expected_match_recall") is not None else -1,
        ),
    )[:20]

    overall_rows = [{**overall, **{
        "dataset_version": dataset.get("dataset_version"),
        "scenario_count": len(dataset.get("scenario_counts", {})),
    }}]
    scenario_fields = [
        ("scenario", "Scenario", "text"),
        ("cases", "Cases", "text"),
        ("images", "Images", "text"),
        ("face_detection_recall", "Detection Recall", "pct"),
        ("face_detection_precision", "Detection Precision", "pct"),
        ("face_count_exact_rate", "Face Count Exact", "pct"),
        ("mean_box_iou", "Mean Box IoU", "text"),
        ("expected_match_recall", "Match Recall", "pct"),
        ("top1_accuracy", "Top-1 Accuracy", "pct"),
        ("attendance_accuracy", "Attendance Accuracy", "pct"),
        ("false_absent_rate", "False Absent", "pct"),
        ("false_present_rate", "False Present", "pct"),
        ("pair_false_match_rate", "False Match Rate", "pct"),
        ("avg_processing_ms", "Avg Latency", "ms"),
        ("p95_processing_ms", "P95 Latency", "ms"),
    ]
    overall_fields = [
        ("dataset_version", "Dataset", "text"),
        ("cases", "Cases", "text"),
        ("images", "Images", "text"),
        ("expected_faces", "Expected Faces", "text"),
        ("detected_faces", "Detected Faces", "text"),
        ("face_detection_recall", "Detection Recall", "pct"),
        ("face_detection_precision", "Detection Precision", "pct"),
        ("face_count_exact_rate", "Face Count Exact", "pct"),
        ("expected_match_recall", "Match Recall", "pct"),
        ("attendance_accuracy", "Attendance Accuracy", "pct"),
        ("pair_false_match_rate", "False Match Rate", "pct"),
        ("contract_errors", "Contract Errors", "text"),
        ("failed_images", "Failed Images", "text"),
        ("p95_processing_ms", "P95 Latency", "ms"),
    ]
    fraud_rows = [
        {
            "known_fraud_groups": fraud["known_fraud_groups"],
            "known_fraud_groups_detected": fraud["known_fraud_groups_detected"],
            "fraud_duplicate_recall": fraud["fraud_duplicate_recall"],
            "cross_pump_false_duplicate_rate": fraud["cross_pump_false_duplicate_rate"],
            "cross_pump_false_duplicate_count": fraud["cross_pump_false_duplicate_count"],
            "cross_pump_different_worker_comparisons": fraud["cross_pump_different_worker_comparisons"],
        }
    ]
    fraud_fields = [
        ("known_fraud_groups", "Known Fraud Groups", "text"),
        ("known_fraud_groups_detected", "Detected", "text"),
        ("fraud_duplicate_recall", "Fraud Recall", "pct"),
        ("cross_pump_false_duplicate_rate", "Cross-Pump False Duplicate Rate", "pct"),
        ("cross_pump_false_duplicate_count", "False Duplicate Count", "text"),
        ("cross_pump_different_worker_comparisons", "Different-Worker Comparisons", "text"),
    ]

    case_cards = []
    image_lookup = defaultdict(dict)
    for row in image_rows:
        image_lookup[row["case_id"]][row["session"]] = row

    for row in worst_cases:
        morning = image_lookup[row["case_id"]].get("morning", {})
        evening = image_lookup[row["case_id"]].get("evening", {})
        morning_overlay = os.path.relpath(ROOT / morning.get("overlay_path", ""), review_dir).replace("\\", "/")
        evening_overlay = os.path.relpath(ROOT / evening.get("overlay_path", ""), review_dir).replace("\\", "/")
        case_cards.append(
            f"""
            <article class="case-card">
              <h3>{html.escape(row['case_id'])}</h3>
              <p>{html.escape(row['scenario'])} | attendance {pct(row.get('attendance_accuracy'))} | match {pct(row.get('expected_match_recall'))}</p>
              <div class="images">
                <figure><img src="{html.escape(morning_overlay)}" alt="Morning overlay"><figcaption>Morning: {morning.get('detected_faces')} / {morning.get('expected_faces')}</figcaption></figure>
                <figure><img src="{html.escape(evening_overlay)}" alt="Evening overlay"><figcaption>Evening: {evening.get('detected_faces')} / {evening.get('expected_faces')}</figcaption></figure>
              </div>
            </article>
            """
        )

    recommended = recommended_threshold(sweep_rows)
    sweep_preview = sorted(
        sweep_rows,
        key=lambda row: (
            row.get("attendance_accuracy") if row.get("attendance_accuracy") is not None else -1,
            row.get("expected_match_recall") if row.get("expected_match_recall") is not None else -1,
            row.get("pair_f1") if row.get("pair_f1") is not None else -1,
        ),
        reverse=True,
    )
    sweep_fields = [
        ("threshold", "Threshold", "text"),
        ("attendance_accuracy", "Attendance", "pct"),
        ("expected_match_recall", "Expected Match Recall", "pct"),
        ("top1_accuracy", "Top-1", "pct"),
        ("pair_precision", "Pair Precision", "pct"),
        ("pair_recall", "Pair Recall", "pct"),
        ("pair_f1", "Pair F1", "text"),
        ("pair_false_match_rate", "False Match", "pct"),
        ("pair_false_non_match_rate", "False Non-Match", "pct"),
        ("false_absent_rate", "False Absent", "pct"),
        ("false_present_rate", "False Present", "pct"),
        ("unknown_handling_accuracy", "Unknown Handling", "pct"),
        ("fraud_duplicate_recall", "Fraud Recall", "pct"),
        ("cross_pump_false_duplicate_rate", "False Fraud Flag", "pct"),
        ("pair_tp", "TP", "text"),
        ("pair_fp", "FP", "text"),
        ("pair_fn", "FN", "text"),
        ("pair_tn", "TN", "text"),
    ]
    scenario_threshold_preview = sorted(
        threshold_scenarios,
        key=lambda row: (
            row["scenario"],
            float(row["threshold"]),
        ),
    )
    threshold_scenario_fields = [
        ("threshold", "Threshold", "text"),
        ("scenario", "Scenario", "text"),
        ("cases", "Cases", "text"),
        ("attendance_accuracy", "Attendance", "pct"),
        ("expected_match_recall", "Match Recall", "pct"),
        ("pair_precision", "Pair Precision", "pct"),
        ("pair_recall", "Pair Recall", "pct"),
        ("pair_false_match_rate", "False Match", "pct"),
        ("false_absent_rate", "False Absent", "pct"),
        ("false_present_rate", "False Present", "pct"),
        ("unknown_handling_accuracy", "Unknown Handling", "pct"),
    ]
    similarity_rows = [
        {"pair_type": "same_worker", **similarity.get("same_worker", {})},
        {"pair_type": "different_worker", **similarity.get("different_worker", {})},
    ]
    similarity_fields = [
        ("pair_type", "Pair Type", "text"),
        ("count", "Pairs", "text"),
        ("min", "Min", "text"),
        ("p05", "P05", "text"),
        ("p50", "P50", "text"),
        ("p95", "P95", "text"),
        ("max", "Max", "text"),
        ("mean", "Mean", "text"),
    ]

    index_html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Golden Small Group Evaluation</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; color: #0b2428; background: #f7f9f9; }}
    h1, h2, h3 {{ margin: 0 0 10px; }}
    h2 {{ margin-top: 28px; }}
    p {{ color: #365154; }}
    table {{ border-collapse: collapse; width: 100%; background: #fff; margin: 12px 0 24px; }}
    th, td {{ border: 1px solid #cbd3d3; padding: 8px 10px; text-align: left; font-size: 14px; }}
    th {{ background: #e7eded; }}
    .case-card {{ background: #fff; border: 1px solid #cbd3d3; padding: 16px; margin: 18px 0; }}
    .images {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }}
    figure {{ margin: 0; }}
    img {{ max-width: 100%; border: 1px solid #bbbfbf; }}
    figcaption {{ font-size: 13px; color: #365154; margin-top: 6px; }}
    code {{ background: #e7eded; padding: 2px 5px; }}
  </style>
</head>
<body>
  <h1>Golden Small Group Evaluation</h1>
  <p>Dataset: <code>{html.escape(str(dataset.get('dataset_version')))}</code>. This report shows metric scores, not only pass/fail gates.</p>
  <p>Recommended threshold from this run: <code>{html.escape(str(recommended.get('threshold') if recommended else 'n/a'))}</code>. The recommendation maximizes pair-level F1 while keeping false-match rate at or below 1% when possible.</p>
  {html_metric_table("Overall Metrics", overall_rows, overall_fields)}
  {html_metric_table("Scenario Metrics", scenarios, scenario_fields)}
  {html_metric_table("Fraud Duplicate Metrics", fraud_rows, fraud_fields)}
  {html_metric_table("Similarity Distribution", similarity_rows, similarity_fields)}
  {html_metric_table("Threshold Decision Matrix", sweep_preview, sweep_fields)}
  {html_metric_table("Threshold By Scenario Matrix", scenario_threshold_preview, threshold_scenario_fields)}
  <h2>Lowest Scoring / Review Cases</h2>
  {''.join(case_cards)}
</body>
</html>
"""
    (review_dir / "index.html").write_text(index_html, encoding="utf-8")

    report_md = f"""# Golden Small Group Evaluation

- Dataset: `{dataset.get('dataset_version')}`
- Cases: {overall['cases']}
- Images: {overall['images']}
- Expected faces: {overall['expected_faces']}
- Detected faces: {overall['detected_faces']}
- Detection recall: {pct(overall['face_detection_recall'])}
- Detection precision: {pct(overall['face_detection_precision'])}
- Attendance accuracy: {pct(overall['attendance_accuracy'])}
- Match recall: {pct(overall['expected_match_recall'])}
- False match rate: {pct(overall['pair_false_match_rate'])}
- Fraud duplicate recall: {pct(fraud['fraud_duplicate_recall'])}
- P95 latency: {overall['p95_processing_ms']} ms
- Recommended pair threshold: {recommended.get('threshold') if recommended else 'n/a'}

Open `review/index.html` for visual overlays and scenario tables.
"""
    (run_dir / "report.md").write_text(report_md, encoding="utf-8")


def print_console_summary(overall: dict[str, Any], scenarios: list[dict[str, Any]], fraud: dict[str, Any], run_dir: Path) -> None:
    print("\nGolden small-group evaluation complete")
    print(f"Output: {relative(run_dir)}")
    print(
        "Overall: "
        f"detection recall {pct(overall['face_detection_recall'])}, "
        f"precision {pct(overall['face_detection_precision'])}, "
        f"attendance {pct(overall['attendance_accuracy'])}, "
        f"match recall {pct(overall['expected_match_recall'])}, "
        f"false match {pct(overall['pair_false_match_rate'])}, "
        f"p95 latency {overall['p95_processing_ms']} ms"
    )
    print(
        "Fraud: "
        f"{fraud['known_fraud_groups_detected']}/{fraud['known_fraud_groups']} known duplicate groups, "
        f"false duplicate rate {pct(fraud['cross_pump_false_duplicate_rate'])}"
    )
    print("\nScenario summary")
    print("scenario,cases,detection_recall,match_recall,attendance_accuracy,false_match_rate,p95_latency_ms")
    for row in scenarios:
        print(
            ",".join(
                [
                    str(row["scenario"]),
                    str(row["cases"]),
                    pct(row["face_detection_recall"]),
                    pct(row["expected_match_recall"]),
                    pct(row["attendance_accuracy"]),
                    pct(row["pair_false_match_rate"]),
                    str(row["p95_processing_ms"]),
                ]
            )
        )


def run(args: argparse.Namespace) -> int:
    dataset_dir = Path(args.dataset_dir).resolve()
    dataset = load_json(dataset_dir / "dataset.json")
    cases = dataset.get("cases", [])
    if args.limit_cases:
        cases = cases[: args.limit_cases]

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_id = args.run_id or f"{timestamp}__golden-small-group__{dataset.get('dataset_version', 'dataset')}"
    output_root = Path(args.output_root).resolve()
    run_dir = output_root / run_id
    suffix = 2
    while run_dir.exists():
        run_dir = output_root / f"{run_id}-{suffix}"
        suffix += 1
    review_dir = run_dir / "review"
    run_dir.mkdir(parents=True, exist_ok=True)
    review_dir.mkdir(parents=True, exist_ok=True)

    write_json(
        run_dir / "run-config.json",
        {
            "dataset_dir": relative(dataset_dir),
            "ai_url": args.ai_url,
            "match_threshold": args.match_threshold,
            "iou_threshold": args.iou_threshold,
            "limit_cases": args.limit_cases,
            "started_at": datetime.now().isoformat(timespec="seconds"),
        },
    )

    image_rows: list[dict[str, Any]] = []
    case_rows: list[dict[str, Any]] = []
    threshold_case_rows: list[dict[str, Any]] = []
    pair_rows: list[dict[str, Any]] = []
    worker_detections: list[dict[str, Any]] = []

    for index, case_meta in enumerate(cases, start=1):
        gt = load_json(dataset_dir / case_meta["ground_truth"])
        session_results: dict[str, dict[str, Any]] = {}
        for session_name in ("morning", "evening"):
            image_row, session_result = evaluate_image(
                dataset_dir=dataset_dir,
                case_meta=case_meta,
                gt=gt,
                session_name=session_name,
                ai_url=args.ai_url.rstrip("/"),
                run_id=run_dir.name,
                review_dir=review_dir,
                iou_threshold=args.iou_threshold,
            )
            image_rows.append(image_row)
            session_results[session_name] = session_result
        case_row, case_pair_rows, case_worker_detections = evaluate_case(
            case_meta,
            gt,
            session_results,
            args.match_threshold,
        )
        case_rows.append(case_row)
        for threshold in THRESHOLDS:
            threshold_case_rows.append(evaluate_case_threshold(case_meta, gt, session_results, threshold))
        pair_rows.extend(case_pair_rows)
        worker_detections.extend(case_worker_detections)
        print(f"[{index}/{len(cases)}] {case_meta['case_id']} done", flush=True)

    scenarios = scenario_metrics(case_rows, image_rows)
    overall = aggregate_metrics(case_rows, image_rows)
    fraud = evaluate_fraud(worker_detections, case_rows, args.match_threshold)
    sweep_rows = threshold_sweep(threshold_case_rows, worker_detections, case_rows)
    threshold_scenarios = threshold_scenario_metrics(threshold_case_rows)
    similarity = similarity_distribution(pair_rows)
    recommended = recommended_threshold(sweep_rows)

    metrics = {
        "run": {
            "id": run_dir.name,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "ai_url": args.ai_url,
            "match_threshold": args.match_threshold,
            "iou_threshold": args.iou_threshold,
        },
        "dataset": {
            "version": dataset.get("dataset_version"),
            "case_count": len(cases),
            "scenario_counts": dataset.get("scenario_counts"),
        },
        "overall": overall,
        "scenarios": scenarios,
        "fraud": {key: value for key, value in fraud.items() if key != "groups"},
        "similarity_distribution": similarity,
        "threshold_sweep": sweep_rows,
        "recommended_threshold": recommended,
    }

    write_json(run_dir / "metrics.json", metrics)
    write_json(run_dir / "fraud-groups.json", fraud["groups"])
    write_csv(run_dir / "image-metrics.csv", image_rows)
    write_csv(run_dir / "case-metrics.csv", case_rows)
    write_csv(run_dir / "match-pairs.csv", pair_rows)
    write_csv(run_dir / "scenario-metrics.csv", scenarios)
    threshold_fields = [
        "threshold",
        "cases",
        "attendance_accuracy",
        "expected_match_recall",
        "top1_accuracy",
        "pair_precision",
        "pair_recall",
        "pair_f1",
        "pair_accuracy",
        "pair_false_match_rate",
        "pair_false_non_match_rate",
        "false_absent_rate",
        "false_present_rate",
        "unknown_handling_accuracy",
        "fraud_duplicate_recall",
        "known_fraud_groups_detected",
        "known_fraud_groups",
        "cross_pump_false_duplicate_rate",
        "cross_pump_false_duplicate_count",
        "cross_pump_different_worker_comparisons",
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
        "unknown_correct",
        "expected_unknown_evening",
    ]
    threshold_case_fields = [
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
        "fraud_group_id",
        "fraud_worker_id",
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
    threshold_scenario_fields = [
        "threshold",
        "scenario",
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
    write_csv(run_dir / "threshold-sweep.csv", sweep_rows, threshold_fields)
    write_csv(run_dir / "threshold-case-metrics.csv", threshold_case_rows, threshold_case_fields)
    write_csv(run_dir / "threshold-scenario-metrics.csv", threshold_scenarios, threshold_scenario_fields)
    write_report(
        run_dir,
        dataset,
        overall,
        scenarios,
        case_rows,
        image_rows,
        fraud,
        sweep_rows,
        threshold_scenarios,
        similarity,
    )
    print_console_summary(overall, scenarios, fraud, run_dir)
    if recommended:
        print(
            "Recommended pair threshold: "
            f"{recommended['threshold']} "
            f"(attendance {pct(recommended.get('attendance_accuracy'))}, "
            f"match recall {pct(recommended.get('expected_match_recall'))}, "
            f"pair F1 {metric_value(recommended.get('pair_f1'))}, "
            f"false match {pct(recommended.get('pair_false_match_rate'))})"
        )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run golden small-group attendance evaluation.")
    parser.add_argument("--dataset-dir", default=str(DEFAULT_DATASET_DIR))
    parser.add_argument("--ai-url", default=DEFAULT_AI_URL)
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    parser.add_argument("--match-threshold", type=float, default=DEFAULT_MATCH_THRESHOLD)
    parser.add_argument("--iou-threshold", type=float, default=DEFAULT_IOU_THRESHOLD)
    parser.add_argument("--limit-cases", type=int, default=None)
    parser.add_argument("--run-id", default=None)
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(run(parse_args()))
