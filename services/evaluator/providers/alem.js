// Provider: alem.plus — OpenAI-compatible `/v1/chat/completions` with role-based model routing.
// Roles (all from env, model ids are never guessed): judge, verifier, kz (second opinion on Kazakh dialogs), fallback (429/quota/failure).
// Structured output is negotiated once per model: json_schema → json_object → plain text + robust JSON extraction.
// The API is free of charge for this project: cost_usd = 0, tokens and latency are recorded from `usage`.
import { extractJson } from '../lib/json.js';

export const name = 'alem';

const support = new Map();   // model -> 'json_schema' | 'json_object' | 'text'
const temperatureOk = new Map(); // model -> boolean
const quota = new Map();
const thinkingKwargsOk = new Map(); // model -> false if the endpoint rejects chat_template_kwargs     // model -> { remaining, limit, exhausted_until }

const ROLES = ['JUDGE', 'VERIFIER', 'VERIFIER_ALT', 'KZ', 'FALLBACK', 'EMBED', 'RERANK'];

/** Per-role endpoint: ALEM_MODEL_<R>, ALEM_API_KEY_<R> (fallback ALEM_API_KEY), ALEM_BASE_URL_<R> (fallback ALEM_BASE_URL). */
export function roleConfig(role) {
  const R = String(role || 'judge').toUpperCase();
  const env = process.env;
  const model = env[`ALEM_MODEL_${R}`] || null;
  return {
    role: R.toLowerCase(),
    model,
    apiKey: env[`ALEM_API_KEY_${R}`] || env.ALEM_API_KEY || '',
    base: (env[`ALEM_BASE_URL_${R}`] || env.ALEM_BASE_URL || '').replace(/\/+$/, ''),
  };
}

