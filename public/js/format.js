// Formatting helpers (Russian locale).
import { t } from './i18n.js';
import { state } from './state.js';

export function num(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return Number(x).toFixed(digits);
}

export function pct(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return `${(Number(x) * 100).toFixed(digits)}%`;
}

export function secs(x) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  const s = Math.round(Number(x));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m} мин ${String(r).padStart(2, '0')} с`;
  const hh = Math.floor(m / 60);
  return `${hh} ч ${String(m % 60).padStart(2, '0')} мин`;
}

export function mmss(x) {
  if (x === null || x === undefined) return '';
  const s = Math.max(0, Math.round(Number(x)));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function date(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Cost line: zero cost is a local model. */
export function cost(usd, model, latencyMs, note) {
  const parts = [];
  const u = Number(usd || 0);
  if (u > 0) parts.push(`$${u.toFixed(4)}`);
  else parts.push(t('cost.zero', { model: model || '—' }));
  if (u > 0 && model) parts.push(model);
  if (latencyMs !== undefined && latencyMs !== null) parts.push(`${(Number(latencyMs) / 1000).toFixed(1)} с`);
  if (note) parts.push(note);
  return parts.join(' · ');
}

/**
 * Provenance line for an evaluation: "qwen3-8 · 0 ₸ · alem.plus · из кэша".
 * When trace.calls is empty nothing was sent to the model, so latency is meaningless and «из кэша» is shown instead.
 */
export function provenance(E) {
  const tr = (E && E.trace) || {};
  const note = tr.cost_note || (E && E.cost_note) || '';
  const usd = Number((E && E.cost_usd) || 0);
  const calls = Array.isArray(tr.calls) ? tr.calls.filter((c) => c && c.role !== 'rule') : null;
  const fromCache = calls ? calls.length === 0 : /кэш/i.test(note);
  const hp = (state.health && state.health.provider) || {};
  const providerName = tr.provider && tr.provider !== 'none' ? tr.provider : hp.provider;
  let price;
  if (usd > 0) price = `$${usd.toFixed(4)}`;
  else if (/alem\.plus/i.test(note) || providerName === 'alem') price = '0 ₸ · alem.plus';
  else if (note && !fromCache) price = note.replace(/\s*\(.*\)\s*$/, '').replace(' — ', ' · ');
  else price = t('cost.zero', { model: (E && E.model) || tr.model || '—' });
  const time = fromCache ? t('card.from_cache') : (E && E.latency_ms !== null && E.latency_ms !== undefined ? `${(Number(E.latency_ms) / 1000).toFixed(1)} с` : null);
  return { price, time, fromCache };
}

/** Human-readable reasons why an evaluation needs a reviewer's eye. Uses the server list when present. */
export function reviewReasons(L) {
  if (!L) return [];
  if (Array.isArray(L.review_reasons) && L.review_reasons.length) return L.review_reasons.map(reasonLabel);
  const out = [];
  if (L.gross_flag) out.push(`${t('card.gross_title').toLowerCase()}: ${(L.gross_types || []).map(grossTypeLabel).join(', ')}`);
  if (L.min_confidence !== null && L.min_confidence !== undefined && L.min_confidence < 0.6) out.push(t('card.low_conf', { v: Math.round(L.min_confidence * 100) }));
  return out;
}
function reasonLabel(s) {
  // server strings look like "грубая ошибка: disclosure" — translate the raw flag type when we know it
  return String(s).replace(/\b(insult|bypass|disclosure)\b/g, (m) => grossTypeLabel(m));
}

export function channelLabel(ch) { return ch === 'voice call' ? t('channel.voice') : t('channel.chat'); }

export function speakerLabel(sp) { return t(`speaker.${sp}`) || sp; }

export function statusLabel(st) { return t(`status.${st}`) || st || '—'; }

export function grossTypeLabel(type) { return t(`gross.${type}`) || type; }

export function outcomeLabel(o) { return t(`outcome.${o}`) || o; }

export function answerKind(r) {
  // r: evaluation result or {applicable, answer, answer_type, scale_value}
  if (!r) return 'na';
  if (r.answer_type === 'flag' || r.scored === false) return r.flag_types && r.flag_types.length ? 'flag' : (r.applicable === false ? 'na' : 'neutral');
  if (r.applicable === false) return 'na';
  if (r.answer_type === 'scale' || r.answer_type === 'scale_na') return 'scale';
  return r.answer === 'yes' ? 'yes' : 'no';
}

export function answerText(r, criterion) {
  if (!r) return '—';
  if (r.answer_label) return r.answer_label;
  if (r.applicable === false) return 'N/A';
  const c = criterion || r;
  if (c.answer_type === 'scale' || c.answer_type === 'scale_na') {
    const max = Math.max(...(c.scale || []).map((s) => Number(s.value)), 0);
    return t('answer.scale', { v: r.scale_value, max });
  }
  if (c.answer_type === 'flag' || c.scored === false) return r.flag_types && r.flag_types.length ? t('answer.yes') : t('answer.no');
  return r.answer === 'yes' ? t('answer.yes') : t('answer.no');
}
