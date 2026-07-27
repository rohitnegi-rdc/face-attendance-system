"""Face AI Microservice — insightface (buffalo_l) on ONNX Runtime CPU.

POST /internal/face/extract: accepts an image, returns bbox + 512-dim ArcFace
embedding + base64 crop per detected face. Internal-only (Docker network).
See plans/MasterPlan.md §5 / Prompt A "AI MICROSERVICE".
"""
import base64
import logging
import time
import uuid
from io import BytesIO

import cv2
import numpy as np
from fastapi import FastAPI, File, Header, UploadFile
from insightface.app import FaceAnalysis
from PIL import Image

MAX_FACES = 30

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
    return {"status": "ok", "model_loaded": face_app is not None}


@app.post("/internal/face/extract")
async def extract_faces(file: UploadFile = File(...), x_request_id: str | None = Header(default=None)):
    request_id = x_request_id or str(uuid.uuid4())
    start = time.time()

    raw = await file.read()
    img = Image.open(BytesIO(raw)).convert("RGB")
    arr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    faces = face_app.get(arr)
    faces = faces[:MAX_FACES]

    results = []
    for f in faces:
        x1, y1, x2, y2 = [max(0, int(v)) for v in f.bbox]
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
