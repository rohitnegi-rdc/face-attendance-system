"""Face AI Microservice — insightface (buffalo_l) on ONNX Runtime CPU.

POST /internal/face/extract: accepts an image, returns bbox + 512-dim ArcFace
embedding + base64 face picture (for people only, see face_preview) per detected face. Internal-only (Docker network).
See plans/MasterPlan.md §5 / Prompt A "AI MICROSERVICE".
"""
import base64
import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO

import cv2
import numpy as np
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from insightface.app import FaceAnalysis
from PIL import Image, ImageOps

from anti_spoofing import AntiSpoofingEngine

MAX_FACES = 30
MAX_IMAGE_LONG_SIDE = max(640, int(os.getenv("AI_MAX_IMAGE_LONG_SIDE", "1920")))
RESIZE_JPEG_QUALITY = min(100, max(50, int(os.getenv("AI_RESIZE_JPEG_QUALITY", "90"))))
MAX_UPLOAD_BYTES = max(1, int(os.getenv("AI_MAX_UPLOAD_BYTES", str(18 * 1024 * 1024))))
MAX_IMAGE_PIXELS = 20_000_000
# The face picture for people (face_preview): largest side in pixels, how much of the head and
# surroundings it shows (side = face box x this), and its JPEG quality.
FACE_PREVIEW_SIZE = min(1024, max(224, int(os.getenv("AI_FACE_PREVIEW_SIZE", "480"))))
FACE_PREVIEW_CONTEXT = 1.4  # head and hair; 1.8 pulled neighbours' faces into group photos
FACE_PREVIEW_JPEG_QUALITY = 90

# Structured JSON logging (plans/MasterPlan.md §7a): the same line shape as the app and the worker
# (src/lib/server/log.ts), ISO timestamp in Asia/Kolkata. json.dumps keeps quotes in a message
# from breaking the line. This service has no database: its failures reach the admin Logs page
# through the worker, which logs them with the same request_id.
IST = timezone(timedelta(hours=5, minutes=30))


class JsonFormatter(logging.Formatter):
    def format(self, record):
        entry = {
            "timestamp": datetime.fromtimestamp(record.created, IST).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower().replace("warning", "warn"),
            "service": "ai-service",
            "message": record.getMessage(),
        }
        if record.exc_info:
            entry["error"] = self.formatException(record.exc_info)
        return json.dumps(entry)


_handler = logging.StreamHandler()
_handler.setFormatter(JsonFormatter())
logging.basicConfig(level=logging.INFO, handlers=[_handler], force=True)
logger = logging.getLogger("ai-service")

app = FastAPI(title="Face AI Microservice")

face_app: FaceAnalysis | None = None
anti_spoof: AntiSpoofingEngine | None = None


def rotate_right_angle(image: np.ndarray, degrees: int) -> np.ndarray:
    """Rotate a BGR image clockwise by a right angle."""
    normalized = degrees % 360
    if normalized == 90:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    if normalized == 180:
        return cv2.rotate(image, cv2.ROTATE_180)
    if normalized == 270:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return image


def face_detection_quality(faces) -> tuple[int, float, float]:
    """Rank candidates by count, upright landmarks, then detector confidence."""
    uprightness = 0.0
    confidence = 0.0
    for face in faces:
        confidence += float(face.det_score)
        landmarks = getattr(face, "kps", None)
        if landmarks is None or len(landmarks) < 3:
            continue

        left_eye, right_eye, nose = landmarks[:3]
        eye_angle = np.arctan2(right_eye[1] - left_eye[1], right_eye[0] - left_eye[0])
        # Upright faces have a horizontal eye line and the nose below both eyes.
        horizontal_eyes = abs(np.cos(eye_angle))
        nose_below_eyes = float(nose[1] > (left_eye[1] + right_eye[1]) / 2)
        uprightness += horizontal_eyes + nose_below_eyes
    return len(faces), round(uprightness, 4), round(confidence, 4)


