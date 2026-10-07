"""Face AI Microservice — insightface (buffalo_l) on ONNX Runtime CPU.

POST /internal/face/extract: accepts an image, returns bbox + 512-dim ArcFace
embedding + base64 crop per detected face. Internal-only (Docker network).
See plans/MasterPlan.md §5 / Prompt A "AI MICROSERVICE".
"""
import base64
import logging
import os
import time
import uuid
from io import BytesIO

import cv2
import numpy as np
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from insightface.app import FaceAnalysis
from insightface.utils import face_align
from PIL import Image, ImageOps

from anti_spoofing import AntiSpoofingEngine

MAX_FACES = 30
MAX_IMAGE_LONG_SIDE = max(640, int(os.getenv("AI_MAX_IMAGE_LONG_SIDE", "1920")))
RESIZE_JPEG_QUALITY = min(100, max(50, int(os.getenv("AI_RESIZE_JPEG_QUALITY", "90"))))
MAX_UPLOAD_BYTES = max(1, int(os.getenv("AI_MAX_UPLOAD_BYTES", str(18 * 1024 * 1024))))
MAX_IMAGE_PIXELS = 20_000_000

# Structured JSON logging (plans/MasterPlan.md §7a)
logging.basicConfig(level=logging.INFO, format='{"timestamp":"%(asctime)s","level":"%(levelname)s","service":"ai-service","message":"%(message)s"}')
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


def upright_face_crop(image: np.ndarray, bbox, landmarks) -> np.ndarray:
    """Align a detected face to canonical upright eye, nose, and mouth landmarks."""
    if landmarks is not None and len(landmarks) >= 5:
        try:
            return face_align.norm_crop(
                image,
                landmark=np.asarray(landmarks, dtype=np.float32),
                image_size=224,
                mode="arcface",
            )
        except (cv2.error, ValueError):
            logger.warning("face landmark alignment failed; using the original crop")

    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1
    padding = int(max(width, height) * 0.28)
    left = max(0, x1 - padding)
    top = max(0, y1 - padding)
    right = min(image.shape[1], x2 + padding)
    bottom = min(image.shape[0], y2 + padding)
    return image[top:bottom, left:right]


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

    results = []
    for f in faces:
        x1 = min(arr.shape[1], max(0, int(f.bbox[0])))
        y1 = min(arr.shape[0], max(0, int(f.bbox[1])))
        x2 = min(arr.shape[1], max(0, int(f.bbox[2])))
        y2 = min(arr.shape[0], max(0, int(f.bbox[3])))
        crop = upright_face_crop(arr, (x1, y1, x2, y2), getattr(f, "kps", None))
        crop_b64 = ""
        if crop.size > 0:
            ok, buf = cv2.imencode(".jpg", crop)
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
