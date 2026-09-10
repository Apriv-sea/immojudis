"""Build an allow-listed standalone Python deployment, never the dirty frontend."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHARED_FILES = (
    "__init__.py",
    "config.py",
    "models.py",
    "normalize.py",
    "raw_models.py",
    "sources/__init__.py",
    "sources/common.py",
    "sources/image_candidates.py",
    "sources/licitor.py",
    "sources/licitor_history.py",
    "sources/licitor_history_run.py",
    "sources/licitor_cloud.py",
    "sources/licitor_cloud_store.py",
)


def build(destination: Path) -> None:
    if destination.exists():
        raise ValueError(
            "Choose a new empty deployment directory; existing data is never overwritten"
        )
    destination.mkdir(parents=True, mode=0o700)
    source = ROOT / "services/licitor-collector"
    for relative in (
        "vercel.json",
        "requirements.txt",
        ".python-version",
        ".vercelignore",
        "api/tick.py",
        "api/monthly.py",
        "api/status.py",
    ):
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target)
    for relative in SHARED_FILES:
        target = destination / "src" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "services/data-pipeline/src" / relative, target)
    print(f"Collector-only deployment prepared: {destination.resolve()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    build(parser.parse_args().destination)
