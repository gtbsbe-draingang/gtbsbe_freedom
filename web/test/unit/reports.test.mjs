import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogs, setLanguage } from '../../src/i18n/ru.js';
import { percentText, averageText, reportAnswer, referenceNote, modelText, accuracyEmptyText, disagreementFilters } from '../../src/ui/reports-page.js';
afterEach(() => setLanguage('ru', { persist: false }));
test('unknown accuracy and averages stay distinct from zero', () => {
  assert.equal(percentText(null), '—');
  assert.equal(percentText(0), '0 %');
  assert.equal(percentText(0.845), '84,5 %');
  assert.equal(averageText(null), '—');
  assert.equal(averageText(0), '0,00');
});
test('disagreements render all contract answer types', () => {
  assert.equal(reportAnswer('yes'), 'Да');
  assert.equal(reportAnswer('no'), 'Нет');
  assert.equal(reportAnswer('na'), 'N/A');
  assert.equal(reportAnswer({step:0}), 'шаг 0');
  assert.equal(reportAnswer(null), '—');
});

test("the backend's fixed reference note is the catalog's Russian text", () => {
  const source = readFileSync(new URL('../../../backend/quality/accuracy.py', import.meta.url), 'utf8');
  assert.ok(source.includes(`"${catalogs.ru['reports.referenceDraft']}"`), 'backend/quality/accuracy.py changed its reference_note');
});
test('known reference notes follow the interface language; any other note stays verbatim', () => {
  setLanguage('en', { persist: false });
  assert.deepEqual(referenceNote(catalogs.ru['reports.referenceDraft']), { text: catalogs.en['reports.referenceDraft'], verbatim: false });
  assert.deepEqual(referenceNote(catalogs.ru['reports.referenceDemo']), { text: catalogs.en['reports.referenceDemo'], verbatim: false });
  assert.deepEqual(referenceNote('Наши эталоны, версия 3'), { text: 'Наши эталоны, версия 3', verbatim: true });
  assert.deepEqual(referenceNote(''), { text: catalogs.en['reports.referenceMissing'], verbatim: false });
});
test('an empty model list reads as a dash; several models are comma-spaced', () => {
  assert.equal(modelText(''), '—');
  assert.equal(modelText(undefined), '—');
  assert.equal(modelText('claude-haiku-5-5,claude-sonnet-5-5'), 'claude-haiku-5-5, claude-sonnet-5-5');
});
test('an empty report says what to run, naming the checklist version when the server sends it', () => {
  const checklist = { checklist_id: 'official-chat', version: 2, name: 'Чек-лист качества чатов' };
  const named = accuracyEmptyText({ overall: { agreement: null, n: 0 }, missing: 517, checklist });
  assert.match(named, /«Чек-лист качества чатов» v2/);
  assert.match(named, /DEV/);
  assert.match(accuracyEmptyText({ overall: { agreement: null, n: 0 }, missing: 517, checklist: { ...checklist, name: null } }), /«official-chat» v2/);
  assert.equal(accuracyEmptyText({ overall: { agreement: null, n: 0 }, missing: 517 }), catalogs.ru['reports.noComparableRun']);
  assert.equal(accuracyEmptyText({ overall: { agreement: null, n: 0 }, missing: 0 }), catalogs.ru['reports.noComparable']);
});
test('the disagreement filter lists criteria in checklist order with their counts', () => {
  const data = {
    by_criterion: [{ criterion_id: 'c01', title: 'Установление контакта' }, { criterion_id: 'c02', title: 'Выявление потребности' }, { criterion_id: 'c03', title: 'Идентификация' }],
    disagreements: [{ criterion_id: 'c02' }, { criterion_id: 'c01' }, { criterion_id: 'c02' }, { criterion_id: 'x9' }],
  };
  assert.deepEqual(disagreementFilters(data), [
    { value: '', label: 'Все критерии (4)', verbatim: false },
    { value: 'c01', label: 'Установление контакта (1)', verbatim: true },
    { value: 'c02', label: 'Выявление потребности (2)', verbatim: true },
    { value: 'x9', label: 'x9 (1)', verbatim: true },
  ]);
});
