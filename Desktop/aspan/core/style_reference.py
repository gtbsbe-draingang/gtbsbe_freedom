from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core.models import ClientInfo


@dataclass(frozen=True)
class StyleReference:
    text: str | None
    file_used: str | None
    warnings: list[str]


def _score(entry: dict[str, Any], client: ClientInfo) -> int:
    industry_match = str(entry.get("industry", "")).lower() == client.industry.lower()
    country_match = str(entry.get("country", "")).lower() == client.country.lower()
    if industry_match and country_match:
        return 3
    if industry_match:
        return 2
    if country_match:
        return 1
    return 0


def select_style_reference(
    client: ClientInfo,
    reference_dir: str | Path = "reference_materials",
) -> StyleReference:
    root = Path(reference_dir)
    index_path = root / "reference_index.json"
    warnings: list[str] = []
    if not index_path.exists():
        return StyleReference(None, None, ["No style reference index found."])

    try:
        entries = json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return StyleReference(None, None, [f"Style reference index is invalid JSON: {exc}"])

    candidates = [
        entry
        for entry in entries
        if entry.get("use_for") == "style_reference" and _score(entry, client) > 0
    ]
    if not candidates:
        return StyleReference(None, None, warnings)

    selected = max(candidates, key=lambda entry: _score(entry, client))
    file_name = selected.get("file")
    if not file_name:
        return StyleReference(None, None, ["Selected style reference has no file field."])

    path = root / file_name
    if not path.exists():
        return StyleReference(None, None, [f"Style reference file missing: {path.as_posix()}"])

    return StyleReference(path.read_text(encoding="utf-8"), path.as_posix(), warnings)

