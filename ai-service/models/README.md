# MiniFASNetV2 ONNX

`MiniFASNetV2.onnx` is the CPU inference artifact used for shadow-mode face
anti-spoofing. It is derived from Minivision's Silent Face Anti-Spoofing model
and distributed by the `yakhyo/face-anti-spoofing` project under Apache-2.0.

- Input: BGR float32 tensor, NCHW, 80x80
- Real class index: 1
- Crop scale: 2.7
- SHA-256: `b32929adc2d9c34b9486f8c4c7bc97c1b69bc0ea9befefc380e4faae4e463907`
- Source: https://github.com/yakhyo/face-anti-spoofing/releases/download/weights/MiniFASNetV2.onnx

This model is a review signal, not proof of identity. Threshold changes require
evaluation against pump-camera images and staged print/display attacks.
