// Screen 4 — Апелляции: queue, reviewer detail, second opinion, decision with live recalculation preview.
import { h, clear, replace } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { state, subscribe, isReviewer, providerAvailable, providerReason } from '../state.js';
import { chip, toast, openModal, skeleton, emptyState, errorBox, field, select } from '../components.js';
import { cardHash } from '../router.js';
import { num, date, speakerLabel, statusLabel, outcomeLabel, answerKind, answerText, pct } from '../format.js';
import { scoreEvaluation, isScale, isFlag, naAllowed } from '../../../packages/scoring/index.js';

const OUTCOMES = ['score_changed', 'criterion_change', 'stands_explanation', 'stands_coaching'];

export function renderAppeals(main, params) {
  let list = [], filter = 'all', selectedId = params.id || null, unsub = null;
  const metrics = h('div', { class: 'metrics mb' });
  const queue = h('div', { class: 'card' });
  const detail = h('div', { class: 'card' });
  replace(main,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('ap.title')), h('p', { class: 'lead' }, t('ap.lead')))),
    metrics, h('div', { class: 'ap-layout' }, queue, detail));

  async function loadMetrics() {
    replace(metrics, skeleton(1));
    try {
      const st = await api.stats(state.group || undefined);
      const d = st.disputes || {};
      const byC = (d.by_criterion || []).slice().sort((a, b) => b.total - a.total).slice(0, 3);
      replace(metrics,
        metric(t('ap.m_total'), d.total ?? 0),
        metric(t('ap.m_open'), d.open ?? 0),
        metric(t('ap.m_changed'), d.changed ?? 0),
        metric(t('ap.m_upheld'), d.upheld_share === null || d.upheld_share === undefined ? '—' : pct(d.upheld_share), t('ap.m_upheld_hint')),
        h('div', { class: 'metric' }, h('div', { class: 'k' }, t('ap.m_by_criterion')), byC.length ? byC.map((c) => h('div', { class: 's' }, `${c.title}: ${c.total} (${t('ap.changed_short')} ${c.changed})`)) : h('div', { class: 's' }, '—')));
    } catch (e) { replace(metrics, h('div', { class: 'metric muted small' }, t('ap.metrics_unavailable'))); }
  }
  const metric = (k, v, s_) => h('div', { class: 'metric' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v)), s_ ? h('div', { class: 's' }, s_) : null);

  async function loadQueue() {
    replace(queue, h('div', { class: 'card-h' }, h('h2', null, t('ap.queue'))), skeleton(6));
    try {
      list = await api.appeals('all');
      drawQueue();
      if (!selectedId && list.length && isReviewer()) selectedId = list[0].id;
      if (selectedId) loadDetail(selectedId); else drawEmptyDetail();
    } catch (e) { replace(queue, errorBox(e, loadQueue)); }
  }

  function drawQueue() {
    const sel = select([{ value: 'all', label: t('ap.f_all') }, { value: 'open', label: t('ap.f_open') }, { value: 'resolved', label: t('ap.f_resolved') }], filter, (v) => { filter = v; drawQueue(); }, { 'aria-label': t('ap.filter') });
    const items = list.filter((a) => filter === 'all' || (filter === 'open' ? a.status === 'open' : a.status !== 'open'));
    replace(queue, h('div', { class: 'card-h' }, h('h2', null, `${t('ap.queue')} (${items.length})`), sel),
      items.length ? items.map((a) => h('div', { class: `ap-item ${a.id === selectedId ? 'sel' : ''}`, role: 'button', tabindex: 0,
        onclick: () => { selectedId = a.id; history.replaceState(null, '', `#/appeals/${encodeURIComponent(a.id)}`); drawQueue(); loadDetail(a.id); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); } } },
        h('div', { class: 'row between' }, h('span', { class: 'mono' }, a.conversation_id), chip(statusLabel(a.status === 'open' ? 'open' : a.status), a.status === 'open' ? 'warn' : a.status === 'changed' ? 'yes' : 'info')),
        h('div', null, h('b', null, a.criterion_title || a.criterion_id), ' · ', chip(a.original ? a.original.answer_label : '—', 'neutral')),
        h('div', { class: 'muted small' }, `${date(a.created_at)}${a.confidence !== undefined && a.confidence !== null ? ` · ${t('card.confidence')} ${Math.round(a.confidence * 100)}%` : ''}`)))
        : emptyState(t('ap.empty_title'), t('ap.empty_hint')));
    h('div');
  }

  function drawEmptyDetail() { replace(detail, emptyState(t('ap.pick_title'), t('ap.pick_hint'))); }

  async function loadDetail(id) {
    replace(detail, skeleton(10));
    try {
      const d = await api.appeal(id);
      drawDetail(d);
    } catch (e) { replace(detail, errorBox(e, () => loadDetail(id))); }
  }

  function drawDetail(d) {
    const { appeal: a, evaluation: E, criterion: C, result: R, lines = [] } = d;
    // The disputed value is the original AI result (kept on the appeal); R may already carry the reviewer's decision.
    const O = { ...(R && a.status === 'open' ? R : {}), ...(a.original || {}) };
    if (!O.explanation && R && a.status === 'open') O.explanation = R.explanation;
    const evLines = new Set((R && R.evidence || []).map((x) => x.line));
    const frag = h('div', { class: 'frag' }, lines.map((l) => h('div', { class: `line ${l.speaker} ${evLines.has(l.n) ? 'evidence' : ''}` },
      h('span', { class: 'n' }, h('a', { href: cardHash(a.conversation_id, l.n) }, `#${l.n}`)), h('span', { class: 'ts' }, l.offset_label || l.timestamp || ''), h('span', { class: 'txt' }, h('span', { class: 'who' }, speakerLabel(l.speaker)), l.text))));
    const second = h('div');
    if (a.second_opinion) second.append(secondOpinionEl(a.second_opinion));
    const actions = h('div', { class: 'row' });
    if (a.status === 'open' && isReviewer()) {
      const okAi = providerAvailable();
      actions.append(h('button', { class: 'btn', type: 'button', disabled: !okAi, title: okAi ? '' : t('health.eval_disabled', { reason: providerReason() || '—' }), onclick: async (e) => {
        e.target.disabled = true; replace(second, skeleton(3));
        try { const so = await api.secondOpinion(a.id); replace(second, secondOpinionEl(so)); } catch (err) { replace(second, errorBox(err)); e.target.disabled = false; }
      } }, t('ap.second_opinion')));
      actions.append(h('button', { class: 'btn primary', type: 'button', onclick: () => openDecision(d) }, t('ap.decide')));
    } else if (a.status === 'open') {
      actions.append(h('span', { class: 'note' }, t('ap.reviewer_only')));
    }
    replace(detail,
      h('div', { class: 'card-h' }, h('div', null, h('h2', null, `${t('ap.appeal')} · ${C ? C.code + ' ' + C.title : a.criterion_title}`), h('div', { class: 'muted small' }, h('a', { href: cardHash(a.conversation_id), class: 'mono' }, a.conversation_id), ` · ${t('card.checklist')} v${E ? E.checklist_version : '—'} · ${date(a.created_at)}`)), chip(statusLabel(a.status), a.status === 'open' ? 'warn' : a.status === 'changed' ? 'yes' : 'info')),
      h('div', { class: 'card-b stack' },
        h('div', { class: 'grid-2' },
          h('div', { class: 'stack' }, h('div', { class: 'lbl' }, t('ap.disputed')),
            h('div', { class: 'row' }, chip(O.answer_label || answerText(R, C), answerKind({ ...O, answer_type: C && C.answer_type, scored: C && C.scored }), 'lg'), O.points !== null && O.points !== undefined ? h('span', { class: 'muted' }, `${num(O.points)} / ${num(C ? C.weight : R && R.weight, 0)}`) : null, O.confidence !== undefined && O.confidence !== null ? h('span', { class: 'muted small' }, `${t('card.confidence')} ${Math.round((O.confidence || 0) * 100)}%`) : null),
            O.explanation ? h('div', { class: 'quote' }, O.explanation) : null,
            O.rule_applied ? h('div', { class: 'small muted' }, `${t('card.rule')}: ${O.rule_applied}`) : null,
            h('div', null, h('span', { class: 'lbl' }, t('col.total')), ' ', h('b', null, a.total_before !== null && a.total_before !== undefined ? num(a.total_before) : (E && E.total_str) || '—'))),
          h('div', { class: 'stack' }, h('div', { class: 'lbl' }, t('ap.operator_comment')), h('div', { class: 'quote', style: { borderLeftColor: 'var(--cqa-operator)' } }, a.comment || '—'))),
        R && R.evidence && R.evidence.length ? h('div', null, h('div', { class: 'lbl' }, t('card.evidence')), h('div', { class: 'ev-list' }, R.evidence.map((ev) => h('div', { class: 'ev' }, h('a', { class: 'ev-btn', href: cardHash(a.conversation_id, ev.line) }, `#${ev.line}`), h('span', null, ev.quote ? h('span', { class: 'q' }, ev.quote) : null, ev.why ? h('span', { class: 'why' }, ' — ', ev.why) : null))))) : null,
        lines.length ? h('div', null, h('div', { class: 'lbl' }, t('ap.fragment')), h('div', { class: 'card', style: { boxShadow: 'none' } }, frag), h('a', { href: cardHash(a.conversation_id, R && R.evidence && R.evidence[0] ? R.evidence[0].line : undefined), class: 'small' }, t('ap.open_card'))) : null,
        second,
        a.decision ? decisionEl(a) : null,
        actions));
  }

  function secondOpinionEl(so) {
    const sug = so.suggestion || {};
    return h('div', { class: 'second' }, h('div', { class: 'row between' }, h('b', null, t('ap.second_opinion')), h('span', { class: 'muted small' }, t('ap.advisory'))),
      h('div', { class: 'row', style: { margin: '.3rem 0' } }, h('span', null, t('ap.suggests'), ': '), chip(sugLabel(sug), sug.applicable === false ? 'na' : sug.answer === 'yes' ? 'yes' : sug.answer === 'no' ? 'no' : 'scale')),
      h('div', null, so.rationale || ''), h('div', { class: 'muted small' }, `${so.model || ''}${so.cost_usd ? ` · $${Number(so.cost_usd).toFixed(4)}` : ''}`));
  }
  const sugLabel = (s_) => s_.applicable === false ? 'N/A' : s_.scale_value !== undefined && s_.scale_value !== null ? String(s_.scale_value) : s_.answer === 'yes' ? t('answer.yes') : s_.answer === 'no' ? t('answer.no') : '—';

  function decisionEl(a) {
    const dcs = a.decision;
    return h('div', { class: 'history' },
      h('div', null, h('span', { class: 'lbl' }, t('ap.decision')), h('b', null, dcs.decision === 'confirm' ? t('ap.confirmed') : t('ap.changed')), ' · ', outcomeLabel(dcs.outcome), dcs.decided_at ? h('span', { class: 'muted' }, ` · ${date(dcs.decided_at)}`) : null),
      h('div', { class: 'row' }, t('card.orig'), ': ', chip(a.original ? a.original.answer_label : '—', 'neutral'), h('span', { class: 'arrow' }, '→'), t('card.final'), ': ', chip(a.final ? a.final.answer_label : (a.original ? a.original.answer_label : '—'), 'info')),
      a.total_before !== null && a.total_before !== undefined ? h('div', null, `${t('col.total')}: `, h('b', null, num(a.total_before)), h('span', { class: 'arrow' }, '→'), h('b', null, num(a.total_after ?? a.total_before))) : null,
      dcs.reviewer_note ? h('div', { class: 'muted' }, `${t('card.reviewer_note')}: ${dcs.reviewer_note}`) : null);
  }

  // ---------- decision modal with live preview ----------
  async function openDecision(d) {
    const { appeal: a, evaluation: E, criterion: C0, result: R } = d;
    const body = h('div', null, skeleton(5));
    const m = openModal({ title: `${t('ap.decide')}: ${a.criterion_title || a.criterion_id}`, wide: true, body });
    let checklist;
    try { checklist = await api.checklist(E.checklist_version); } catch (e) { replace(body, errorBox(e)); return; }
    const C = checklist.criteria.find((c) => c.id === a.criterion_id) || C0;
    const answersOf = () => { const o = {}; for (const r of E.results || []) o[r.criterion_id] = { applicable: r.applicable !== false, answer: r.answer || undefined, scale_value: r.scale_value ?? undefined, flag_types: r.flag_types || [] }; return o; };
    const before = (() => { try { return scoreEvaluation(checklist, answersOf()); } catch { return null; } })();

    const dec = { decision: 'confirm', outcome: 'stands_explanation', new_value: { applicable: R ? R.applicable !== false : true, answer: R ? R.answer : undefined, scale_value: R ? R.scale_value : undefined, flag_types: R ? R.flag_types || [] : [] }, reviewer_note: '' };
    const radio = (name, value, label, checked, onchange) => { const i = h('input', { type: 'radio', name, value, onchange }); i.checked = checked; return h('label', null, i, h('span', null, label)); };
    const valueBox = h('div', { class: 'row' });
    const previewBox = h('div', { class: 'preview' });
    const outBox = h('div', { class: 'outcome' });
    const note = h('textarea', { rows: 3, placeholder: t('ap.reason_ph'), oninput: (e) => { dec.reviewer_note = e.target.value; } });
    const err = h('div');

    function drawValue() {
      clear(valueBox);
      if (dec.decision !== 'change') { valueBox.append(h('span', { class: 'muted' }, t('ap.keep_value'))); return; }
      const nv = dec.new_value;
      if (isFlag(C)) {
        const types = C.flag_types || ['insult', 'bypass', 'disclosure'];
        valueBox.append(types.map((ty) => { const cb = h('input', { type: 'checkbox', onchange: (e) => { nv.flag_types = e.target.checked ? [...new Set([...(nv.flag_types || []), ty])] : (nv.flag_types || []).filter((x) => x !== ty); preview(); } }); cb.checked = (nv.flag_types || []).includes(ty); return h('label', { class: 'chk' }, cb, t(`gross.${ty}`)); }));
        nv.applicable = true; nv.answer = (nv.flag_types || []).length ? 'yes' : 'no';
        return;
      }
      const opts = [];
      if (isScale(C)) for (const st of C.scale || []) opts.push({ value: `s:${st.value}`, label: `${st.value} — ${st.label || ''}` });
      else { opts.push({ value: 'yes', label: t('answer.yes') }); opts.push({ value: 'no', label: t('answer.no') }); }
      if (naAllowed(C)) opts.push({ value: 'na', label: `N/A${C.na_condition ? ' — ' + C.na_condition : ''}` });
      const cur = nv.applicable === false ? 'na' : isScale(C) ? `s:${nv.scale_value}` : nv.answer;
      valueBox.append(h('span', null, t('ap.new_value'), ': '), select(opts, cur, (v) => {
        if (v === 'na') { nv.applicable = false; nv.answer = undefined; nv.scale_value = undefined; }
        else if (v.startsWith('s:')) { nv.applicable = true; nv.scale_value = Number(v.slice(2)); nv.answer = undefined; }
        else { nv.applicable = true; nv.answer = v; nv.scale_value = undefined; }
        preview();
      }, { 'aria-label': t('ap.new_value'), style: 'max-width:100%' }));
    }

    function preview() {
      clear(previewBox);
      const ans = answersOf();
      if (dec.decision === 'change') ans[C.id] = { applicable: dec.new_value.applicable !== false, answer: dec.new_value.answer, scale_value: dec.new_value.scale_value, flag_types: dec.new_value.flag_types || [] };
      let after = null, errs = [];
      try { after = scoreEvaluation(checklist, ans); errs = after.errors || []; } catch (e) { errs = [e.message]; }
      const b = before && before.calculated ? before.total_str : t('card.not_calculated');
      const af = after && after.calculated ? after.total_str : t('card.not_calculated');
      previewBox.append(h('div', null, h('div', { class: 'lbl' }, t('ap.preview')), h('span', { class: 'big' }, b), h('span', { class: 'arrow' }, '→'), h('span', { class: 'big', style: { color: after && before && after.total !== before.total ? 'var(--cqa-accent)' : 'inherit' } }, af)),
        after && after.per_criterion && after.per_criterion[C.id] ? h('div', { class: 'small muted' }, `${t('card.eff_weight')} ${num(after.per_criterion[C.id].effective_weight)} · ${num(after.per_criterion[C.id].points)} / ${num(C.weight, 0)}`) : null,
        after && after.gross && after.gross.flag ? chip(`${t('card.gross_title')}: ${after.gross.types.map((x) => t(`gross.${x}`)).join(', ')}`, 'flag') : null,
        errs.length ? h('div', { class: 'dirty small' }, errs.join('; ')) : null,
        h('div', { class: 'small muted' }, t('ap.preview_engine')));
    }

    function drawOutcomes() {
      clear(outBox);
      const allowed = dec.decision === 'change' ? ['score_changed', 'criterion_change'] : ['stands_explanation', 'stands_coaching', 'criterion_change'];
      if (!allowed.includes(dec.outcome)) dec.outcome = allowed[0];
      for (const o of allowed) outBox.append(radio('outcome', o, h('span', null, h('b', null, outcomeLabel(o)), h('div', { class: 'small muted' }, t(`outcome_hint.${o}`))), dec.outcome === o, () => { dec.outcome = o; }));
    }

    const decBox = h('div', { class: 'outcome' },
      radio('decision', 'confirm', h('span', null, h('b', null, t('ap.d_confirm')), h('div', { class: 'small muted' }, t('ap.d_confirm_hint'))), true, () => { dec.decision = 'confirm'; drawValue(); drawOutcomes(); preview(); }),
      radio('decision', 'change', h('span', null, h('b', null, t('ap.d_change')), h('div', { class: 'small muted' }, t('ap.d_change_hint'))), false, () => { dec.decision = 'change'; drawValue(); drawOutcomes(); preview(); }));
    drawValue(); drawOutcomes(); preview();

    const submit = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      if (dec.reviewer_note.trim().length < 5) { replace(err, errorBox(new Error(t('ap.reason_required')))); return; }
      submit.disabled = true;
      const payload = { decision: dec.decision, outcome: dec.outcome, reviewer_note: dec.reviewer_note.trim() };
      if (dec.decision === 'change') payload.new_value = { applicable: dec.new_value.applicable !== false, ...(dec.new_value.applicable === false ? {} : isScale(C) ? { scale_value: dec.new_value.scale_value } : isFlag(C) ? { answer: dec.new_value.answer, flag_types: dec.new_value.flag_types || [] } : { answer: dec.new_value.answer }) };
      try {
        const r = await api.decide(a.id, payload);
        const ap = r.appeal || {};
        toast(t('ap.decided', { b: num(ap.total_before), a: num(ap.total_after) }), 'ok');
        m.close(); selectedId = a.id; await loadQueue(); loadMetrics();
      } catch (e) { replace(err, errorBox(e)); submit.disabled = false; }
    } }, t('ap.submit'));

    replace(body, h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('span', null, t('ap.disputed'), ': '), chip(a.original ? a.original.answer_label : '—', 'neutral', 'lg'), h('span', { class: 'muted' }, '·'), h('span', { class: 'muted' }, a.comment || '')),
      h('div', { class: 'grid-2' }, h('div', { class: 'stack' }, h('div', { class: 'lbl' }, t('ap.decision')), decBox, valueBox), h('div', { class: 'stack' }, h('div', { class: 'lbl' }, t('ap.outcome')), outBox)),
      previewBox,
      field(t('ap.reason'), note), err,
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('btn.cancel')), submit)));
  }

  unsub = subscribe((what) => { if (what === 'role' && selectedId) loadDetail(selectedId); });
  loadMetrics(); loadQueue();
  return { update(p) { if (p.id && p.id !== selectedId) { selectedId = p.id; drawQueue(); loadDetail(p.id); } return true; }, destroy() { if (unsub) unsub(); } };
}
