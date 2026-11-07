// Server configuration: defaults, overridable through environment variables (.env is loaded by server/index.js).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Organizers' Power Automate endpoint (published in the task description); `group_id` is appended per request.
export const DEFAULT_DATA_URL = 'https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=5Sog2MThgCRTlk3HObv70LRmRk6u7IOwzlwMpe804qo';

export const VERSION = '0.1.0';

export function getConfig(env = process.env, overrides = {}) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    dataUrl: env.CQA_DATA_URL || DEFAULT_DATA_URL,
    provider: env.CQA_PROVIDER || null,
    model: env.CQA_MODEL || null,
    verifierModel: env.CQA_VERIFIER_MODEL || null,
    concurrency: num(env.CQA_CONCURRENCY, 2),
    bodyLimit: 10 * 1024 * 1024,
    fetchTimeoutMs: num(env.CQA_FETCH_TIMEOUT_MS, 30000),
    dataDir: env.CQA_DATA_DIR || join(ROOT, 'data'),
    devFile: join(ROOT, 'data', 'dev', 'DEV.json'),
    seedDir: join(ROOT, 'data', 'seed'),
    publicDir: join(ROOT, 'public'),
    packagesDir: join(ROOT, 'packages'),
    configDir: join(ROOT, 'config'),
    reportsDir: join(ROOT, 'reports'),
    needsReviewThreshold: 0.6,
    maxExamplesPerCriterion: 5,
    maxCriteria: 50,
    ...overrides,
  };
}