def detect_with_orientation_fallback(image: np.ndarray):
    """Return the best upright orientation from the normal and sideways camera views."""
    faces = face_app.get(image)
    # A near-sideways frame can still yield faces with weak or misleading landmarks.
    # Evaluate both landscape directions and select the one whose faces are upright.
    candidates = [(image, faces, 0)]
    for degrees in (90, 270):
        candidate = rotate_right_angle(image, degrees)
        candidates.append((candidate, face_app.get(candidate), degrees))
    return max(candidates, key=lambda candidate: face_detection_quality(candidate[1]))


def face_preview(image: np.ndarray, bbox, landmarks, scale: float) -> np.ndarray:
    """The face picture people look at (crop_base64), never used for matching.

    Cut from the full-size photo, not the smaller copy faces are found in (`scale` maps the
    copy's coordinates onto it), with room around the head and turned so the eyes are level.
    Up to FACE_PREVIEW_SIZE pixels square; a small face is not enlarged past its own detail.
    It used to be a tight 224 px cut from the smaller copy, too blurry to judge a match by.
    """
    x1, y1, x2, y2 = (value * scale for value in bbox)
    center_x, center_y = (x1 + x2) / 2, (y1 + y2) / 2
    side = max(x2 - x1, y2 - y1) * FACE_PREVIEW_CONTEXT
    angle = 0.0
    if landmarks is not None and len(landmarks) >= 2:
        (left_x, left_y), (right_x, right_y) = np.asarray(landmarks[:2], dtype=np.float32) * scale
        angle = float(np.degrees(np.arctan2(right_y - left_y, right_x - left_x)))
    size = max(1, min(FACE_PREVIEW_SIZE, round(side)))
    matrix = cv2.getRotationMatrix2D((center_x, center_y), angle, size / side)
    matrix[0, 2] += size / 2 - center_x
    matrix[1, 2] += size / 2 - center_y
    return cv2.warpAffine(
        image, matrix, (size, size), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )


@app.on_event("startup")
def load_model():
    global face_app, anti_spoof
    logger.info("loading buffalo_l model pack (warm, once at startup)")
    face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    face_app.prepare(ctx_id=0, det_size=(640, 640))
    anti_spoof = AntiSpoofingEngine()
    logger.info(f"model pack ready anti_spoof_ready={anti_spoof.ready}")


@app.get("/health")
def health():
    if face_app is None:
        raise HTTPException(status_code=503, detail="Face recognition model is not ready")
    return {
        "status": "ok",
        "model_loaded": face_app is not None,
        "anti_spoof_enabled": bool(anti_spoof and anti_spoof.enabled),
        "anti_spoof_ready": bool(anti_spoof and anti_spoof.ready),
    }


