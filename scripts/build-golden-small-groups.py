"""Build a reusable golden dataset for small-group morning/evening attendance.

The output is deterministic and intentionally stored under datasets/, which is
ignored by git because it contains biometric test images derived from public
face datasets.
"""

from __future__ import annotations

import csv
import json
import math
import random
import shutil
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageStat


ROOT = Path(__file__).resolve().parents[1]
PINS_ROOT = ROOT / "datasets" / "pins" / "105_classes_pins_dataset"
OUTPUT_ROOT = ROOT / "datasets" / "golden-small-groups-v1"
DATASET_VERSION = "golden-small-groups-v1"
RANDOM_SEED = 20260811
CANVAS_SIZE = (1600, 900)
VERIFY_THUMB_SIZE = (500, 281)
RESAMPLE_LANCZOS = getattr(getattr(Image, "Resampling", Image), "LANCZOS")


@dataclass(frozen=True)
class Worker:
    worker_id: str
    source_identity_folder: str
    source_display_name: str
    images: list[Path]


@dataclass(frozen=True)
class CasePlan:
    case_id: str
    scenario: str
    pump_id: str
    attendance_date: str
    morning_count: int
    evening_count: int
    morning_variant: str
    evening_variant: str
    worker_ids: list[str]
    absent_worker_ids: list[str]
    unknown_count: int = 0
    fraud_group_id: str | None = None
    fraud_worker_id: str | None = None


def slug(value: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "-" for char in value)
    return "-".join(part for part in cleaned.split("-") if part)


def load_fonts() -> tuple[ImageFont.ImageFont, ImageFont.ImageFont, ImageFont.ImageFont]:
    try:
        return (
            ImageFont.truetype("arial.ttf", 22),
            ImageFont.truetype("arial.ttf", 28),
            ImageFont.truetype("arial.ttf", 34),
        )
    except Exception:
        fallback = ImageFont.load_default()
        return fallback, fallback, fallback


LABEL_FONT, CASE_FONT, TITLE_FONT = load_fonts()


def image_quality(path: Path) -> tuple[int, float, float, float]:
    with Image.open(path) as image:
        gray = image.convert("L")
        stat = ImageStat.Stat(gray)
        brightness = float(stat.mean[0])
        contrast = float(stat.stddev[0])
        edge = gray.filter(ImageFilter.FIND_EDGES)
        edge_values = list(edge.resize((96, 96), RESAMPLE_LANCZOS).tobytes())
        edge_mean = sum(edge_values) / max(1, len(edge_values))
        sharpness = sum((value - edge_mean) ** 2 for value in edge_values) / max(1, len(edge_values))
        width, height = image.size
    return min(width, height), brightness, contrast, sharpness


def source_identity_name(folder_name: str) -> str:
    return folder_name.removeprefix("pins_").replace("_", " ").title()


def discover_workers(limit: int = 72) -> list[Worker]:
    if not PINS_ROOT.exists():
        raise FileNotFoundError(f"Pins dataset not found: {PINS_ROOT}")

    candidates: list[tuple[str, list[Path], float]] = []
    for folder in sorted(path for path in PINS_ROOT.iterdir() if path.is_dir()):
        images = sorted(folder.glob("*.jpg"))
        filtered: list[Path] = []
        for image in images:
            try:
                min_side, brightness, contrast, sharpness = image_quality(image)
            except Exception:
                continue
            if min_side >= 90 and 35 <= brightness <= 235 and contrast >= 12 and sharpness >= 8:
                filtered.append(image)
        if len(filtered) >= 60:
            candidates.append((folder.name, filtered, len(filtered)))

    candidates.sort(key=lambda item: (-item[2], item[0].lower()))
    workers = []
    for index, (folder, images, _) in enumerate(candidates[:limit], start=1):
        workers.append(
            Worker(
                worker_id=f"worker_{index:03d}",
                source_identity_folder=folder,
                source_display_name=source_identity_name(folder),
                images=images,
            )
        )
    if len(workers) < limit:
        raise RuntimeError(f"Only found {len(workers)} usable identities; need {limit}")
    return workers


