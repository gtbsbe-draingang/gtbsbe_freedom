import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from jsonschema import Draft202012Validator

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
        find_evaluations=lambda *a, **kw: e))
    response = client.get('/api/reports/accuracy')
    assert response.status_code == 200
    assert set(response.json()) == {'reference_note', 'model', 'overall', 'by_criterion', 'by_language',
                                     'by_channel', 'missing', 'disputed_excluded', 'disagreements'}
    assert response.json()['overall'] == {'agreement': 1.0, 'n': 4}
    assert client.get('/api/reports/accuracy?version=2').json()['error'] == 'reference_mismatch'
    assert client.get('/api/reports/accuracy?group_id=CONTROL').status_code == 409
    monkeypatch.setattr(route, 'get_store', lambda: SimpleNamespace(get_checklist_version=lambda *a: None))
    assert client.get('/api/reports/accuracy').json()['error'] == 'not_found'


def accuracy_validator():
    path = Path(__file__).resolve().parents[3] / 'contract/schemas/accuracy.schema.json'
    return Draft202012Validator(json.loads(path.read_text(encoding='utf-8')))


def test_shipped_references_default_to_v2_and_exclude_unapproved_labels(client):
    from app import store

    _, evaluations, kwargs = fixture_data()
    store.upsert_conversation(kwargs['conversations']['DEV:a'], None)
    store.insert_evaluation(evaluations[0])  # old v1 runs never count toward v2
    response = client.get('/api/reports/accuracy')
    assert response.status_code == 200
    data = response.json()
    accuracy_validator().validate(data)
    assert data['overall'] == {'agreement': None, 'n': 0}
    assert data['disputed_excluded'] == 41
    assert data['missing'] == 479
    assert client.get('/api/reports/accuracy?version=1').status_code == 409


def test_real_storage_empty_and_partial_report(client, tmp_path, monkeypatch):
    from app import store
    import quality.router as route

    reference, evaluations, kwargs = fixture_data()
    path = tmp_path / 'reference.json'
    path.write_text(reference.model_dump_json(), encoding='utf-8')
    monkeypatch.setattr(route, 'REFERENCE_PATH', path)
    for conv in kwargs['conversations'].values():
        store.upsert_conversation(conv, None)

    empty = client.get('/api/reports/accuracy')
    assert empty.status_code == 200
    accuracy_validator().validate(empty.json())
    assert empty.json()['overall'] == {'agreement': None, 'n': 0}
    assert empty.json()['missing'] == 4

    # Real persisted runs: only a's latest done MODEL run counts. The mock run is the newest of
    # all (review of PR 56: it must not hide the real run); older, failed, other-version,
    # other-checklist and other-group runs never count.
    for name, change in [
        ('old', {'created_at': '2025-01-01T00:00:00Z'}),
        ('mock', {'source': 'mock', 'created_at': '2026-12-31T00:00:00Z'}),
        ('failed', {'status': 'failed'}),
        ('version', {'version': 2}), ('checklist', {'checklist_id': 'custom'}),
        ('control', {'conversation': 'CONTROL:a'}),
    ]:
        data = evaluations[0].model_dump()
        data.update(id=name, **change)
        data['results'] = [r.model_copy(update={'answer': 'no'}).model_dump()
                           for r in evaluations[0].results]
        store.insert_evaluation(Evaluation.model_validate(data))
    store.upsert_conversation(kwargs['conversations']['DEV:a'].model_copy(
        update={'id': 'CONTROL:a', 'group_id': 'CONTROL'}), None)
    evaluations[0].results.pop()
    store.insert_evaluation(evaluations[0])
    partial = client.get('/api/reports/accuracy')
    assert partial.status_code == 200
    data = partial.json()
    accuracy_validator().validate(data)
    assert data['overall'] == {'agreement': 1.0, 'n': 1}
    assert data['missing'] == 3
    assert next(r for r in data['by_criterion'] if r['criterion_id'] == 'c02')['agreement'] is None
    # the shared store still returns the newest done run of any source for the other reports
    assert [e.id for e in store.list_evaluations('official-chat', 1, group_id='DEV') if e.conversation == 'DEV:a'] == ['mock']


@pytest.mark.parametrize('field', ['overall', 'by_criterion', 'by_language', 'by_channel'])
@pytest.mark.parametrize('agreement,n', [(0, 0), (None, 1)])
def test_schema_rejects_missing_as_zero_or_observed_as_null(field, agreement, n):
    r, e, kwargs = fixture_data()
    payload = accuracy_report(r, e, **kwargs).model_dump()
    cell = payload[field] if field == 'overall' else payload[field][0]
    cell.update(agreement=agreement, n=n)
    assert not accuracy_validator().is_valid(payload)
