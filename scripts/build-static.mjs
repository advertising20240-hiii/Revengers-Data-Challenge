#!/usr/bin/env node
// Builds the read-only static demo: one self-contained HTML file that opens from file:// or GitHub Pages.
//
//   npm run build:static          -> dist/static/index.html
//   node scripts/build-static.mjs --out dist/static/index.html --group DEV
//
// How it works
//   1. Bundles the UI exactly like the Dynamics 365 build (scripts/build-d365.mjs): one classic <script>,
//      inlined CSS and i18n dictionaries.
//   2. Starts the application in-process (createApp, as scripts/export-results.mjs does) on a fresh temporary
//      data directory, so the snapshot comes only from committed data: data/dev/DEV.json, data/seed/*,
//      config/checklist.v1.json, reports/calibration.json. Provider is forced to "offline": nothing is evaluated,
//      no network calls are made.
//   3. Calls every GET route the UI uses through the real request handler and stores the responses
//      (status + body, identical bodies stored once) in a <script type="application/json"> block.
//   4. Injects a fetch shim: GET /api/... is answered from the snapshot; POST/PUT/PATCH/DELETE get a 403 JSON
//      error explaining that this is a view-only demo, so the UI shows it through its normal error/toast path.
//      All three dictionaries are exposed as window.CQA_I18N so the language switcher keeps working.
//   5. Patches api.audioUrl (original recording link — the audio proxy needs the server) and api.exportUrl
//      (CSV from the snapshot as a data: URL), and adds a small persistent "view-only demo" banner.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildD365 } from './build-d365.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DEFAULT = resolve(HERE, '..');

// ---------------------------------------------------------------- request key (shared by Node and the browser)

/** Canonical "METHOD /api/path?sorted=query" key; null for URLs that are not API calls. Serialized into the page. */
function cqaStaticKey(method, url) {
  var s = String(url || '');
  var at = s.indexOf('/api/');
  if (at < 0) return null;
  s = s.slice(at);
  var hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  var qi = s.indexOf('?');
  var path = qi >= 0 ? s.slice(0, qi) : s;
  var query = qi >= 0 ? s.slice(qi + 1) : '';
  var dec = function (x) { try { return decodeURIComponent(String(x).replace(/\+/g, ' ')); } catch (e) { return String(x); } };
  path = path.split('/').map(function (seg) { return encodeURIComponent(dec(seg)); }).join('/');
  var pairs = query.split('&').filter(Boolean).map(function (p) {
    var eq = p.indexOf('=');
    return eq < 0 ? [dec(p), ''] : [dec(p.slice(0, eq)), dec(p.slice(eq + 1))];
  }).filter(function (kv) { return kv[1] !== ''; });
  pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
  var qs = pairs.map(function (kv) { return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]); }).join('&');
  return String(method || 'GET').toUpperCase() + ' ' + path + (qs ? '?' + qs : '');
}

export { cqaStaticKey };

// ---------------------------------------------------------------- snapshot

const enc = (v) => encodeURIComponent(String(v));

