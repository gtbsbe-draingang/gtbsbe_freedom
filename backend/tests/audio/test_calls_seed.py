from copy import deepcopy

import pytest

from audio.build_calls_seed import build_calls_seed


def test_copies_authoritative_fields_without_mutating_source():
    official = dict(checklist_id='official-chat', version=3, sections=[dict(id='conduct')], criteria=[
        dict(id=f'c{i:02d}', section_id='conduct', order=i, wording='В чате', na_condition='Конец чата',
             answer_type='yes_no', scale_steps=[], weight=i, na_allowed=True, kind='scored',
             model='local-model', fingerprint='old') for i in range(1, 9)])
    before = deepcopy(official)
    calls = build_calls_seed(official)
    assert official == before
    assert 'based_on' not in calls and calls['checklist_id'] == 'calls' and calls['locked'] is False
    for old, new in zip(official['criteria'], calls['criteria']):
        for field in ('id', 'section_id', 'answer_type', 'scale_steps', 'weight', 'na_allowed', 'kind', 'model'):
            assert new[field] == old[field]
        assert 'чат' not in new['wording'] and 'чат' not in new['na_condition']
        assert 'fingerprint' not in new
    last = calls['criteria'][-1]
    assert last['id'] == 'c09' and last['weight'] == 10 and last['na_allowed']
    assert [s['value'] for s in last['scale_steps']] == [0, 5, 10]


def test_rejects_retyped_ids():
    with pytest.raises(ValueError):
        build_calls_seed(dict(checklist_id='official-chat', criteria=[dict(id='01')]))
