from __future__ import annotations

import re
from pathlib import Path


def ensure_dir(path: str | Path) -> Path:
    directory = Path(path)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip().lower()).strip("_")
    return slug or "proposal"


def format_number(value: float, decimals: int = 0) -> str:
    return f"{value:,.{decimals}f}"


def format_currency(value: float, currency: str = "USD", decimals: int = 0) -> str:
    return f"{currency} {value:,.{decimals}f}"


def format_kwp(value: float) -> str:
    return f"{value:,.1f} kWp"


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]

