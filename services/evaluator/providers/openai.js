// Provider: local model behind an OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, …).
// Two transports: Ollama native `/api/chat` with `format` = JSON schema (default when the base URL is an Ollama one)
// and plain OpenAI `/v1/chat/completions` with `response_format`. Cost is always 0 (local hardware); seconds are measured.
import { extractJson } from '../lib/json.js';

export const name = 'openai';

export function config() {
  const base = (process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
  const isOllama = /:11434(\/|$)/.test(base) || /ollama/i.test(base);
  const native = process.env.CQA_OPENAI_NATIVE != null ? process.env.CQA_OPENAI_NATIVE === '1' : isOllama;
  return {
    base,
    native,
    root: base.replace(/\/v1$/, ''),
    apiKey: process.env.OPENAI_API_KEY || 'ollama',
    model: process.env.OPENAI_MODEL || process.env.CQA_MODEL || 'qwen2.5:7b',
    numCtx: Number(process.env.CQA_NUM_CTX || 16384),
  };
}

export function info() {
  const c = config();
  return { available: true, reason: `локальная модель через ${c.native ? 'Ollama /api/chat' : 'OpenAI-совместимый API'} (${c.base}); доступность проверяется при первом вызове`, base_url: c.base, transport: c.native ? 'ollama' : 'openai' };
}

/** Quick reachability probe (used by providerInfo() refresh and by the calibration script). */
export async function probe(timeoutMs = 2500) {
  const c = config();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = c.native ? `${c.root}/api/tags` : `${c.base}/models`;
    const r = await fetch(url, { signal: ctl.signal, headers: c.native ? {} : { Authorization: `Bearer ${c.apiKey}` } });
    if (!r.ok) return { available: false, reason: `endpoint ${url} ответил ${r.status}` };
    const j = await r.json().catch(() => ({}));
    const models = c.native ? (j.models || []).map((m) => m.name) : (j.data || []).map((m) => m.id);
    const has = models.some((m) => m === c.model || m.startsWith(`${c.model}:`) || c.model.startsWith(m));
    return { available: has || models.length === 0, reason: has ? `модель ${c.model} доступна` : `модель ${c.model} не найдена среди: ${models.join(', ') || '—'}`, models };
  } catch (e) {
    return { available: false, reason: `локальная модель недоступна (${c.base}): ${e.message}` };
  } finally { clearTimeout(t); }
}

export async function complete({ system, user, schema, model, signal, timeoutMs = 600000, maxTokens = 3000 }) {
  const c = config();
  const m = model || c.model;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  const started = Date.now();
  try {
    let text; let usage;
    if (c.native) {
      const body = {
        model: m,
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        options: { temperature: 0, num_ctx: c.numCtx, num_predict: maxTokens, seed: 7 },
      };
      if (schema) body.format = schema;
      const r = await fetch(`${c.root}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      text = j.message?.content ?? '';
      usage = { input_tokens: j.prompt_eval_count || 0, output_tokens: j.eval_count || 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    } else {
      const body = {
        model: m,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      };
      if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'cqa', schema } };
      const r = await fetch(`${c.base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) throw new Error(`${c.base} ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      text = j.choices?.[0]?.message?.content ?? '';
      usage = { input_tokens: j.usage?.prompt_tokens || 0, output_tokens: j.usage?.completion_tokens || 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    }
    const latency_ms = Date.now() - started;
    return { text, json: extractJson(text), usage, cost_usd: 0, cost_basis: 'local model, no per-call cost', latency_ms, model: m, local: true };
  } finally { clearTimeout(t); }
}
