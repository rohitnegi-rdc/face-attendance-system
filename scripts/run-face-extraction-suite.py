"""Run the real AI face extractor against the 20-photo E2E corpus."""

from __future__ import annotations

import base64
import csv
import hashlib
import json
import math
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "tests" / "fixtures" / "group-e2e"
OUTPUT_ROOT = ROOT / "test-output" / "attendance-e2e"
AI_URL = os.getenv("AI_SERVICE_URL", "http://127.0.0.1:6102")
THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.68"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def greedy_pairs(
    left: list[dict[str, Any]], right: list[dict[str, Any]]
) -> list[tuple[int, int, float]]:
    candidates = sorted(
        (
            (cosine(a["embedding"], b["embedding"]), left_index, right_index)
            for left_index, a in enumerate(left)
            for right_index, b in enumerate(right)
        ),
        reverse=True,
    )
    used_left: set[int] = set()
    used_right: set[int] = set()
    pairs: list[tuple[int, int, float]] = []
    for similarity, left_index, right_index in candidates:
        if left_index in used_left or right_index in used_right:
            continue
        used_left.add(left_index)
        used_right.add(right_index)
        pairs.append((left_index, right_index, similarity))
    return pairs


def extract(photo: Path, request_id: str) -> dict[str, Any]:
    with photo.open("rb") as handle:
        response = requests.post(
            f"{AI_URL}/internal/face/extract",
            files={"file": (photo.name, handle, "image/jpeg")},
            headers={"x-request-id": request_id},
            timeout=180,
        )
    response.raise_for_status()
    return response.json()


def validate_face(face: dict[str, Any], width: int, height: int) -> list[str]:
    errors: list[str] = []
    bbox = face.get("bbox")
    embedding = face.get("embedding")
    if not isinstance(bbox, list) or len(bbox) != 4:
        errors.append("bbox must contain four coordinates")
    else:
        x1, y1, x2, y2 = bbox
        if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
            errors.append(f"bbox outside image: {bbox}")
    if not isinstance(embedding, list) or len(embedding) != 512:
        errors.append("embedding must contain 512 values")
    elif not all(isinstance(value, (int, float)) and math.isfinite(value) for value in embedding):
        errors.append("embedding contains a non-finite value")
    return errors


def write_photo_artifacts(
    entry: dict[str, Any], result: dict[str, Any], run_dir: Path
) -> tuple[dict[str, Any], list[str]]:
    source = FIXTURE_ROOT / "photos" / entry["filename"]
    photo_dir = run_dir / "photos" / entry["id"]
    crops_dir = photo_dir / "faces"
    crops_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, photo_dir / "original.jpg")

    errors: list[str] = []
    with Image.open(source) as image:
        image = image.convert("RGB")
        overlay = image.copy()
        draw = ImageDraw.Draw(overlay)
        font = ImageFont.load_default()
        normalized_faces: list[dict[str, Any]] = []

        for index, face in enumerate(result.get("faces", []), start=1):
            errors.extend(validate_face(face, image.width, image.height))
            bbox = [int(value) for value in face["bbox"]]
            embedding = [float(value) for value in face["embedding"]]
            norm = math.sqrt(sum(value * value for value in embedding))
            crop_bytes = base64.b64decode(face.get("crop_base64", ""))
            crop_name = f"face-{index:02d}.jpg"
            if crop_bytes:
                (crops_dir / crop_name).write_bytes(crop_bytes)
            else:
                errors.append(f"{crop_name} is empty")
            x1, y1, x2, y2 = bbox
            draw.rectangle((x1, y1, x2, y2), outline=(5, 173, 152), width=4)
            draw.rectangle((x1, max(0, y1 - 18), x1 + 44, y1), fill=(5, 173, 152))
            draw.text((x1 + 4, max(1, y1 - 16)), f"F{index:02d}", fill=(255, 255, 255), font=font)
            normalized_faces.append(
                {
                    "face_index": index,
                    "bbox": bbox,
                    "embedding": embedding,
                    "embedding_dimensions": len(embedding),
                    "embedding_norm": norm,
                    "crop_file": f"faces/{crop_name}" if crop_bytes else None,
                    "crop_sha256": sha256_bytes(crop_bytes) if crop_bytes else None,
                }
            )

        overlay.save(photo_dir / "bounding-boxes.jpg", quality=92)

    artifact = {
        "photo": entry,
        "request_id": result.get("request_id"),
        "processing_ms": result.get("processing_ms"),
        "faces_detected": len(normalized_faces),
        "faces": normalized_faces,
        "validation_errors": errors,
    }
    (photo_dir / "extraction.json").write_text(
        json.dumps(artifact, indent=2) + "\n", encoding="utf-8"
    )
    return artifact, errors


