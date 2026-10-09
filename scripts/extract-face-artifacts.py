import json
import mimetypes
import shutil
import sys
import uuid
from pathlib import Path
from urllib import request

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
AI_URL = "http://localhost:6102/internal/face/extract"
OUTPUT_ROOT = ROOT / "test-output" / "face-extraction"
INPUTS = [
    ROOT / "Test" / "faces" / "group photo.jpg",
    ROOT / "Test" / "faces" / "group_evening.jpg",
    ROOT / "Test" / "faces" / "group_morning.jpg",
]


def post_image(path: Path) -> dict:
    boundary = f"----codex-face-test-{uuid.uuid4().hex}"
    content_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            (
                f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode(),
            path.read_bytes(),
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    req = request.Request(
        AI_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
            "x-request-id": f"face-artifact-{path.stem.replace(' ', '-')}",
        },
    )
    with request.urlopen(req, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def draw_label(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str) -> None:
    font = ImageFont.load_default()
    left, top = xy
    bbox = draw.textbbox((left, top), text, font=font)
    pad = 4
    draw.rectangle(
        (bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad),
        fill=(255, 214, 10),
    )
    draw.text((left, top), text, fill=(20, 20, 20), font=font)


def save_artifacts(image_path: Path, result: dict) -> dict:
    image_out = OUTPUT_ROOT / image_path.stem.replace(" ", "_")
    crops_out = image_out / "crops"
    crops_out.mkdir(parents=True, exist_ok=True)

    original_copy = image_out / image_path.name
    shutil.copy2(image_path, original_copy)

    img = Image.open(image_path).convert("RGB")
    annotated = img.copy()
    draw = ImageDraw.Draw(annotated)

    faces = result.get("faces", [])
    face_records = []
    for index, face in enumerate(faces, start=1):
        x1, y1, x2, y2 = [int(v) for v in face["bbox"]]
        draw.rectangle((x1, y1, x2, y2), outline=(255, 214, 10), width=4)
        draw_label(draw, (x1 + 4, max(4, y1 + 4)), f"face {index}")

        crop_path = crops_out / f"face_{index:02d}.jpg"
        img.crop((x1, y1, x2, y2)).save(crop_path, quality=95)

        embedding = face["embedding"]
        face_records.append(
            {
                "face_index": index,
                "bbox": [x1, y1, x2, y2],
                "crop_path": str(crop_path.relative_to(ROOT)).replace("\\", "/"),
                "embedding_dimension": len(embedding),
                "embedding": embedding,
            }
        )

    annotated_path = image_out / "annotated_bounding_boxes.jpg"
    annotated.save(annotated_path, quality=95)

    payload = {
        "source_image": str(image_path.relative_to(ROOT)).replace("\\", "/"),
        "original_copy": str(original_copy.relative_to(ROOT)).replace("\\", "/"),
        "annotated_image": str(annotated_path.relative_to(ROOT)).replace("\\", "/"),
        "image_width": img.width,
        "image_height": img.height,
        "face_count": len(face_records),
        "processing_ms": result.get("processing_ms"),
        "request_id": result.get("request_id"),
        "faces": face_records,
    }

    json_path = image_out / "faces.json"
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def main() -> None:
    missing = [str(path) for path in INPUTS if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing input image(s): {missing}")

    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)
    OUTPUT_ROOT.mkdir(parents=True)

    summaries = []
    for image_path in INPUTS:
        result = post_image(image_path)
        artifact = save_artifacts(image_path, result)
        summaries.append(
            {
                "source_image": artifact["source_image"],
                "face_count": artifact["face_count"],
                "annotated_image": artifact["annotated_image"],
                "json": str(
                    (OUTPUT_ROOT / image_path.stem.replace(" ", "_") / "faces.json")
                    .relative_to(ROOT)
                ).replace("\\", "/"),
                "processing_ms": artifact["processing_ms"],
            }
        )

    summary_path = OUTPUT_ROOT / "summary.json"
    summary_path.write_text(json.dumps({"images": summaries}, indent=2), encoding="utf-8")
    print(json.dumps({"output_dir": str(OUTPUT_ROOT), "images": summaries}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"face extraction artifact generation failed: {exc}", file=sys.stderr)
        sys.exit(1)
