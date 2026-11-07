// Provider: official Anthropic SDK (loaded dynamically; not a dependency of this project).
// Locked by the zero-spend policy unless CQA_ALLOW_CLOUD=1.
import { extractJson } from '../lib/json.js';
import { costFromUsage } from '../pricing.js';

export const name = 'anthropic';
let sdkPromise = null;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/sdk').then((m) => m.default || m.Anthropic || m).catch(() => null);
  }
  return sdkPromise;
}

export function info(cfg) {
  if (!cfg.allowCloud) return { available: false, reason: 'облачные модели отключены политикой нулевых затрат (CQA_ALLOW_CLOUD=1 для разблокировки)' };
  if (!process.env.ANTHROPIC_API_KEY) return { available: false, reason: 'ANTHROPIC_API_KEY не задан' };
  return { available: true, reason: 'SDK @anthropic-ai/sdk загружается при первом вызове' };
}

export async function complete({ system, user, schema, model, signal, maxTokens = 4000, effort = 'medium' }, cfg = {}) {
  if (!cfg.allowCloud) throw new Error('Облачные модели отключены политикой нулевых затрат (CQA_ALLOW_CLOUD=1 для разблокировки)');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY не задан');
  const Anthropic = await loadSdk();
  if (!Anthropic) throw new Error('@anthropic-ai/sdk не установлен');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const started = Date.now();
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort },
  };
  if (schema) params.output_config.format = { type: 'json_schema', schema };
  const resp = await client.messages.create(params, { signal });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = resp.usage || {};
  const usage = {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    cache_creation_tokens: u.cache_creation_input_tokens || 0,
  };
  return {
    text,
    json: extractJson(text),
    usage,
    cost_usd: costFromUsage(model, usage) ?? 0,
    cost_basis: 'computed from usage at list price',
    latency_ms: Date.now() - started,
    model: resp.model || model,
  };
}
