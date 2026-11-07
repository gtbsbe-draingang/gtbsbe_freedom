"""#25: team interpretations live only in per-criterion guidance of the official seed."""
import json
from pathlib import Path

SEED = Path(__file__).resolve().parents[3] / "checklists" / "official-chat-v1.json"
TEAM = {"c01", "c03", "c06", "c07"}


def test_team_guidance_present_and_official_wording_kept():
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    for c in seed["criteria"]:
        if c["id"] in TEAM:
            assert c["guidance"].startswith("Уточнение команды: ")
            assert "Уточнение команды" not in c["wording"]
        else:
            assert c["guidance"] is None
    assert "порог первой реакции в 3 минуты" in seed["guidance"]
