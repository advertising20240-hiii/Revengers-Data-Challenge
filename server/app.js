// Application assembly: storage, services, REST routes and static files.
// `createApp({ evaluator, dataDir })` allows tests to inject a fake evaluator and a temporary data directory.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getConfig, ROOT, VERSION } from './config.js';
import { Db, readJson, listJsonFiles } from './lib/store.js';
import { Router, HttpError, setCors, sendJson, sendText, readJsonBody, serveStatic } from './lib/http.js';
import { DataService, convKey } from './services/data.js';
import { ChecklistService, templates, validateChecklist, normalizeChecklist, diffChecklists } from './services/checklists.js';
import { EvalEngine, loadEvaluator } from './services/engine.js';
import { JobService } from './services/jobs.js';
import { AppealService } from './services/appeals.js';
import { computeStats, exportCsv } from './services/stats.js';
import { evaluationSummary } from './services/evaluations.js';
import { hashJson } from './lib/hash.js';

export async function createApp({ evaluator = undefined, dataDir = undefined, config: configOverrides = {}, fetchImpl = undefined, log = () => {} } = {}) {
  const config = getConfig(process.env, { ...(dataDir ? { dataDir } : {}), ...configOverrides });
  const db = new Db(join(config.dataDir, 'db'));
  const data = new DataService(db, config, fetchImpl ? { fetchImpl } : {});
  const checklists = new ChecklistService(db, config);
  const engine = new EvalEngine({ db, config, data, checklists });
  const jobs = new JobService(db, config);
  const appeals = new AppealService({ db, config, data, checklists, engine });

  // evaluator: injected (tests) or loaded from services/evaluator (must not break startup)
  if (evaluator !== undefined) engine.setEvaluator(evaluator, evaluator ? null : 'evaluator disabled');
  else { const { evaluator: mod, error } = await loadEvaluator(ROOT); engine.setEvaluator(mod, error); if (error) log(`evaluator: ${error}`); }

  bootstrap({ db, data, checklists, config, log });

  const router = new Router();
  const q = (url, k) => url.searchParams.get(k);
  const bool = (v) => v === '1' || v === 'true';

  // ---------- health / groups / datasets ----------
  router.get('/api/health', () => {
    const p = engine.providerInfo();
    return { ok: true, version: VERSION, provider: p, offline: !p.available || p.provider === 'offline', groups: data.groups(), counts: { conversations: db.conversations.size, evaluations: db.evaluations.find((e) => e.mode === 'stored').length, appeals_open: db.appeals.find((a) => a.status === 'open').length, checklists: db.checklists.size }, concurrency: config.concurrency, data_url_configured: !!config.dataUrl };
  });
  router.get('/api/groups', () => data.groups());
  router.post('/api/datasets/fetch', async ({ body }) => data.fetchGroup(String(body.group_id ?? '').trim(), { url: body.url || null }));
  router.post('/api/transcripts/upload', async ({ body, raw }) => {
    const payload = body.payload !== undefined ? body.payload : (Array.isArray(body) || body.records || body.data || body.conversation_id ? body : undefined);
    if (payload === undefined) throw new HttpError(400, 'payload is required (API response, {records}, array or a single record)');
    return data.upload(body.group_id, payload);
  });

  // ---------- conversations ----------
  router.get('/api/conversations', ({ url }) => {
    const gid = q(url, 'group_id'); const lang = q(url, 'lang'); const channel = q(url, 'channel'); const flag = q(url, 'flag'); const status = q(url, 'status'); const text = (q(url, 'q') || '').toLowerCase(); const minConf = q(url, 'min_conf'); const version = q(url, 'checklist_version');
    const out = [];
    for (const row of data.rows(gid)) {
      const s = data.summary(row);
      const ev = engine.latestFor(row.group_id, row.conversation_id, version);
      const latest = evaluationSummary(ev);
      const item = { ...s, latest, appeal_status: ev ? appeals.statusFor(ev.id) : 'none' };
      if (lang && s.client_language !== lang.toUpperCase() && s.language !== lang.toUpperCase()) continue;
      if (channel && s.channel !== channel) continue;
      if (flag && bool(flag) && !latest?.gross_flag) continue;
      if (status) {
        if (status === 'unevaluated' && latest) continue;
        if (status === 'evaluated' && !latest) continue;
        if (status === 'needs_review' && !latest?.needs_review) continue;
        if (['final', 'under_appeal', 'reviewed'].includes(status) && latest?.status !== status) continue;
      }
      if (minConf && latest && latest.min_confidence > Number(minConf)) continue;
      if (text && !(s.conversation_id.toLowerCase().includes(text) || (s.operator_name || '').toLowerCase().includes(text))) continue;
      out.push(item);
    }
    return out;
  });
  router.get('/api/conversations/:id', ({ params, url }) => {
    const row = data.resolve(params.id, q(url, 'group_id'));
    const conv = data.conversation(row);
    const list = engine.evaluationsFor(row.group_id, row.conversation_id);
    const version = q(url, 'checklist_version');
    const latest = version ? (list.find((e) => e.checklist_version === Number(version)) ?? null) : (list[0] ?? null);
    return {
      conversation: { ...conv, group_id: row.group_id, operator_name: data.operatorName(conv) },
      evaluations: list.map((e) => ({ id: e.id, checklist_version: e.checklist_version, total_str: e.total_str, total: e.total, created_at: e.created_at, status: e.status, model: e.model })),
      latest, appeals: db.appeals.find((a) => a.conversation_id === row.conversation_id && a.group_id === row.group_id),
    };
  });
  router.get('/api/audio/:id', async ({ params, url, req, res }) => {
    const row = data.resolve(params.id, q(url, 'group_id'));
    const conv = data.conversation(row);
    if (!conv.audio_url) throw new HttpError(404, 'У этого диалога нет записи');
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    let upstream;
    try { upstream = await (fetchImpl || globalThis.fetch)(conv.audio_url, { headers }); } catch (e) { throw new HttpError(502, `Запись недоступна: ${e.message}`); }
    if (!upstream.ok && upstream.status !== 206) throw new HttpError(502, `Запись недоступна (HTTP ${upstream.status})`);
    const h = { 'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    for (const k of ['content-length', 'content-range']) if (upstream.headers.get(k)) h[k] = upstream.headers.get(k);
    res.writeHead(upstream.status, h);
    if (!upstream.body) { res.end(); return null; }
    const reader = upstream.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r)); }
    res.end();
    return null;
  });

  // ---------- checklists ----------
  router.get('/api/checklists', () => checklists.list());
  router.get('/api/checklists/active', () => { const c = checklists.active(); if (!c) throw new HttpError(404, 'No checklist installed'); return c; });
  router.get('/api/checklists/diff', ({ url }) => checklists.diff(q(url, 'from'), q(url, 'to')));
  router.get('/api/checklists/:version', ({ params }) => checklists.getOrThrow(params.version));
  router.post('/api/checklists', ({ body }) => {
    if (!body.checklist) throw new HttpError(400, 'checklist is required');
    return checklists.save(body.checklist, { note: body.note ?? null, activate: !!body.activate, parentVersion: body.checklist.version ?? null });
  });
  router.post('/api/checklists/validate', ({ body }) => { const cl = normalizeChecklist(body.checklist || body); return { valid: validateChecklist(cl, { maxCriteria: config.maxCriteria }).length === 0, errors: validateChecklist(cl, { maxCriteria: config.maxCriteria }) }; });
  router.post('/api/checklists/:version/activate', ({ params }) => checklists.activate(params.version));
  router.post('/api/checklists/:version/restore', ({ params }) => checklists.restore(params.version));
  router.post('/api/checklists/replace-criterion', ({ body }) => checklists.replaceCriterion(body));
  router.get('/api/templates', () => templates());

  // ---------- evaluation jobs ----------
  function selectRows({ conversation_ids, group_id, all }) {
    let rows;
    if (Array.isArray(conversation_ids) && conversation_ids.length) {
      rows = conversation_ids.map((id) => {
        if (typeof id === 'object' && id) return data.resolve(String(id.conversation_id), id.group_id || group_id || null);
        return data.resolve(String(id), group_id || null);
      });
    } else if (all || group_id) rows = data.rows(group_id || null);
    else throw new HttpError(400, 'conversation_ids, group_id or all:true is required');
    if (!rows.length) throw new HttpError(404, 'Нет диалогов для оценки');
    return rows;
  }
  const items = (rows) => rows.map((r) => ({ key: r.id, conversation_id: r.conversation_id, group_id: r.group_id }));

  router.post('/api/evaluate', ({ body }) => {
    engine.requireEvaluator();
    const checklist = checklists.resolve(body.checklist_version);
    if (!checklist) throw new HttpError(404, 'No checklist installed');
    const rows = selectRows(body);
    const force = !!body.force;
    const criteriaIds = Array.isArray(body.criteria_ids) && body.criteria_ids.length ? body.criteria_ids : null;
    const job = jobs.create({
      kind: 'evaluate', items: items(rows), checklist_version: checklist.version, group_id: body.group_id ?? rows[0].group_id, meta: { force, concurrency: body.concurrency },
      worker: async (item, signal) => {
        const row = db.conversations.get(item.key);
        if (!row) return { conversation_id: item.conversation_id, error: 'conversation removed' };
        const ev = await engine.evaluate(row, checklist, { force, signal, criteriaIds: criteriaIds || undefined });
        return { conversation_id: item.conversation_id, group_id: row.group_id, evaluation_id: ev.id, total_str: ev.total_str, total: ev.total, gross_flag: ev.gross.flag, min_confidence: ev.min_confidence, cost_usd: ev.cost_usd, cost_note: ev.cost_note, reused: ev.trace?.reused || [] };
      },
    });
    return { job_id: job.id, total: job.items.length, checklist_version: checklist.version };
  });

  router.post('/api/simulate', ({ body }) => {
    engine.requireEvaluator();
    if (!body.checklist) throw new HttpError(400, 'checklist (draft) is required');
    const draft = normalizeChecklist(body.checklist);
    const errors = validateChecklist(draft, { maxCriteria: config.maxCriteria });
    if (errors.length) throw new HttpError(400, `Чек-лист не прошёл проверку: ${errors.join('; ')}`, { errors });
    draft.version = draft.version ?? 0;
    draft.status = 'simulation';
    const rows = selectRows({ conversation_ids: body.conversation_ids, group_id: body.group_id });
    const criteriaIds = Array.isArray(body.criteria_ids) && body.criteria_ids.length ? body.criteria_ids : null;
    const active = checklists.active();
    const job = jobs.create({
      kind: 'simulate', items: items(rows), checklist_version: draft.version, group_id: body.group_id ?? rows[0].group_id, meta: { checklist_hash: hashJson(draft) },
      worker: async (item, signal) => {
        const row = db.conversations.get(item.key);
        const sim = await engine.evaluate(row, draft, { signal, mode: 'simulation', criteriaIds: criteriaIds || undefined });
        const stored = engine.latestFor(row.group_id, row.conversation_id, active?.version ?? null) || engine.latestFor(row.group_id, row.conversation_id);
        const changed = [];
        for (const r of sim.results) {
          const prev = stored?.results.find((x) => x.criterion_id === r.criterion_id);
          if (!prev) { changed.push({ criterion_id: r.criterion_id, code: r.code, title: r.title, from: null, to: r.answer_label, points_from: null, points_to: r.points, new: true }); continue; }
          if (prev.answer_label !== r.answer_label || prev.points !== r.points) changed.push({ criterion_id: r.criterion_id, code: r.code, title: r.title, from: prev.answer_label, to: r.answer_label, points_from: prev.points, points_to: r.points });
        }
        for (const prev of stored?.results || []) if (!sim.results.some((r) => r.criterion_id === prev.criterion_id)) changed.push({ criterion_id: prev.criterion_id, code: prev.code, title: prev.title, from: prev.answer_label, to: null, points_from: prev.points, points_to: null, removed: true });
        return { conversation_id: item.conversation_id, group_id: row.group_id, total_str: sim.total_str, simulated_total: sim.total, stored_total: stored?.total ?? null, stored_evaluation_id: stored?.id ?? null, changed_criteria: changed, evaluation: sim, cost_usd: sim.cost_usd, cost_note: sim.cost_note };
      },
    });
    return { job_id: job.id, total: job.items.length };
  });

  router.get('/api/jobs', ({ url }) => jobs.list(Number(q(url, 'limit')) || 20));
  router.get('/api/jobs/:id', ({ params }) => jobs.view(jobs.get(params.id)));
  router.post('/api/jobs/:id/cancel', ({ params }) => jobs.view(jobs.cancel(params.id)));
  router.post('/api/jobs/:id/resume', ({ params }) => jobs.view(jobs.resume(params.id)));

  // ---------- evaluations ----------
  router.get('/api/evaluations', ({ url }) => db.evaluations.find((e) => e.mode === 'stored' && (!q(url, 'conversation_id') || e.conversation_id === q(url, 'conversation_id')) && (!q(url, 'checklist_version') || e.checklist_version === Number(q(url, 'checklist_version')))).map((e) => ({ ...evaluationSummary(e), id: e.id, conversation_id: e.conversation_id, group_id: e.group_id })));
  router.get('/api/evaluations/:id', ({ params }) => { const e = db.evaluations.get(params.id); if (!e) throw new HttpError(404, `Evaluation ${params.id} not found`); return e; });

  // ---------- appeals ----------
  router.post('/api/appeals', ({ body }) => appeals.open(body));
  router.get('/api/appeals', ({ url }) => appeals.list(q(url, 'status') || 'open'));
  router.get('/api/appeals/:id', ({ params }) => appeals.details(params.id));
  router.post('/api/appeals/:id/second-opinion', ({ params }) => appeals.secondOpinion(params.id));
  router.post('/api/appeals/:id/decision', ({ params, body }) => appeals.decide(params.id, body));

  // ---------- stats / calibration / export ----------
  router.get('/api/stats', ({ url }) => computeStats({ data, engine, appeals, checklists, groupId: q(url, 'group_id') || null }));
  router.get('/api/calibration', () => {
    const f = join(config.reportsDir, 'calibration.json');
    const j = readJson(f, null);
    if (!j) throw new HttpError(404, 'Калибровка ещё не запускалась (reports/calibration.json отсутствует)');
    return j;
  });
  router.get('/api/export.csv', ({ url, res }) => {
    const csv = exportCsv({ data, engine, checklists, groupId: q(url, 'group_id') || null, version: q(url, 'checklist_version') || null });
    sendText(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="cqa-export-${q(url, 'group_id') || 'all'}.csv"` });
    return null;
  });

  // ---------- request handling ----------
  async function handle(req, res) {
    setCors(res);
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      if (url.pathname.startsWith('/api/')) {
        const m = router.match(req.method, url.pathname);
        if (!m) throw new HttpError(404, `Unknown API route ${req.method} ${url.pathname}`);
        const body = ['POST', 'PUT'].includes(req.method) ? await readJsonBody(req, config.bodyLimit) : {};
        const out = await m.handler({ params: m.params, url, body, req, res });
        if (res.writableEnded || out === null) return;
        sendJson(res, 200, out);
        return;
      }
      if (url.pathname.startsWith('/packages/')) {
        if (serveStatic(req, res, config.packagesDir, url.pathname.slice('/packages/'.length))) return;
        sendText(res, 404, 'Not found'); return;
      }
      if (serveStatic(req, res, config.publicDir, url.pathname, { fallbackIndex: true })) return;
      sendText(res, 404, existsSync(config.publicDir) ? 'Not found' : 'UI is not built yet (public/ is empty); API is available under /api/');
    } catch (e) {
      if (res.writableEnded) return;
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log(`[${status}] ${req.method} ${url.pathname}: ${e?.stack || e}`);
      sendJson(res, status, { error: e?.message || String(e), ...(e?.extra || {}) });
    }
  }

  const server = createServer(handle);
  const app = {
    config, db, data, checklists, engine, jobs, appeals, router, server, handle,
    listen(port = config.port, host = config.host) { return new Promise((r) => server.listen(port, host, () => r(server.address()))); },
    async close() { db.flush(); await new Promise((r) => server.close(() => r())); },
    flush() { db.flush(); },
  };
  return app;
}

/** First start on an empty database: DEV dataset, checklist v1, committed seed evaluations. */
function bootstrap({ db, data, checklists, config, log }) {
  if (db.checklists.size === 0) {
    const f = join(config.configDir, 'checklist.v1.json');
    if (existsSync(f)) { checklists.install(JSON.parse(readFileSync(f, 'utf8'))); log('checklist v1 installed'); }
  }
  if (db.conversations.size === 0) {
    const r = config.devFile ? data.importFile('DEV', config.devFile, 'bundled') : null;
    if (r) log(`DEV dataset loaded: ${r.added} conversations`);
    // any raw files cached from earlier API fetches
    for (const f of listJsonFiles(join(config.dataDir, 'raw'))) {
      const gid = f.replace(/\\/g, '/').split('/').pop().replace(/\.json$/, '');
      if (gid !== 'DEV' && !db.groups.has(gid)) { try { data.importFile(gid, f, 'cache'); } catch { /* skip unreadable cache */ } }
    }
  }
  if (db.evaluations.size === 0) {
    for (const f of config.seedDir ? listJsonFiles(config.seedDir) : []) {
      const seed = readJson(f, null);
      const list = Array.isArray(seed) ? seed : seed?.evaluations;
      if (!Array.isArray(list)) continue;
      let n = 0;
      for (const ev of list) {
        if (!ev?.id || !ev.conversation_id) continue;
        if (!db.conversations.has(convKey(ev.group_id || 'DEV', ev.conversation_id))) continue;
        db.evaluations.put({ ...ev, mode: 'stored' }); n++;
      }
      for (const ap of seed?.appeals || []) if (ap?.id) db.appeals.put(ap);
      log(`seed ${f}: ${n} evaluations`);
    }
  }
  db.flush();
}
