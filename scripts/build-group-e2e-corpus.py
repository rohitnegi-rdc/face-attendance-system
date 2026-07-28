"""Build the deterministic 20-image group-face E2E corpus."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "tests" / "fixtures" / "group-e2e"
ORIGINALS = FIXTURE_ROOT / "originals"
PHOTOS = FIXTURE_ROOT / "photos"
NEGATIVE = FIXTURE_ROOT / "negative"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save_jpeg(image: Image.Image, path: Path, quality: int = 88) -> None:
    image.convert("RGB").save(path, "JPEG", quality=quality, optimize=True)


def fit_width(image: Image.Image, width: int) -> Image.Image:
    if image.width <= width:
        return image.copy()
    height = round(image.height * width / image.width)
    return image.resize((width, height), Image.Resampling.LANCZOS)


def transform(image: Image.Image, variant: str) -> Image.Image:
    base = fit_width(image, 1600)
    if variant == "baseline":
        return base
    if variant == "lowlight":
        dark = ImageEnhance.Brightness(base).enhance(0.48)
        return ImageEnhance.Contrast(dark).enhance(0.86)
    if variant == "compressed":
        return fit_width(base, 720)
    if variant == "center-crop":
        margin_x = round(base.width * 0.1)
        margin_y = round(base.height * 0.06)
        return base.crop((margin_x, margin_y, base.width - margin_x, base.height - margin_y))
    if variant == "mirrored":
        return ImageOps.mirror(base)
    raise ValueError(f"unknown variant: {variant}")


def main() -> None:
    source_manifest = json.loads((FIXTURE_ROOT / "sources.json").read_text(encoding="utf-8"))
    PHOTOS.mkdir(parents=True, exist_ok=True)
    NEGATIVE.mkdir(parents=True, exist_ok=True)

    variants = ("baseline", "lowlight", "compressed", "center-crop", "mirrored")
    entries: list[dict[str, object]] = []

    for source in source_manifest["sources"]:
        source_path = ORIGINALS / source["filename"]
        if not source_path.exists():
            raise FileNotFoundError(f"missing source image: {source_path}")
        with Image.open(source_path) as original:
            original = ImageOps.exif_transpose(original).convert("RGB")
            for index, variant in enumerate(variants, start=1):
                filename = f"{source['cohort'].lower()}-{index:02d}-{variant}.jpg"
                output = PHOTOS / filename
                transformed = transform(original, variant)
                quality = 32 if variant == "compressed" else 88
                save_jpeg(transformed, output, quality)
                entries.append(
                    {
                        "id": f"{source['cohort']}{index:02d}",
                        "cohort": source["cohort"],
                        "variant": variant,
                        "filename": filename,
                        "width": transformed.width,
                        "height": transformed.height,
                        "sha256": sha256(output),
                        "expected_visible_faces": source["expected_visible_faces"],
                        "source": {
                            key: source[key]
                            for key in (
                                "title",
                                "description_url",
                                "author",
                                "license",
                                "license_url",
                            )
                        },
                        "modified": variant != "baseline",
                    }
                )

    no_face = Image.new("RGB", (1280, 720), (187, 191, 191))
    save_jpeg(no_face, NEGATIVE / "no-face.jpg")
    (NEGATIVE / "corrupt-image.jpg").write_bytes(b"not-a-valid-jpeg")
    save_jpeg(Image.new("RGB", (256, 256), (5, 173, 152)), NEGATIVE / "unsupported-name.bmp")

    manifest = {
        "schema_version": 1,
        "description": "20 licensed group-photo cases across four recurring identity cohorts",
        "photo_count": len(entries),
        "photos": entries,
        "negative_controls": [
            "negative/no-face.jpg",
            "negative/corrupt-image.jpg",
            "negative/unsupported-name.bmp",
        ],
    }
    (FIXTURE_ROOT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {len(entries)} photos and manifest to {FIXTURE_ROOT}")


if __name__ == "__main__":
    main()
