import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildResultsFile, validateResultsFile, resultRecord } from '../server/services/results.js';

const seed = JSON.parse(readFileSync(new URL('../data/seed/DEV.evaluations.json', import.meta.url), 'utf8'));
const evs = Array.isArray(seed) ? seed : seed.evaluations;

test('results file for DEV follows the organizers format (JSON 1.0)', () => {
  const rows = [...new Set(evs.map((e) => e.conversation_id))].map((id) => ({ conversation_id: id, evaluations: evs.filter((e) => e.conversation_id === id) }));
  const file = buildResultsFile({ teamName: 'Revengers', rows });
  assert.deepEqual(validateResultsFile(file, { expectedCount: 65 }), []);
  const r = file.results.find((x) => x.conversation_id === 'p1-ru-023');
  assert.equal(r.criteria.length, 8);
  assert.equal(r.score.critical_flag, true);
  assert.equal(r.criteria.find((c) => c.criterion_id === 'critical').value, true);
  for (const c of r.criteria) assert.ok(c.evidence_turns.every((n) => Number.isInteger(n) && n >= 1));
});

test('a dialog without a complete evaluation is reported as error, never as zero', () => {
  const rec = resultRecord('x-1', null, 'Не удалось получить ответ модели.');
  assert.deepEqual(rec, { conversation_id: 'x-1', status: 'error', criteria: [], score: null, error: 'Не удалось получить ответ модели.' });
  const file = { schema_version: '1.0', team_name: 'T', model: { mode: 'hybrid', name: 'm' }, results: [rec, { ...rec }] };
  assert.ok(validateResultsFile(file).some((e) => /повторяющийся/.test(e)));
});
