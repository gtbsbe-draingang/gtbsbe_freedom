"""Conservative local-model selection; no hosted provider or invented benchmark."""
import json
from pathlib import Path

from quality.models import AgreementCell


def choose_model(baseline: AgreementCell, challenger: AgreementCell, baseline_planted_ok: bool,
                 *, baseline_model: str, challenger_model: str, challenger_planted_ok: bool = False,
                 expected_n: int, tolerance: float = 0.03) -> str | None:
    """Require complete, paired cohorts and planted checks before recommending defaults.

    The caller must use the same reference/group/version and label set for both reports.
    A missing benchmark yields no recommendation, not an automatic model promotion.
    """
    if expected_n <= 0 or baseline.n != expected_n or challenger.n != expected_n:
        return None
    if baseline.agreement is None or challenger.agreement is None:
        return None
    if not 0 <= tolerance <= 1:
        raise ValueError("Invalid tolerance")
    if baseline_planted_ok and baseline.agreement >= challenger.agreement - tolerance:
        return baseline_model
    return challenger_model if challenger_planted_ok else None


def write_models(seed_path: Path, models: dict[str, str]) -> None:
    """Set models only on an unpublished seed copy; published versions are immutable."""
    seed_path = Path(seed_path)
    seed = json.loads(seed_path.read_text(encoding="utf-8"))
    ids = {c["id"] for c in seed["criteria"]}
    if set(models) - ids:
        raise ValueError("Unknown criterion IDs")
    if any(not isinstance(m, str) or not m.strip() for m in models.values()):
        raise ValueError("A concrete local model identifier is required")
    for criterion in seed["criteria"]:
        if criterion["id"] in models:
            criterion["model"] = models[criterion["id"]]
    seed_path.write_text(json.dumps(seed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
