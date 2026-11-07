// Tests for schemas/*.json (with a tiny built-in JSON Schema validator) and for scripts/build-d365.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildD365, transformModule } from '../scripts/build-d365.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// ------------------------------------------------------------ minimal JSON Schema (2020-12 subset) validator

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function deref(ref, rootSchema) {
  if (!ref.startsWith('#/')) throw new Error(`Only local $ref supported: ${ref}`);
  return ref.slice(2).split('/').reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema);
}

/** Validate `value` against `schema`; returns a list of "path: message" strings (empty = valid). */
export function validate(value, schema, rootSchema = schema, path = '$') {
  const errs = [];
  if (schema === true) return errs;
  if (schema === false) return [`${path}: schema is false`];
  if (schema.$ref) return validate(value, deref(schema.$ref, rootSchema), rootSchema, path);

  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = allowed.includes(t) || (t === 'integer' && allowed.includes('number'));
    if (!ok) errs.push(`${path}: expected ${allowed.join('|')}, got ${t}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${path}: not in enum ${JSON.stringify(schema.enum)}`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${path}: const mismatch`);

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, rootSchema, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${path}: missing required "${r}"`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) errs.push(...validate(value[k], sub, rootSchema, `${path}.${k}`));
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
      for (const k of Object.keys(value)) if (!(schema.properties && k in schema.properties)) errs.push(...validate(value[k], schema.additionalProperties, rootSchema, `${path}.${k}`));
    }
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => validate(value, s, rootSchema, path).length === 0).length;
    if (passing !== 1) errs.push(`${path}: oneOf matched ${passing} branches`);
  }
  if (schema.anyOf && !schema.anyOf.some((s) => validate(value, s, rootSchema, path).length === 0)) errs.push(`${path}: anyOf matched nothing`);
  return errs;
}

const checklistSchema = read('schemas/checklist.schema.json');
const evaluationSchema = read('schemas/evaluation.schema.json');
const appealSchema = read('schemas/appeal.schema.json');

test('validator: catches type/required/enum/items violations', () => {
  const s = { type: 'object', required: ['a'], properties: { a: { type: 'integer' }, b: { enum: ['x', 'y'] }, c: { type: 'array', items: { type: 'string' } } } };
  assert.deepEqual(validate({ a: 1, b: 'x', c: ['s'] }, s), []);
  assert.ok(validate({}, s).some((e) => e.includes('missing required "a"')));
  assert.ok(validate({ a: 1.5 }, s).some((e) => e.includes('expected integer')));
  assert.ok(validate({ a: 1, b: 'z' }, s).some((e) => e.includes('not in enum')));
  assert.ok(validate({ a: 1, c: [1] }, s).some((e) => e.includes('c[0]')));
});

test('config/checklist.v1.json conforms to schemas/checklist.schema.json', () => {
  const checklist = read('config/checklist.v1.json');
  assert.deepEqual(validate(checklist, checklistSchema), []);
  // scale criteria declare a scale; flag criteria are unscored
  for (const c of checklist.criteria) {
    if (c.answer_type.startsWith('scale')) assert.ok(Array.isArray(c.scale) && c.scale.length >= 2, `${c.id} needs a scale`);
    if (c.answer_type === 'flag') assert.equal(c.scored, false, `${c.id} flag must be unscored`);
    if (c.na_allowed) assert.ok(c.na_condition, `${c.id} N/A needs a condition`);
  }
});

test('checklist schema rejects a broken criterion', () => {
  const bad = { ...read('config/checklist.v1.json') };
  bad.criteria = [{ ...bad.criteria[0], answer_type: 'maybe', weight: -1 }];
  const errs = validate(bad, checklistSchema);
  assert.ok(errs.some((e) => e.includes('answer_type')));
  assert.ok(errs.some((e) => e.includes('weight')));
});

