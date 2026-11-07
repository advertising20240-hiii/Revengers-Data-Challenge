// Per-criterion evaluation cache: data/cache/eval/<sha256>.json
// Key = sha256(conversation lines, criterion definition JSON, policy text, PROMPT_VERSION, model).
// A changed checklist therefore only re-evaluates the criteria whose definition actually changed.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableStringify } from './lib/hash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = process.env.CQA_CACHE_DIR || join(ROOT, 'data', 'cache', 'eval');

export function linesDigest(conv) {
  return sha256(stableStringify((conv.lines || []).map((l) => [l.n, l.speaker, l.text, l.offset_seconds ?? null])));
}

export function criterionDigest(criterion) {
  return sha256(stableStringify(criterion));
}

export function cacheKey({ conv, criterion, policyText, promptVersion, model }) {
  return sha256(linesDigest(conv), '|', criterionDigest(criterion), '|', sha256(policyText || ''), '|', promptVersion, '|', model || '');
}

function fileFor(key) { return join(CACHE_DIR, `${key}.json`); }

export function cacheGet(key) {
  const f = fileFor(key);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function cachePut(key, value) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(fileFor(key), JSON.stringify(value, null, 1), 'utf8');
}

export function cacheStats() {
  if (!existsSync(CACHE_DIR)) return { entries: 0, conversations: 0, models: {} };
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
  const convs = new Set();
  const models = {};
  for (const f of files) {
    try {
      const v = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8'));
      if (v.conversation_id) convs.add(v.conversation_id);
      models[v.model || '?'] = (models[v.model || '?'] || 0) + 1;
    } catch { /* ignore */ }
  }
  return { entries: files.length, conversations: convs.size, models };
}

export function cacheClear() {
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
}
