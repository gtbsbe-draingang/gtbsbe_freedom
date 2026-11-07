from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
needs_dev = pytest.mark.skipif(not (REPO / "data/dev.json").exists(), reason="no DEV data")
needs_audio = pytest.mark.skipif(not (REPO / "data/audio").exists(), reason="no DEV audio")
