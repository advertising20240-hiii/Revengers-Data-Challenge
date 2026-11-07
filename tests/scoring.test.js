import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Rat, scoreEvaluation, answersFromLabels, validateAnswer } from '../packages/scoring/index.js';

const checklist = JSON.parse(readFileSync(new URL('../config/checklist.v1.json', import.meta.url), 'utf8'));
const gold = JSON.parse(readFileSync(new URL('./gold/dev_labels.json', import.meta.url), 'utf8'));

test('Rat: round half away from zero with exact arithmetic', () => {
  assert.equal(Rat.of('60.5').div(80).mul(100).toFixed(2), '75.63'); // 75.625 -> 75.63
  assert.equal(Rat.of('1.005').toFixed(2), '1.01'); // float would give 1.00
  assert.equal(Rat.of('-1.005').toFixed(2), '-1.01');
  assert.equal(Rat.of('2.675').toFixed(2), '2.68');
  assert.equal(new Rat(1n, 3n).toFixed(2), '0.33');
  assert.equal(new Rat(2n, 3n).toFixed(2), '0.67');
  assert.equal(Rat.of(0).toFixed(2), '0.00');
});

test('unit vector p1-ru-003: 60.5 / 80 -> 75.63', () => {
  const labels = { '01': 'Y', '02': 'Y', '03': 'NA', '04': 10, '05': 'Y', '06': 7, '07': 'N', '08': 'N' };
  const r = scoreEvaluation(checklist, answersFromLabels(checklist, labels));
  assert.deepEqual(r.errors, []);
  assert.equal(r.sum_points, '60.5000');
  assert.equal(r.sum_weights, '80.0000');
  assert.equal(r.total_str, '75.63');
  assert.equal(r.total, 75.63);
  assert.equal(r.gross.flag, false);
  assert.equal(r.per_criterion.c04.points, 10);
  assert.equal(r.per_criterion.c06.points, 10.5);
  assert.equal(r.per_criterion.c03.applicable, false);
  assert.equal(r.per_criterion.c03.effective_weight, 0);
  assert.equal(r.per_criterion.c01.effective_weight, 12.5); // 10/80
});

test('every gold dialog: engine reproduces expected_total', () => {
  for (const g of gold.labels) {
    const r = scoreEvaluation(checklist, answersFromLabels(checklist, g.expected, g.gross_error_types));
    assert.deepEqual(r.errors, [], g.conversation_id);
    assert.equal(r.total, g.expected_total, `${g.conversation_id}: ${r.total_str} != ${g.expected_total}`);
    assert.equal(r.gross.flag, g.gross_error === 'Y', `${g.conversation_id} gross flag`);
  }
});

test('gross error never changes the total (100 and flagged)', () => {
  const labels = { '01': 'Y', '02': 'NA', '03': 'NA', '04': 20, '05': 'Y', '06': 10, '07': 'Y', '08': 'Y' };
  const r = scoreEvaluation(checklist, answersFromLabels(checklist, labels, ['bypass']));
  assert.equal(r.total_str, '100.00');
  assert.equal(r.gross.flag, true);
  assert.deepEqual(r.gross.types, ['bypass']);
});

test('no applicable weighted criterion -> total not calculated', () => {
  const cl = { criteria: [
    { id: 'a', answer_type: 'yes_no_na', weight: 10, na_allowed: true },
    { id: 'f', answer_type: 'flag', weight: 0, scored: false },
  ] };
  const r = scoreEvaluation(cl, { a: { applicable: false }, f: { applicable: true, answer: 'no' } });
  assert.equal(r.total, null);
  assert.equal(r.calculated, false);
});

test('N/A rejected where not allowed; scale value must be a step', () => {
  const c01 = checklist.criteria.find((c) => c.id === 'c01');
  const c04 = checklist.criteria.find((c) => c.id === 'c04');
  assert.ok(validateAnswer(c01, { applicable: false }).length > 0);
  assert.ok(validateAnswer(c04, { applicable: true, scale_value: 12 }).length > 0);
  assert.equal(validateAnswer(c04, { applicable: true, scale_value: 15 }).length, 0);
  const r = scoreEvaluation(checklist, { c01: { applicable: false } });
  assert.ok(r.errors.length > 0);
});

test('section subtotals use the same formula', () => {
  const labels = { '01': 'Y', '02': 'Y', '03': 'NA', '04': 10, '05': 'Y', '06': 7, '07': 'N', '08': 'N' };
  const r = scoreEvaluation(checklist, answersFromLabels(checklist, labels));
  assert.equal(r.section_totals.A.total, 100); // 25/25
  assert.equal(r.section_totals.B.total, 50); // 10/20
  assert.equal(r.section_totals.C.total_str, '72.86'); // (15 + 10.5 + 0) / 35 = 72.857
});

test('custom 3-step scale, custom weights, weight 0 criterion', () => {
  const cl = { criteria: [
    { id: 'x', section: 'S', answer_type: 'scale', weight: 7.5, scale: [{ value: 0 }, { value: 1 }, { value: 2 }] },
    { id: 'y', section: 'S', answer_type: 'yes_no', weight: 2.5 },
    { id: 'z', section: 'S', answer_type: 'yes_no', weight: 0 },
  ] };
  const r = scoreEvaluation(cl, { x: { applicable: true, scale_value: 1 }, y: { applicable: true, answer: 'yes' }, z: { applicable: true, answer: 'no' } });
  assert.equal(r.total_str, '62.50'); // (3.75 + 2.5) / 10
  assert.equal(r.per_criterion.x.points, 3.75);
});
