// Hard spending guard of the external free-tier / credit providers (Gemini, NVIDIA): no network, fetch is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CQA_BUDGET_DIR = mkdtempSync(join(tmpdir(), 'cqa-budget-'));
const { makeProvider } = await import('../services/evaluator/providers/compat.js');

function stubFetch(counter) {
  return async () => {
    counter.n++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'm', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }) };
  };
}

test('guard: no key → not available, nothing sent', async () => {
  delete process.env.NVIDIA_API_KEY;
  const p = makeProvider('nvidia');
  assert.equal(p.info().available, false);
  await assert.rejects(p.complete({ system: 's', user: 'u' }), /NVIDIA_API_KEY/);
});

test('guard: dollar cap refuses BEFORE sending (worst case counted), daily call cap too', async () => {
  const realFetch = globalThis.fetch;
  const counter = { n: 0 };
  globalThis.fetch = stubFetch(counter);
  try {
    process.env.NVIDIA_API_KEY = 'test-key';
    process.env.NVIDIA_PRICE_IN = '1'; process.env.NVIDIA_PRICE_OUT = '1';
    process.env.NVIDIA_MAX_USD = '0.004'; // worst case per call ≈ (8 + 3000) tokens × $1/1M ≈ $0.003
    const p = makeProvider('nvidia');
    const r = await p.complete({ system: 's'.repeat(10), user: 'u'.repeat(10), maxTokens: 3000 });
    assert.equal(r.json.ok, true);
    assert.equal(counter.n, 1);
    // spent 1200 tokens ≈ $0.0012; the next worst case (+$0.003) would cross $0.004 → refused without a request
    await assert.rejects(p.complete({ system: 's', user: 'u', maxTokens: 3000 }), (e) => e.budget === true && /лимит бюджета/.test(e.message));
    assert.equal(counter.n, 1, 'the refused call must not reach the network');
    assert.equal(p.readLedger().refused, 1);

    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MAX_CALLS_PER_DAY = '2';
    const g = makeProvider('gemini');
    await g.complete({ system: 's', user: 'u', maxTokens: 10 });
    await g.complete({ system: 's', user: 'u', maxTokens: 10 });
    await assert.rejects(g.complete({ system: 's', user: 'u', maxTokens: 10 }), /дневной лимит 2/);
    assert.equal(counter.n, 3);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['NVIDIA_API_KEY', 'NVIDIA_PRICE_IN', 'NVIDIA_PRICE_OUT', 'NVIDIA_MAX_USD', 'GEMINI_API_KEY', 'GEMINI_MAX_CALLS_PER_DAY']) delete process.env[k];
  }
});