def make_case_plans(workers: list[Worker]) -> list[CasePlan]:
    worker_ids = [worker.worker_id for worker in workers]
    plans: list[CasePlan] = []
    scenario_counts = [
        ("normal_6_to_5", 8, 6, 5, "normal", "normal"),
        ("normal_5_to_5", 7, 5, 5, "normal", "normal"),
        ("low_light_evening", 8, 6, 5, "normal", "low_light"),
        ("blur_evening", 7, 6, 5, "normal", "blur"),
        ("small_faces_far_camera", 7, 6, 5, "small_faces", "small_faces"),
        ("partial_occlusion", 5, 6, 5, "normal", "partial_occlusion"),
        ("extra_unknown_evening", 4, 5, 5, "normal", "extra_unknown"),
    ]

    case_number = 1
    for scenario, count, morning_count, evening_count, morning_variant, evening_variant in scenario_counts:
        for local_index in range(count):
            start = (case_number * 5 + local_index * 7) % (len(worker_ids) - 8)
            selected = worker_ids[start : start + morning_count]
            absent = selected[evening_count:] if evening_count < morning_count else []
            unknown_count = 1 if scenario == "extra_unknown_evening" else 0
            plans.append(
                CasePlan(
                    case_id=f"SG-{case_number:03d}-{slug(scenario)}",
                    scenario=scenario,
                    pump_id=f"golden_pump_{(case_number % 10) + 1:02d}",
                    attendance_date=f"2026-08-{(case_number % 20) + 1:02d}",
                    morning_count=morning_count,
                    evening_count=evening_count,
                    morning_variant=morning_variant,
                    evening_variant=evening_variant,
                    worker_ids=selected,
                    absent_worker_ids=absent,
                    unknown_count=unknown_count,
                )
            )
            case_number += 1

    fraud_pairs = [
        ("fraud_pair_alpha", "worker_010"),
        ("fraud_pair_alpha", "worker_010"),
        ("fraud_pair_beta", "worker_020"),
        ("fraud_pair_beta", "worker_020"),
    ]
    for fraud_index, (fraud_group_id, fraud_worker_id) in enumerate(fraud_pairs):
        start = (case_number * 9 + fraud_index * 11) % (len(worker_ids) - 8)
        selected = worker_ids[start : start + 6]
        if fraud_worker_id not in selected:
            selected[-1] = fraud_worker_id
        plans.append(
            CasePlan(
                case_id=f"SG-{case_number:03d}-fraud-duplicate-cross-pump",
                scenario="fraud_duplicate_cross_pump",
                pump_id=f"golden_pump_fraud_{fraud_index + 1:02d}",
                attendance_date="2026-08-28",
                morning_count=6,
                evening_count=5,
                morning_variant="normal",
                evening_variant="normal",
                worker_ids=selected,
                absent_worker_ids=selected[5:],
                fraud_group_id=fraud_group_id,
                fraud_worker_id=fraud_worker_id,
            )
        )
        case_number += 1

    if len(plans) != 50:
        raise AssertionError(f"Expected 50 case plans, got {len(plans)}")
    return plans


def select_image(worker: Worker, case_index: int, slot_index: int, session: str) -> Path:
    offset = 23 if session == "evening" else 0
    index = (case_index * 17 + slot_index * 13 + offset) % len(worker.images)
    return worker.images[index]