export function config() {
  const roles = Object.fromEntries(ROLES.map((r) => [r.toLowerCase(), roleConfig(r).model]));
  const judge = roleConfig('judge');
  return {
    base: judge.base, apiKey: judge.apiKey,
    roles,
    score: { url: process.env.ALEM_SCORE_URL || null, configured: !!(process.env.ALEM_SCORE_URL && process.env.ALEM_SCORE_API_KEY) },
    langfuse: !!(process.env.LANGFUSE_HOST && process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
  };
}

export function configured() {
  const j = roleConfig('judge');
  return !!(j.base && j.apiKey && j.model);
}

/** Model id for a role; verifier falls back to verifier_alt (different model family). */
export function modelForRole(role) {
  if (role === 'verifier') return roleConfig('verifier').model || roleConfig('verifier_alt').model || null;
  return roleConfig(role).model || null;
}

/** Endpoint (base + key) for a concrete model id: the first role that names it; otherwise the shared values. */
function endpointForModel(model, roleHint) {
  const order = roleHint ? [roleHint.toUpperCase(), ...ROLES] : ROLES;
  for (const r of order) { const c = roleConfig(r); if (c.model && c.model === model && c.base && c.apiKey) return c; }
  const shared = roleConfig(roleHint || 'judge');
  return { ...shared, model };
}

export function info() {
  const c = config();
  const roles = Object.fromEntries(Object.entries(c.roles).map(([k, v]) => [k, v ? 'задана' : 'не задана']));
  if (!c.base || !c.apiKey) return { available: false, reason: 'ALEM_BASE_URL / ALEM_API_KEY не заданы', roles };
  if (!c.roles.judge) return { available: false, reason: 'ALEM_MODEL_JUDGE не задан', roles };
  return {
    available: true,
    reason: `alem.plus; роли: ${Object.entries(c.roles).filter(([, v]) => v).map(([k]) => k).join(', ')}${c.langfuse ? '; трассировка Langfuse включена' : ''}`,
    roles, base_url: c.base, score_api: c.score.configured ? 'настроен (вызовы не реализованы)' : 'не настроен', langfuse: c.langfuse,
    quota: Object.fromEntries([...quota.entries()].map(([m, q]) => [m, { remaining: q.remaining, limit: q.limit }])),
  };
}

/** Score API hook (contract unknown): records intent only, never calls the network. */
export function scoreHook(payload) {
  const c = config();
  if (!c.score.configured) return { sent: false, reason: 'ALEM_SCORE_URL / ALEM_SCORE_API_KEY не заданы' };
  return { sent: false, reason: 'контракт Score API не задокументирован; вызов не выполняется', payload_keys: Object.keys(payload || {}) };
}

/** Optional Langfuse trace: fire-and-forget, never awaited by the evaluation, errors swallowed. */
export function traceToLangfuse(event) {
  const env = process.env;
  if (!(env.LANGFUSE_HOST && env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY)) return false;
  try {
    const body = { batch: [{ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, type: 'generation-create', timestamp: new Date().toISOString(), body: { name: event.name || 'cqa-judge', model: event.model, input: event.input_tokens, output: event.output_tokens, metadata: event.metadata || {}, startTime: event.started_at, endTime: new Date().toISOString() } }] };
    const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64');
    fetch(`${env.LANGFUSE_HOST.replace(/\/+$/, '')}/api/public/ingestion`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).catch(() => {});
  } catch { /* never affects the evaluation */ }
  return true;
}

const SHARED = '__shared';
const RESERVE = Number(process.env.CQA_ALEM_RESERVE ?? NaN); // requests kept in reserve (default: 20 % of the limit)

function quotaExhausted(model) {
  for (const k of [model, SHARED]) {
    const q = quota.get(k);
    if (!q) continue;
    if (q.exhausted_until && q.exhausted_until > Date.now()) return true;
    const floor = Number.isNaN(RESERVE) ? (q.limit ? q.limit * 0.2 : 0) : RESERVE;
    if (q.remaining != null && q.remaining <= floor) return true; // keep a reserve for the control set and the live demo
  }
  return false;
}

/** Reads rate-limit headers in any vendor naming (e.g. x-ratelimit-remaining-requests, x-ratelimit-<scope>-remaining-requests). */
function readQuota(model, headers) {
  let remaining = NaN, limit = NaN, scoped = false;
  for (const [k, v] of headers) {
    const m = /^x-ratelimit-(?:(.+?)-)?(remaining|limit)(?:-requests)?$/i.exec(k);
    if (!m || /tokens/i.test(k)) continue;
    if (m[2].toLowerCase() === 'remaining') remaining = Number(v); else limit = Number(v);
    if (m[1]) scoped = true; // scoped quota (per team/account) is shared by all models and keys
  }
  if (Number.isNaN(remaining) && Number.isNaN(limit)) return;
  for (const key of scoped ? [model, SHARED] : [model]) {
    const q = quota.get(key) || {};
    quota.set(key, { ...q, remaining: Number.isNaN(remaining) ? q.remaining : remaining, limit: Number.isNaN(limit) ? q.limit : limit });
  }
}

async function once({ system, user, schema, model, signal, timeoutMs, maxTokens, role, _retry = 0 }, _c) {
  const c = endpointForModel(model, role);
  const mode = support.get(model) || (schema ? (process.env.CQA_ALEM_JSON_MODE || 'json_object') : 'text');
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  // The gateway caches identical requests; a retry must not receive the same (failed) cached answer.
  if (_retry) { body.cache = { 'no-cache': true }; body.messages[0].content += `

(попытка ${_retry + 1})`; }
  if (temperatureOk.get(model) !== false) body.temperature = 0;
  // Hybrid-reasoning models (Qwen3 family) otherwise spend the whole token budget thinking and return no answer.
  if (/qwen/i.test(model) && process.env.CQA_ALEM_THINKING !== '1' && thinkingKwargsOk.get(model) !== false) body.chat_template_kwargs = { enable_thinking: false };
  if (/gpt-oss/i.test(model)) body.reasoning_effort = process.env.CQA_ALEM_REASONING_EFFORT || 'low';
  if (schema && mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'cqa_result', schema, strict: false } };
  else if (schema && mode === 'json_object') body.response_format = { type: 'json_object' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const r = await fetch(`${c.base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(body), signal: ctl.signal });
    readQuota(model, r.headers);
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 600);
      const err = new Error(`alem ${r.status}: ${txt}`);
      err.status = r.status;
      err.retryAfter = Number(r.headers.get('retry-after') || 0);
      err.body = txt;
      throw err;
    }
    const j = await r.json();
    return j;
  } finally { clearTimeout(t); }
}

export async function complete(req, _cfg = {}, ctx = {}) {
  const c = config();
  let model = req.model || modelForRole(req.role || 'judge') || c.roles.judge;
  if (!model) throw new Error('alem: модель не задана (ALEM_MODEL_JUDGE)');
  const ep = endpointForModel(model, req.role);
  if (!ep.base || !ep.apiKey) throw new Error(`alem: ALEM_BASE_URL / ALEM_API_KEY не заданы для модели роли ${req.role || 'judge'}`);
  const timeoutMs = req.timeoutMs || 180000;
  const maxTokens = req.maxTokens || 3000;
  const started = Date.now();
  let attempts = 0;
  let switched = false;
  for (;;) {
    if (quotaExhausted(model) && c.roles.fallback && model !== c.roles.fallback && !switched) { model = c.roles.fallback; switched = true; }
    try {
      const j = await once({ ...req, model, timeoutMs, maxTokens }, c);
      const text = j.choices?.[0]?.message?.content ?? '';
      const u = j.usage || {};
      if (process.env.CQA_DEBUG_DIR) { try { (await import('node:fs')).writeFileSync(`${process.env.CQA_DEBUG_DIR}/ok-${req.role || 'judge'}-${Date.now()}.txt`, String(text)); } catch { /* debug only */ } }
      if (req.schema && extractJson(text) == null) {
        // empty or non-JSON answer: step down the structured-output mode once, then give up to the validator
        const cur = support.get(model) || process.env.CQA_ALEM_JSON_MODE || 'json_object';
        const next = cur === 'json_schema' ? 'json_object' : cur === 'json_object' ? 'text' : null;
        if (process.env.CQA_DEBUG_DIR) { try { (await import('node:fs')).writeFileSync(`${process.env.CQA_DEBUG_DIR}/alem-${Date.now()}.json`, JSON.stringify(j, null, 1)); } catch { /* debug only */ } }
        if (next && !req._downgraded) { support.set(model, next); req = { ...req, _downgraded: true, _retry: (req._retry || 0) + 1 }; continue; }
      }
      if (req.schema && !support.has(model)) support.set(model, support.get(model) || process.env.CQA_ALEM_JSON_MODE || 'json_object');
      traceToLangfuse({ name: `cqa-${req.role || 'judge'}`, model, input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, started_at: new Date(started).toISOString(), metadata: { conversation_id: ctx.conversationId, criteria: (ctx.criteria || []).map((x) => x.id) } });
      return {
        text,
        json: extractJson(text),
        usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, cache_read_tokens: u.prompt_tokens_details?.cached_tokens || 0, cache_creation_tokens: 0 },
        cost_usd: 0,
        cost_basis: 'alem.plus free API — 0 ₸; tokens recorded',
        latency_ms: Date.now() - started,
        model: j.model || model,
        switched_to_fallback: switched || undefined,
      };
    } catch (e) {
      if (e.name === 'AbortError' || /aborted/.test(e.message)) throw e;
      const b = String(e.body || e.message);
      // negotiate structured output / temperature support once per model
      if (e.status === 400 && /temperature/i.test(b) && temperatureOk.get(model) !== false) { temperatureOk.set(model, false); continue; }
      if (e.status === 400 && /chat_template_kwargs|enable_thinking/i.test(b) && thinkingKwargsOk.get(model) !== false) { thinkingKwargsOk.set(model, false); continue; }
      if (e.status === 400 && req.schema && /response_format|json_schema|schema/i.test(b)) {
        const cur = support.get(model) || process.env.CQA_ALEM_JSON_MODE || 'json_object';
        if (cur === 'json_schema') { support.set(model, 'json_object'); continue; }
        if (cur === 'json_object') { support.set(model, 'text'); continue; }
      }
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || /fetch failed|ECONNRESET|timeout/i.test(b);
      if (e.status === 429) {
        const q = quota.get(model) || {};
        quota.set(model, { ...q, exhausted_until: Date.now() + Math.max(e.retryAfter || 0, 30) * 1000 });
      }
      if (retryable && attempts < 3) {
        attempts++;
        const wait = e.retryAfter ? e.retryAfter * 1000 : 1000 * 2 ** attempts;
        await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));
        continue;
      }
      if (c.roles.fallback && model !== c.roles.fallback && !switched) { model = c.roles.fallback; switched = true; attempts = 0; continue; }
      e.message = `alem (${model}, ${ctx.conversationId || '?'}): ${e.message}`;
      throw e;
    }
  }
}
