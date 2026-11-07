// List prices per 1M tokens (USD). Used only to compute/estimate the cost of cloud calls.
// Local models cost nothing per call; their results carry cost_usd = 0 and a cost_note with measured seconds.
export const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cache_read: 0.01, cache_write: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.20, cache_write: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.20, cache_write: 5 },
};

export function priceFor(model) {
  if (!model) return null;
  const k = Object.keys(PRICES).find((m) => model.startsWith(m));
  return k ? PRICES[k] : null;
}

export function costFromUsage(model, usage = {}) {
  const p = priceFor(model);
  if (!p) return null;
  const n = (x) => Number(x || 0) / 1e6;
  return n(usage.input_tokens) * p.input + n(usage.output_tokens) * p.output
    + n(usage.cache_read_tokens) * p.cache_read + n(usage.cache_creation_tokens) * p.cache_write;
}

export function isLocalModel(provider) {
  return provider === 'openai' || provider === 'ollama' || provider === 'heuristic' || provider === 'offline' || provider === 'fake';
}
