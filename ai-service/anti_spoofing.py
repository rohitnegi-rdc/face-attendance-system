"""CPU-only MiniFASNetV2 inference with conservative image-quality gating."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort


MODEL_VERSION = "minifasnet-v2-1"


@dataclass(frozen=True)
class LivenessResult:
    status: str
    score: float | None
    quality: str
    reason: str | None
    model: str = MODEL_VERSION
    inference_ms: float = 0.0

    def as_dict(self) -> dict:
        return {
            "liveness_status": self.status,
            "liveness_score": self.score,
            "liveness_quality": self.quality,
            "liveness_reason": self.reason,
            "liveness_model": self.model,
            "liveness_inference_ms": self.inference_ms,
        }


class AntiSpoofingEngine:
    def __init__(self) -> None:
        self.enabled = os.getenv("ANTI_SPOOF_ENABLED", "true").lower() == "true"
        self.model_path = os.getenv(
            "ANTI_SPOOF_MODEL_PATH", "/app/models/MiniFASNetV2.onnx"
        )
        self.live_threshold = float(os.getenv("ANTI_SPOOF_LIVE_THRESHOLD", "0.80"))
        self.suspicious_threshold = float(
            os.getenv("ANTI_SPOOF_SUSPICIOUS_THRESHOLD", "0.20")
        )
        self.min_face_size = int(os.getenv("ANTI_SPOOF_MIN_FACE_SIZE", "64"))
        self.min_blur_variance = float(os.getenv("ANTI_SPOOF_MIN_BLUR_VARIANCE", "35"))
        self.session: ort.InferenceSession | None = None
        self.input_name = ""
        self.output_name = ""
        self.input_size = (80, 80)

        if self.enabled and os.path.isfile(self.model_path):
            options = ort.SessionOptions()
            options.intra_op_num_threads = max(1, int(os.getenv("ANTI_SPOOF_THREADS", "1")))
            self.session = ort.InferenceSession(
                self.model_path,
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
            model_input = self.session.get_inputs()[0]
            self.input_name = model_input.name
            height, width = model_input.shape[-2:]
            if isinstance(height, int) and isinstance(width, int):
                self.input_size = (width, height)
            self.output_name = self.session.get_outputs()[0].name

    @property
    def ready(self) -> bool:
        return self.session is not None

    def _quality_reason(self, image: np.ndarray, bbox: list[int]) -> str | None:
        x1, y1, x2, y2 = bbox
        width, height = x2 - x1, y2 - y1
        if min(width, height) < self.min_face_size:
            return "face_too_small"
        if x1 <= 1 or y1 <= 1 or x2 >= image.shape[1] - 1 or y2 >= image.shape[0] - 1:
            return "face_clipped"
        crop = image[y1:y2, x1:x2]
        if crop.size == 0:
            return "empty_crop"
        blur = cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
        if blur < self.min_blur_variance:
            return "face_blurred"
        return None

    @staticmethod
    def _softmax(logits: np.ndarray) -> np.ndarray:
        shifted = logits - np.max(logits, axis=1, keepdims=True)
        exponent = np.exp(shifted)
        return exponent / exponent.sum(axis=1, keepdims=True)

    def _crop(self, image: np.ndarray, bbox: list[int], scale: float = 2.7) -> np.ndarray:
        x1, y1, x2, y2 = bbox
        box_w, box_h = x2 - x1, y2 - y1
        actual_scale = min(
            (image.shape[0] - 1) / max(1, box_h),
            (image.shape[1] - 1) / max(1, box_w),
            scale,
        )
        center_x, center_y = x1 + box_w / 2, y1 + box_h / 2
        half_w, half_h = box_w * actual_scale / 2, box_h * actual_scale / 2
        left, top = max(0, int(center_x - half_w)), max(0, int(center_y - half_h))
        right = min(image.shape[1] - 1, int(center_x + half_w))
        bottom = min(image.shape[0] - 1, int(center_y + half_h))
        return cv2.resize(image[top : bottom + 1, left : right + 1], self.input_size)

    def _classify(self, image: np.ndarray, bbox: list[int]) -> LivenessResult:
        started = time.perf_counter()
        face = self._crop(image, bbox).astype(np.float32)
        tensor = np.expand_dims(np.transpose(face, (2, 0, 1)), axis=0)
        logits = self.session.run([self.output_name], {self.input_name: tensor})[0]
        probabilities = self._softmax(logits)
        predicted_class = int(np.argmax(probabilities[0]))
        live_score = float(probabilities[0, 1]) if probabilities.shape[1] > 1 else 0.0
        elapsed = round((time.perf_counter() - started) * 1000, 2)

        if predicted_class == 1 and live_score >= self.live_threshold:
            status = "live"
        elif predicted_class != 1 and live_score <= self.suspicious_threshold:
            status = "suspicious"
        else:
            status = "unverified"
        return LivenessResult(status, live_score, "sufficient", None, inference_ms=elapsed)

    def predict(self, image: np.ndarray, bbox: list[int]) -> LivenessResult:
        """Per-face liveness — used for the "needs review" UI on individual faces."""
        if not self.enabled:
            return LivenessResult("unverified", None, "insufficient", "disabled")
        if not self.ready:
            return LivenessResult("unverified", None, "insufficient", "model_unavailable")
        reason = self._quality_reason(image, bbox)
        if reason:
            return LivenessResult("unverified", None, "insufficient", reason)
        return self._classify(image, bbox)

    def predict_whole_image(self, image: np.ndarray) -> LivenessResult:
        """Whole-photo liveness — the session-level fraud signal.

        A screen/print recapture (someone photographing a phone or printout instead of
        real people) is far more reliable to catch from the *whole frame* than by voting
        across small per-face crops: moiré, bezel edges, and screen glare are frame-level
        cues that a face crop of 70-150px often doesn't carry, and a single face crop can
        be misread by the model in isolation even when the photo is obviously a recapture.
        Deliberately skips the per-face quality gate's edge-clipping check — a full-frame
        bbox always touches every edge by definition, so that check does not apply here.
        """
        if not self.enabled:
            return LivenessResult("unverified", None, "insufficient", "disabled")
        if not self.ready:
            return LivenessResult("unverified", None, "insufficient", "model_unavailable")
        return self._classify(image, [0, 0, image.shape[1], image.shape[0]])
