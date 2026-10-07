"""Download and register public face evaluation datasets.

The script uses KaggleHub when available and stores local dataset locations in
eval/datasets.local.json. That file is intentionally ignored because it contains
machine-specific paths and biometric dataset metadata.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "eval" / "datasets.local.json"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
CORE_DATASETS = ("pins", "lfw", "wider-test")
KAGGLE_CACHE = Path.home() / ".cache" / "kagglehub" / "datasets"
PROJECT_KAGGLEHUB_CACHE = ROOT / "datasets" / ".kagglehub-cache"

DATASETS: dict[str, dict[str, Any]] = {
    "pins": {
        "name": "Pins Face Recognition",
        "source": "https://www.kaggle.com/datasets/hereisburak/pins-face-recognition",
        "kagglehub_ref": "hereisburak/pins-face-recognition",
        "kind": "identity-face-eval",
        "large": False,
        "project_root": ROOT / "datasets" / "pins",
        "notes": "Primary 100-identity benchmark: many photos per identity.",
    },
    "lfw": {
        "name": "LFW",
        "source": "https://www.kaggle.com/datasets/jessicali9530/lfw-dataset",
        "kagglehub_ref": "jessicali9530/lfw-dataset",
        "kind": "identity-face-eval",
        "large": False,
        "project_root": ROOT / "datasets" / "lfw",
        "notes": "Standard face verification sanity benchmark; many identities have few photos.",
    },
    "wider-test": {
        "name": "WIDER FACE",
        "source": "https://www.kaggle.com/datasets/iamprateek/wider-face-a-face-detection-dataset",
        "kagglehub_ref": "iamprateek/wider-face-a-face-detection-dataset",
        "kind": "face-detection-eval",
        "large": False,
        "fallback_archive": KAGGLE_CACHE
        / "iamprateek"
        / "wider-face-a-face-detection-dataset"
        / "1.archive",
        "project_root": ROOT / "datasets" / "wider-face",
        "fallback_root": ROOT / "datasets" / "wider-face",
        "notes": "Detection benchmark with train/val/test images and public train/val bbox annotations. Windows may need the short-path extraction fallback.",
    },
    "celeba": {
        "name": "CelebA",
        "source": "https://www.kaggle.com/datasets/jessicali9530/celeba-dataset",
        "kagglehub_ref": "jessicali9530/celeba-dataset",
        "kind": "condition-slicing",
        "large": True,
        "project_root": ROOT / "datasets" / "celeba",
        "notes": "Large attribute dataset for condition slicing; skipped unless --include-large is set.",
    },
    "vggface2": {
        "name": "VGGFace2",
        "source": "https://www.kaggle.com/datasets/hearfool/vggface2",
        "kagglehub_ref": "hearfool/vggface2",
        "kind": "hard-identity-face-eval",
        "large": True,
        "project_root": ROOT / "datasets" / "vggface2",
        "notes": "Very large hard benchmark; skipped unless --include-large is set.",
    },
}


def count_images(root: Path) -> int:
    return sum(1 for file in root.rglob("*") if file.is_file() and file.suffix.lower() in IMAGE_EXTENSIONS)


def find_annotation_files(root: Path) -> list[str]:
    matches = []
    for file in root.rglob("*"):
        if file.is_file() and (
            "bbx" in file.name.lower()
            or "annot" in file.name.lower()
            or file.name.lower().endswith("_gt.txt")
        ):
            try:
                matches.append(file.relative_to(root).as_posix())
            except ValueError:
                matches.append(file.as_posix())
    return sorted(matches)


def load_existing(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": 1, "datasets": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def write_registry(path: Path, registry: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")


def is_populated_dataset(root: Path) -> bool:
    return root.exists() and root.is_dir() and count_images(root) > 0


def project_root_for(key: str) -> Path:
    return Path(DATASETS[key]["project_root"]).resolve()


def move_download_to_project_root(downloaded_root: Path, project_root: Path) -> tuple[Path, str]:
    downloaded_root = downloaded_root.resolve()
    project_root = project_root.resolve()
    if downloaded_root == project_root:
        return project_root, ""
    if is_populated_dataset(project_root):
        return project_root, f"Used existing project-local dataset and left downloaded path unchanged: {downloaded_root}"
    if project_root.exists() and any(project_root.iterdir()):
        raise FileExistsError(f"Project dataset folder is not empty: {project_root}")

    project_root.parent.mkdir(parents=True, exist_ok=True)
    if project_root.exists():
        project_root.rmdir()
    shutil.move(str(downloaded_root), str(project_root))
    return project_root, f"Moved KaggleHub download from {downloaded_root} to {project_root}"


def extract_fallback_archive(key: str) -> Path:
    spec = DATASETS[key]
    archive = Path(spec["fallback_archive"]).expanduser().resolve()
    target = Path(spec["fallback_root"]).resolve()
    if not archive.exists():
        raise FileNotFoundError(f"Fallback archive not found: {archive}")
    train_gt = target / "wider_face_annotations" / "wider_face_split" / "wider_face_train_bbx_gt.txt"
    val_gt = target / "wider_face_annotations" / "wider_face_split" / "wider_face_val_bbx_gt.txt"
    if train_gt.exists() and val_gt.exists() and count_images(target) > 0:
        return target

    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as archive_file:
        archive_file.extractall(target)
    return target


def download_dataset(key: str, include_large: bool) -> dict[str, Any]:
    spec = DATASETS[key]
    if spec["large"] and not include_large:
        return {
            "key": key,
            "name": spec["name"],
            "source": spec["source"],
            "kind": spec["kind"],
            "status": "skipped",
            "large": True,
            "notes": spec["notes"],
        }

    project_root = project_root_for(key)
    if is_populated_dataset(project_root):
        root = project_root
        download_warning = ""
    else:
        download_warning = ""
        os.environ.setdefault("KAGGLEHUB_CACHE", str(PROJECT_KAGGLEHUB_CACHE.resolve()))
        try:
            import kagglehub
        except ImportError as error:
            raise RuntimeError("Install KaggleHub first with: python -m pip install kagglehub") from error

        try:
            downloaded_root = Path(
                kagglehub.dataset_download(spec["kagglehub_ref"], output_dir=str(project_root))
            ).resolve()
            root, move_note = move_download_to_project_root(downloaded_root, project_root)
            download_warning = move_note
        except Exception as error:
            if not spec.get("fallback_archive"):
                raise
            root = extract_fallback_archive(key)
            download_warning = f"KaggleHub project-local extraction failed, used short-path fallback: {error}"
    annotations = find_annotation_files(root)
    result = {
        "key": key,
        "name": spec["name"],
        "source": spec["source"],
        "kind": spec["kind"],
        "status": "downloaded",
        "large": bool(spec["large"]),
        "root": root.as_posix(),
        "image_count": count_images(root),
        "annotation_files": annotations[:50],
        "has_annotation_files": bool(annotations),
        "downloaded_at": datetime.now().astimezone().isoformat(),
        "notes": spec["notes"],
    }
    if download_warning:
        result["download_warning"] = download_warning
    if key == "wider-test":
        result["bbox_eval_ready"] = bool(annotations)
    if key == "wider-test" and not annotations:
        result["bbox_eval_ready"] = False
        result["bbox_eval_note"] = "No public bbox annotation files were present in this Kaggle test split."
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        action="append",
        choices=sorted(DATASETS),
        help="Dataset key to download/register. Can be passed multiple times.",
    )
    parser.add_argument("--all", action="store_true", help="Select every known dataset key.")
    parser.add_argument(
        "--include-large",
        action="store_true",
        help="Allow large datasets such as CelebA and VGGFace2 to download.",
    )
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Local registry output path.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    selected = list(DATASETS) if args.all else args.dataset or list(CORE_DATASETS)
    registry_path = Path(args.output).resolve()
    registry = load_existing(registry_path)
    registry["schema_version"] = 1
    registry["updated_at"] = datetime.now().astimezone().isoformat()
    registry.setdefault("datasets", {})

    results = []
    failures = 0
    for key in selected:
        try:
            result = download_dataset(key, args.include_large)
            registry["datasets"][key] = result
            results.append(result)
        except Exception as error:
            failures += 1
            result = {
                "key": key,
                "name": DATASETS[key]["name"],
                "source": DATASETS[key]["source"],
                "kind": DATASETS[key]["kind"],
                "status": "failed",
                "error": str(error),
                "updated_at": datetime.now().astimezone().isoformat(),
            }
            registry["datasets"][key] = result
            results.append(result)

    write_registry(registry_path, registry)
    print(
        json.dumps(
            {
                "output": registry_path.as_posix(),
                "selected": selected,
                "results": results,
            },
            indent=2,
        )
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