def cover_crop(path: Path, size: tuple[int, int]) -> Image.Image:
    target_w, target_h = size
    image = Image.open(path).convert("RGB")
    src_w, src_h = image.size
    target_ratio = target_w / target_h
    src_ratio = src_w / src_h
    if src_ratio > target_ratio:
        new_w = int(src_h * target_ratio)
        left = max(0, (src_w - new_w) // 2)
        crop_box = (left, 0, left + new_w, src_h)
    else:
        new_h = int(src_w / target_ratio)
        top = max(0, int((src_h - new_h) * 0.24))
        crop_box = (0, top, src_w, min(src_h, top + new_h))
    return image.crop(crop_box).resize(size, RESAMPLE_LANCZOS)


def background(kind: str, labelled: bool, plan: CasePlan, session: str) -> Image.Image:
    canvas = Image.new("RGB", CANVAS_SIZE, "#eef4f2" if kind != "low_light" else "#30373a")
    draw = ImageDraw.Draw(canvas)
    if kind == "low_light":
        for y in range(CANVAS_SIZE[1]):
            base = int(42 + 24 * (y / CANVAS_SIZE[1]))
            draw.line([(0, y), (CANVAS_SIZE[0], y)], fill=(base, base + 5, base + 7))
        draw.rectangle((0, 700, CANVAS_SIZE[0], CANVAS_SIZE[1]), fill="#23282a")
    else:
        for y in range(CANVAS_SIZE[1]):
            shade = int(235 + 14 * (y / CANVAS_SIZE[1]))
            draw.line([(0, y), (CANVAS_SIZE[0], y)], fill=(shade, min(255, shade + 3), min(255, shade + 1)))
        draw.rectangle((0, 685, CANVAS_SIZE[0], CANVAS_SIZE[1]), fill="#d8dfdc")
    if labelled:
        title_color = "#ffffff" if kind == "low_light" else "#102529"
        subtitle_color = "#d8dfdc" if kind == "low_light" else "#526468"
        draw.text((42, 34), f"{plan.case_id} {session.title()}", fill=title_color, font=TITLE_FONT)
        draw.text((42, 75), f"{plan.scenario} | pump {plan.pump_id}", fill=subtitle_color, font=LABEL_FONT)
    return canvas


def layout_for_count(count: int, variant: str) -> dict[int, tuple[int, int, int, int]]:
    if variant == "small_faces":
        size = (155, 210)
        if count == 5:
            coords = [(260, 250), (470, 210), (680, 250), (890, 210), (1100, 250)]
        else:
            coords = [(210, 245), (405, 210), (600, 245), (795, 210), (990, 245), (705, 500)]
        return {index: (x, y, size[0], size[1]) for index, (x, y) in enumerate(coords)}
    size = (250, 330) if count == 6 else (265, 345)
    if count == 5:
        coords = [(160, 230), (445, 195), (730, 235), (1015, 200), (620, 535)]
    else:
        coords = [(120, 210), (380, 160), (640, 215), (900, 165), (1160, 220), (675, 520)]
    return {index: (x, y, size[0], size[1]) for index, (x, y) in enumerate(coords)}


def face_bbox_from_person_bbox(bbox: list[int]) -> list[int]:
    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1
    return [
        int(x1 + width * 0.12),
        int(y1 + height * 0.07),
        int(x1 + width * 0.88),
        int(y1 + height * 0.78),
    ]


def color_for_worker(worker_id: str) -> str:
    palette = ["#05AD98", "#2563eb", "#dc2626", "#7c3aed", "#b45309", "#047857", "#be185d", "#0f766e"]
    number = int(worker_id.split("_")[-1])
    return palette[number % len(palette)]


def apply_session_variant(image: Image.Image, variant: str, slot_index: int) -> Image.Image:
    if variant in {"low_light", "extra_unknown"}:
        image = ImageEnhance.Brightness(image).enhance(0.72)
        image = ImageEnhance.Contrast(image).enhance(0.90)
        image = ImageEnhance.Color(image).enhance(0.82)
        image = image.filter(ImageFilter.GaussianBlur(radius=0.25))
    if variant == "blur":
        image = image.filter(ImageFilter.GaussianBlur(radius=1.15))
        image = ImageEnhance.Contrast(image).enhance(0.88)
    if variant == "partial_occlusion" and slot_index in {1, 3}:
        draw = ImageDraw.Draw(image)
        width, height = image.size
        draw.rectangle((0, int(height * 0.55), width, int(height * 0.68)), fill="#596467")
    return image


def paste_people(
    plan: CasePlan,
    workers_by_id: dict[str, Worker],
    unknown_workers: list[Worker],
    case_index: int,
    session: str,
    labelled: bool,
) -> tuple[Image.Image, list[dict[str, Any]], list[dict[str, Any]]]:
    present_worker_ids = plan.worker_ids[: plan.morning_count] if session == "morning" else plan.worker_ids[: plan.evening_count]
    variant = plan.morning_variant if session == "morning" else plan.evening_variant
    count_for_layout = len(present_worker_ids) + (plan.unknown_count if session == "evening" else 0)
    layout = layout_for_count(count_for_layout, variant)
    bg_kind = "low_light" if variant in {"low_light", "extra_unknown"} and session == "evening" else "normal"
    canvas = background(bg_kind, labelled, plan, session)
    draw = ImageDraw.Draw(canvas)
    worker_regions: list[dict[str, Any]] = []
    unknown_regions: list[dict[str, Any]] = []

    entries: list[tuple[str, Worker, bool]] = [(worker_id, workers_by_id[worker_id], False) for worker_id in present_worker_ids]
    if session == "evening" and plan.unknown_count:
        for unknown_index in range(plan.unknown_count):
            entries.append((f"unknown_{unknown_index + 1:03d}", unknown_workers[(case_index + unknown_index) % len(unknown_workers)], True))

    for slot_index, (person_id, worker, is_unknown) in enumerate(entries):
        x, y, width, height = layout[slot_index]
        source = select_image(worker, case_index, slot_index, session)
        portrait = cover_crop(source, (width, height))
        portrait = apply_session_variant(portrait, variant, slot_index)

        shadow = Image.new("RGBA", (width + 18, height + 18), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle((8, 8, width + 18, height + 18), radius=20, fill=(0, 0, 0, 48))
        canvas.paste(shadow.convert("RGB"), (x - 8, y - 8), shadow)
        canvas.paste(portrait, (x, y))
        person_bbox = [x, y, x + width, y + height]
        face_bbox = face_bbox_from_person_bbox(person_bbox)
        draw.rounded_rectangle(person_bbox, radius=14, outline="#ffffff", width=3)

        if labelled:
            color = "#878787" if is_unknown else color_for_worker(person_id)
            draw.rounded_rectangle(person_bbox, radius=14, outline=color, width=7)
            label = f"{person_id} | {'Unknown' if is_unknown else worker.source_display_name[:18]}"
            label_width = max(220, min(420, len(label) * 10))
            draw.rounded_rectangle((x, y - 34, x + label_width, y - 6), radius=8, fill=color)
            draw.text((x + 8, y - 29), label, fill="#ffffff", font=LABEL_FONT)
            draw.rectangle(face_bbox, outline="#ffffff", width=2)

        region = {
            "id": person_id,
            "bbox": face_bbox,
            "person_bbox": person_bbox,
            "source_image": str(source.relative_to(ROOT)).replace("\\", "/"),
            "source_identity_folder": worker.source_identity_folder,
        }
        if is_unknown:
            unknown_regions.append(region)
        else:
            region["worker_id"] = person_id
            worker_regions.append(region)

    return canvas, worker_regions, unknown_regions


def quality_for_image(image_path: Path, regions: list[dict[str, Any]], variant: str) -> dict[str, Any]:
    with Image.open(image_path) as image:
        gray = image.convert("L")
        stat = ImageStat.Stat(gray)
        brightness_mean = round(float(stat.mean[0]), 3)
        brightness_std = round(float(stat.stddev[0]), 3)
        edge = gray.filter(ImageFilter.FIND_EDGES)
        values = list(edge.resize((128, 72), RESAMPLE_LANCZOS).tobytes())
        mean = sum(values) / max(1, len(values))
        sharpness = round(sum((value - mean) ** 2 for value in values) / max(1, len(values)), 3)
    image_area = CANVAS_SIZE[0] * CANVAS_SIZE[1]
    ratios = []
    for region in regions:
        x1, y1, x2, y2 = region["bbox"]
        ratios.append(((x2 - x1) * (y2 - y1)) / image_area)
    avg_face_area_ratio = round(sum(ratios) / max(1, len(ratios)), 6)
    if avg_face_area_ratio < 0.012:
        face_size_label = "small"
    elif avg_face_area_ratio > 0.04:
        face_size_label = "large"
    else:
        face_size_label = "medium"
    return {
        "variant": variant,
        "brightness_mean": brightness_mean,
        "brightness_std": brightness_std,
        "sharpness_edges_variance": sharpness,
        "avg_face_area_ratio": avg_face_area_ratio,
        "face_size_label": face_size_label,
        "manual_quality_label": variant,
        "low_light": variant in {"low_light", "extra_unknown"},
        "blur": variant == "blur",
        "occlusion": variant == "partial_occlusion",
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = sorted({key for row in rows for key in row.keys()})
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def make_contact_sheets(case_dirs: list[Path]) -> list[Path]:
    verify_dir = OUTPUT_ROOT / "verification"
    verify_dir.mkdir(parents=True, exist_ok=True)
    sheet_paths = []
    for sheet_index in range(0, len(case_dirs), 5):
        group = case_dirs[sheet_index : sheet_index + 5]
        sheet_no = sheet_index // 5 + 1
        width = VERIFY_THUMB_SIZE[0] * 2 + 80
        row_height = VERIFY_THUMB_SIZE[1] + 76
        height = 70 + row_height * len(group)
        sheet = Image.new("RGB", (width, height), "#f5f7f7")
        draw = ImageDraw.Draw(sheet)
        draw.text((24, 22), f"{DATASET_VERSION} visual verification sheet {sheet_no:02d}", fill="#102529", font=TITLE_FONT)
        for row_index, case_dir in enumerate(group):
            y = 70 + row_index * row_height
            case_id = case_dir.name
            draw.text((24, y + 4), case_id, fill="#102529", font=CASE_FONT)
            for col_index, filename in enumerate(("morning_labeled_preview.jpg", "evening_labeled_preview.jpg")):
                thumb = Image.open(case_dir / filename).convert("RGB")
                thumb.thumbnail(VERIFY_THUMB_SIZE, RESAMPLE_LANCZOS)
                x = 24 + col_index * (VERIFY_THUMB_SIZE[0] + 32)
                paste_y = y + 42
                sheet.paste(thumb, (x, paste_y))
                draw.rectangle((x, paste_y, x + VERIFY_THUMB_SIZE[0], paste_y + VERIFY_THUMB_SIZE[1]), outline="#BBBFBF", width=2)
        path = verify_dir / f"contact-sheet-{sheet_no:02d}.jpg"
        sheet.save(path, quality=88)
        sheet_paths.append(path)
    return sheet_paths


def build_dataset() -> None:
    random.seed(RANDOM_SEED)
    workers = discover_workers()
    workers_by_id = {worker.worker_id: worker for worker in workers}
    unknown_workers = workers[-8:]
    plans = make_case_plans(workers[:64])

    resolved = OUTPUT_ROOT.resolve()
    if resolved == ROOT.resolve() or ROOT.resolve() not in resolved.parents:
        raise RuntimeError(f"Refusing to rebuild unsafe output path: {OUTPUT_ROOT}")
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    (OUTPUT_ROOT / "cases").mkdir(parents=True, exist_ok=True)

    quality_rows: list[dict[str, Any]] = []
    dataset_cases: list[dict[str, Any]] = []
    case_dirs: list[Path] = []

    for case_index, plan in enumerate(plans, start=1):
        case_dir = OUTPUT_ROOT / "cases" / plan.case_id
        case_dir.mkdir(parents=True, exist_ok=True)
        case_dirs.append(case_dir)

        sessions: dict[str, Any] = {}
        for session in ("morning", "evening"):
            labelled = False
            image, worker_regions, unknown_regions = paste_people(plan, workers_by_id, unknown_workers, case_index, session, labelled)
            image_path = case_dir / f"{session}.jpg"
            image.save(image_path, quality=92 if session == "morning" else 90)

            preview, _, _ = paste_people(plan, workers_by_id, unknown_workers, case_index, session, labelled=True)
            preview_path = case_dir / f"{session}_labeled_preview.jpg"
            preview.save(preview_path, quality=91)

            variant = plan.morning_variant if session == "morning" else plan.evening_variant
            expected_workers = plan.worker_ids[: plan.morning_count] if session == "morning" else plan.worker_ids[: plan.evening_count]
            expected_absent = [] if session == "morning" else plan.absent_worker_ids
            all_regions = worker_regions + unknown_regions
            quality = quality_for_image(image_path, all_regions, variant)
            sessions[session] = {
                "photo": f"{session}.jpg",
                "labeled_preview": f"{session}_labeled_preview.jpg",
                "expected_face_count": len(all_regions),
                "expected_worker_face_count": len(worker_regions),
                "expected_unknown_face_count": len(unknown_regions),
                "expected_present_workers": expected_workers,
                "expected_absent_workers": expected_absent,
                "worker_regions": worker_regions,
                "unknown_regions": unknown_regions,
                "quality": quality,
            }
            quality_rows.append(
                {
                    "case_id": plan.case_id,
                    "session": session,
                    "scenario": plan.scenario,
                    "variant": variant,
                    "photo": f"cases/{plan.case_id}/{session}.jpg",
                    "expected_face_count": len(all_regions),
                    "expected_worker_face_count": len(worker_regions),
                    "expected_unknown_face_count": len(unknown_regions),
                    **quality,
                }
            )

        present_evening = set(plan.worker_ids[: plan.evening_count])
        expected_matches = [
            {"morning_worker_id": worker_id, "evening_worker_id": worker_id, "should_match": True}
            for worker_id in plan.worker_ids[: plan.morning_count]
            if worker_id in present_evening
        ]
        expected_attendance = {
            worker_id: {
                "morning": "present",
                "evening": "present" if worker_id in present_evening else "absent",
            }
            for worker_id in plan.worker_ids[: plan.morning_count]
        }
        ground_truth = {
            "schema_version": 1,
            "dataset_version": DATASET_VERSION,
            "case_id": plan.case_id,
            "scenario": plan.scenario,
            "pump_id": plan.pump_id,
            "attendance_date": plan.attendance_date,
            "fraud_group_id": plan.fraud_group_id,
            "fraud_worker_id": plan.fraud_worker_id,
            "sessions": sessions,
            "expected_matches": expected_matches,
            "expected_attendance": expected_attendance,
            "iou_threshold_for_label_assignment": 0.5,
            "notes": [
                "Unlabelled morning.jpg/evening.jpg are evaluation inputs.",
                "Labelled preview files are for human verification only.",
                "worker_regions.bbox is the golden face-region box used for IoU assignment.",
                "person_bbox is included only to understand placement in the synthetic group photo.",
            ],
        }
        (case_dir / "ground_truth.json").write_text(json.dumps(ground_truth, indent=2) + "\n", encoding="utf-8")
        (case_dir / "README.md").write_text(
            f"""# {plan.case_id}

Scenario: `{plan.scenario}`

Use `morning.jpg` and `evening.jpg` as evaluation inputs.
Use `morning_labeled_preview.jpg` and `evening_labeled_preview.jpg` only to verify labels.
Ground truth is in `ground_truth.json`.
""",
            encoding="utf-8",
        )

        dataset_cases.append(
            {
                "case_id": plan.case_id,
                "scenario": plan.scenario,
                "pump_id": plan.pump_id,
                "attendance_date": plan.attendance_date,
                "morning_photo": f"cases/{plan.case_id}/morning.jpg",
                "evening_photo": f"cases/{plan.case_id}/evening.jpg",
                "ground_truth": f"cases/{plan.case_id}/ground_truth.json",
                "morning_expected_faces": sessions["morning"]["expected_face_count"],
                "evening_expected_faces": sessions["evening"]["expected_face_count"],
                "expected_absent_workers": plan.absent_worker_ids,
                "fraud_group_id": plan.fraud_group_id,
                "fraud_worker_id": plan.fraud_worker_id,
            }
        )

    sheet_paths = make_contact_sheets(case_dirs)
    workers_json = [
        {
            "worker_id": worker.worker_id,
            "source_identity_folder": worker.source_identity_folder,
            "source_display_name": worker.source_display_name,
            "usable_source_images": len(worker.images),
        }
        for worker in workers[:64]
    ]
    scenario_counts = Counter(case["scenario"] for case in dataset_cases)
    fraud_pairs = [
        {
            "fraud_group_id": group_id,
            "fraud_worker_id": worker_id,
            "case_ids": [case["case_id"] for case in dataset_cases if case["fraud_group_id"] == group_id],
            "expected_duplicate": True,
        }
        for group_id, worker_id in sorted({(case["fraud_group_id"], case["fraud_worker_id"]) for case in dataset_cases if case["fraud_group_id"]})
    ]
    dataset = {
        "schema_version": 1,
        "dataset_version": DATASET_VERSION,
        "created_by": "scripts/build-golden-small-groups.py",
        "random_seed": RANDOM_SEED,
        "source_dataset": "Pins Face Recognition",
        "case_count": len(dataset_cases),
        "evaluation_input_image_count": len(dataset_cases) * 2,
        "labelled_preview_image_count": len(dataset_cases) * 2,
        "scenario_counts": dict(sorted(scenario_counts.items())),
        "cases": dataset_cases,
        "fraud_pairs": fraud_pairs,
        "verification_contact_sheets": [str(path.relative_to(OUTPUT_ROOT)).replace("\\", "/") for path in sheet_paths],
        "quality_summary": "quality-summary.csv",
        "workers": "workers.json",
        "manifest": "manifest.json",
    }
    (OUTPUT_ROOT / "dataset.json").write_text(json.dumps(dataset, indent=2) + "\n", encoding="utf-8")
    (OUTPUT_ROOT / "workers.json").write_text(json.dumps(workers_json, indent=2) + "\n", encoding="utf-8")
    (OUTPUT_ROOT / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "kind": "golden-small-group-attendance-v1",
                "dataset_version": DATASET_VERSION,
                "dataset_root": str(OUTPUT_ROOT).replace("\\", "/"),
                "cases": dataset_cases,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    write_csv(OUTPUT_ROOT / "quality-summary.csv", quality_rows)
    (OUTPUT_ROOT / "README.md").write_text(
        f"""# Golden Small Groups V1

This dataset contains 50 deterministic morning/evening attendance use cases for model comparison.

- Evaluation input images: 100 (`morning.jpg` + `evening.jpg` for each case)
- Labelled preview images: 100 (`*_labeled_preview.jpg`, for human verification only)
- Source dataset: Pins Face Recognition
- Ground truth: one `ground_truth.json` per case

Start with:

```text
dataset.json
quality-summary.csv
verification/contact-sheet-01.jpg ... contact-sheet-10.jpg
```

Use only unlabelled `morning.jpg` and `evening.jpg` images during evaluation. The labelled previews and contact sheets are there to verify worker mapping before scoring models.
""",
        encoding="utf-8",
    )


if __name__ == "__main__":
    build_dataset()
    print(OUTPUT_ROOT)
