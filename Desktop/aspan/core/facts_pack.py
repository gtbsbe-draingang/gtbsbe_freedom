from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from core.models import ClientInfo


@dataclass(frozen=True)
class FactsPack:
    text: str
    files_used: list[str]
    warnings: list[str]


def _read_optional(path: Path) -> tuple[str, str | None]:
    if not path.exists():
        return "", f"Missing facts pack file: {path.as_posix()}"
    return path.read_text(encoding="utf-8").strip(), None


def _country_filename(country: str) -> str:
    normalized = country.strip().lower().replace("'", "").replace(" ", "_")
    if normalized in {"cote_divoire", "cote_d_ivoire"}:
        return "cote_divoire.md"
    return f"{normalized}.md"


def load_facts_pack(
    client: ClientInfo,
    base_dir: str | Path = "knowledge_base",
) -> FactsPack:
    root = Path(base_dir)
    files = [
        root / "facts_pack.md",
        root / "ppa_model.md",
        root / "scope_of_services.md",
        root / "implementation_process.md",
        root / "assumptions_disclaimer.md",
        root / "industries" / f"{client.industry}.md",
        root / "countries" / _country_filename(client.country),
    ]

    sections: list[str] = []
    files_used: list[str] = []
    warnings: list[str] = []
    for path in files:
        text, warning = _read_optional(path)
        if text:
            sections.append(f"# Source: {path.as_posix()}\n{text}")
            files_used.append(path.as_posix())
        if warning:
            warnings.append(warning)

    if not sections:
        warnings.append("No facts pack files were available; narrative must avoid Aspan-specific claims.")
    return FactsPack("\n\n".join(sections), files_used, warnings)

