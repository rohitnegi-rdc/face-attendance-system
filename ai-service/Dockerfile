FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY anti_spoofing.py .
COPY models ./models

# Pre-download the buffalo_l model pack into the image at build time (single process, no
# race). Without this, every container start re-downloads ~300MB from GitHub, and with
# AI_SERVICE_WORKERS > 1 the concurrent uvicorn worker processes race to create
# /root/.insightface/models and crash with FileExistsError (insightface's download.py calls
# os.makedirs() unconditionally, not with exist_ok=True). Baking it in means the model is
# already on disk before any worker process starts, so `force=False` skips re-downloading
# and no worker ever calls the racy makedirs path.
RUN python -c "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider']).prepare(ctx_id=0, det_size=(640, 640))"

EXPOSE 8000
CMD uvicorn main:app --host 0.0.0.0 --port 8000 --workers ${AI_SERVICE_WORKERS:-2}
