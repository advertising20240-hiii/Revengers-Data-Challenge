// UI strings. Loaded from i18n/<lang>.json; a preloaded dictionary in window.CQA_I18N wins (single-file builds).

let dict = {};

export function setDict(d) { dict = d || {}; }

export async function loadDict(base, lang) {
  if (window.CQA_I18N && typeof window.CQA_I18N === 'object') { dict = window.CQA_I18N; return dict; }
  try {
    const r = await fetch(`${base}/i18n/${lang}.json`, { cache: 'no-cache' });
    if (r.ok) dict = await r.json();
  } catch { /* keys will be shown as-is */ }
  return dict;
}

/** t('key.path', {n: 5}) -> string; missing keys return the key so gaps are visible, never crash. */
export function t(key, vars) {
  let s = dict[key];
  if (s === undefined) s = key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Russian plural: plural(n, ['диалог','диалога','диалогов']) */
export function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
