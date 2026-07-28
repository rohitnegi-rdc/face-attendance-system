# Group Face E2E Corpus

This fixture set contains four Creative Commons group photographs and sixteen deterministic
derivatives used to test face detection and embedding stability.

Run:

```powershell
python scripts/build-group-e2e-corpus.py
```

The generated `manifest.json` records source attribution, license, SHA-256 checksums, dimensions,
expected visible-face counts, and the transformation applied to each of the 20 test images.
Derived images remain under the source image's stated license. They are test data only and must not
be used to identify the photographed people.

Raw embeddings and face crops are written only to the git-ignored
`test-output/attendance-e2e/<run-id>/` directory.
