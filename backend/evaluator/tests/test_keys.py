import re
from decimal import Decimal

from evaluator.keys import reuse_key, transcript_hash
from evaluator.testing import make_checklist, make_conv, make_criterion

M = "claude-haiku-5-5"
LINES = [("client", "Привет"), ("operator", "Здравствуйте")]


def _key(conv=None, checklist=None, criterion=None, model=M):
    return reuse_key(conv or make_conv(LINES), checklist or make_checklist(), criterion or make_criterion(), model)


def test_same_inputs_same_key_64_hex():
    k = _key()
    assert k == _key() and re.fullmatch(r"[0-9a-f]{64}", k)


def test_weight_order_rounding_do_not_change_key():
    assert _key(criterion=make_criterion(weight=Decimal(99), order=5)) == _key()
    assert _key(checklist=make_checklist(rounding=0)) == _key()


def test_changes_give_new_key():
    base = _key()
    assert _key(criterion=make_criterion(fingerprint="a" * 64)) != base
    assert _key(model="claude-sonnet-5-5") != base
    assert _key(checklist=make_checklist(guidance="other")) != base
    assert _key(conv=make_conv([("client", "Привет"), ("operator", "Здравствуйте!")])) != base
    assert _key(conv=make_conv(LINES, duplicates={1})) != base
    assert _key(conv=make_conv(LINES, timestamps=["00:00", "00:11"])) != base


def test_facts_and_voice_change_key():
    from evaluator._compat import Facts, VoiceMeasurement

    base = make_conv(LINES)
    facts = Facts(operator_joined_index=1, first_reaction_seconds=1.0, longest_wait_seconds=2.0,
                  identity_verified_index=None, ending="normal")
    c2 = base.model_copy(update={"facts": facts})
    c3 = c2.model_copy(update={"facts": facts.model_copy(update={"first_reaction_seconds": 2.0})})
    vm = VoiceMeasurement(message_index=0, from_seconds=0, to_seconds=1, pitch_range=1.0, rate_wpm=100.0,
                          pauses=0.1, overlap=0.0)
    c4 = base.model_copy(update={"voice_measurements": [vm]})
    keys = {_key(conv=c) for c in (base, c2, c3, c4)}
    assert len(keys) == 4


def test_prompt_version_in_key(monkeypatch):
    from evaluator import prompt

    base = _key()
    monkeypatch.setattr(prompt, "PROMPT_VERSION", "other")
    assert _key() != base


def test_transcript_hash_depends_on_transcript_only():
    a = make_conv(LINES)
    assert transcript_hash(a) == transcript_hash(make_conv(LINES, language="KZ"))
    assert transcript_hash(a) != transcript_hash(make_conv(LINES[:1]))


def test_info_key_changes_with_transcript_facts_model_and_is_not_a_criterion_key():
    from evaluator.keys import info_key

    conv = make_conv(LINES)
    k = info_key(conv, M)
    assert re.fullmatch(r"[0-9a-f]{64}", k) and k == info_key(make_conv(LINES), M)
    assert info_key(conv, "claude-sonnet-5-5") != k
    assert info_key(make_conv([("client", "Привет"), ("operator", "Здравствуйте!")]), M) != k
    assert k != _key(conv=conv)


def test_rendered_prompt_text_is_in_the_key_even_if_fingerprint_is_stale():
    base = _key()
    assert _key(criterion=make_criterion(wording="другая формулировка")) != base
    assert _key(criterion=make_criterion(na_allowed=True, na_condition="условие")) != base
    assert _key(criterion=make_criterion(guidance="подсказка")) != base
    assert _key(checklist=make_checklist(name="Другое имя")) != base
    assert _key(criterion=make_criterion(title="Другой заголовок")) != base
