# Evaluation Approval Profiles

This folder contains reusable approval thresholds for face attendance quality.

- `face-approval.full.json`: strict 100-identity Pins Face Recognition approval gate.
- `face-approval.lfw-sanity.json`: smaller LFW identity sanity gate.
- `face-approval.smoke.json`: fast smoke gate for the checked-in group-photo corpus.
- `face-approval.wider-smoke.json`: WIDER FACE bbox detection smoke gate.
- `datasets.local.json`: generated local dataset registry. Ignored by git.
- `manifests/`: generated dataset manifests. JSON manifests are ignored because they can contain local paths and biometric dataset metadata.

Common commands:

```powershell
npm run eval:download:core
npm run eval:manifest:pins:local
npm run eval:manifest:lfw:local
npm run eval:manifest:wider:local
npm run eval:manifest:pins
npm run eval:faces:smoke
npm run eval:faces:lfw
npm run eval:faces:wider
npm run eval:faces
npm run eval:approve
npm run eval:index
```

Where to look after a run:

- Start with `test-output/evaluations/INDEX.md`. It lists every run with its real evaluation name, status, dataset, key metrics, and links.
- New run folders are named like `<timestamp>__<approved-or-blocked>__<profile>__<dataset>`, not only by date.
- Inside a run folder, open `README.md` first.
- Open `review/index.html` to see the visual report: metrics, approval gates, and every evaluated photo/case thumbnail.
- Open `review/cases.csv` for the compact per-photo evidence table.
- Open `review/approval-gates.csv` to see which approval checks passed or failed.

Output layout:

```text
test-output/evaluations/
  INDEX.md
  <timestamp>__<status>__<profile>__<dataset>/
    README.md
    review/
      index.html
      cases.csv
      metrics.json
      approval-gates.csv
      photos/
        *.jpg
```

The runner keeps this compact layout by default. Use `--keep-raw` only when debugging the eval harness internals.

Dataset notes:

- Pins is the main 100-user attendance-style benchmark.
- LFW is a cleaner sanity benchmark and is useful for checking whether detector, embedding, and ranking behavior work end to end.
- WIDER uses labeled train/val annotation files and scores bbox IoU, detection precision/recall, count accuracy, and contract validity.
- CelebA and VGGFace2 are intentionally skipped by the core downloader because they are large; run `python scripts/download-eval-datasets.py --all --include-large` only when you explicitly want those larger downloads.

Full design:

```text
plans/FaceAttendanceEvaluationApprovalSystem.md
```
