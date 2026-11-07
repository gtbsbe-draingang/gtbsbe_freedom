"""Derive the calls checklist from stream A's authoritative seed, never a retyped copy."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import re


def voice_text(text):
    if not text:
        return text
    substitutions = {'чате': 'разговоре', 'чата': 'звонка', 'чат': 'звонок'}
    return re.sub(r'\b(чате|чата|чат)\b', lambda m: substitutions[m[0].lower()], text, flags=re.I)


def build_calls_seed(official: dict) -> dict:
    expected = {f'c{i:02d}' for i in range(1, 9)}
    if official.get('checklist_id') != 'official-chat' or {c['id'] for c in official['criteria']} != expected:
        raise ValueError('Expected the official eight-criterion seed from stream A')
    result = deepcopy(official)
    result.pop('id', None)
    result.pop('created_at', None)
    result.update(checklist_id='calls', version=1, name='Звонки', channel='call', locked=False,
                  description='Официальные 8 критериев с формулировками для звонков и критерий 09 по записи')
    # The seed shape carries no based_on and no fingerprints; the loader adds what it needs.
    result.pop('based_on', None)
    for criterion in result['criteria']:
        criterion.pop('fingerprint', None)
        if criterion['id'] == 'c01':
            criterion['wording'] = criterion['wording'].replace('в первом ответе', 'в начале разговора')
        for field in ('wording', 'na_condition'):
            if field in criterion:
                criterion[field] = voice_text(criterion[field])
    section = 'conduct'
    if section not in {s['id'] for s in result['sections']}:
        raise ValueError('Official seed is missing the conduct section')
    result['criteria'].append(dict(
        id='c09', section_id=section, order=max(c['order'] for c in result['criteria']) + 1,
        title='Интонация и темп речи',
        wording='Оцените интонацию и темп по записи и доступным измерениям с учётом контекста разговора.',
        answer_type='scale', scale_steps=[
            {'value': 0, 'label': 'Выраженные нарушения интонации или темпа мешают пониманию.'},
            {'value': 5, 'label': 'Есть заметные отклонения, затрудняющие разговор.'},
            {'value': 10, 'label': 'Интонация и темп соответствуют ситуации.'}],
        weight=10, na_allowed=True, na_condition='Запись отсутствует.', kind='scored', kinds=[], model=None,
        guidance='Измерения приблизительны и зависят от качества выравнивания. Не выводите эмоции или перебивания '
                 'из отсутствующих данных. При неуверенном выравнивании нужна проверка человеком, а не автоматический '
                 'N/A или штраф. Пороговые значения ещё не валидированы на реальных звонках.'))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('official', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; use a new draft path to avoid replacing a published version')
    seed = build_calls_seed(json.loads(args.official.read_text(encoding='utf-8')))
    args.output.write_text(json.dumps(seed, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