test('evaluation and appeal schemas accept minimal valid objects and reject bad status', () => {
  const evaluation = {
    id: 'e1', conversation_id: 'p1-ru-003', group_id: 'DEV', checklist_id: 'freedom-chat-quality', checklist_version: 1,
    prompt_version: 'judge-v1.0', provider: 'openai', model: 'qwen2.5:7b', created_at: '2026-11-07T18:00:00+05:00',
    status: 'final', mode: 'stored',
    results: [{ criterion_id: 'c01', code: '01', applicable: true, na_reason: null, answer: 'yes', scale_value: null, flag_types: [],
      evidence: [{ line: 3, why: 'приветствие и имя', speaker: 'operator', quote: 'Здравствуйте, меня зовут …' }],
      checked_range: null, rule_applied: '01: первая реплика оператора', explanation: 'Поздоровался и представился.', confidence: 0.95, source: 'ai' }],
    total: 75.63, total_str: '75.63', calculated: true, original_total: null,
    section_totals: { A: { title: 'Начало', points: 25, weight: 25, total: 100, total_str: '100.00', calculated: true } },
    gross: { flag: false, types: [], criteria: [], evidence: [] }, min_confidence: 0.95, needs_review: false,
    cost_usd: 0, latency_ms: 1200, trace: { prompt_version: 'judge-v1.0', calls: [] },
    history: [{ at: '2026-11-07T18:00:00+05:00', action: 'evaluated', by: 'ai' }],
  };
  assert.deepEqual(validate(evaluation, evaluationSchema), []);
  assert.ok(validate({ ...evaluation, status: 'done' }, evaluationSchema).length > 0);
  assert.ok(validate({ ...evaluation, gross: { flag: true, types: ['rudeness'] } }, evaluationSchema).length > 0);

  const appeal = {
    id: 'a1', evaluation_id: 'e1', conversation_id: 'p1-ru-007', criterion_id: 'c04', criterion_title: 'Консультация',
    comment: 'Основной вопрос был решён.', created_at: '2026-11-07T18:10:00+05:00', status: 'open',
    original: { answer_label: '10 из 20', applicable: true, answer: null, scale_value: 10, points: 10 }, decision: null, final: null,
    total_before: 70, total_after: null,
  };
  assert.deepEqual(validate(appeal, appealSchema), []);
  const decided = { ...appeal, status: 'changed', decision: { decision: 'change', outcome: 'score_changed', new_value: { applicable: true, scale_value: 15 }, reviewer_note: 'Согласен с оператором.', decided_at: '2026-11-07T18:20:00+05:00' }, final: { answer_label: '15 из 20', points: 15 }, total_after: 77.69 };
  assert.deepEqual(validate(decided, appealSchema), []);
  assert.ok(validate({ ...decided, decision: { ...decided.decision, outcome: 'other' } }, appealSchema).length > 0);
});

// ------------------------------------------------------------ D365 build

test('transformModule rewrites imports/exports into registry form', () => {
  const src = `import { a as alpha, b } from './lib.js';\nimport * as ns from '../x.js';\nimport data from './d.json' with { type: 'json' };\nexport function f() { return alpha + b; }\nexport const K = 1;\nexport class C {}\nexport { f as g, K };\nexport { z } from './z.js';\n`;
  const { code, deps } = transformModule(src, '/app.js', (s) => s);
  assert.deepEqual(deps, ['./z.js', './lib.js', '../x.js', './d.json']);
  assert.ok(!/^\s*(import|export)\b/m.test(code), 'no import/export left');
  assert.match(code, /const \{ a: alpha, b \} = __cqa_require\("\.\/lib\.js"\)/);
  assert.match(code, /const ns = __cqa_require\("\.\.\/x\.js"\)/);
  assert.match(code, /const data = __cqa_require\("\.\/d\.json"\)\.default/);
  assert.match(code, /"f": \{ enumerable: true, get: \(\) => f \}/);
  assert.match(code, /"g": \{ enumerable: true, get: \(\) => f \}/);
  assert.match(code, /"C": \{ enumerable: true, get: \(\) => C \}/);
  assert.match(code, /Object\.defineProperty\(__exports, "z"/);
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cqa-d365-'));
  const pub = join(dir, 'public');
  mkdirSync(join(pub, 'lib'), { recursive: true });
  mkdirSync(join(pub, 'i18n'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'scoring'), { recursive: true });
  writeFileSync(join(pub, 'index.html'), `<!doctype html>\n<html><head><meta charset="utf-8"><title>CQA</title>\n<link rel="stylesheet" href="styles.css">\n<script>window.CQA_CONFIG = { lang: 'ru' };</script>\n</head><body>\n<div id="cqa-root" class="cqa-root"></div>\n<script type="module" src="./app.js"></script>\n</body></html>\n`);
  writeFileSync(join(pub, 'styles.css'), `.cqa-root { color: #123; }\n`);
  writeFileSync(join(pub, 'i18n', 'ru.json'), JSON.stringify({ title: 'Диалоги' }));
  writeFileSync(join(pub, 'lib', 'util.js'), `export const VERSION = '1.0';\nexport function add(a, b) { return a + b; }\nexport { add as plus };\n`);
  writeFileSync(join(pub, 'lib', 'format.js'), `import { VERSION } from './util.js';\nexport async function fmt(x) { return \`\${VERSION}:\${x}\`; }\nexport * from './util.js';\n`);
  writeFileSync(join(dir, 'packages', 'scoring', 'index.js'), `export function total(points, weights) { return points / weights * 100; }\n`);
  writeFileSync(join(pub, 'app.js'), `import { add as sum, plus } from './lib/util.js';\nimport { fmt } from './lib/format.js';\nimport { total } from '/packages/scoring/index.js';\nimport * as f from './lib/format.js';\nfetch('./i18n/ru.json').then((r) => r.json()).then((i18n) => {\n  window.__result = { sum: sum(2, 3), plus: plus(1, 1), total: total(60.5, 80), title: i18n.title, version: f.VERSION, apiBase: window.CQA_CONFIG.apiBase, lang: window.CQA_CONFIG.lang };\n});\n`);
  return dir;
}

async function runBuilt(html, search) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, 'config script + bundle');
  const sandbox = { window: null, location: { search }, URLSearchParams, Response: class { constructor(body) { this.body = body; } async json() { return JSON.parse(this.body); } }, Error, Object, JSON, Promise, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const s of scripts) vm.runInContext(s, ctx);
  await new Promise((r) => setTimeout(r, 10));
  return sandbox.__result && JSON.parse(JSON.stringify(sandbox.__result));
}

