import json

import pytest

from quality.planted import PLANTED

from .conftest import REPO, needs_dev

LABELS = REPO / "data" / "reference" / "dev_labels.json"


@needs_dev
@pytest.mark.skipif(not LABELS.exists(), reason="no reference file")
def test_planted_pairs_match_reference():
    labels = json.loads(LABELS.read_text(encoding="utf-8"))["labels"]
    got = {(lab["conversation_id"], lab["criterion_id"]): lab["answer"] for lab in labels}
    wrong = [(c, k, want, got.get((c, k))) for c, k, want in PLANTED if got.get((c, k)) != want]
    assert wrong == []
