// Provider registry. All providers expose `complete(req, cfg, ctx)` and `info(cfg)`.
// `heuristic` is not a text-completion provider: the evaluator handles it directly from deterministic facts.
import * as anthropic from './anthropic.js';
import * as openai from './openai.js';
import * as offline from './offline.js';
import * as alem from './alem.js';

export const PROVIDERS = { alem, anthropic, openai, ollama: openai, offline };
export const LOCAL_PROVIDERS = ['alem', 'openai', 'ollama', 'offline', 'heuristic', 'fake']; // zero per-call cost
export const CLOUD_PROVIDERS = ['anthropic'];

export function cloudAllowed() { return process.env.CQA_ALLOW_CLOUD === '1'; }

/** Resolution order: CQA_PROVIDER → alem (if configured) → openai/Ollama (if a base URL is configured) → offline. */
export function defaultProviderName() {
  if (process.env.CQA_PROVIDER) return process.env.CQA_PROVIDER;
  if (alem.configured()) return 'alem';
  if (process.env.OLLAMA_BASE_URL || process.env.OPENAI_BASE_URL) return 'openai';
  return 'offline'; // nothing configured: replay the committed cache honestly instead of guessing a local endpoint
}

export function defaultModelFor(provider) {
  if (provider === 'alem') return alem.modelForRole('judge') || process.env.CQA_MODEL || null;
  if (provider === 'openai' || provider === 'ollama') return process.env.OPENAI_MODEL || process.env.CQA_MODEL || 'qwen2.5:7b';
  if (provider === 'heuristic') return 'heuristic-v1';
  // offline replays the committed evaluation cache, which was produced by the alem.plus judge qwen3-8
  if (provider === 'offline') return process.env.CQA_MODEL || alem.modelForRole('judge') || 'qwen3-8';
  return process.env.CQA_MODEL || 'claude-haiku-5-5';
}

export function defaultVerifierFor(provider, model) {
  if (process.env.CQA_VERIFIER_MODEL != null) return process.env.CQA_VERIFIER_MODEL || null;
  if (provider === 'alem') return alem.modelForRole('verifier') || null;
  if (provider === 'openai' || provider === 'ollama') return model; // same local model audits itself (different prompt)
  if (provider === 'heuristic' || provider === 'offline') return null;
  return 'claude-haiku-5-5';
}

/** Model used for the Kazakh second-opinion pass (alem role `kz`), or null. */
export function kzModelFor(provider) {
  if (process.env.CQA_KZ_MODEL != null) return process.env.CQA_KZ_MODEL || null;
  if (provider === 'alem') return alem.modelForRole('kz');
  return null;
}

/** Resolve `opts.provider`: a name or an object with `complete()` (used by tests). */
export function resolveProvider(p) {
  if (p && typeof p === 'object' && typeof p.complete === 'function') return { name: p.name || 'fake', mod: p };
  const nm = p || defaultProviderName();
  if (nm === 'heuristic') return { name: 'heuristic', mod: null };
  const mod = PROVIDERS[nm];
  if (!mod) throw new Error(`Неизвестный провайдер «${nm}» (доступны: ${[...Object.keys(PROVIDERS), 'heuristic'].join(', ')})`);
  return { name: nm, mod };
}

export function providerStatus(nm) {
  const cfg = { allowCloud: cloudAllowed() };
  if (nm === 'heuristic') return { available: true, reason: 'детерминированная базовая оценка по фактам транскрипта (без модели)' };
  if (nm === 'fake') return { available: true, reason: 'тестовый провайдер' };
  const mod = PROVIDERS[nm];
  if (!mod) return { available: false, reason: `неизвестный провайдер «${nm}»` };
  return mod.info(cfg);
}

export { alem };
