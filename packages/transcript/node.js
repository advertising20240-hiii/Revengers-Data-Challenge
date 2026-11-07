// Node-only helpers: load lexicons from config/ and wrap the pure functions.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeRecord, extractFacts } from './index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let cached = null;

export function loadLexicon() {
  if (cached) return cached;
  const read = (f) => JSON.parse(readFileSync(join(ROOT, 'config', 'lexicon', f), 'utf8'));
  cached = { events: read('events.json'), signals: read('signals.json') };
  return cached;
}

/** Normalize a raw record and attach deterministic facts. */
export function prepareConversation(rec, groupId = null) {
  const conv = normalizeRecord(rec, groupId);
  conv.facts = extractFacts(conv, loadLexicon());
  return conv;
}

export { ROOT };
