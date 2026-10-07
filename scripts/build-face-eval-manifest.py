"""Build identity-based face evaluation manifests from folder datasets.

Recommended first dataset:
  Kaggle: hereisburak/pins-face-recognition

Expected layout examples:
  datasets/pins/105_classes_pins_dataset/pins_Aaron Paul/*.jpg
  datasets/pins/pins_Aaron Paul/*.jpg
  datasets/my_faces/Aaron Paul/*.jpg

The generated manifest intentionally stores dataset-relative paths. Keep the raw
dataset and generated manifests out of git because they contain biometric data
and local machine paths.
"""

from __future__ import annotations

import argparse
import json
import random
import re
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
LOCAL_DATASETS = ROOT / "eval" / "datasets.local.json"
DEFAULT_DATASET_NAME = "Pins Face Recognition"
DEFAULT_DATASET_SOURCE = "https://www.kaggle.com/datasets/hereisburak/pins-face-recognition"


def slugify(value: str) -> str:
    value = re.sub(r"^pins[_ -]*", "", value.strip(), flags=re.IGNORECASE)
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return value or "identity"


def display_label(directory_name: str) -> str:
    label = re.sub(r"^pins[_ -]*", "", directory_name.strip(), flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", label.replace("_", " ")).strip() or directory_name


def find_identity_dirs(dataset_root: Path) -> list[tuple[str, Path, list[Path]]]:
    candidates: list[tuple[str, Path, list[Path]]] = []
    for directory in sorted(path for path in dataset_root.rglob("*") if path.is_dir()):
        files = sorted(
            file
            for file in directory.iterdir()
            if file.is_file() and file.suffix.lower() in IMAGE_EXTENSIONS
        )
        if files:
            candidates.append((display_label(directory.name), directory, files))

    # If the root itself is an identity directory, include it too.
    root_files = sorted(
        file
        for file in dataset_root.iterdir()
        if file.is_file() and file.suffix.lower() in IMAGE_EXTENSIONS
    )
    if root_files:
        candidates.append((display_label(dataset_root.name), dataset_root, root_files))

    deduped: dict[Path, tuple[str, Path, list[Path]]] = {}
    for label, directory, files in candidates:
        deduped[directory.resolve()] = (label, directory, files)
    return sorted(deduped.values(), key=lambda item: item[0].lower())


def resolve_dataset_args(args: argparse.Namespace) -> tuple[Path, str, str]:
    dataset_name = args.dataset_name
    dataset_source = args.dataset_source
    dataset_root_value = args.dataset_root

    if args.dataset_key:
        if not LOCAL_DATASETS.exists():
            raise FileNotFoundError(
                f"Local dataset registry not found: {LOCAL_DATASETS}. "
                "Run scripts/download-eval-datasets.py first."
            )
        registry = json.loads(LOCAL_DATASETS.read_text(encoding="utf-8"))
        entry = registry.get("datasets", {}).get(args.dataset_key)
        if not entry or entry.get("status") != "downloaded" or not entry.get("root"):
            raise ValueError(f"Dataset key is not downloaded in {LOCAL_DATASETS}: {args.dataset_key}")
        dataset_root_value = dataset_root_value or entry["root"]
        dataset_name = dataset_name or entry.get("name")
        dataset_source = dataset_source or entry.get("source")

    if not dataset_root_value:
        raise ValueError("Provide --dataset-root or --dataset-key")

    return (
        Path(dataset_root_value).expanduser().resolve(),
        dataset_name or DEFAULT_DATASET_NAME,
        dataset_source or DEFAULT_DATASET_SOURCE,
    )


def build_manifest(args: argparse.Namespace) -> dict:
    dataset_root, dataset_name, dataset_source = resolve_dataset_args(args)
    if not dataset_root.exists():
        raise FileNotFoundError(f"Dataset root does not exist: {dataset_root}")

    required_images = args.gallery_images + args.probe_images
    identities = [
        (label, directory, files)
        for label, directory, files in find_identity_dirs(dataset_root)
        if len(files) >= required_images
    ]
    if len(identities) < args.identities:
        raise ValueError(
            f"Need {args.identities} identities with at least {required_images} images each; "
            f"found {len(identities)} under {dataset_root}"
        )

    rng = random.Random(args.seed)
    rng.shuffle(identities)
    selected = sorted(identities[: args.identities], key=lambda item: item[0].lower())

    manifest_identities = []
    seen_ids: set[str] = set()
    for index, (label, directory, files) in enumerate(selected, start=1):
        identity_id = slugify(label)
        if identity_id in seen_ids:
            identity_id = f"{identity_id}-{index:03d}"
        seen_ids.add(identity_id)

        shuffled_files = list(files)
        rng.shuffle(shuffled_files)
        gallery = sorted(shuffled_files[: args.gallery_images])
        probe = sorted(shuffled_files[args.gallery_images : required_images])
        images = []
        for split, split_files in (("gallery", gallery), ("probe", probe)):
            for file_index, file in enumerate(split_files, start=1):
                rel = file.relative_to(dataset_root).as_posix()
                images.append(
                    {
                        "image_id": f"{identity_id}-{split}-{file_index:03d}",
                        "identity_id": identity_id,
                        "label": label,
                        "split": split,
                        "path": rel,
                    }
                )

        manifest_identities.append(
            {
                "identity_id": identity_id,
                "label": label,
                "source_dir": directory.relative_to(dataset_root).as_posix(),
                "image_count_available": len(files),
                "images": images,
            }
        )

    return {
        "schema_version": 1,
        "kind": "identity-face-eval",
        "dataset": {
            "name": dataset_name,
            "source": dataset_source,
            "root": str(dataset_root),
            "created_at": datetime.now().astimezone().isoformat(),
            "selection": {
                "seed": args.seed,
                "identities": args.identities,
                "gallery_images_per_identity": args.gallery_images,
                "probe_images_per_identity": args.probe_images,
                "minimum_images_per_identity": required_images,
            },
        },
        "identities": manifest_identities,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", help="Root directory of the downloaded dataset")
    parser.add_argument(
        "--dataset-key",
        help="Dataset key from eval/datasets.local.json, such as pins or lfw",
    )
    parser.add_argument(
        "--output",
        default=str(ROOT / "eval" / "manifests" / "pins-100.json"),
        help="Manifest output path",
    )
    parser.add_argument("--dataset-name")
    parser.add_argument(
        "--dataset-source",
    )
    parser.add_argument("--identities", type=int, default=100)
    parser.add_argument("--gallery-images", type=int, default=5)
    parser.add_argument("--probe-images", type=int, default=10)
    parser.add_argument("--seed", type=int, default=42)
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
                "identities": len(manifest["identities"]),
                "gallery_images": sum(
                    1
                    for identity in manifest["identities"]
                    for image in identity["images"]
                    if image["split"] == "gallery"
                ),
                "probe_images": sum(
                    1
                    for identity in manifest["identities"]
                    for image in identity["images"]
                    if image["split"] == "probe"
                ),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