test('build-d365 bundles a fixture module graph into one HTML file that runs', async () => {
  const dir = makeFixture();
  try {
    const out = join(dir, 'dist', 'cqa.html');
    const res = buildD365({ publicDir: join(dir, 'public'), root: dir, outFile: out, quiet: true });
    assert.ok(existsSync(out));
    assert.ok(res.bytes > 0 && res.bytes < 5 * 1024 * 1024);
    assert.ok(res.modules.includes('/packages/scoring/index.js'));
    assert.ok(!/type="module"/.test(res.html), 'no module scripts remain');
    assert.ok(!/<link[^>]*stylesheet/.test(res.html), 'stylesheet inlined');
    assert.match(res.html, /\.cqa-root \{ color: #123; \}/);
    assert.ok(!/\/WebResources\//.test(res.html));
    assert.match(res.html, /getClientUrl/);

    const r1 = await runBuilt(res.html, '');
    assert.deepEqual(r1, { sum: 5, plus: 2, total: 75.625, title: 'Диалоги', version: '1.0', apiBase: '', lang: 'ru' });

    // apiBase from the web-resource "data" parameter (JSON or bare URL), without clobbering lang from CQA_CONFIG
    const r2 = await runBuilt(res.html, '?data=' + encodeURIComponent(JSON.stringify({ apiBase: 'https://cqa.example.kz', lang: 'en' })));
    assert.equal(r2.apiBase, 'https://cqa.example.kz');
    assert.equal(r2.lang, 'ru');
    const r3 = await runBuilt(res.html, '?data=' + encodeURIComponent('https://api.example.kz'));
    assert.equal(r3.apiBase, 'https://api.example.kz');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-d365 fails clearly when public/index.html is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cqa-d365-empty-'));
  try {
    assert.throws(() => buildD365({ publicDir: join(dir, 'public'), root: dir, outFile: join(dir, 'out.html'), quiet: true }), /not built yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-d365 on the real public/ (when present) stays under 5 MB', () => {
  const pub = join(ROOT, 'public');
  if (!existsSync(join(pub, 'index.html'))) { console.log('  (public/index.html not present yet — skipped)'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'cqa-d365-real-'));
  try {
    let res;
    try {
      res = buildD365({ publicDir: pub, root: ROOT, outFile: join(dir, 'cqa.html'), quiet: true });
    } catch (e) {
      if (e.code === 'ENOENT' || /not found at/.test(e.message)) { console.log(`  (public/ incomplete: ${e.message} — skipped)`); return; }
      throw e;
    }
    assert.ok(res.bytes < 5 * 1024 * 1024);
    assert.ok(!/\/WebResources\//.test(res.html));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
