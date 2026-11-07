"""Agreement with reviewed references, never with human-overridden final answers."""
from collections import defaultdict
from pathlib import Path

from app.models import Answer, Evaluation, StepAnswer
from quality.models import AccuracyReport, AgreementCell, ReferenceSet


def load_reference(path: Path) -> ReferenceSet:
    return ReferenceSet.model_validate_json(Path(path).read_text(encoding="utf-8"))


def answer_json(answer: Answer):
    return answer.model_dump() if isinstance(answer, StepAnswer) else answer


def answers_match(ref: Answer, got: Answer) -> bool:
    return answer_json(ref) == answer_json(got)


def _cell(values):
    return AgreementCell(agreement=round(sum(values) / len(values), 4) if values else None, n=len(values))


def accuracy_report(reference: ReferenceSet, evaluations: list[Evaluation], *,
                    group_id="DEV", conversations=None, checklist=None) -> AccuracyReport:
    """Use the latest completed real evaluation per conversation of this exact version.

    Explicit group matching prevents a control-set ID from matching a DEV label.
    Pass conversations/checklist for offline reports; otherwise use B's store.
    """
    if conversations is None or checklist is None:
        from app import store
        if conversations is None:
            conversations = {
                f"{group_id}:{r.conversation_id}": store.get_conversation(f"{group_id}:{r.conversation_id}")
                for r in reference.labels
            }
        if checklist is None:
            checklist = store.get_checklist_version(reference.checklist_id, reference.version)
    titles = {c.id: c.title for c in checklist.criteria} if checklist else {}
    eligible = [e for e in evaluations if e.source == "model" and e.status == "done"
                and e.checklist_id == reference.checklist_id and e.version == reference.version]
    latest = {e.conversation: e for e in sorted(eligible, key=lambda e: (e.created_at, e.id))}
    overall, criteria, languages, channels = [], defaultdict(list), defaultdict(list), defaultdict(list)
    missing = disputed = 0
    disagreements, models = [], set()
    for label in reference.labels:
        criteria[label.criterion_id]  # keep zero-observation rows visible
        if label.disputed:
            disputed += 1
            continue
        key = f"{group_id}:{label.conversation_id}"
        evaluation = latest.get(key)
        result = next((r for r in evaluation.results if r.criterion_id == label.criterion_id), None) if evaluation else None
        conv = conversations.get(key)
        if conv:
            languages[conv.language]
            channels[conv.channel]
        if result is None or conv is None or label.criterion_id not in titles:
            missing += 1
            continue
        match = answers_match(label.answer, result.answer)
        overall.append(match)
        criteria[label.criterion_id].append(match)
        languages[conv.language].append(match)
        channels[conv.channel].append(match)
        model = result.model or evaluation.model
        if model:
            models.add(model)
        if not match:
            disagreements.append(dict(conversation=key, conversation_id=label.conversation_id,
                                      criterion_id=label.criterion_id, reference=answer_json(label.answer),
                                      evaluated=answer_json(result.answer)))
    return AccuracyReport(
        reference_note="Сравнение с предварительными ответами команды, а не с разметкой организаторов. Спорные ответы исключены; остальные ещё требуют проверки командой.",
        model=",".join(sorted(models)), overall=_cell(overall), missing=missing,
        disputed_excluded=disputed, disagreements=disagreements,
        by_criterion=[dict(criterion_id=k, title=titles.get(k, k), **_cell(v).model_dump()) for k, v in sorted(criteria.items())],
        by_language=[dict(language=k, **_cell(v).model_dump()) for k, v in sorted(languages.items())],
        by_channel=[dict(channel=k, **_cell(v).model_dump()) for k, v in sorted(channels.items())],
    )
