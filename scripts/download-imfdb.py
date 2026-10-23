"""Download IMFDB (Indian Movie Face Database, CVIT IIIT Hyderabad) into datasets/imfdb/.

About 92 MB: 34,512 face crops of 100 Indian actors from 100+ films, with per-frame annotations
(pose, illumination, occlusion, age). Academic dataset, no licence stated by the authors: use it
for internal evaluation only and cite Setty et al., "Indian Movie Face Database: A Benchmark for
Face Recognition Under Wide Variations", NCVPRIPG 2013. datasets/ is ignored by git.

  python scripts/download-imfdb.py
"""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "datasets" / "imfdb"
URL = "https://cvit.iiit.ac.in/projects/IMFDB/IMFDB_final.zip"


def main() -> int:
    if (TARGET / "IMFDB_final").exists():
        print(f"Already there: {TARGET / 'IMFDB_final'}")
        return 0
    TARGET.mkdir(parents=True, exist_ok=True)
    archive = TARGET / "IMFDB_final.zip"
    with requests.get(URL, stream=True, timeout=60) as response:
        response.raise_for_status()
        with archive.open("wb") as handle:
            shutil.copyfileobj(response.raw, handle)
    with zipfile.ZipFile(archive) as z:
        for name in z.namelist():
            if name.startswith("/") or ".." in Path(name).parts:
                raise SystemExit(f"Unsafe path in archive: {name}")
        z.extractall(TARGET)
    archive.unlink()
    print(f"Extracted to {TARGET / 'IMFDB_final'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
