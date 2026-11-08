// Regression tests for audited server bugs: result reuse (weight / transcript), export version choice, review queue
// after decisions, atomic decisions, network exposure, empty uploads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { getConfig } from '../server/config.js';
import { legacyCriterionHash, criterionHash, diffChecklists } from '../server/services/checklists.js';
import { pickEvaluation, modelInfo, buildResultsFile, validateResultsFile } from '../server/services/results.js';
import { isPrivateAddress } from '../server/lib/net.js';
import { scoreEvaluation, answersFromLabels } from '../packages/scoring/index.js';

const checklistV1 = JSON.parse(readFileSync(new URL('../config/checklist.v1.json', import.meta.url), 'utf8'));
const LABELS_70 = { '01': 'Y', '02': 'NA', '03': 'NA', '04': 10, '05': 'Y', '06': 7, '07': 'N', '08': 'N' };

/** Minimal fake evaluator (no model): labels by criterion code, records every call. */
function fakeEvaluator(labels = LABELS_70, { confidence = 0.9 } = {}) {
  const calls = [];
  return {
    calls,
    providerInfo: () => ({ provider: 'fake', model: 'fake-judge', available: true }),
    async evaluateConversation(conv, checklist, opts = {}) {
      calls.push({ conversation_id: conv.conversation_id, criteriaIds: opts.criteriaIds || null });
      const wanted = checklist.criteria.filter((c) => !opts.criteriaIds || opts.criteriaIds.includes(c.id));
      const line = conv.facts.first_operator?.line || 1;
      const results = wanted.map((c) => {
        const v = labels[c.code];
        const scale = c.answer_type.startsWith('scale');
        if (v === 'NA') return { criterion_id: c.id, applicable: false, na_reason: c.na_condition, evidence: [], explanation: 'N/A', confidence, source: 'ai' };
        const flagged = c.answer_type === 'flag' && v === 'Y';
        return {
          criterion_id: c.id, applicable: true,
          answer: scale ? null : (c.answer_type === 'flag' ? (flagged ? 'yes' : 'no') : (v === 'N' ? 'no' : 'yes')),
          scale_value: scale ? (typeof v === 'number' ? v : Math.max(...c.scale.map((s) => Number(s.value)))) : null,
          flag_types: flagged ? ['insult'] : [], evidence: [{ line, why: 'тест' }], explanation: 'Тест', confidence, source: 'ai',
        };
      });
      return { results, trace: { prompt_version: 'fake-v1', provider: 'fake', model: 'fake-judge', calls: [{ role: 'judge', model: 'fake-judge' }], cost_usd: 0, cache: { hits: [], misses: wanted.map((c) => c.id) } } };
    },
  };
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'cqa-fixes-'));
let app, base, evaluator, audioFetches;
const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(base + path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};
const rec = (id, text = 'Здравствуйте! Меня зовут Айгерим.', extra = {}) => ({ conversation_id: id, channel: 'agent chat', language: 'RU', transcript: [{ timestamp: '00:00', speaker: 'client', text: 'вопрос' }, { timestamp: '00:05', speaker: 'operator', text }], ...extra });

