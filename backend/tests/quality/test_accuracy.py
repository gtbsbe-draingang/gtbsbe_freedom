import json
from types import SimpleNamespace

import pytest

from app.models import Conversation, CriterionResult, Evaluation, StepAnswer
from quality.accuracy import accuracy_report, answers_match
from quality.models import ReferenceSet


def fixture_data():
    reference = ReferenceSet(checklist_id="official-chat", version=1, labels=[
        dict(conversation_id=c, criterion_id=k, answer="yes") for c in ("a", "b") for k in ("c01", "c02")])
    convs = {f"DEV:{c}": Conversation(id=f"DEV:{c}", conversation_id=c, group_id="DEV", transcript=[],
              language=lang, channel=channel) for c, lang, channel in [("a", "RU", "agent chat"), ("b", "KZ", "voice call")]}
    checklist = SimpleNamespace(criteria=[SimpleNamespace(id=k, title=k) for k in ("c01", "c02")])
    evals = [Evaluation(id=c, created_at="2026-11-07T10:00:00Z", conversation=f"DEV:{c}", checklist_id="official-chat",
              version=1, status="done", model="local-base", results=[CriterionResult(
                  criterion_id=k, answer="yes", explanation="fixture", confidence="high", points=10,
                  effective_weight=10) for k in ("c01", "c02")]) for c in ("a", "b")]
    return reference, evals, dict(conversations=convs, checklist=checklist)


def test_perfect_and_breakdowns():
    r, e, kwargs = fixture_data()
    report = accuracy_report(r, e, **kwargs)
    assert report.overall.model_dump() == dict(agreement=1.0, n=4)
    assert {x['language']: x['n'] for x in report.by_language} == {"RU": 2, "KZ": 2}
    assert {x['channel']: x['n'] for x in report.by_channel} == {"agent chat": 2, "voice call": 2}


def test_disputes_missing_steps_and_human_override():
    r, e, kwargs = fixture_data()
    r.labels[0].disputed = True
    r.labels[1].answer = StepAnswer(step=10)
    e[0].results[1].answer = StepAnswer(step=5)
    e[0].results[1].final_answer = StepAnswer(step=10)
    e[1].results.pop()
    report = accuracy_report(r, e, **kwargs)
    assert report.disputed_excluded == 1 and report.missing == 1
    assert report.overall.agreement == .5 and report.overall.n == 2
    assert report.disagreements[0]['reference'] == {'step': 10}
    assert report.disagreements[0]['evaluated'] == {'step': 5}
    assert answers_match(StepAnswer(step=10), StepAnswer(step=10))
    assert not answers_match(StepAnswer(step=10), "yes")


@pytest.mark.parametrize('change', ['group', 'mock', 'version', 'failed', 'replaced'])
def test_invalid_comparisons_are_missing(change):
    r, e, kwargs = fixture_data()
    for ev in e:
        if change == 'group': ev.conversation = ev.conversation.replace('DEV:', 'CTRL:')
        if change == 'mock': ev.source = 'mock'
        if change == 'version': ev.version = 2
        if change == 'failed': ev.status = 'failed'
        if change == 'replaced':
            for result in ev.results: result.criterion_id += '-replacement'
    report = accuracy_report(r, e, **kwargs)
    assert report.missing == 4 and report.overall.n == 0
    assert report.overall.agreement is None
    assert not report.disagreements


def test_latest_run_and_model_names():
    r, e, kwargs = fixture_data()
    old = e[0].model_copy(deep=True)
    old.created_at = old.created_at.replace(year=2025)
    old.results[0].answer = 'no'
    e[0].results[0].model = 'local-challenger'
    report = accuracy_report(r, [*e, old], **kwargs)
    assert report.overall.agreement == 1
    assert report.model == 'local-base,local-challenger'


def test_duplicate_reference_rejected():
    r, _, _ = fixture_data()
    payload = r.model_dump()
    payload['labels'].append(payload['labels'][0])
    with pytest.raises(ValueError, match='Duplicate'):
        ReferenceSet.model_validate(payload)


def test_router_missing_reference_and_valid_shape(tmp_path, monkeypatch, client):
    import quality.router as route
    r, e, kwargs = fixture_data()
    path = tmp_path / 'refs.json'
    monkeypatch.setattr(route, 'REFERENCE_PATH', path)
    assert client.get('/api/reports/accuracy').json()['error'] == 'reference_missing'
    path.write_text(r.model_dump_json(), encoding='utf-8')
    monkeypatch.setattr(route, 'get_store', lambda: SimpleNamespace(
        get_checklist_version=lambda *a: kwargs['checklist'],
        get_conversation=lambda key: kwargs['conversations'].get(key),
        list_evaluations=lambda *a, **kw: e))
    response = client.get('/api/reports/accuracy')
    assert response.status_code == 200
    assert set(response.json()) == {'reference_note', 'model', 'overall', 'by_criterion', 'by_language',
                                     'by_channel', 'missing', 'disputed_excluded', 'disagreements'}
    assert response.json()['overall'] == {'agreement': 1.0, 'n': 4}
    assert client.get('/api/reports/accuracy?version=2').json()['error'] == 'reference_mismatch'
    assert client.get('/api/reports/accuracy?group_id=CONTROL').status_code == 409
    monkeypatch.setattr(route, 'get_store', lambda: SimpleNamespace(get_checklist_version=lambda *a: None))
    assert client.get('/api/reports/accuracy').json()['error'] == 'not_found'
