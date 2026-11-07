// Dataset analytics computed from stored data: totals, criteria, escalation, first reaction, voice holds,
// operator coaching cards, disputes, cost. Open (disputed) evaluations are excluded from operator rankings.

function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(2)); }
function percentile(xs, p) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; }
function avg(xs) { return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null; }

export function computeStats({ data, engine, appeals, checklists, groupId = null, firstReactionThreshold = 180 }) {
  const rows = data.rows(groupId);
  const convs = rows.map((r) => ({ row: r, conv: data.prepare(r), summary: data.summary(r) }));
  const latest = convs.map((c) => ({ ...c, ev: engine.latestFor(c.row.group_id, c.row.conversation_id) })).filter((c) => c.ev);
  const totals = latest.filter((c) => c.ev.calculated).map((c) => c.ev.total);
  const buckets = ['0–20', '20–40', '40–60', '60–80', '80–100'].map((b) => ({ bucket: b, count: 0 }));
  for (const t of totals) buckets[Math.min(4, Math.floor(t / 20))].count++;

  const groupBy = (key) => {
    const m = {};
    for (const c of latest) { const k = key(c); m[k] ??= { n: 0, totals: [], gross: 0 }; m[k].n++; if (c.ev.calculated) m[k].totals.push(c.ev.total); if (c.ev.gross?.flag) m[k].gross++; }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { n: v.n, avg_total: avg(v.totals), gross: v.gross }]));
  };

  const checklist = checklists.active();
  const criteria = (checklist?.criteria || []).map((c) => {
    let applicable = 0, yes = 0, no = 0, na = 0; const shares = [];
    for (const { ev } of latest) {
      const r = ev.results.find((x) => x.criterion_id === c.id); if (!r) continue;
      if (r.applicable === false) { na++; continue; }
      applicable++;
      if (r.answer_type === 'scale' || r.answer_type === 'scale_na') { const max = Math.max(...(c.scale || []).map((s) => Number(s.value))); const share = max > 0 ? r.scale_value / max : 0; shares.push(share); if (share < 1) no++; else yes++; }
      else if (r.answer === 'yes') yes++; else if (r.answer === 'no') no++;
    }
    const isFlagC = c.answer_type === 'flag';
    return { criterion_id: c.id, code: c.code, title: c.title, answer_type: c.answer_type, applicable, yes, no, na, fail_rate: applicable ? Number(((isFlagC ? yes : no) / applicable).toFixed(3)) : null, avg_share: shares.length ? Number(avg(shares).toFixed(3)) : (applicable ? Number((yes / applicable).toFixed(3)) : null) };
  });

  const gross = latest.filter((c) => c.ev.gross?.flag).map((c) => ({ conversation_id: c.row.conversation_id, group_id: c.row.group_id, types: c.ev.gross.types, line: c.ev.gross.evidence?.[0]?.line ?? null, quote: c.ev.gross.evidence?.[0]?.quote ?? null, operator_name: c.summary.operator_name, total_str: c.ev.total_str }));

  const withBot = convs.filter((c) => c.conv.facts.counts.bot_lines > 0).length;
  const escalated = convs.filter((c) => c.conv.facts.counts.bot_lines > 0 && (c.conv.facts.escalation_lines.length > 0 || c.conv.facts.operator_participated)).length;
  const botOnly = convs.filter((c) => c.conv.facts.counts.bot_lines > 0 && !c.conv.facts.operator_participated).length;
  const frValues = convs.filter((c) => c.conv.facts.first_reaction_seconds != null).map((c) => ({ conversation_id: c.row.conversation_id, seconds: c.conv.facts.first_reaction_seconds, channel: c.conv.channel }));
  const frSec = frValues.map((v) => v.seconds);

  const voice = convs.filter((c) => c.conv.channel === 'voice call');
  const holdSegs = voice.flatMap((c) => c.conv.facts.segments.filter((s) => s.kind === 'hold'));
  const consultSegs = voice.flatMap((c) => c.conv.facts.segments.filter((s) => s.kind === 'consult'));
  const voiceStats = { calls: voice.length, with_audio: voice.filter((c) => c.conv.audio_url).length, hold_segments: holdSegs.length, hold_seconds_total: Number(holdSegs.reduce((s, x) => s + (x.seconds || 0), 0).toFixed(1)), consult_segments: consultSegs.length, consult_seconds_total: Number(consultSegs.reduce((s, x) => s + (x.seconds || 0), 0).toFixed(1)), avg_duration_seconds: avg(voice.map((c) => c.conv.facts.duration_seconds).filter((x) => x != null)) };

  // operators: leaderboard excludes evaluations under appeal
  const ops = new Map();
  for (const c of latest) {
    const name = c.summary.operator_name || '—';
    const o = ops.get(name) || { operator_name: name, conversations: 0, totals: [], excluded_open_appeals: 0, gross: 0, missed: new Map() };
    o.conversations++;
    if (c.ev.status === 'under_appeal') { o.excluded_open_appeals++; ops.set(name, o); continue; }
    if (c.ev.calculated) o.totals.push(c.ev.total);
    if (c.ev.gross?.flag) o.gross++;
    for (const r of c.ev.results) {
      if (r.applicable === false || !r.scored) continue;
      const missed = (r.answer_type === 'scale' || r.answer_type === 'scale_na') ? (r.points != null && r.weight > 0 && r.points < r.weight) : r.answer === 'no';
      if (!missed) continue;
      const m = o.missed.get(r.criterion_id) || { criterion_id: r.criterion_id, code: r.code, title: r.title, count: 0, example: null };
      m.count++;
      if (!m.example && r.evidence?.[0]) m.example = { conversation_id: c.row.conversation_id, line: r.evidence[0].line, quote: r.evidence[0].quote };
      if (!m.example) m.example = { conversation_id: c.row.conversation_id, line: null, quote: null };
      o.missed.set(r.criterion_id, m);
    }
    ops.set(name, o);
  }
  const operators = [...ops.values()].map((o) => ({ operator_name: o.operator_name, conversations: o.conversations, ranked: o.totals.length, avg_total: avg(o.totals), gross: o.gross, excluded_open_appeals: o.excluded_open_appeals, top_missed: [...o.missed.values()].sort((a, b) => b.count - a.count).slice(0, 3) }))
    .sort((a, b) => (b.avg_total ?? -1) - (a.avg_total ?? -1));

  const costs = latest.map((c) => Number(c.ev.cost_usd) || 0);
  const models = [...new Set(latest.map((c) => c.ev.model).filter(Boolean))];
  const costNote = latest.map((c) => c.ev.cost_note).find(Boolean) || null;
  const allEvals = engine.db.evaluations.find((e) => e.mode === 'stored' && (!groupId || e.group_id === groupId));

  return {
    group_id: groupId, n_conversations: convs.length, n_evaluated: latest.length,
    avg_total: avg(totals), median_total: median(totals), distribution: buckets,
    by_language: groupBy((c) => c.conv.facts.client_language || c.conv.language), by_channel: groupBy((c) => c.conv.channel),
    criteria, gross,
    escalation: { total: convs.length, with_bot: withBot, bot_only: botOnly, escalated, rate: convs.length ? Number((escalated / convs.length).toFixed(3)) : null, containment: withBot ? Number((botOnly / withBot).toFixed(3)) : null },
    first_reaction: { median: median(frSec), p90: percentile(frSec, 0.9), avg: avg(frSec), threshold_seconds: firstReactionThreshold, over_threshold: frValues.filter((v) => v.seconds > firstReactionThreshold).map((v) => v.conversation_id), values: frValues },
    voice: voiceStats, operators,
    disputes: appeals.metrics(groupId),
    cost: { evaluations: allEvals.length, total_usd: Number(allEvals.reduce((s, e) => s + (Number(e.cost_usd) || 0), 0).toFixed(4)), avg_usd: allEvals.length ? Number((allEvals.reduce((s, e) => s + (Number(e.cost_usd) || 0), 0) / allEvals.length).toFixed(5)) : null, latest_total_usd: Number(costs.reduce((a, b) => a + b, 0).toFixed(4)), models, cost_note: costNote },
    confidence: { needs_review: latest.filter((c) => c.ev.needs_review).length, under_appeal: latest.filter((c) => c.ev.status === 'under_appeal').length, reviewed: latest.filter((c) => c.ev.status === 'reviewed').length, avg_min_confidence: avg(latest.map((c) => c.ev.min_confidence)) },
    checklist_version: checklist?.version ?? null,
  };
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with UTF-8 BOM so Excel opens Cyrillic correctly. */
export function exportCsv({ data, engine, checklists, groupId = null, version = null }) {
  const checklist = version != null ? checklists.getOrThrow(version) : checklists.active();
  const rows = data.rows(groupId);
  const crit = checklist?.criteria || [];
  const header = ['conversation_id', 'group_id', 'language', 'channel', 'operator', 'checklist_version', ...crit.map((c) => `${c.code} ${c.title}`), 'total', 'gross_flag', 'gross_types', 'status', 'min_confidence', 'model', 'cost_usd'];
  const lines = [header.map(csvCell).join(';')];
  for (const r of rows) {
    const s = data.summary(r);
    const ev = engine.latestFor(r.group_id, r.conversation_id, version);
    const cells = [s.conversation_id, s.group_id, s.client_language, s.channel, s.operator_name, ev?.checklist_version ?? ''];
    for (const c of crit) cells.push(ev ? (ev.results.find((x) => x.criterion_id === c.id)?.answer_label ?? '') : '');
    cells.push(ev?.total_str ?? '', ev ? (ev.gross?.flag ? 'Да' : 'Нет') : '', ev?.gross?.types?.join('|') ?? '', ev?.status ?? 'не оценён', ev?.min_confidence ?? '', ev?.model ?? '', ev?.cost_usd ?? '');
    lines.push(cells.map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