// Fake network: the organizers' API answers with one record; public recording hosts answer with audio or redirects.
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.hostname.endsWith('powerplatform.com')) return new Response(JSON.stringify({ isSuccess: true, data: { records: [rec('api-1')] } }), { status: 200 });
  audioFetches.push(String(url));
  if (u.pathname === '/redirect-internal') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } });
  if (u.pathname === '/player') return new Response('<audio><source src="http://10.1.2.3/x.mp3"></audio>', { status: 200, headers: { 'content-type': 'text/html' } });
  return new Response(Buffer.from('ID3fake'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
}

before(async () => {
  evaluator = fakeEvaluator();
  audioFetches = [];
  app = await createApp({ evaluator, dataDir: join(tmpRoot, 'main'), config: { seedDir: null, fetchTimeoutMs: 500 }, fetchImpl: fakeFetch });
  const addr = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => { await app.close(); rmSync(tmpRoot, { recursive: true, force: true }); });

const evaluate = (id, checklist, opts) => app.engine.evaluate(app.data.resolve(id, 'DEV'), checklist, opts);

test('B1: weight-only change is pure re-scoring — no evaluator call, total uses the new weight', async () => {
  const v1 = app.checklists.active();
  const first = await evaluate('p1-ru-003', v1);
  assert.equal(first.total_str, '70.00');
  const draft = JSON.parse(JSON.stringify(v1));
  draft.criteria.find((c) => c.id === 'c01').weight = 12;
  const v2 = app.checklists.save(draft, { activate: true, parentVersion: v1.version });
  assert.equal(criterionHash(v2.criteria[0]), criterionHash(v1.criteria[0]), 'weight is not part of the reuse hash');
  assert.deepEqual(diffChecklists(v1, v2).changed[0].fields, [{ field: 'weight', from: 10, to: 12 }], 'diff still shows the weight change');
  evaluator.calls.length = 0;
  const ev = await evaluate('p1-ru-003', v2);
  assert.equal(evaluator.calls.length, 0, 'no provider call');
  assert.equal(ev.trace.reused.length, 8);
  const expected = scoreEvaluation(v2, answersFromLabels(v2, LABELS_70));
  assert.equal(ev.total_str, expected.total_str);
  assert.notEqual(ev.total_str, '70.00');
  assert.equal(ev.results.find((r) => r.criterion_id === 'c01').weight, 12);
  app.checklists.activate(v1.version);
});

test('B1: results stored with the old weight-inclusive hash are still reused', async () => {
  const v1 = app.checklists.active();
  const prior = app.engine.latestFor('DEV', 'p1-ru-003', v1.version);
  const legacy = structuredClone(prior);
  for (const r of legacy.results) r.criterion_hash = legacyCriterionHash({ ...v1.criteria.find((c) => c.id === r.criterion_id), weight: r.weight });
  delete legacy.transcript_hash;
  legacy.created_at = new Date().toISOString();
  app.db.evaluations.put(legacy);
  evaluator.calls.length = 0;
  await evaluate('p1-ru-003', v1);
  assert.equal(evaluator.calls.length, 0);
});

test('B2: a re-uploaded dialog with the same id but new content is evaluated again', async () => {
  const v1 = app.checklists.active();
  await api('/api/transcripts/upload', { method: 'POST', body: { group_id: 'RE', payload: rec('re-1') } });
  const row = () => app.data.resolve('re-1', 'RE');
  const ev1 = await app.engine.evaluate(row(), v1);
  assert.ok(ev1.transcript_hash);
  // identical upload: reused
  await api('/api/transcripts/upload', { method: 'POST', body: { group_id: 'RE', payload: rec('re-1') } });
  evaluator.calls.length = 0;
  await app.engine.evaluate(row(), v1);
  assert.equal(evaluator.calls.length, 0);
  // changed content: everything re-evaluated
  await api('/api/transcripts/upload', { method: 'POST', body: { group_id: 'RE', payload: rec('re-1', 'Привет, это другой текст оператора.') } });
  evaluator.calls.length = 0;
  const ev3 = await app.engine.evaluate(row(), v1);
  assert.equal(evaluator.calls.length, 1);
  assert.equal(evaluator.calls[0].criteriaIds.length, 8);
  assert.notEqual(ev3.transcript_hash, ev1.transcript_hash);
  // evaluation stored before digests existed: re-upload with new content after it was created is detected too
  const old = app.engine.latestFor('RE', 're-1');
  delete old.transcript_hash; old.created_at = new Date(Date.now() - 1000).toISOString();
  app.db.evaluations.put(old);
  await api('/api/transcripts/upload', { method: 'POST', body: { group_id: 'RE', payload: rec('re-1', 'Третья версия диалога.') } });
  evaluator.calls.length = 0;
  await app.engine.evaluate(row(), v1);
  assert.equal(evaluator.calls.length, 1);
});

test('B3/B15: export prefers the requested checklist version; model info never claims an uncalled model', () => {
  const full = (version, created_at, extra = {}) => ({ checklist_version: version, created_at, calculated: true, total: 50, gross: { flag: false }, results: ['01', '02', '03', '04', '05', '06', '07', '08'].map((code) => ({ code, applicable: true, answer: code === '04' || code === '06' ? null : 'no', scale_value: code === '04' ? 10 : code === '06' ? 7 : null, evidence: [], explanation: 'x', source: 'ai' })), ...extra });
  const newer = full(3, '2026-11-02'); const older = full(2, '2026-11-01');
  assert.equal(pickEvaluation([newer, older]), newer, 'no version: newest complete');
  assert.equal(pickEvaluation([newer, older], { checklistVersion: 2 }), older, 'requested version wins');
  assert.equal(pickEvaluation([newer, older], { checklistVersion: 9 }), newer, 'missing version: newest complete');
  const file = buildResultsFile({ teamName: 'T', rows: [{ conversation_id: 'a', evaluations: [newer, older] }], checklistVersion: 2 });
  assert.deepEqual(validateResultsFile(file), []);
  // rules fallback only (provider failed): no model named, local
  const fallback = { provider: 'alem', model: 'qwen3-8', trace: { kz_model: 'kazllm', calls: [{ role: 'rule', model: 'rule:first_reaction' }] }, results: [{ source: 'rule', rule_applied: 'fallback:greeting' }] };
  const mi = modelInfo([fallback]);
  assert.equal(mi.mode, 'local');
  assert.doesNotMatch(mi.name, /qwen|kazllm/);
  assert.match(mi.name, /правила/);
  const heuristic = { provider: 'heuristic', model: 'heuristic-v1', trace: { calls: [] }, results: [{ source: 'rule', rule_applied: 'greeting' }] };
  assert.equal(modelInfo([heuristic]).mode, 'local');
  // normal alem run: judge + kz calls are named, external API
  const live = { provider: 'alem', model: 'qwen3-8', trace: { kz_model: 'kazllm', calls: [{ role: 'judge', model: 'qwen3-8' }, { role: 'kz', model: 'kazllm' }, { role: 'rule', model: 'rule:first_reaction' }] }, results: [{ source: 'ai' }, { source: 'rule', rule_applied: 'route' }] };
  const ml = modelInfo([live]);
  assert.equal(ml.mode, 'external_api');
  assert.equal(ml.name, 'qwen3-8, kazllm (alem.plus API) + детерминированные правила по фактам транскрипта');
});

test('B4: card "latest" and list row use the same evaluation (active version first, then newest)', async () => {
  const v1 = app.checklists.active();
  const draft = JSON.parse(JSON.stringify(v1));
  draft.criteria[3].guidance = 'другая формулировка';
  const other = app.checklists.save(draft, { activate: false });
  const onActive = await evaluate('p1-ru-005', v1);
  await evaluate('p1-ru-005', other); // newer, but not the active version
  const card = (await api('/api/conversations/p1-ru-005?group_id=DEV')).body;
  const row = (await api('/api/conversations?group_id=DEV&q=p1-ru-005')).body[0];
  assert.equal(card.latest.id, onActive.id);
  assert.equal(row.latest.evaluation_id, card.latest.id);
  assert.equal((await api(`/api/conversations/p1-ru-005?group_id=DEV&checklist_version=${other.version}`)).body.latest.checklist_version, other.version);
});

test('B7: a reviewer decision recomputes needs_review / review_reasons (08 → «Нет» removes the gross reason)', async () => {
  const v1 = app.checklists.active();
  app.engine.setEvaluator(fakeEvaluator({ ...LABELS_70, '08': 'Y' }));
  let ev;
  try { ev = await evaluate('p1-ru-006', v1, { force: true }); } finally { app.engine.setEvaluator(evaluator); }
  assert.equal(ev.gross.flag, true);
  assert.ok(ev.review_reasons.some((r) => r.startsWith('грубая ошибка')));
  const ap = (await api('/api/appeals', { method: 'POST', body: { evaluation_id: ev.id, criterion_id: 'c08', comment: 'Грубости не было.' } })).body;
  const r = await api(`/api/appeals/${ap.id}/decision`, { method: 'POST', body: { decision: 'change', outcome: 'score_changed', new_value: { applicable: true, answer: 'no' }, reviewer_note: 'Нарушения нет.' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.evaluation.gross.flag, false);
  assert.ok(!r.body.evaluation.review_reasons.some((x) => x.startsWith('грубая ошибка')));
  assert.equal(r.body.evaluation.needs_review, false);
});

test('B8: a decision refused by the scoring engine leaves the evaluation and the appeal untouched', async () => {
  const v1 = app.checklists.active();
  const ev = await evaluate('p1-ru-007', v1, { force: true });
  const ap = (await api('/api/appeals', { method: 'POST', body: { evaluation_id: ev.id, criterion_id: 'c04', comment: 'Спорно.' } })).body;
  // another criterion of the stored evaluation is broken (yes/no without an answer) → re-scoring reports an error
  const stored = app.db.evaluations.get(ev.id);
  stored.results.find((x) => x.criterion_id === 'c01').answer = null;
  const snapshot = JSON.stringify(stored);
  const r = await api(`/api/appeals/${ap.id}/decision`, { method: 'POST', body: { decision: 'change', outcome: 'score_changed', new_value: { applicable: true, scale_value: 15 }, reviewer_note: 'x' } });
  assert.equal(r.status, 400);
  assert.equal(JSON.stringify(app.db.evaluations.get(ev.id)), snapshot);
  const c04 = app.db.evaluations.get(ev.id).results.find((x) => x.criterion_id === 'c04');
  assert.equal(c04.scale_value, 10); assert.equal(c04.ai_original, undefined); assert.equal(c04.review, undefined);
  assert.equal(app.db.appeals.get(ap.id).status, 'open');
  assert.equal(app.db.appeals.get(ap.id).decision, null);
});

test('B10: loopback by default, fixed organizers URL, audio proxy refuses non-public targets', async () => {
  assert.equal(getConfig({}).host, '127.0.0.1');
  assert.equal(getConfig({ HOST: '0.0.0.0' }).host, '0.0.0.0');
  const bad = await api('/api/datasets/fetch', { method: 'POST', body: { group_id: 'X1', url: 'http://169.254.169.254/latest/meta-data' } });
  assert.equal(bad.status, 400);
  const ok = await api('/api/datasets/fetch', { method: 'POST', body: { group_id: 'X1' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.source, 'api');
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.ok(isPrivateAddress(ip), ip);
  assert.ok(!isPrivateAddress('93.184.216.34'));
  const cases = [
    ['a-loop', 'http://127.0.0.1:8080/api/health', 400],
    ['a-file', 'file:///etc/passwd', 400],
    ['a-local', 'http://localhost/x.mp3', 400],
    ['a-priv', 'http://10.0.0.5/x.mp3', 400],
    ['a-redir', 'http://93.184.216.34/redirect-internal', 400],
    ['a-player', 'http://93.184.216.34/player', 400],
    ['a-ok', 'http://93.184.216.34/rec.mp3', 200],
  ];
  await api('/api/transcripts/upload', { method: 'POST', body: { group_id: 'AUD', payload: cases.map(([id, audio_url]) => rec(id, 'Здравствуйте!', { channel: 'voice call', audio_url })) } });
  for (const [id, , status] of cases) {
    audioFetches.length = 0;
    const res = await fetch(`${base}/api/audio/${id}?group_id=AUD`);
    assert.equal(res.status, status, id);
    await res.arrayBuffer();
    assert.ok(audioFetches.every((u) => u.startsWith('http://93.184.216.34/')), `${id}: no request to a private host (${audioFetches})`);
  }
});

test('B14: an upload whose records are all invalid returns 400 and creates no group', async () => {
  const r = await api('/api/transcripts/upload', { method: 'POST', body: { group_id: 'EMPTYG', payload: [{ foo: 1 }, { conversation_id: 'no-lines' }, { conversation_id: 'blank', transcript: [] }] } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /не прошла проверку/);
  assert.ok(!(await api('/api/groups')).body.some((g) => g.group_id === 'EMPTYG'));
  const mixed = await api('/api/transcripts/upload', { method: 'POST', body: { group_id: 'MIXED', payload: [{ foo: 1 }, rec('m-1')] } });
  assert.equal(mixed.status, 200); assert.equal(mixed.body.added, 1); assert.equal(mixed.body.skipped, 1);
});

test('spec 02: evaluate accepts checklist_version and group_id-scoped ids', async () => {
  const versions = app.checklists.list();
  const target = versions.find((v) => v.status !== 'active');
  await api('/api/transcripts/upload', { method: 'POST', body: { group_id: 'DUP', payload: rec('p1-ru-001', 'Копия в другой группе.') } });
  const r = await api('/api/evaluate', { method: 'POST', body: { conversation_ids: [{ conversation_id: 'p1-ru-001', group_id: 'DUP' }], checklist_version: target.version } });
  assert.equal(r.status, 200); assert.equal(r.body.checklist_version, target.version);
  await app.jobs.wait(r.body.job_id);
  const job = (await api(`/api/jobs/${r.body.job_id}`)).body;
  assert.equal(job.results[0].group_id, 'DUP');
});

test('public tunnel: requests with Cloudflare headers are view-only unless CQA_PUBLIC_WRITE=1', async () => {
  const cf = { 'cf-connecting-ip': '203.0.113.7', 'Content-Type': 'application/json' };
  const health = await (await fetch(`${base}/api/health`, { headers: cf })).json();
  assert.equal(health.public_view, true);
  assert.equal((await api('/api/health')).body.public_view, false, 'local requests are not public');
  const blocked = await fetch(`${base}/api/datasets/fetch`, { method: 'POST', headers: cf, body: JSON.stringify({ group_id: 'X' }) });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error || '', /только для просмотра/);
  const read = await fetch(`${base}/api/conversations`, { headers: cf });
  assert.equal(read.status, 200, 'reads stay open');
  process.env.CQA_PUBLIC_WRITE = '1';
  try {
    const allowed = await fetch(`${base}/api/datasets/fetch`, { method: 'POST', headers: cf, body: JSON.stringify({ group_id: 'X' }) });
    assert.notEqual(allowed.status, 403);
  } finally { delete process.env.CQA_PUBLIC_WRITE; }
});

test('public tunnel: any forwarded request or foreign Host is view-only', async () => {
  const viaProxy = await fetch(`${base}/api/datasets/fetch`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.4', 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: 'X' }) });
  assert.equal(viaProxy.status, 403);
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const r = request(`${base}/api/datasets/fetch`, { method: 'POST', headers: { Host: 'demo.a.pinggy.link', 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject); r.end(JSON.stringify({ group_id: 'X' }));
  });
  assert.equal(status, 403);
});