@app.post("/internal/face/extract")
async def extract_faces(file: UploadFile = File(...), x_request_id: str | None = Header(default=None)):
    request_id = x_request_id or str(uuid.uuid4())
    start = time.time()

    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the upload size limit")
    try:
        source_image = Image.open(BytesIO(raw))
        if source_image.format not in {"JPEG", "PNG", "WEBP"}:
            raise HTTPException(status_code=415, detail="Unsupported image format")
        if source_image.width * source_image.height > MAX_IMAGE_PIXELS:
            raise HTTPException(status_code=413, detail="Image dimensions exceed the processing limit")
        source_image.verify()
        source_image = Image.open(BytesIO(raw))
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=415, detail="Invalid or unsupported image") from error
    exif_orientation = source_image.getexif().get(274, 1)
    img = ImageOps.exif_transpose(source_image).convert("RGB")
    evidence_arr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    original_height, original_width = evidence_arr.shape[:2]
    original_bytes = len(raw)
    processed = False

    # Keep the submitted evidence untouched. Only the in-memory inference image is
    # resized, and only where an oversized image adds CPU work without useful detail.
    arr = evidence_arr
    long_side = max(original_width, original_height)
    if long_side > MAX_IMAGE_LONG_SIDE:
        scale = MAX_IMAGE_LONG_SIDE / long_side
        arr = cv2.resize(
            arr,
            (round(original_width * scale), round(original_height * scale)),
            interpolation=cv2.INTER_AREA,
        )
        processed = True

    arr, faces, sideways_correction = detect_with_orientation_fallback(arr)
    if sideways_correction:
        evidence_arr = rotate_right_angle(evidence_arr, sideways_correction)
    faces = faces[:MAX_FACES]

    processed_height, processed_width = arr.shape[:2]
    ok, encoded = cv2.imencode(".jpg", arr, [cv2.IMWRITE_JPEG_QUALITY, RESIZE_JPEG_QUALITY])
    processed_bytes = int(encoded.size) if ok else original_bytes

    # The full-size photo is turned the same way as arr, so one factor maps arr onto it.
    preview_scale = evidence_arr.shape[1] / arr.shape[1]
    results = []
    for f in faces:
        x1 = min(arr.shape[1], max(0, int(f.bbox[0])))
        y1 = min(arr.shape[0], max(0, int(f.bbox[1])))
        x2 = min(arr.shape[1], max(0, int(f.bbox[2])))
        y2 = min(arr.shape[0], max(0, int(f.bbox[3])))
        crop = face_preview(evidence_arr, (x1, y1, x2, y2), getattr(f, "kps", None), preview_scale)
        crop_b64 = ""
        if crop.size > 0:
            ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, FACE_PREVIEW_JPEG_QUALITY])
            if ok:
                crop_b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        results.append(
            {
                "bbox": [x1, y1, x2, y2],
                "embedding": f.normed_embedding.tolist(),
                "crop_base64": crop_b64,
                **anti_spoof.predict(arr, [x1, y1, x2, y2]).as_dict(),
            }
        )

    # Session-level fraud signal — see anti_spoofing.AntiSpoofingEngine.predict_whole_image for
    # why this is evaluated on the whole frame rather than derived from the per-face results above.
    whole_image_liveness = anti_spoof.predict_whole_image(arr).as_dict()

    elapsed_ms = round((time.time() - start) * 1000, 1)
    image_meta = {
        "original_width": original_width,
        "original_height": original_height,
        "original_bytes": original_bytes,
        "processed_width": processed_width,
        "processed_height": processed_height,
        "processed_bytes": processed_bytes,
        "resized": processed,
        "max_long_side": MAX_IMAGE_LONG_SIDE,
        "exif_orientation": exif_orientation,
        "sideways_rotation_degrees": sideways_correction,
        "orientation_corrected": exif_orientation != 1 or sideways_correction != 0,
    }
    logger.info(
        f'request_id={request_id} faces_detected={len(results)} processing_ms={elapsed_ms} '
        f'image_resized={processed} original={original_width}x{original_height}/{original_bytes} '
        f'processed={processed_width}x{processed_height}/{processed_bytes} '
        f'orientation_rotation={sideways_correction} '
        f'live={sum(face["liveness_status"] == "live" for face in results)} '
        f'suspicious={sum(face["liveness_status"] == "suspicious" for face in results)} '
        f'unverified={sum(face["liveness_status"] == "unverified" for face in results)} '
        f'whole_image_liveness={whole_image_liveness["liveness_status"]} '
        f'whole_image_score={whole_image_liveness["liveness_score"]} '
    )

    normalized_photo_base64 = None
    if image_meta["orientation_corrected"]:
        ok, normalized = cv2.imencode(".jpg", evidence_arr, [cv2.IMWRITE_JPEG_QUALITY, 95])
        if ok:
            normalized_photo_base64 = base64.b64encode(normalized.tobytes()).decode("ascii")

    return {
        "faces": results,
        "processing_ms": elapsed_ms,
        "request_id": request_id,
        "image_preprocessing": image_meta,
        "normalized_photo_base64": normalized_photo_base64,
        "whole_image_liveness": whole_image_liveness,
    }
