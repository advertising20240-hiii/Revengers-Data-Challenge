// Screen 6 — Инсайты: dataset analytics from /api/stats.
import { h, replace } from '../dom.js';
import { t, pl } from '../i18n.js';
import { api } from '../api.js';
import { state, setGroup } from '../state.js';
import { chip, skeleton, emptyState, errorBox, select } from '../components.js';
import { barChart, histogram, ciChart, stackBar, legend, PALETTE } from '../charts.js';
import { cardHash } from '../router.js';
import { num, pct, secs, cost, grossTypeLabel, channelLabel } from '../format.js';

export function renderInsights(main) {
  const box = h('div');
  const groupSel = h('span');
  replace(main, h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ins.title')), h('p', { class: 'lead' }, t('ins.lead'))), groupSel), box);

  async function load() {
    replace(box, h('div', { class: 'card' }, skeleton(10)));
    try {
      const [groups, st] = await Promise.all([api.groups().catch(() => []), api.stats(state.group || undefined)]);
      replace(groupSel, select([{ value: '', label: t('dialogs.all_groups') }, ...groups.map((g) => ({ value: g.group_id, label: `${g.group_id} (${g.count})` }))], state.group, (v) => { setGroup(v); load(); }, { 'aria-label': t('col.group') }));
      if (!st.n_evaluated) { replace(box, h('div', { class: 'card' }, emptyState(t('ins.empty_title'), t('ins.empty_hint'), h('a', { class: 'btn primary', href: '#/' }, t('nav.dialogs'))))); return; }
      draw(st);
    } catch (e) { replace(box, errorBox(e, load)); }
  }

  const card = (title, body, sub, extraClass = '') => h('div', { class: `card ${extraClass}` }, h('div', { class: 'card-h' }, h('h2', null, title), sub ? h('span', { class: 'muted small' }, sub) : null), h('div', { class: 'card-b' }, body));
  const metric = (k, v, s_) => h('div', { class: 'metric' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s_ ? h('div', { class: 's' }, s_) : null);

  function draw(st) {
    const esc = st.escalation || {}, fr = st.first_reaction || {}, voice = st.voice || {}, c = st.cost || {};
    const kpis = h('div', { class: 'metrics' },
      metric(t('ins.n_conv'), String(st.n_conversations ?? 0), t('ins.n_eval', { n: st.n_evaluated ?? 0 })),
      metric(t('ins.avg_total'), num(st.avg_total), t('ins.median', { v: num(st.median_total) })),
      metric(t('ins.escalation'), pct(esc.rate), t('ins.escalation_hint', { e: esc.escalated ?? 0, b: esc.with_bot ?? 0 })),
      metric(t('ins.containment'), esc.containment !== undefined && esc.containment !== null ? pct(esc.containment) : esc.with_bot ? pct(Math.max(0, 1 - Math.min(esc.escalated || 0, esc.with_bot) / esc.with_bot)) : '—', t('ins.containment_hint')),
      metric(t('ins.first_reaction_med'), secs(fr.median), t('ins.p90', { v: secs(fr.p90) })),
      metric(t('ins.needs_review'), String((st.confidence || {}).needs_review ?? 0), t('ins.needs_review_hint')),
      metric(t('ins.cost'), c.total_usd ? `$${Number(c.total_usd).toFixed(2)}` : '0 ₸', c.evaluations ? t('ins.cost_hint', { n: c.evaluations, m: (c.models || []).join(', ') || '—' }) : ''));

    const dist = card(t('ins.dist_title'), histogram(st.distribution || [], { xLabel: t('ins.dist_x'), yLabel: t('ins.dist_y'), title: t('ins.dist_title') }), t('ins.dist_sub'));

    const crit = (st.criteria || []).filter((x) => x.applicable > 0 || x.yes || x.no || x.na);
    const failItems = crit.map((x) => ({ label: `${x.code} ${x.title}`, value: Math.round((x.fail_rate || 0) * 100), color: (x.fail_rate || 0) > 0.3 ? PALETTE.no : (x.fail_rate || 0) > 0.15 ? PALETTE.warn : PALETTE.primary, hint: `${x.title}: ${t('answer.yes')} ${x.yes}, ${t('answer.no')} ${x.no}, N/A ${x.na}` }));
    const fail = card(t('ins.fail_title'), h('div', null, barChart(failItems, { max: 100, width: 1200, labelW: 340, barH: 22, format: (v) => `${v}%`, title: t('ins.fail_title') }),
      h('div', { class: 'tbl-wrap mt' }, h('table', { class: 'tbl small' }, h('thead', null, h('tr', null, h('th', null, t('cl.criterion')), h('th', null, t('answer.yes')), h('th', null, t('answer.no')), h('th', null, 'N/A'), h('th', null, t('ins.shares')), h('th', null, t('ins.avg_share')))),
        h('tbody', null, crit.map((x) => h('tr', null, h('td', null, `${x.code} ${x.title}`), h('td', { class: 'num' }, x.yes), h('td', { class: 'num' }, x.no), h('td', { class: 'num' }, x.na),
          h('td', null, stackBar([{ value: x.yes, color: PALETTE.yes, label: t('answer.yes') }, { value: x.no, color: PALETTE.no, label: t('answer.no') }, { value: x.na, color: PALETTE.na, label: 'N/A' }])), h('td', { class: 'num' }, x.avg_share !== undefined && x.avg_share !== null ? pct(x.avg_share) : '—')))))),
      legend([{ color: PALETTE.yes, label: t('answer.yes') }, { color: PALETTE.no, label: t('answer.no') }, { color: PALETTE.na, label: 'N/A' }])), t('ins.fail_sub'));

    const byLang = Object.entries(st.by_language || {}).map(([k, v]) => ({ label: `${k} (n=${v.n})`, value: Number(v.avg_total || 0).toFixed(2), color: PALETTE.primary }));
    const byCh = Object.entries(st.by_channel || {}).map(([k, v]) => ({ label: `${channelLabel(k)} (n=${v.n})`, value: Number(v.avg_total || 0).toFixed(2), color: PALETTE.secondary }));
    const seg = card(t('ins.seg_title'), h('div', null, barChart([...byLang, ...byCh], { max: 100, format: (v) => num(v), title: t('ins.seg_title') })), t('ins.seg_sub'));

    const frVals = (fr.values || []).map((v) => v.seconds).filter((v) => v !== null && v !== undefined);
    const frBuckets = bucketize(frVals, [30, 60, 120, 180, 300, 600], (s_) => s_ >= 60 ? `${Math.round(s_ / 60)} ${t('unit.min')}` : `${s_} ${t('unit.sec')}`);
    const frCard = card(t('ins.fr_title'), h('div', null, histogram(frBuckets, { xLabel: t('ins.fr_x'), yLabel: t('ins.dist_y'), highlight: (b) => b.over ? PALETTE.no : PALETTE.primary, title: t('ins.fr_title') }),
      h('div', { class: 'row small muted mt' }, h('span', null, t('ins.fr_over', { n: (fr.over_threshold || []).length })), (fr.over_threshold || []).slice(0, 12).map((id) => h('a', { href: cardHash(id), class: 'mono' }, id)))), t('ins.fr_sub'));

    const voiceCard = card(t('ins.voice_title'), h('div', { class: 'metrics' }, metric(t('ins.calls'), String(voice.calls ?? 0)), metric(t('ins.hold_total'), secs(voice.hold_seconds_total)), metric(t('ins.consults'), String(voice.consult_segments ?? 0)),
      metric(t('ins.hold_avg'), voice.calls ? secs((voice.hold_seconds_total || 0) / voice.calls) : '—')), t('ins.voice_sub'));

    const gross = st.gross || [];
    const doom = card(t('ins.doom_title'), gross.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, t('col.id')), h('th', null, t('col.operator')), h('th', null, t('ins.gross_type')), h('th', null, t('card.evidence')))),
      h('tbody', null, gross.map((g) => h('tr', null, h('td', null, h('a', { href: cardHash(g.conversation_id, g.line), class: 'mono' }, g.conversation_id)), h('td', null, g.operator_name || '—'), h('td', null, (g.types || []).map((ty) => chip(grossTypeLabel(ty), 'flag'))), h('td', { class: 'small' }, g.line ? h('a', { href: cardHash(g.conversation_id, g.line), class: 'ev-btn', style: 'margin-right:.4rem' }, `#${g.line}`) : null, g.quote ? h('span', { class: 'q' }, `«${g.quote}»`) : null))))))
      : emptyState(t('ins.doom_empty'), ''), t('ins.doom_sub', { n: gross.length }), 'doom');

    const ops = (st.operators || []).slice().sort((a, b) => (a.avg_total ?? 101) - (b.avg_total ?? 101));
    const coach = card(t('ins.coach_title'), ops.length ? h('div', { class: 'grid-3' }, ops.map((o) => h('div', { class: 'coach' },
      h('div', { class: 'name' }, h('span', null, o.operator_name || '—'), h('span', null, o.avg_total !== null && o.avg_total !== undefined ? num(o.avg_total) : '—')),
      h('div', { class: 'muted small' }, `${pl(o.conversations, 'unit.dialogs')}${o.excluded_open_appeals ? ` · ${t('ins.excluded', { n: o.excluded_open_appeals })}` : ''}`),
      (o.top_missed || []).slice(0, 2).map((m) => h('div', { class: 'miss' }, h('b', null, m.title), ` — ${pl(m.count, 'unit.times')}`,
        m.example ? h('div', { class: 'small' }, h('a', { href: cardHash(m.example.conversation_id, m.example.line), class: 'mono' }, `${m.example.conversation_id} #${m.example.line}`), m.example.quote ? h('span', { class: 'muted' }, ` «${truncate(m.example.quote, 90)}»`) : null) : null)),
      !(o.top_missed || []).length ? h('div', { class: 'small muted' }, t('ins.no_misses')) : null))) : emptyState(t('ins.no_operators'), ''), t('ins.coach_sub'));

    const d = st.disputes || {};
    const disputes = card(t('ins.disputes_title'), h('div', { class: 'metrics' }, metric(t('ap.m_total'), String(d.total ?? 0)), metric(t('ap.m_open'), String(d.open ?? 0)), metric(t('ap.m_changed'), String(d.changed ?? 0)), metric(t('ap.m_upheld'), d.upheld_share === null || d.upheld_share === undefined ? '—' : pct(d.upheld_share))), t('ins.disputes_sub'));

    replace(box, h('div', { class: 'stack' }, kpis, h('div', { class: 'grid-2' }, dist, seg), fail, h('div', { class: 'grid-2' }, frCard, voiceCard), doom, coach, disputes,
      h('p', { class: 'small muted' }, t('ins.usage_note'))));
  }

  load();
  return { destroy() {} };
}

function bucketize(values, edges, label) {
  const b = [];
  let prev = 0;
  for (const e of edges) { b.push({ bucket: `${label(prev)}–${label(e)}`, count: 0, lo: prev, hi: e, over: prev >= 180 }); prev = e; }
  b.push({ bucket: `> ${label(prev)}`, count: 0, lo: prev, hi: Infinity, over: true });
  for (const v of values) { const k = b.find((x) => v >= x.lo && v < x.hi); if (k) k.count++; }
  return b;
}
function truncate(str, n) { str = String(str ?? ''); return str.length > n ? str.slice(0, n - 1) + '…' : str; }
