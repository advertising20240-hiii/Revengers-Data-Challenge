// Stable hashing of JSON values (keys sorted) so that identical criterion definitions
// produce identical hashes regardless of property order.
import { createHash, randomBytes } from 'node:crypto';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function hashJson(value, length = 16) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, length);
}

export function newId(prefix) {
  const t = Date.now().toString(36);
  return `${prefix}_${t}${randomBytes(4).toString('hex')}`;
}
