// Screen 2 — Карточка диалога: transcript (left) + evaluation result (right), deep links, audio, appeals.
import { h, clear, replace } from '../dom.js';
import { t, pl } from '../i18n.js';
import { api } from '../api.js';
import { state, subscribe, isOperator, setRole, healthStale } from '../state.js';
import { chip, langTag, toast, openModal, skeleton, emptyState, errorBox, confidence, field, select } from '../components.js';
import { cardHash, replaceHash } from '../router.js';
import { channelLabel, speakerLabel, num, secs, date, provenance, reviewReasons, statusLabel, grossTypeLabel, outcomeLabel, answerKind, answerText, answerLabel } from '../format.js';

export function renderCard(main, params) {
  let convId = params.id, pendingLine = params.line || null;
  const group = params.group || null;
  let data = null, version = null, audioEl = null, unsub = null;
  const page = h('div');
  main.append(page);

  async function load() {
    replace(page, h('div', { class: 'cardpage' }, h('div', { class: 'card' }, skeleton(14)), h('div', { class: 'card' }, skeleton(10))));
    try {
      data = await api.conversation(convId, version, group);
      draw();
      if (pendingLine) { focusLine(pendingLine, true); pendingLine = null; }
    } catch (e) {
      replace(page, h('div', { class: 'card' }, h('div', { class: 'card-b' }, errorBox(e, load),
        e.status === 404 ? h('p', { class: 'mt' }, h('a', { href: '#/' }, t('card.back'))) : null)));
    }
  }

  function draw() {
    const { conversation: conv, latest, evaluations = [], appeals = [] } = data;
    const evidenceLines = new Map(); // line -> [codes]
    if (latest) for (const r of latest.results || []) for (const ev of r.evidence || []) {
      if (!evidenceLines.has(ev.line)) evidenceLines.set(ev.line, []);
      evidenceLines.get(ev.line).push(r.code || r.criterion_id);
    }
    const headEl = h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'row' }, h('a', { href: '#/', class: 'small' }, '← ' + t('nav.dialogs')), h('span', { class: 'muted small' }, conv.group_id || '')),
        h('h1', { class: 'row' }, h('span', { class: 'mono' }, conv.conversation_id), langTag(conv.language), chip(channelLabel(conv.channel), 'neutral'),
          latest && latest.status === 'under_appeal' ? chip(t('status.under_appeal'), 'warn') : null,
          latest && latest.status === 'reviewed' ? chip(t('status.reviewed'), 'info') : null)),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: copyLink }, t('card.copy_link')),
        h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, t('card.print'))));
    replace(page, headEl, h('div', { class: 'cardpage' }, transcriptPanel(conv, latest, evidenceLines), resultPanel(conv, latest, evaluations, appeals)));
  }

  // ---------- transcript ----------
  function transcriptPanel(conv, latest, evidenceLines) {
    const facts = conv.facts || {};
    const segs = facts.segments || [];
    const segAt = (n) => segs.find((g) => n > g.from && (g.to === null || n < g.to));
    const firstOpLine = facts.first_operator ? facts.first_operator.line : null;
    const lines = h('div', { class: 't-lines', role: 'list' });
    const openSegs = new Set();
    for (const l of conv.lines || []) {
      for (const g of segs) {
        if (g.from === l.n) lines.append(h('div', { class: `seg-label ${g.kind}` }, `${t(`seg.${g.kind}`)}${g.seconds != null ? ` · ${secs(g.seconds)}` : ''}`));
      }
      if (firstOpLine && l.n === firstOpLine) {
        lines.append(h('div', { class: 'marker' }, t('card.first_reaction', { s: facts.first_reaction_seconds != null ? secs(facts.first_reaction_seconds) : '—' }),
          facts.first_reaction_seconds != null && facts.first_reaction_seconds > 180 ? chip(t('card.over_3min'), 'warn') : null));
      }
      const seg = segAt(l.n);
      const ev = evidenceLines.get(l.n);
      const ts = l.offset_label || l.timestamp || '';
      const tsEl = conv.channel === 'voice call' && conv.audio_url
        ? h('button', { type: 'button', title: t('card.seek'), onclick: () => seekAudio(l.offset_seconds) }, ts)
        : ts;
      lines.append(h('div', { class: `line ${l.speaker} ${seg ? 'in-' + seg.kind : ''} ${ev ? 'evidence' : ''}`, id: `line-${l.n}`, role: 'listitem', dataset: { line: l.n } },
        h('span', { class: 'n' }, h('a', { href: cardHash(conv.conversation_id, l.n, group), title: t('card.deep_link'), onclick: (e) => { e.preventDefault(); focusLine(l.n, true); } }, `#${l.n}`)),
        h('span', { class: 'ts' }, tsEl),
        h('span', { class: 'txt' }, h('span', { class: 'who' }, speakerLabel(l.speaker)), l.text,
          ev ? h('span', { class: 'tags' }, ev.map((c) => h('span', { class: 'tag ev', title: t('card.evidence_for', { c }) }, c))) : null)));
    }
    const counts = facts.counts || {};
    const meta = h('div', { class: 't-meta' },
      h('span', null, pl((conv.lines || []).length, 'unit.lines')),
      h('span', null, `${t('speaker.operator')}: ${counts.operator_lines ?? '—'}`),
      h('span', null, `${t('speaker.client')}: ${counts.client_lines ?? '—'}`),
      h('span', null, `${t('card.duration')}: ${secs(facts.duration_seconds)}`),
      facts.client_language && facts.client_language !== conv.language ? h('span', null, `${t('card.client_lang')}: ${facts.client_language}`) : null,
      facts.operator_participated === false ? chip(t('card.no_operator'), 'warn') : null);
    const panel = h('div', { class: 'card transcript' }, h('div', { class: 'card-h' }, h('h2', null, t('card.transcript')), legendEl()), meta);
    if (conv.channel === 'voice call' && conv.audio_url) panel.append(audioPanel(conv));
    panel.append(lines);
    return panel;
  }

  function legendEl() {
    return h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: 'var(--cqa-operator)' } }), t('speaker.operator')),
      h('span', null, h('i', { style: { background: 'var(--cqa-client)' } }), t('speaker.client')),
      h('span', null, h('i', { style: { background: 'var(--cqa-bot)' } }), `${t('speaker.bot')}/${t('speaker.system')}`),
      h('span', null, h('i', { style: { background: '#ffe680' } }), t('card.evidence')));
  }

  function audioPanel(conv) {
    // preload="none": the recording is streamed through the server proxy only when the user plays or seeks.
    audioEl = h('audio', { controls: true, preload: 'none', src: api.audioUrl(conv.conversation_id, group), 'aria-label': t('card.open_recording') });
    const fallback = h('a', { href: conv.audio_url, target: '_blank', rel: 'noopener', class: 'btn sm' }, t('card.open_recording'));
    const note = h('span', { class: 'muted small' }, t('card.audio_hint'));
    audioEl.addEventListener('error', () => { note.textContent = t('card.audio_unavailable'); note.classList.add('dirty'); });
    return h('div', { class: 'audio' }, audioEl, fallback, note);
  }

  function seekAudio(offset) {
    if (!audioEl || offset === null || offset === undefined) return;
    const target = Math.max(0, offset - 1);
    const go = () => { try { audioEl.currentTime = target; audioEl.play().catch(() => {}); } catch { /* not seekable */ } };
    if (audioEl.readyState >= 1) go();
    else { audioEl.addEventListener('loadedmetadata', go, { once: true }); try { audioEl.load(); } catch { /* ignore */ } }
  }

  function focusLine(n, updateUrl) {
    const el = page.querySelector(`#line-${n}`);
    if (!el) { toast(t('card.line_missing', { n }), 'err'); return; }
    for (const x of page.querySelectorAll('.line.hl')) x.classList.remove('hl');
    el.classList.add('hl');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (updateUrl) replaceHash(cardHash(convId, n, group));
    if (data && data.conversation.channel === 'voice call') {
      const line = (data.conversation.lines || []).find((l) => l.n === n);
      if (line) seekAudio(line.offset_seconds);
    }
  }

  // ---------- result ----------
  function resultPanel(conv, E, evaluations, appeals) {
    const panel = h('div', { class: 'card result' });
    const verSel = evaluations.length > 1 ? select(evaluations.map((e) => ({ value: e.checklist_version, label: `v${e.checklist_version} · ${e.total_str ?? t('card.not_calculated')} · ${date(e.created_at)}` })), E ? E.checklist_version : '', (v) => { version = v; load(); }, { 'aria-label': t('card.version') }) : null;
    panel.append(h('div', { class: 'card-h' }, h('h2', null, t('card.result')), h('div', { class: 'row' }, verSel, E ? h('span', { class: 'muted small' }, `${t('card.checklist')} v${E.checklist_version}`) : null)));
    if (!E) {
      panel.append(emptyState(t('card.no_eval_title'), t('card.no_eval_hint'), h('a', { class: 'btn primary', href: '#/' }, t('nav.dialogs'))));
      return panel;
    }
    const openAppeals = appeals.filter((a) => a.status === 'open');
    // total
    panel.append(h('div', { class: 'total-box' },
      E.calculated ? h('div', { class: 'total-num', aria: { label: t('col.total') } }, E.total_str, h('small', null, '/ 100')) : h('div', { class: 'total-num na' }, t('card.not_calculated')),
      h('div', { class: 'total-side' },
        E.original_total !== null && E.original_total !== undefined && E.original_total !== E.total ? h('span', null, t('card.original_total'), ': ', h('b', null, num(E.original_total))) : null,
        h('span', null, t('card.status'), ': ', chip(statusLabel(E.status), E.status === 'under_appeal' ? 'warn' : E.status === 'reviewed' ? 'info' : 'neutral')),
        openAppeals.length ? h('a', { href: `#/appeals/${encodeURIComponent(openAppeals[0].id)}` }, t('card.open_appeals', { n: openAppeals.length })) : null,
        E.needs_review ? h('span', { class: 'review-why' }, chip(t('card.needs_review'), 'warn'), h('span', { class: 'small' }, reviewReasons(E).join(' · ') || t('card.min_conf', { v: Math.round((E.min_confidence || 0) * 100) }))) : null,
        h('span', { class: 'small' }, t('card.min_conf', { v: Math.round((E.min_confidence || 0) * 100) })),
        h('span', { class: 'small' }, `${t('card.evaluated_at')} ${date(E.created_at)}`))));
    // gross banner
    if (E.gross && E.gross.flag) {
      panel.append(h('div', { class: 'gross-banner', role: 'alert' }, h('span', { class: 'ic', aria: { hidden: 'true' } }, '⚑'),
        h('div', null, h('strong', null, t('card.gross_title')), ' — ', (E.gross.types || []).map(grossTypeLabel).join(', '),
          h('div', { class: 'small' }, t('card.gross_note')),
          (E.gross.evidence || []).length ? h('div', { class: 'ev-list mt', style: { marginTop: '.4rem' } }, E.gross.evidence.map((ev) => evidenceEl(ev))) : null)));
    }
    // sections
    const secs_ = E.section_totals || {};
    if (Object.keys(secs_).length) {
      panel.append(h('div', { class: 'sections' }, Object.entries(secs_).map(([id, s_]) => h('div', { class: 'sec' },
        h('div', { class: 't' }, `${id}. ${s_.title || ''}`),
        h('div', { class: 'v' }, s_.calculated ? s_.total_str : h('span', { class: 'muted small' }, s_.weight ? t('card.not_calculated') : t('card.flag_only'))),
        h('div', { class: 'w' }, s_.weight ? t('card.sec_pts', { p: num(s_.points), w: num(s_.weight, 0) }) : '')))));
    }
    // why the score is lower: every scored criterion that lost points, largest loss first
    const losses = (E.results || [])
      .filter((r) => r.applicable !== false && r.scored !== false && r.answer_type !== 'flag' && Number(r.weight) > 0 && r.effective_weight != null)
      .map((r) => ({ r, lost: Number(r.effective_weight) * (1 - Number(r.points || 0) / Number(r.weight)) }))
      .filter((x) => x.lost > 0.004)
      .sort((a, b) => b.lost - a.lost);
    if (losses.length) {
      panel.append(h('div', { class: 'losses' },
        h('div', { class: 'lbl' }, t('card.why_lower')),
        losses.map(({ r, lost }) => {
          const ev = (r.evidence || [])[0];
          return h('div', { class: 'loss' },
            h('b', { class: 'minus' }, `−${num(lost)}`),
            h('a', { href: `#crit-${r.criterion_id}`, onclick: (e) => { e.preventDefault(); const el = document.getElementById(`crit-${r.criterion_id}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, `${r.code} ${r.title}`),
            chip(answerText(r), answerKind(r)),
            ev ? h('button', { class: 'ev-btn', type: 'button', title: t('card.goto_line'), onclick: () => focusLine(ev.line, true) }, `#${ev.line}`) : null);
        })));
    }
    // criteria
    for (const r of E.results || []) panel.append(criterionEl(r, E, appeals));
    // footer
    const tr = E.trace || {};
    const prov = provenance(E);
    panel.append(h('div', { class: 'r-foot' },
      h('span', null, `${t('card.model')}: `, h('b', null, E.model || tr.model || '—')),
      h('span', null, `${t('card.prompt')}: `, h('b', { class: 'mono' }, E.prompt_version || tr.prompt_version || '—')),
      h('span', null, h('b', null, prov.price)),
      prov.time ? h('span', { class: prov.fromCache ? 'cache-hit' : '', title: prov.fromCache ? t('card.from_cache_hint') : t('cl.latency') }, prov.time) : null,
      tr.cache ? h('span', null, t('card.cache', { h: (tr.cache.hits || []).length, m: (tr.cache.misses || []).length })) : null,
      E.history && E.history.length ? h('button', { class: 'btn link sm', type: 'button', onclick: () => showHistory(E) }, t('card.history')) : null));
    return panel;
  }

  function evidenceEl(ev) {
    return h('div', { class: 'ev' },
      h('button', { class: 'ev-btn', type: 'button', onclick: () => focusLine(ev.line, true), title: t('card.goto_line') }, `#${ev.line}${ev.offset_label ? ' · ' + ev.offset_label : ''}`),
      h('span', null, ev.speaker ? h('span', { class: 'lbl' }, speakerLabel(ev.speaker)) : null, ev.quote ? h('span', { class: 'q' }, ev.quote) : null, ev.why ? h('span', { class: 'why' }, ' — ', ev.why) : null));
  }

  function criterionEl(r, E, appeals) {
    const kind = answerKind(r);
    const myAppeals = appeals.filter((a) => a.criterion_id === r.criterion_id);
    const openAp = myAppeals.find((a) => a.status === 'open');
    const flag = r.answer_type === 'flag' || r.scored === false;
    const isNa = r.applicable === false;
    const pts = flag ? h('span', { class: 'c-pts' }, t('card.flag_only')) :
      isNa ? h('span', { class: 'c-pts' }, t('card.na_excluded_short', { w: num(r.weight, 0) })) :
        h('span', { class: 'c-pts' }, h('span', null, h('b', null, num(r.points)), ` / ${num(r.weight, 0)}`), h('span', { class: 'muted' }, '→'), h('span', { title: t('card.eff_weight_hint') }, `${t('card.eff_weight')} `, h('b', null, num(r.effective_weight))));
    const body = h('div', { class: 'c-body' });
    // N/A is a first-class outcome: the reason and the weight redistribution are shown as one explicit callout.
    if (isNa) body.append(h('div', { class: 'callout na', role: 'note' },
      h('div', { class: 'lbl' }, t('card.na_reason')),
      h('div', { class: 'callout-main' }, r.na_reason || r.explanation || '—'),
      h('div', { class: 'small muted' }, t('card.na_redistributed', { w: num(r.weight, 0) }))));
    if (r.explanation && !(isNa && !r.na_reason)) body.append(h('div', null, h('span', { class: 'lbl' }, t('card.why')), r.explanation));
    if (r.evidence && r.evidence.length) body.append(h('div', null, h('span', { class: 'lbl' }, t('card.evidence')), h('div', { class: 'ev-list' }, r.evidence.map(evidenceEl))));
    // Checked range: for a missed action it is the proof of absence, so it gets its own callout; otherwise a quiet line.
    if (r.checked_range && r.checked_range.length === 2 && !isNa) {
      const [a, b] = r.checked_range;
      const missed = kind === 'no' || (kind === 'scale' && r.points !== null && r.points !== undefined && Number(r.points) < Number(r.weight));
      const rangeBtn = h('button', { class: 'ev-btn', type: 'button', title: t('card.goto_line'), onclick: () => focusLine(a, true) }, a === b ? `#${a}` : `#${a} — #${b}`);
      body.append(missed
        ? h('div', { class: 'callout range', role: 'note' }, h('div', { class: 'lbl' }, t('card.checked_range')), h('div', { class: 'callout-main row' }, rangeBtn, h('span', null, t('card.checked_range_missed', { n: b - a + 1 }))))
        : h('div', null, h('span', { class: 'lbl' }, t('card.checked_range')), rangeBtn, ' ', h('span', { class: 'muted small' }, t('card.checked_range_ok'))));
    }
    if (r.rule_applied) body.append(h('div', null, h('span', { class: 'lbl' }, t('card.rule')), h('span', { class: 'small' }, r.rule_applied)));
    if (r.second_opinion && r.second_opinion.label) {
      const so = r.second_opinion;
      body.append(h('div', { class: 'second-line small' }, h('span', { class: 'lbl' }, t('card.second_opinion')), chip(so.label, 'neutral'),
        so.model ? h('span', { class: 'muted' }, ` · ${so.model}`) : null, so.explanation ? h('span', { class: 'muted' }, ` — ${so.explanation}`) : null));
    }
    body.append(h('div', { class: 'row' }, confidence(r.confidence), r.source === 'rule' ? chip(t('card.source_rule'), 'info') : null, openAp ? chip(t('status.under_appeal'), 'warn') : null));
    // review chain
    if (r.review || r.ai_original) {
      const orig = r.ai_original || {};
      body.append(h('div', { class: 'history' },
        h('div', null, h('span', { class: 'lbl' }, t('card.chain')),
          h('span', null, t('card.orig'), ': ', chip(answerText(orig, r), answerKind({ ...orig, answer_type: r.answer_type, scored: r.scored })), orig.points !== undefined && orig.points !== null ? ` (${num(orig.points)})` : ''),
          h('span', { class: 'arrow' }, '→'),
          r.review ? h('span', null, t('card.decision'), ': ', outcomeLabel(r.review.outcome)) : null,
          h('span', { class: 'arrow' }, '→'),
          h('span', null, t('card.final'), ': ', chip(answerText(r), kind), r.points !== undefined && r.points !== null ? ` (${num(r.points)})` : '')),
        r.review && r.review.reviewer_note ? h('div', { class: 'muted' }, `${t('card.reviewer_note')}: ${r.review.reviewer_note}`, r.review.decided_at ? ` · ${date(r.review.decided_at)}` : '') : null,
        r.review && r.review.appeal_id ? h('a', { href: `#/appeals/${encodeURIComponent(r.review.appeal_id)}`, class: 'small' }, t('card.open_appeal')) : null));
    }
    const actions = h('div', { class: 'row' });
    if (!openAp && E.mode !== 'simulation') {
      if (isOperator()) actions.append(h('button', { class: 'btn sm', type: 'button', onclick: () => openAppealModal(r, E) }, t('card.dispute')));
      // Reviewer sees the same entry point; one click switches the role and opens the form (role is a view switch, not auth).
      else actions.append(h('button', { class: 'btn sm ghost', type: 'button', title: t('card.dispute_as_operator_hint'), onclick: () => { setRole('operator'); openAppealModal(r, E); } }, t('card.dispute_as_operator')));
    }
    if (openAp) actions.append(h('a', { class: 'btn sm', href: `#/appeals/${encodeURIComponent(openAp.id)}` }, t('card.to_appeal')));
    return h('article', { class: 'crit', id: `crit-${r.criterion_id}`, aria: { label: `${r.code} ${r.title}` } },
      h('div', { class: 'c-h' },
        h('div', { class: 'c-title' }, h('span', { class: 'code' }, r.code), r.title, r.section ? h('span', { class: 'muted small' }, ` · ${t('card.section')} ${r.section}`) : null),
        h('div', { class: 'row' }, chip(answerText(r), kind, 'lg'), flag && r.flag_types && r.flag_types.length ? h('span', { class: 'small' }, r.flag_types.map(grossTypeLabel).join(', ')) : null)),
      h('div', { class: 'row between', style: { marginTop: '.25rem' } }, pts, actions),
      body);
  }

  function showHistory(E) {
    const rows = (E.history || []).slice().reverse().map((x) => h('tr', null,
      h('td', { class: 'nowrap' }, date(x.at)), h('td', null, t(`hist.${x.action}`) || x.action), h('td', null, t(`by.${x.by}`) || x.by),
      h('td', null, x.criterion_id || '—'), h('td', null, x.from !== undefined ? `${fmtVal(x.from)} → ${fmtVal(x.to)}` : '—'),
      h('td', null, x.total_before !== undefined && x.total_before !== null ? `${num(x.total_before)} → ${num(x.total_after)}` : '—'), h('td', null, x.note || '')));
    openModal({ title: t('card.history'), wide: true, body: h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, t('hist.at')), h('th', null, t('hist.action')), h('th', null, t('hist.by')), h('th', null, t('hist.criterion')), h('th', null, t('hist.value')), h('th', null, t('col.total')), h('th', null, t('hist.note')))),
      h('tbody', null, rows))) });
  }

  function fmtVal(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return (v.answer_label && answerLabel(v.answer_label)) || (v.applicable === false ? 'N/A' : v.scale_value !== undefined && v.scale_value !== null ? String(v.scale_value) : v.answer === 'yes' ? t('answer.yes') : v.answer === 'no' ? t('answer.no') : JSON.stringify(v));
    return String(v);
  }

  function openAppealModal(r, E) {
    const ta = h('textarea', { placeholder: t('appeal.comment_ph'), rows: 5, required: true });
    const err = h('div');
    const okBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      if (ta.value.trim().length < 5) { replace(err, errorBox(new Error(t('appeal.comment_required')))); return; }
      okBtn.disabled = true;
      try {
        await api.createAppeal({ evaluation_id: E.id, criterion_id: r.criterion_id, comment: ta.value.trim() });
        toast(t('appeal.created'), 'ok'); m.close(); healthStale(); load();
      } catch (e) { replace(err, errorBox(e)); okBtn.disabled = false; }
    } }, t('appeal.submit'));
    const m = openModal({
      title: `${t('card.dispute')}: ${r.code} ${r.title}`,
      body: h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('span', null, t('appeal.current'), ': '), chip(answerText(r), answerKind(r)), r.points !== null && r.points !== undefined ? h('span', { class: 'muted' }, `${num(r.points)} / ${num(r.weight, 0)}`) : null),
        r.explanation ? h('div', { class: 'quote' }, r.explanation) : null,
        field(t('appeal.comment'), ta), h('p', { class: 'muted small' }, t('appeal.hint')), err),
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('btn.cancel')), okBtn],
    });
  }

  function copyLink() {
    const url = location.href.split('#')[0] + (location.hash || cardHash(convId, null, group));
    const done = () => toast(t('card.link_copied'), 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => prompt(t('card.copy_manual'), url));
    else prompt(t('card.copy_manual'), url);
  }

  unsub = subscribe((what) => { if (what === 'role' && data) draw(); });
  load();

  return {
    update(p) {
      if (p.id !== convId || (p.group || null) !== group) return false;
      if (p.line) { if (data) focusLine(p.line, false); else pendingLine = p.line; }
      return true;
    },
    destroy() { if (unsub) unsub(); if (audioEl) { try { audioEl.pause(); } catch { /* ignore */ } } },
  };
}