/** Run one GET through the real request handler (no socket). */
async function callApp(app, url) {
  const req = { method: 'GET', url, headers: {} };
  let status = 200; let headers = {}; const chunks = [];
  const res = {
    writableEnded: false,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    writeHead(s, h = {}) { status = s; for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v; return this; },
    write(c) { if (c !== undefined) chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(Buffer.from(c)); this.writableEnded = true; },
    once() {},
  };
  await app.handle(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(headers['content-type'] || '');
  if (type.includes('application/json')) return { status, kind: 'json', body: text ? JSON.parse(text) : null };
  return { status, kind: 'text', type, body: text };
}

/**
 * Create the app on a temporary data directory and capture every GET response the UI needs.
 * @returns {Promise<{routes: Record<string, {status:number, ref:string}>, bodies: Record<string, object>, audio: Record<string,string>, meta: object}>}
 */
export async function collectSnapshot({ group = 'DEV', log = () => {} } = {}) {
  process.env.CQA_PROVIDER = 'offline'; // replay only: the snapshot never calls a model
  const dataDir = mkdtempSync(join(tmpdir(), 'cqa-static-'));
  const { createApp } = await import('../server/app.js');
  const app = await createApp({ dataDir, log });
  try {
    const routes = {}; const bodies = {}; const audio = {};
    const add = async (url) => {
      const key = cqaStaticKey('GET', url);
      if (routes[key]) return routes[key];
      const r = await callApp(app, url);
      const payload = r.kind === 'json' ? { kind: 'json', body: r.body } : { kind: 'text', type: r.type, body: r.body };
      const ref = createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
      bodies[ref] = payload;
      routes[key] = { status: r.status, ref };
      return { ...routes[key], body: r.body };
    };

    const groupIds = app.data.groups().map((g) => g.group_id);
    if (!groupIds.includes(group)) throw new Error(`group ${group} is not loaded (have: ${groupIds.join(', ') || 'none'})`);
    const others = groupIds.filter((g) => g !== group);
    if (others.length) throw new Error(`unexpected groups in the fresh database: ${others.join(', ')}`);
    const groupQs = ['', `?group_id=${enc(group)}`];

    await add('/api/health');
    await add('/api/groups');
    await add('/api/jobs');
    for (const q of groupQs) {
      await add(`/api/conversations${q}`);
      await add(`/api/stats${q}`);
      await add(`/api/export.csv${q}`);
    }
    await add('/api/results.json');
    await add(`/api/results.json?group_id=${enc(group)}`);

    // dialog cards (+ every checklist version the card can switch to)
    const rows = app.data.rows(group);
    for (const row of rows) {
      const id = row.conversation_id;
      const card = await add(`/api/conversations/${enc(id)}`);
      if (card.status === 200 && card.body?.conversation?.audio_url) audio[id] = card.body.conversation.audio_url;
      const versions = [...new Set((card.body?.evaluations || []).map((e) => e.checklist_version))];
      for (const v of versions) await add(`/api/conversations/${enc(id)}?checklist_version=${enc(v)}`);
    }

    // checklists, versions, diffs, templates
    const list = await add('/api/checklists');
    await add('/api/checklists/active');
    const vers = (list.body || []).map((c) => c.version);
    for (const v of vers) await add(`/api/checklists/${enc(v)}`);
    for (const a of vers) for (const b of vers) if (a !== b) await add(`/api/checklists/diff?from=${enc(a)}&to=${enc(b)}`);
    await add('/api/templates');

    // appeals
    const all = await add('/api/appeals?status=all');
    await add('/api/appeals?status=open');
    await add('/api/appeals?status=resolved');
    for (const a of all.body || []) await add(`/api/appeals/${enc(a.id)}`);

    await add('/api/calibration');

    const evaluations = rows.reduce((n, r) => n + app.engine.evaluationsFor(r.group_id, r.conversation_id).length, 0);
    const meta = {
      group,
      conversations: rows.length,
      evaluations,
      appeals: (all.body || []).length,
      checklist_versions: vers,
      routes: Object.keys(routes).length,
      source: 'committed data (data/dev, data/seed, config, reports) on a fresh database',
    };
    return { routes, bodies, audio, meta };
  } finally {
    try { await app.close(); } catch { /* server was never listening */ }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- injected code

const BANNER_CSS = `
#cqa-static-banner { position: fixed; left: 1rem; bottom: 1rem; z-index: 90; max-width: calc(100vw - 2rem);
  padding: .4rem .75rem; border-radius: 999px; background: #1f4f8f; color: #fff; font: 600 .82rem/1.3 "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
  box-shadow: 0 2px 10px rgba(15, 30, 60, .25); pointer-events: none; }
#cqa-static-banner code { font-family: Consolas, "SFMono-Regular", Menlo, monospace; background: rgba(255,255,255,.16); padding: 0 .3em; border-radius: 4px; }
@media print { #cqa-static-banner { display: none; } }
`;

/** Shim code; runs inside the bundle script after the D365 hook (CQA_ASSETS ready) and before any module. */
export function shimScript() {
  return `
// --- static read-only demo (scripts/build-static.mjs) --------------------------------------
var __cqa_static_patch = (function () {
  var cqaStaticKey = ${cqaStaticKey.toString()};
  var el = document.getElementById('cqa-static-snapshot');
  var S = el ? JSON.parse(el.textContent) : { routes: {}, bodies: {}, audio: {} };
  window.CQA_STATIC = { meta: S.meta, key: cqaStaticKey, readOnly: true };
  var assets = window.CQA_ASSETS || {};
  var dicts = { ru: assets['i18n/ru.json'] || {}, kk: assets['i18n/kk.json'] || {}, en: assets['i18n/en.json'] || {} };
  window.CQA_I18N = dicts; // i18n.loadDict picks dicts[lang]; the switcher reloads the page with a new cqa.lang

  function lang() {
    var l = null;
    try { l = window.localStorage.getItem('cqa.lang'); } catch (e) { /* storage unavailable */ }
    if (!dicts[l]) l = window.CQA_CONFIG && window.CQA_CONFIG.lang;
    return dicts[l] ? l : 'ru';
  }
  function tr(k) { var d = dicts[lang()]; return (d && d[k]) || dicts.ru[k] || k; }

  function respond(status, kind, body, type) {
    var text = kind === 'json' ? JSON.stringify(body) : String(body == null ? '' : body);
    return Promise.resolve(new Response(text, { status: status, headers: { 'Content-Type': kind === 'json' ? 'application/json; charset=utf-8' : (type || 'text/plain; charset=utf-8'), 'X-CQA-Static': '1' } }));
  }
  function lookup(key) { var r = S.routes[key]; return r ? { status: r.status, payload: S.bodies[r.ref] } : null; }

  var nextFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    var key = cqaStaticKey(method === 'HEAD' ? 'GET' : method, url);
    if (key === null) return nextFetch ? nextFetch(input, init) : Promise.reject(new TypeError('fetch unavailable'));
    if (method !== 'GET' && method !== 'HEAD') return respond(403, 'json', { error: tr('static.readonly'), read_only: true });
    var hit = lookup(key);
    if (!hit) return respond(404, 'json', { error: tr('static.not_in_snapshot'), read_only: true, request: key });
    return respond(hit.status, hit.payload.kind, hit.payload.body, hit.payload.type);
  };

  // persistent banner, outside #cqa-root (the app replaces the root's children on boot)
  try {
    var st = document.createElement('style'); st.textContent = ${JSON.stringify(BANNER_CSS)};
    document.head.appendChild(st);
    var b = document.createElement('div');
    b.id = 'cqa-static-banner'; b.setAttribute('role', 'note'); b.setAttribute('lang', lang());
    var msg = tr('static.banner'), cmd = 'npm start', at = msg.indexOf(cmd);
    if (at >= 0) { b.append(msg.slice(0, at)); var c = document.createElement('code'); c.textContent = cmd; b.append(c, msg.slice(at + cmd.length)); }
    else b.textContent = msg;
    document.body.appendChild(b);
  } catch (e) { /* banner is cosmetic */ }

  // called with the module registry right before the app entry runs
  return function (req) {
    var api = req('/public/js/api.js').api;
    api.audioUrl = function (id) { return S.audio[String(id)] || ''; };
    api.exportUrl = function (group_id) {
      var q = group_id ? '?group_id=' + encodeURIComponent(String(group_id)) : '';
      var hit = lookup(cqaStaticKey('GET', '/api/export.csv' + q));
      if (!hit || hit.status !== 200) return '#';
      return 'data:text/csv;charset=utf-8,' + encodeURIComponent(String(hit.payload.body));
    };
  };
})();
`;
}

function scriptJson(obj) {
  // "</" can only occur inside JSON strings, where "\\/" is a valid escape; U+2028/9 are escaped for safety.
  return JSON.stringify(obj).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\u0021--').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const REGISTRY_START = 'var __cqa_modules = {}; var __cqa_cache = {};';
const ENTRY = '\n__cqa_require("/public/app.js");';

/**
 * Build dist/static/index.html.
 * @param {{root?:string, publicDir?:string, outFile?:string, group?:string, quiet?:boolean}} opts
 */
export async function buildStatic({ root = ROOT_DEFAULT, publicDir, outFile, group = 'DEV', quiet = false } = {}) {
  publicDir = publicDir || join(root, 'public');
  outFile = outFile || join(root, 'dist', 'static', 'index.html');

  const tmp = mkdtempSync(join(tmpdir(), 'cqa-static-ui-'));
  let html;
  try { html = buildD365({ publicDir, root, outFile: join(tmp, 'ui.html'), quiet: true }).html; } finally { rmSync(tmp, { recursive: true, force: true }); }

  for (const k of ['ru', 'kk', 'en']) {
    const d = JSON.parse(readFileSync(join(publicDir, 'i18n', `${k}.json`), 'utf8'));
    for (const key of ['static.banner', 'static.readonly', 'static.not_in_snapshot']) if (!d[key]) throw new Error(`public/i18n/${k}.json has no "${key}"`);
  }

  const snap = await collectSnapshot({ group });

  const at = html.indexOf(REGISTRY_START);
  const entryAt = html.lastIndexOf(ENTRY);
  if (at < 0 || entryAt < 0 || entryAt < at) throw new Error('unexpected bundle layout from build-d365 (module registry or app entry not found)');
  if (!html.includes('__cqa_modules["/public/js/api.js"]')) throw new Error('bundle has no /public/js/api.js module');
  const shim = shimScript().replace(/<\/script/gi, '<\\/script');
  html = html.slice(0, at) + shim + '\n' + html.slice(at, entryAt) + '\n__cqa_static_patch(__cqa_require);' + html.slice(entryAt);

  // the snapshot must exist in the DOM before the bundle script runs: put it right before that <script>
  const bundleTag = html.lastIndexOf('<script>', at);
  if (bundleTag < 0) throw new Error('bundle <script> not found');
  html = html.slice(0, bundleTag) + `<script type="application/json" id="cqa-static-snapshot">${scriptJson(snap)}</script>\n` + html.slice(bundleTag);

  html = html.replace(/^<!--[^\n]*-->\n/, '<!-- Revengers CQA — read-only static demo. Generated by scripts/build-static.mjs (npm run build:static); do not edit by hand. Full product: npm start. -->\n');

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html, 'utf8');
  const bytes = Buffer.byteLength(html, 'utf8');
  if (!quiet) {
    console.log(`built ${outFile}: ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`);
    console.log(`snapshot: group ${snap.meta.group}, ${snap.meta.conversations} conversations, ${snap.meta.evaluations} evaluations, ${snap.meta.appeals} appeals, checklist versions ${snap.meta.checklist_versions.join(', ')}; ${snap.meta.routes} GET routes, ${Object.keys(snap.bodies).length} distinct bodies`);
  }
  return { outFile, bytes, html, snapshot: snap };
}

// ---------------------------------------------------------------- CLI

function argValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = ROOT_DEFAULT;
  const outFile = resolve(root, argValue('--out', 'dist/static/index.html'));
  try {
    await buildStatic({ root, outFile, group: argValue('--group', 'DEV') });
    process.exit(0);
  } catch (e) {
    console.error(`build:static failed: ${e?.stack || e}`);
    process.exit(2);
  }
}
