import os
import unittest
from unittest.mock import patch

import numpy as np

from anti_spoofing import AntiSpoofingEngine


class AntiSpoofingEngineTests(unittest.TestCase):
    def make_engine(self):
        with patch.dict(os.environ, {"ANTI_SPOOF_MODEL_PATH": "missing.onnx"}):
            return AntiSpoofingEngine()

    def test_missing_model_is_unverified(self):
        result = self.make_engine().predict(np.zeros((200, 200, 3), dtype=np.uint8), [40, 40, 140, 140])
        self.assertEqual(result.status, "unverified")
        self.assertEqual(result.reason, "model_unavailable")

    def test_small_face_is_unverified_when_model_is_ready(self):
        engine = self.make_engine()
        engine.session = object()
        result = engine.predict(np.zeros((200, 200, 3), dtype=np.uint8), [40, 40, 80, 80])
        self.assertEqual(result.status, "unverified")
        self.assertEqual(result.reason, "face_too_small")

    def test_clipped_face_is_unverified(self):
        engine = self.make_engine()
        engine.session = object()
        result = engine.predict(np.zeros((200, 200, 3), dtype=np.uint8), [0, 20, 100, 120])
        self.assertEqual(result.reason, "face_clipped")

    def test_low_live_probability_is_suspicious(self):
        class FakeSession:
            def run(self, *_args, **_kwargs):
                return [np.asarray([[4.0, 0.01, 3.5]], dtype=np.float32)]

        engine = self.make_engine()
        engine.session = FakeSession()
        engine.input_name = "input"
        engine.output_name = "output"
        image = np.random.default_rng(7).integers(0, 255, (240, 240, 3), dtype=np.uint8)
        result = engine.predict(image, [70, 70, 170, 170])
        self.assertEqual(result.status, "suspicious")
        self.assertLess(result.score, engine.suspicious_threshold)


if __name__ == "__main__":
    unittest.main()
