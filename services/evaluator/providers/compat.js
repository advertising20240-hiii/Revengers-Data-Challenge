// External OpenAI-compatible APIs with a HARD spending guard: Google Gemini (AI Studio key) and NVIDIA (API key).
// Before every request the guard checks a persisted ledger (data/budget/<provider>.json) against two limits:
//   <P>_MAX_USD            — dollars, estimated at list price for input + the WORST CASE output (max_tokens), so the next
//                            call can never cross the cap; default: NVIDIA 35 (below a $40 credit), Gemini 0.50
//   <P>_MAX_CALLS_PER_DAY  — requests per UTC day (free-tier daily limits); default: NVIDIA 300, Gemini 200
// A request that would cross a limit is refused before it is sent; the evaluator then falls back to deterministic rules
// with an honest label, it never retries around the guard. Keys come only from .env and are never logged.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJson } from '../lib/json.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUDGET_DIR = () => process.env.CQA_BUDGET_DIR || join(process.env.CQA_DATA_DIR || join(ROOT, 'data'), 'budget');

const DEFS = {
  gemini: {
    prefix: 'GEMINI', label: 'Google Gemini API',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash',
    // list price of a Gemini Flash model (2.5 tier), $ per 1M tokens — used only to bound the worst case if billing were ever enabled
    priceIn: 0.30, priceOut: 2.50, maxUsd: 0.50, maxCallsPerDay: 200,
    extra: () => ({ reasoning_effort: process.env.GEMINI_REASONING_EFFORT || 'none' }),
  },
  nvidia: {
    prefix: 'NVIDIA', label: 'NVIDIA API',
    base: 'https://integrate.api.nvidia.com/v1', model: 'deepseek-ai/deepseek-v4.1-flash',
    priceIn: 0.80, priceOut: 0.80, maxUsd: 35, maxCallsPerDay: 300,
    extra: () => ({}),
  },
};

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function makeProvider(name) {
  const D = DEFS[name];
  const env = (k) => process.env[`${D.prefix}_${k}`];

  function config() {
    return {
      base: (env('BASE_URL') || D.base).replace(/\/+$/, ''),
      apiKey: env('API_KEY') || '',
      model: env('MODEL') || D.model,
      priceIn: num(env('PRICE_IN'), D.priceIn), priceOut: num(env('PRICE_OUT'), D.priceOut),
      maxUsd: num(env('MAX_USD'), D.maxUsd), maxCallsPerDay: num(env('MAX_CALLS_PER_DAY'), D.maxCallsPerDay),
    };
  }

  const ledgerFile = () => join(BUDGET_DIR(), `${name}.json`);
  function readLedger() {
    try { if (existsSync(ledgerFile())) return JSON.parse(readFileSync(ledgerFile(), 'utf8')); } catch { /* corrupt → start conservative below */ }
    return { provider: name, calls: 0, input_tokens: 0, output_tokens: 0, est_usd: 0, refused: 0, days: {} };
  }
  function writeLedger(l) {
    mkdirSync(BUDGET_DIR(), { recursive: true });
    const tmp = `${ledgerFile()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`, 'utf8');
    renameSync(tmp, ledgerFile());
  }
  const today = () => new Date().toISOString().slice(0, 10);

  /** Throws when the next call could cross a limit. */
  function guard(c, inputChars, maxTokens) {
    const l = readLedger();
    const estIn = Math.ceil(inputChars / 2.5); // conservative: Cyrillic ≈ 2.5 chars per token
    const worst = (estIn * c.priceIn + maxTokens * c.priceOut) / 1e6;
    const day = l.days[today()] || 0;
    let why = null;
    if (l.est_usd + worst > c.maxUsd) why = `лимит бюджета ${c.maxUsd} $ (израсходовано по оценке ${l.est_usd.toFixed(4)} $)`;
    else if (day + 1 > c.maxCallsPerDay) why = `дневной лимит ${c.maxCallsPerDay} запросов`;
    if (why) {
      l.refused = (l.refused || 0) + 1; writeLedger(l);
      const e = new Error(`${D.label}: запрос не отправлен — ${why}`); e.budget = true; throw e;
    }
  }
  function record(c, usage) {
    const l = readLedger();
    const usd = (usage.input_tokens * c.priceIn + usage.output_tokens * c.priceOut) / 1e6;
    l.calls += 1; l.input_tokens += usage.input_tokens; l.output_tokens += usage.output_tokens;
    l.est_usd = Math.round((l.est_usd + usd) * 1e6) / 1e6;
    l.days[today()] = (l.days[today()] || 0) + 1;
    l.updated_at = new Date().toISOString();
    writeLedger(l);
    return usd;
  }

  function info() {
    const c = config();
    if (!c.apiKey) return { available: false, reason: `${D.prefix}_API_KEY не задан` };
    const l = readLedger();
    return {
      available: true,
      reason: `${D.label} (${c.model}); жёсткий лимит: ${c.maxUsd} $ и ${c.maxCallsPerDay} запросов в день; израсходовано по оценке ${l.est_usd.toFixed(4)} $, запросов сегодня ${l.days[today()] || 0}`,
      base_url: c.base, budget: { max_usd: c.maxUsd, est_usd: l.est_usd, calls_today: l.days[today()] || 0, max_calls_per_day: c.maxCallsPerDay, refused: l.refused || 0 },
    };
  }

  async function complete({ system, user, schema, model, signal, timeoutMs = 180000, maxTokens = 3000 }) {
    const c = config();
    if (!c.apiKey) throw new Error(`${D.prefix}_API_KEY не задан`);
    const m = model || c.model;
    guard(c, String(system).length + String(user).length, maxTokens);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    signal?.addEventListener('abort', () => ctl.abort(), { once: true });
    const started = Date.now();
    try {
      let mode = schema ? 'json_schema' : null;
      let reasoning = true;
      for (let attempt = 0; attempt < 4; attempt++) {
        const body = { model: m, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...(reasoning ? D.extra() : {}) };
        if (mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'cqa', schema } };
        if (mode === 'json_object') body.response_format = { type: 'json_object' };
        const r = await fetch(`${c.base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(body), signal: ctl.signal });
        const raw = await r.text();
        if (!r.ok) {
          // the request reached the API: count it against the daily limit even when it failed
          record(c, { input_tokens: 0, output_tokens: 0 });
          if (r.status === 400 && reasoning && /reasoning/i.test(raw)) { reasoning = false; continue; }
          if (r.status === 400 && mode && /response_format|json_schema|schema/i.test(raw)) { mode = mode === 'json_schema' ? 'json_object' : null; continue; }
          const e = new Error(`${D.label} ${r.status}: ${raw.slice(0, 200).replace(/key=[^&\s"]+/gi, 'key=***')}`); e.status = r.status; throw e;
        }
        const j = JSON.parse(raw);
        const text = j.choices?.[0]?.message?.content ?? '';
        const usage = { input_tokens: j.usage?.prompt_tokens || 0, output_tokens: j.usage?.completion_tokens || 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
        const usd = record(c, usage);
        return { text, json: extractJson(text), usage, cost_usd: 0, est_list_usd: usd, cost_basis: `${D.label}: бесплатный тариф/кредит, списание по прайсу оценено как ${usd.toFixed(5)} $ и учтено в жёстком лимите`, latency_ms: Date.now() - started, model: j.model || m };
      }
      throw new Error(`${D.label}: структурированный ответ не поддерживается`);
    } finally { clearTimeout(t); }
  }

  return { name, config, info, complete, readLedger };
}

export const gemini = makeProvider('gemini');
export const nvidia = makeProvider('nvidia');
