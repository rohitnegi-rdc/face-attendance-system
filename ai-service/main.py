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
from PIL import Image

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


@app.on_event("startup")
def load_model():
    global face_app
    logger.info("loading buffalo_l model pack (warm, once at startup)")
    face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    face_app.prepare(ctx_id=0, det_size=(640, 640))
    logger.info("model pack ready")


@app.get("/health")
def health():
    if face_app is None:
        raise HTTPException(status_code=503, detail="Face recognition model is not ready")
    return {"status": "ok", "model_loaded": face_app is not None}


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
        img = Image.open(BytesIO(raw)).convert("RGB")
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=415, detail="Invalid or unsupported image") from error
    arr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    faces = face_app.get(arr)
    faces = faces[:MAX_FACES]

    results = []
    for f in faces:
        x1 = min(arr.shape[1], max(0, int(f.bbox[0])))
        y1 = min(arr.shape[0], max(0, int(f.bbox[1])))
        x2 = min(arr.shape[1], max(0, int(f.bbox[2])))
        y2 = min(arr.shape[0], max(0, int(f.bbox[3])))
        crop = arr[y1:y2, x1:x2]
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
            }
        )

    elapsed_ms = round((time.time() - start) * 1000, 1)
    logger.info(f'request_id={request_id} faces_detected={len(results)} processing_ms={elapsed_ms}')

    return {"faces": results, "processing_ms": elapsed_ms, "request_id": request_id}
