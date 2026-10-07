"""Build a WIDER FACE bbox-detection evaluation manifest.

The generated manifest samples labeled WIDER train/val images and stores only
dataset-relative paths plus ground-truth boxes. Keep generated manifests out of
git because they contain biometric dataset metadata and local roots.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
LOCAL_DATASETS = ROOT / "eval" / "datasets.local.json"


def load_dataset_entry(dataset_key: str) -> dict[str, Any]:
    if not LOCAL_DATASETS.exists():
        raise FileNotFoundError(
            f"Local dataset registry not found: {LOCAL_DATASETS}. Run scripts/download-eval-datasets.py first."
        )
    registry = json.loads(LOCAL_DATASETS.read_text(encoding="utf-8"))
    entry = registry.get("datasets", {}).get(dataset_key)
    if not entry or entry.get("status") != "downloaded" or not entry.get("root"):
        raise ValueError(f"Dataset key is not downloaded in {LOCAL_DATASETS}: {dataset_key}")
    return entry


def resolve_dataset_root(args: argparse.Namespace) -> tuple[Path, str, str]:
    if args.dataset_key:
        entry = load_dataset_entry(args.dataset_key)
        root = Path(args.dataset_root or entry["root"]).expanduser().resolve()
        return root, entry.get("name") or "WIDER FACE", entry.get("source") or ""
    if not args.dataset_root:
        raise ValueError("Provide --dataset-root or --dataset-key")
    return Path(args.dataset_root).expanduser().resolve(), args.dataset_name, args.dataset_source


def annotation_path(root: Path, split: str) -> Path:
    return root / "wider_face_annotations" / "wider_face_split" / f"wider_face_{split}_bbx_gt.txt"


def image_path(root: Path, split: str, relative_path: str) -> Path:
    split_dir = "WIDER_train" if split == "train" else "WIDER_val"
    return root / split_dir / split_dir / "images" / relative_path


def parse_annotations(root: Path, split: str, min_box_size: int, max_faces: int | None) -> list[dict[str, Any]]:
    path = annotation_path(root, split)
    if not path.exists():
        raise FileNotFoundError(f"WIDER annotation file not found: {path}")

    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()]
    entries = []
    index = 0
    while index < len(lines):
        relative_image = lines[index]
        index += 1
        if not relative_image:
            continue
        face_count = int(lines[index])
        index += 1
        boxes = []
        for _ in range(face_count):
            values = [int(float(value)) for value in lines[index].split()]
            index += 1
            if len(values) < 10:
                continue
            x, y, width, height, blur, expression, illumination, invalid, occlusion, pose = values[:10]
            if invalid:
                continue
            if width < min_box_size or height < min_box_size:
                continue
            boxes.append(
                {
                    "bbox": [x, y, x + width, y + height],
                    "blur": blur,
                    "expression": expression,
                    "illumination": illumination,
                    "occlusion": occlusion,
                    "pose": pose,
                }
            )
        if not boxes:
            continue
        if max_faces is not None and len(boxes) > max_faces:
            continue
        image_file = image_path(root, split, relative_image)
        if not image_file.exists():
            continue
        entries.append(
            {
                "image_id": f"{split}-{len(entries) + 1:05d}",
                "split": split,
                "event": relative_image.split("/", 1)[0],
                "path": image_file.relative_to(root).as_posix(),
                "ground_truth_faces": boxes,
            }
        )
    return entries


def build_manifest(args: argparse.Namespace) -> dict[str, Any]:
    dataset_root, dataset_name, dataset_source = resolve_dataset_root(args)
    entries = parse_annotations(dataset_root, args.split, args.min_box_size, args.max_faces)
    if len(entries) < args.images:
        raise ValueError(f"Need {args.images} WIDER images after filters; found {len(entries)}")

    rng = random.Random(args.seed)
    rng.shuffle(entries)
    selected = sorted(entries[: args.images], key=lambda entry: entry["path"])

    return {
        "schema_version": 1,
        "kind": "wider-face-detection-eval",
        "dataset": {
            "name": dataset_name,
            "source": dataset_source,
            "root": str(dataset_root),
            "created_at": datetime.now().astimezone().isoformat(),
            "selection": {
                "seed": args.seed,
                "split": args.split,
                "images": args.images,
                "min_box_size": args.min_box_size,
                "max_faces": args.max_faces,
            },
        },
        "images": selected,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", help="Root directory of the downloaded WIDER FACE dataset")
    parser.add_argument("--dataset-key", default="wider-test", help="Dataset key from eval/datasets.local.json")
    parser.add_argument("--dataset-name", default="WIDER FACE")
    parser.add_argument(
        "--dataset-source",
        default="https://www.kaggle.com/datasets/iamprateek/wider-face-a-face-detection-dataset",
    )
    parser.add_argument("--split", choices=["train", "val"], default="val")
    parser.add_argument("--images", type=int, default=25)
    parser.add_argument("--min-box-size", type=int, default=24)
    parser.add_argument("--max-faces", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", default=str(ROOT / "eval" / "manifests" / "wider-val-25.json"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = build_manifest(args)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(output),
                "images": len(manifest["images"]),
                "ground_truth_faces": sum(len(image["ground_truth_faces"]) for image in manifest["images"]),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
