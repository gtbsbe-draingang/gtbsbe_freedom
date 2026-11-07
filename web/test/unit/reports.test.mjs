import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentText, averageText, reportAnswer } from '../../src/ui/reports-page.js';
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
