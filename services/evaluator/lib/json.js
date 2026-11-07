// Robust JSON extraction from model text output.
// Models sometimes wrap JSON in markdown fences, prepend prose or leave trailing commas; we recover the first balanced object.

export function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  // strip markdown fences
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  // find first balanced {...} or [...]
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const stack = [];
  let inStr = false; let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        const cand = s.slice(start, i + 1);
        try { return JSON.parse(cand); } catch { /* try lenient */ }
        try { return JSON.parse(cand.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
      }
    }
  }
  // unbalanced (truncated output): close the open string and containers
  let cand = s.slice(start).replace(/,\s*$/, '');
  if (inStr) cand += '"';
  cand = cand.replace(/,\s*$/, '');
  try { return JSON.parse(cand.replace(/,\s*([}\]])/g, '$1') + stack.reverse().join('')); } catch { return null; }
}

/** Normalize a judge payload into an array of per-criterion objects. */
export function resultsArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.criteria)) return payload.criteria;
  // object keyed by criterion id
  const vals = Object.entries(payload).filter(([k, v]) => v && typeof v === 'object' && /^c\d+/.test(k)).map(([k, v]) => ({ criterion_id: k, ...v }));
  return vals;
}
