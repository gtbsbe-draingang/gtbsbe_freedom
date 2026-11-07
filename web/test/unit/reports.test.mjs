import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentText, averageText, weightedAverage } from '../../src/ui/reports-page.js';
test('unknown rates and averages stay distinct from zero', () => {
  assert.equal(percentText(null), '—');
  assert.equal(percentText(0), '0 %');
  assert.equal(percentText(0.845), '84,5 %');
  assert.equal(averageText(null), '—');
  assert.equal(averageText(0), '0,00');
});
test('the headline average weights each group by its n and skips groups without a total', () => {
  assert.equal(weightedAverage([{ avg_total: 80, n: 30 }, { avg_total: 60, n: 10 }, { avg_total: null, n: 5 }]), 75);
  assert.equal(weightedAverage([{ avg_total: null, n: 3 }]), null);
  assert.equal(weightedAverage([]), null);
});
