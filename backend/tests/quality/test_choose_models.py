import json

import pytest

from quality.choose_models import choose_model, write_models
from quality.models import AgreementCell


@pytest.mark.parametrize('a,b,planted,challenger_ok,expected', [
    (.90, .92, True, True, 'base'), (.85, .92, True, True, 'challenger'),
    (.95, .92, False, True, 'challenger'), (.85, .92, True, False, None),
    (None, .92, True, True, None)])
def test_selection(a, b, planted, challenger_ok, expected):
    assert choose_model(AgreementCell(agreement=a, n=100), AgreementCell(agreement=b, n=100), planted,
                        baseline_model='base', challenger_model='challenger',
                        challenger_planted_ok=challenger_ok, expected_n=100) == expected


def test_incomplete_is_not_a_recommendation():
    assert choose_model(AgreementCell(agreement=1, n=1), AgreementCell(agreement=1, n=2), True,
                        baseline_model='base', challenger_model='challenger', expected_n=2) is None


def test_write_changes_only_model(tmp_path):
    path = tmp_path / 'seed.json'
    original = {'name': 'draft', 'criteria': [{'id': 'custom', 'wording': 'unchanged', 'model': None}]}
    path.write_text(json.dumps(original), encoding='utf-8')
    write_models(path, {'custom': 'local-model'})
    result = json.loads(path.read_text(encoding='utf-8'))
    original['criteria'][0]['model'] = 'local-model'
    assert result == original
    with pytest.raises(ValueError): write_models(path, {'unknown': 'model'})
