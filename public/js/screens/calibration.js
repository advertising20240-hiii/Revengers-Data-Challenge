// Screen 5 — Калибровка: AI vs human labels (accuracy, κ with 95% CI, confusion matrices, disagreements).
import { h, replace } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { providerAvailable, providerReason } from '../state.js';
import { chip, toast, skeleton, emptyState, errorBox } from '../components.js';
import { ciChart, confusionMatrix, legend, PALETTE } from '../charts.js';
import { cardHash } from '../router.js';
import { num, pct, date, cost } from '../format.js';

export function renderCalibration(main) {
  const box = h('div');
  replace(main, h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('cal.title')), h('p', { class: 'lead' }, t('cal.lead')))), box);

  async function load() {
    replace(box, h('div', { class: 'card' }, skeleton(10)));
    try {
      const c = await api.calibration();
      draw(c);
    } catch (e) {
      if (e.status === 404) replace(box, h('div', { class: 'card' }, emptyState(t('cal.empty_title'), t('cal.empty_hint'), runButton())));
      else replace(box, errorBox(e, load));
    }
  }

  function runButton() {
    const ok = providerAvailable();
    return h('button', { class: 'btn primary', type: 'button', disabled: !ok, title: ok ? '' : t('health.eval_disabled', { reason: providerReason() || '—' }), onclick: async (e) => {
      e.target.disabled = true; toast(t('cal.running'));
      try { await api.runCalibration(); load(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
    } }, t('cal.run'));
  }

  function draw(c) {
    const crit = c.criteria || [];
    const metric = (k, v, s_) => h('div', { class: 'metric' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s_ ? h('div', { class: 's' }, s_) : null);
    const tot = c.totals || {}, g = c.gross || {}, rt = c.retest || {}, ll = c.learning_loop;
    const header = h('div', { class: 'card' }, h('div', { class: 'card-b' },
      h('div', { class: 'row between' },
        h('div', { class: 'row small muted' }, h('span', null, `${t('card.model')}: `, h('b', null, c.model || '—')), h('span', null, `${t('card.prompt')}: `, h('b', { class: 'mono' }, c.prompt_version || '—')), h('span', null, `${t('card.checklist')} v${c.checklist_version ?? '—'}`), h('span', null, `${t('cal.created')} ${date(c.created_at)}`),
          h('span', null, `n = ${c.n ?? '—'}`), c.split ? h('span', null, t('cal.split', { tune: (c.split.tune || []).length, hold: (c.split.holdout || []).length })) : null),
        runButton()),
      h('div', { class: 'metrics mt' },
        metric(t('cal.exact_total'), pct(tot.exact_match_rate), t('cal.exact_total_hint')),
        metric(t('cal.mae'), num(tot.mae), t('cal.mae_hint')),
        metric(t('cal.within5'), pct(tot.within_5pts)),
        metric(t('cal.gross_recall'), pct(g.recall), t('cal.gross_recall_hint')),
        metric(t('cal.gross_precision'), pct(g.precision)),
        metric(t('cal.retest'), pct(rt.identical_label_rate), t('cal.retest_hint', { n: rt.n ?? '—' })),
        metric(t('cal.cost'), c.cost && Number(c.cost.total_usd) > 0 ? `$${Number(c.cost.total_usd).toFixed(2)}` : '0 ₸', c.cost && Number(c.cost.total_usd) > 0 ? t('cal.cost_per', { v: Number(c.cost.per_dialog_usd || 0).toFixed(4) }) : t('cost.zero', { model: c.model || '—' })),
        metric(t('cal.learning'), ll ? String(ll.examples_used ?? 0) : '0', ll && ll.before && ll.after ? t('cal.learning_delta', { b: pct(ll.before.accuracy ?? ll.before.kappa), a: pct(ll.after.accuracy ?? ll.after.kappa) }) : t('cal.learning_hint')))));

    const kappaItems = crit.map((x) => ({ label: `${x.code} ${x.title}`, value: x.kappa, lo: x.kappa_ci ? x.kappa_ci[0] : null, hi: x.kappa_ci ? x.kappa_ci[1] : null }));
    const accItems = crit.map((x) => ({ label: `${x.code} ${x.title}`, value: x.accuracy, lo: x.accuracy_ci ? x.accuracy_ci[0] : null, hi: x.accuracy_ci ? x.accuracy_ci[1] : null, color: PALETTE.primary }));
    const charts = h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, t('cal.kappa_title')), h('span', { class: 'muted small' }, t('cal.ci95'))), h('div', { class: 'card-b' }, ciChart(kappaItems, { min: -0.2, max: 1, refLine: 0.6, format: (v) => Number(v).toFixed(2), title: t('cal.kappa_title') }),
        legend([{ color: PALETTE.yes, label: t('cal.k_good') }, { color: PALETTE.warn, label: t('cal.k_ok') }, { color: PALETTE.no, label: t('cal.k_low') }]), h('p', { class: 'small muted mt' }, t('cal.kappa_note')))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, t('cal.acc_title')), h('span', { class: 'muted small' }, t('cal.ci95'))), h('div', { class: 'card-b' }, ciChart(accItems, { min: 0, max: 1, refLine: 0.92, format: (v) => `${Math.round(v * 100)}%`, title: t('cal.acc_title') }), h('p', { class: 'small muted mt' }, t('cal.acc_note')))));

    const table = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, t('cal.table_title'))), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, t('cl.criterion')), h('th', null, 'n'), h('th', null, t('cal.accuracy')), h('th', null, 'κ'), h('th', null, t('cal.holdout')), h('th', null, t('cal.within_step')), h('th', null, t('cal.confusion')))),
      h('tbody', null, crit.map((x) => h('tr', null,
        h('td', null, h('b', null, `${x.code} ${x.title}`), h('div', { class: 'muted small' }, x.kind === 'scale' ? t('cal.kind_scale') : t('cal.kind_binary'))),
        h('td', { class: 'num' }, x.n ?? '—'),
        h('td', { class: 'num' }, pct(x.accuracy), x.accuracy_ci ? h('div', { class: 'muted small' }, `[${pct(x.accuracy_ci[0])}; ${pct(x.accuracy_ci[1])}]`) : null),
        h('td', { class: 'num' }, num(x.kappa), x.kappa_ci ? h('div', { class: 'muted small' }, `[${num(x.kappa_ci[0])}; ${num(x.kappa_ci[1])}]`) : null),
        h('td', { class: 'num' }, x.holdout ? h('span', null, `${pct(x.holdout.accuracy)} · κ ${num(x.holdout.kappa)}`, h('div', { class: 'muted small' }, `n = ${x.holdout.n}`)) : '—'),
        h('td', { class: 'num' }, x.within_one_step !== undefined && x.within_one_step !== null ? pct(x.within_one_step) : '—'),
        h('td', null, confusionMatrix(x.confusion))))))));

    const gTypes = g.by_type || {};
    const grossCard = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, t('cal.gross_title'))), h('div', { class: 'card-b tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, t('cal.gross_type')), h('th', null, 'TP'), h('th', null, 'FP'), h('th', null, 'FN'), h('th', null, t('cal.gross_recall')), h('th', null, t('cal.gross_precision')))),
      h('tbody', null, Object.entries(gTypes).map(([ty, v]) => h('tr', null, h('td', null, chip(t(`gross.${ty}`), 'flag')), h('td', { class: 'num' }, v.tp ?? 0), h('td', { class: 'num' }, v.fp ?? 0), h('td', { class: 'num' }, v.fn ?? 0),
        h('td', { class: 'num' }, pct((v.tp || 0) + (v.fn || 0) ? (v.tp || 0) / ((v.tp || 0) + (v.fn || 0)) : null)), h('td', { class: 'num' }, pct((v.tp || 0) + (v.fp || 0) ? (v.tp || 0) / ((v.tp || 0) + (v.fp || 0)) : null))))))));

    const dis = c.disagreements || [];
    const disCard = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, `${t('cal.disagreements')} (${dis.length})`), h('span', { class: 'muted small' }, t('cal.disagreements_hint'))),
      dis.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, t('col.id')), h('th', null, t('cl.criterion')), h('th', null, t('cal.ai')), h('th', null, t('cal.human')), h('th', null, t('cal.accepted')), h('th', null, t('hist.note')))),
        h('tbody', null, dis.map((x) => h('tr', null, h('td', null, h('a', { href: cardHash(x.conversation_id), class: 'mono' }, x.conversation_id)), h('td', null, x.criterion_id), h('td', null, chip(String(x.ai), 'neutral')), h('td', null, chip(String(x.human), 'info')), h('td', null, (x.accepted || []).join(', ') || '—'), h('td', { class: 'small muted' }, x.note || ''))))))
        : emptyState(t('cal.no_disagreements'), ''));

    replace(box, h('div', { class: 'stack' }, header, charts, table, h('div', { class: 'grid-2' }, grossCard, disCard)));
  }

  load();
  return { destroy() {} };
}
