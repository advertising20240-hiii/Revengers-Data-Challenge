// UI strings. Loaded from i18n/<lang>.json; a preloaded dictionary in window.CQA_I18N wins (single-file builds).
// Languages: ru (default), kk, en. The choice is remembered per browser (localStorage, optional).

export const LANGS = ['ru', 'kk', 'en'];
const LOCALES = { ru: 'ru-RU', kk: 'kk-KZ', en: 'en-GB' };
const STORE_KEY = 'cqa.lang';

let dict = {};
let lang = 'ru';

export function setDict(d) { dict = d || {}; }
export function getLang() { return lang; }
export function locale() { return LOCALES[lang] || 'ru-RU'; }

/** Language to start with: saved choice → configured default → ru. */
export function initialLang(configured) {
  let saved = null;
  try { saved = window.localStorage.getItem(STORE_KEY); } catch { /* storage may be unavailable */ }
  const pick = [saved, configured, 'ru'].find((x) => LANGS.includes(x));
  return pick || 'ru';
}

export function saveLang(l) {
  try { window.localStorage.setItem(STORE_KEY, l); } catch { /* storage may be unavailable */ }
}

export async function loadDict(base, wanted) {
  lang = LANGS.includes(wanted) ? wanted : 'ru';
  const pre = window.CQA_I18N;
  if (pre && typeof pre === 'object') {
    // single-file builds may preload one dictionary or {ru:{…}, kk:{…}, en:{…}}
    dict = pre[lang] && typeof pre[lang] === 'object' ? pre[lang] : pre;
    return dict;
  }
  try {
    const r = await fetch(`${base}/i18n/${lang}.json`, { cache: 'no-cache' });
    if (r.ok) dict = await r.json();
    else if (lang !== 'ru') return loadDict(base, 'ru');
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

/** Counted noun in the current language: pl(3, 'unit.lines') with "реплика|реплики|реплик" / "line|lines". */
export function pl(n, key) {
  const forms = String(t(key)).split('|');
  const num = Number(n) || 0;
  let word;
  if (lang === 'ru') word = plural(num, [forms[0], forms[1] || forms[0], forms[2] || forms[1] || forms[0]]);
  else if (lang === 'en') word = num === 1 ? forms[0] : (forms[1] || forms[0]);
  else word = forms[0];
  return `${n} ${word}`;
}