def main() -> int:
    manifest = json.loads((FIXTURE_ROOT / "manifest.json").read_text(encoding="utf-8"))
    run_id = os.getenv("E2E_RUN_ID") or datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = OUTPUT_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(FIXTURE_ROOT / "manifest.json", run_dir / "corpus-manifest.json")

    health = requests.get(f"{AI_URL}/health", timeout=20)
    health.raise_for_status()
    health_body = health.json()
    if not health_body.get("model_loaded"):
        raise RuntimeError("AI service is healthy but its face model is not loaded")

    artifacts: dict[str, dict[str, Any]] = {}
    validation_errors: list[str] = []
    detection_rows: list[dict[str, Any]] = []

    for entry in manifest["photos"]:
        print(f"extracting {entry['id']} {entry['filename']}...", flush=True)
        result = extract(
            FIXTURE_ROOT / "photos" / entry["filename"],
            f"extract-{run_id}-{entry['id']}",
        )
        artifact, errors = write_photo_artifacts(entry, result, run_dir)
        artifacts[entry["id"]] = artifact
        validation_errors.extend(f"{entry['id']}: {error}" for error in errors)
        detected = artifact["faces_detected"]
        expected = entry["expected_visible_faces"]
        detection_rows.append(
            {
                "photo_id": entry["id"],
                "cohort": entry["cohort"],
                "variant": entry["variant"],
                "expected_visible_faces": expected,
                "faces_detected": detected,
                "detection_recall": round(min(detected, expected) / expected, 4),
                "processing_ms": artifact["processing_ms"],
                "validation_errors": len(errors),
            }
        )

    with (run_dir / "detection-summary.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=detection_rows[0].keys())
        writer.writeheader()
        writer.writerows(detection_rows)

    matching_rows: list[dict[str, Any]] = []
    baseline_by_cohort = {
        entry["cohort"]: artifacts[entry["id"]]
        for entry in manifest["photos"]
        if entry["variant"] == "baseline"
    }
    for entry in manifest["photos"]:
        baseline = baseline_by_cohort[entry["cohort"]]
        target = artifacts[entry["id"]]
        pairs = greedy_pairs(baseline["faces"], target["faces"])
        similarities = [similarity for _, _, similarity in pairs]
        passing = [similarity for similarity in similarities if similarity >= THRESHOLD]
        matching_rows.append(
            {
                "baseline_photo_id": baseline["photo"]["id"],
                "target_photo_id": entry["id"],
                "cohort": entry["cohort"],
                "variant": entry["variant"],
                "baseline_faces": len(baseline["faces"]),
                "target_faces": len(target["faces"]),
                "matched_at_threshold": len(passing),
                "match_rate": round(len(passing) / max(1, len(baseline["faces"])), 4),
                "minimum_pair_similarity": round(min(similarities), 6) if similarities else "",
                "mean_pair_similarity": (
                    round(sum(similarities) / len(similarities), 6) if similarities else ""
                ),
                "maximum_pair_similarity": round(max(similarities), 6) if similarities else "",
            }
        )

    with (run_dir / "matching-matrix.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=matching_rows[0].keys())
        writer.writeheader()
        writer.writerows(matching_rows)

    baseline_faces = {
        cohort: artifact["faces"] for cohort, artifact in baseline_by_cohort.items()
    }
    cross_cohort: list[dict[str, Any]] = []
    cohorts = sorted(baseline_faces)
    for left_index, left_cohort in enumerate(cohorts):
        for right_cohort in cohorts[left_index + 1 :]:
            values = [
                cosine(left["embedding"], right["embedding"])
                for left in baseline_faces[left_cohort]
                for right in baseline_faces[right_cohort]
            ]
            cross_cohort.append(
                {
                    "left_cohort": left_cohort,
                    "right_cohort": right_cohort,
                    "comparisons": len(values),
                    "maximum_similarity": round(max(values), 6) if values else None,
                    "false_matches_at_threshold": sum(value >= THRESHOLD for value in values),
                }
            )
    (run_dir / "cross-cohort-audit.json").write_text(
        json.dumps(cross_cohort, indent=2) + "\n", encoding="utf-8"
    )

    total_detected = sum(row["faces_detected"] for row in detection_rows)
    mean_recall = sum(row["detection_recall"] for row in detection_rows) / len(detection_rows)
    variant_rows = [row for row in matching_rows if row["variant"] != "baseline"]
    mean_match_rate = sum(row["match_rate"] for row in variant_rows) / len(variant_rows)
    false_matches = sum(row["false_matches_at_threshold"] for row in cross_cohort)
    summary = {
        "run_id": run_id,
        "started_at": datetime.now().astimezone().isoformat(),
        "ai_service_url": AI_URL,
        "face_match_threshold": THRESHOLD,
        "photos_processed": len(detection_rows),
        "faces_detected": total_detected,
        "mean_detection_recall": round(mean_recall, 4),
        "mean_variant_match_rate": round(mean_match_rate, 4),
        "cross_cohort_false_matches": false_matches,
        "validation_errors": validation_errors,
        "health": health_body,
    }
    (run_dir / "run.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    (OUTPUT_ROOT / "latest-run.txt").write_text(run_id + "\n", encoding="utf-8")

    report = f"""# Face Extraction Test Report

- Run: `{run_id}`
- Photos processed: **{len(detection_rows)}**
- Faces detected: **{total_detected}**
- Mean visible-face recall: **{mean_recall:.1%}**
- Mean same-cohort variant match rate at `{THRESHOLD}`: **{mean_match_rate:.1%}**
- Cross-cohort false matches at `{THRESHOLD}`: **{false_matches}**
- Contract validation errors: **{len(validation_errors)}**

See `detection-summary.csv`, `matching-matrix.csv`, `cross-cohort-audit.json`, and each photo's
`extraction.json` plus `bounding-boxes.jpg` for complete evidence.
"""
    (run_dir / "E2EReport.md").write_text(report, encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 1 if validation_errors else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"face extraction suite failed: {error}", file=sys.stderr)
        raise
