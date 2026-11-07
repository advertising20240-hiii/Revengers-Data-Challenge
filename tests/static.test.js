// Tests for scripts/build-static.mjs: the read-only static demo (one HTML file with a snapshot of GET responses).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildStatic, shimScript, cqaStaticKey } from '../scripts/build-static.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let dir, res, html, snap;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cqa-static-test-'));
  res = await buildStatic({ root: ROOT, outFile: join(dir, 'index.html'), quiet: true });
  html = readFileSync(res.outFile, 'utf8');
  const m = html.match(/<script type="application\/json" id="cqa-static-snapshot">([\s\S]*?)<\/script>/);
  snap = m ? JSON.parse(m[1]) : null;
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const body = (key) => { const r = snap.routes[key]; return r ? { status: r.status, ...snap.bodies[r.ref] } : null; };

test('build:static writes one self-contained HTML file', () => {
  assert.ok(existsSync(res.outFile));
  assert.equal(statSync(res.outFile).size, res.bytes);
  assert.ok(res.bytes < 16 * 1024 * 1024, `output is ${res.bytes} bytes`);
  assert.ok(!/<script[^>]+type=["']module["']/i.test(html), 'no ES module scripts left');
  assert.ok(!/<link[^>]+rel=["']stylesheet["'][^>]+href=["'](?!https?:)/i.test(html), 'stylesheets are inlined');
  assert.match(html, /read-only static demo/);
});

test('snapshot contains the 65 DEV conversations with their cards', () => {
  assert.ok(snap, 'snapshot block present');
  assert.equal(snap.meta.group, 'DEV');
  assert.equal(snap.meta.conversations, 65);
  const list = body('GET /api/conversations');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 65);
  assert.equal(body('GET /api/conversations?group_id=DEV').body.length, 65);
  for (const row of list.body) {
    const card = body(cqaStaticKey('GET', `/api/conversations/${encodeURIComponent(row.conversation_id)}`));
    assert.ok(card && card.status === 200, `card for ${row.conversation_id}`);
    assert.equal(card.body.conversation.conversation_id, row.conversation_id);
  }
  for (const k of ['GET /api/health', 'GET /api/groups', 'GET /api/checklists', 'GET /api/checklists/active', 'GET /api/templates', 'GET /api/appeals?status=all', 'GET /api/stats', 'GET /api/calibration', 'GET /api/export.csv']) {
    assert.ok(snap.routes[k], `${k} snapshotted`);
  }
  assert.equal(body('GET /api/health').body.provider.provider, 'offline');
});

test('shim, banner and all three dictionaries are present', () => {
  assert.match(html, /__cqa_static_patch\(__cqa_require\);/);
  assert.match(html, /window\.fetch = function \(input, init\)/);
  assert.match(html, /cqa-static-banner/);
  for (const lang of ['ru', 'kk', 'en']) {
    const d = JSON.parse(readFileSync(join(ROOT, 'public', 'i18n', `${lang}.json`), 'utf8'));
    for (const k of ['static.banner', 'static.readonly', 'static.not_in_snapshot']) assert.ok(d[k], `${lang}.json: ${k}`);
    assert.ok(html.includes(JSON.stringify(d['static.banner'])), `${lang} banner text inlined`);
  }
});

test('request keys are canonical (query order, empty params, encoding)', () => {
  assert.equal(cqaStaticKey('get', '/api/checklists/diff?to=2&from=1'), 'GET /api/checklists/diff?from=1&to=2');
  assert.equal(cqaStaticKey('GET', 'http://x/api/stats?group_id='), 'GET /api/stats');
  assert.equal(cqaStaticKey('GET', '/api/conversations/a%20b?checklist_version=1#x'), 'GET /api/conversations/a%20b?checklist_version=1');
  assert.equal(cqaStaticKey('GET', '/i18n/ru.json'), null);
});

test('in the page: GET is answered from the snapshot, POST gets the read-only message', async () => {
  const dicts = {};
  for (const l of ['ru', 'kk', 'en']) dicts[`i18n/${l}.json`] = JSON.parse(readFileSync(join(ROOT, 'public', 'i18n', `${l}.json`), 'utf8'));
  const passthrough = [];
  const el = () => ({ children: [], append(...x) { this.children.push(...x); }, appendChild(x) { this.children.push(x); }, setAttribute() {} });
  const storage = { 'cqa.lang': 'en' };
  const window = {
    CQA_ASSETS: dicts,
    CQA_CONFIG: { lang: 'ru' },
    localStorage: { getItem: (k) => storage[k] ?? null },
    fetch: async (u) => { passthrough.push(u); return new Response('{}'); },
  };
  const snapshotJson = JSON.stringify(snap);
  const document = { getElementById: (id) => (id === 'cqa-static-snapshot' ? { textContent: snapshotJson } : null), createElement: el, head: el(), body: el() };
  const ctx = vm.createContext({ window, document, Response, JSON, Promise, String, encodeURIComponent, decodeURIComponent });
  vm.runInContext(`${shimScript()}\nwindow.__patch = __cqa_static_patch;`, ctx);

  assert.equal(window.CQA_I18N.kk['static.banner'], dicts['i18n/kk.json']['static.banner']);
  const list = await (await window.fetch('/api/conversations')).json();
  assert.equal(list.length, 65);

  const post = await window.fetch('/api/evaluate', { method: 'POST', body: '{"all":true}' });
  assert.equal(post.status, 403);
  const pj = await post.json();
  assert.equal(pj.read_only, true);
  assert.equal(pj.error, dicts['i18n/en.json']['static.readonly']);
  assert.match(pj.error, /npm start/);

  const miss = await window.fetch('/api/conversations/does-not-exist');
  assert.equal(miss.status, 404);

  await window.fetch('/i18n/en.json');
  assert.deepEqual(passthrough, ['/i18n/en.json'], 'non-API requests go to the next fetch');

  const api = {};
  window.__patch(() => ({ api }));
  const first = list.find((r) => r.channel === 'voice call') || list[0];
  const card = body(cqaStaticKey('GET', `/api/conversations/${encodeURIComponent(first.conversation_id)}`)).body;
  assert.equal(api.audioUrl(first.conversation_id), card.conversation.audio_url || '');
  assert.match(api.exportUrl('DEV'), /^data:text\/csv/);
});
