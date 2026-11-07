// Assembly of Evaluation objects: evaluator results + shared scoring engine + evidence enrichment.
// Totals are never computed here directly — always through packages/scoring.
import { scoreEvaluation, isScale, isFlag, scaleMax, naAllowed } from '../../packages/scoring/index.js';
import { criterionHash } from './checklists.js';
import { createHash } from 'node:crypto';
import { newId } from '../lib/hash.js';
import { HttpError } from '../lib/http.js';

export const NA_REASON_NO_OPERATOR = 'Оператор не участвовал в диалоге';

export function answerLabel(c, r) {
  if (!r || r.applicable === false) return 'N/A';
  if (isScale(c)) return `${r.scale_value ?? '—'} из ${scaleMax(c).toFixed(0)}`;
  return r.answer === 'yes' ? 'Да' : r.answer === 'no' ? 'Нет' : '—';
}

/** Convert criterion results into the answer map the scoring engine expects. */
export function answersFromResults(checklist, results) {
  const byId = new Map(results.map((r) => [r.criterion_id, r]));
  const answers = {};
  for (const c of checklist.criteria) {
    const r = byId.get(c.id);
    if (!r) continue;
    answers[c.id] = r.applicable === false
      ? { applicable: false }
      : { applicable: true, answer: r.answer ?? undefined, scale_value: r.scale_value ?? undefined, flag_types: r.flag_types || [] };
  }
  return answers;
}

function quoteOf(line, max = 400) {
  const t = String(line?.text ?? '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function enrichEvidence(conv, evidence) {
  const out = [];
  for (const e of evidence || []) {
    const n = Number(e?.line);
    const line = Number.isInteger(n) && n >= 1 && n <= conv.lines.length ? conv.lines[n - 1] : null;
    if (!line) continue; // dangling references are dropped, not shown as facts
    out.push({ line: n, why: String(e.why ?? ''), timestamp: line.timestamp, offset_label: line.offset_label, offset_seconds: line.offset_seconds, speaker: line.speaker, quote: quoteOf(line) });
  }
  return out;
}

/** Digest of the transcript as the evaluator saw it; stored results are reused only for the same digest. */
export function transcriptDigest(conv) {
  const lines = (conv?.lines || []).map((l, i) => [l.n ?? i + 1, l.speaker ?? null, String(l.text ?? '')]);
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex').slice(0, 32);
}

/**
 * Human-review queue: concrete risk signals, not a blanket threshold. Shared by creation and re-scoring.
 * Criteria a reviewer has already decided (`review`) no longer raise low-confidence / disagreement / fallback signals.
 */
export function reviewSignals(results, gross, trace = {}) {
  const conf = (r) => (typeof r.confidence === 'number' ? r.confidence : 0);
  const confs = results.map(conf);
  const minConf = confs.length ? Math.min(...confs) : 0;
  const open = results.filter((r) => !r.review);
  const openIds = new Set(open.map((r) => r.criterion_id));
  const openMin = open.length ? Math.min(...open.map(conf)) : 1;
  const reasons = [];
  if (openMin < 0.6) reasons.push(`низкая уверенность (${openMin.toFixed(2)})`);
  if (gross?.flag) reasons.push(`грубая ошибка: ${(gross.types || []).join(', ') || 'тип не указан'}`);
  const kz = (trace?.kz_disagreements || []).filter((d) => openIds.has(d.criterion_id));
  if (kz.length) reasons.push(`расхождение с казахской моделью: ${kz.map((d) => d.criterion_id).join(', ')}`);
  const ver = (trace?.verifier_changes || []).filter((d) => openIds.has(d.criterion_id));
  if (ver.length) reasons.push(`проверяющая модель не согласна: ${ver.map((d) => d.criterion_id).join(', ')}`);
  if (open.some((r) => String(r.rule_applied || '').startsWith('fallback:'))) reasons.push('ответ модели не прошёл проверку — использованы правила');
  return { min_confidence: Number(minConf.toFixed(3)), needs_review: reasons.length > 0, review_reasons: reasons };
}

/** Bare CriterionResult (what the evaluator produced), without presentation fields. */
export function stripResult(r) {
  return {
    criterion_id: r.criterion_id, applicable: r.applicable !== false, na_reason: r.na_reason ?? null,
    answer: r.answer ?? null, scale_value: r.scale_value ?? null, flag_types: Array.isArray(r.flag_types) ? r.flag_types : [],
    evidence: (r.evidence || []).map((e) => ({ line: e.line, why: e.why ?? '' })),
    checked_range: r.checked_range ?? null, rule_applied: r.rule_applied ?? '', explanation: r.explanation ?? '',
    confidence: typeof r.confidence === 'number' ? r.confidence : 0, source: r.source || 'ai',
    ...(r.second_opinion ? { second_opinion: { source: r.second_opinion.source ?? 'ai', model: r.second_opinion.model ?? null, label: r.second_opinion.label ?? null, explanation: r.second_opinion.explanation ?? '' } } : {}),
  };
}

/** Result for a conversation without operator lines: every criterion N/A, no model call. */
export function noOperatorResults(checklist) {
  return checklist.criteria.map((c) => ({
    criterion_id: c.id, applicable: false, na_reason: NA_REASON_NO_OPERATOR, answer: null, scale_value: null, flag_types: [],
    evidence: [], checked_range: null, rule_applied: 'operator_absent', explanation: `${NA_REASON_NO_OPERATOR}: критерий не оценивается, итог не рассчитывается.`,
    confidence: 1, source: 'rule',
  }));
}

/**
 * Build a full Evaluation from criterion results.
 * `results` must contain one CriterionResult per checklist criterion (missing ones become N/A with low confidence
 * only when N/A is allowed; otherwise the engine reports an error and the total is not calculated).
 */
export function buildEvaluation({ conv, checklist, results, trace = {}, mode = 'stored', provider = null, model = null, promptVersion = null, groupId = null, id = null, extraHistory = [] }) {
  const byId = new Map(results.map((r) => [r.criterion_id, r]));
  const full = checklist.criteria.map((c) => {
    const r = byId.get(c.id);
    if (r) return r;
    return { criterion_id: c.id, applicable: naAllowed(c) ? false : true, na_reason: naAllowed(c) ? 'Критерий не был оценён' : null, answer: null, scale_value: null, flag_types: [], evidence: [], checked_range: null, rule_applied: 'missing', explanation: 'Результат для критерия отсутствует.', confidence: 0, source: 'ai' };
  });
  const scored = scoreEvaluation(checklist, answersFromResults(checklist, full));
  const sectionsById = Object.fromEntries((checklist.sections || []).map((s) => [s.id, s.title]));
  const criteriaOut = checklist.criteria.map((c) => {
    const r = byId.get(c.id) || full.find((x) => x.criterion_id === c.id);
    const per = scored.per_criterion[c.id] || {};
    const base = {
      ...stripResult(r), code: c.code, title: c.title, section: c.section, answer_type: c.answer_type, weight: Number(c.weight ?? 0), scored: !isFlag(c),
      points: per.points ?? null, effective_weight: per.effective_weight ?? null, answer_label: answerLabel(c, r),
      evidence: enrichEvidence(conv, r.evidence), criterion_hash: criterionHash(c),
    };
    if (r.ai_original) base.ai_original = r.ai_original;
    if (r.review) base.review = r.review;
    if (r.na_reason == null && r.applicable === false && c.na_condition) base.na_reason = c.na_condition;
    return base;
  });
  const section_totals = {};
  for (const [sec, v] of Object.entries(scored.section_totals)) section_totals[sec] = { title: sectionsById[sec] ?? sec, ...v };
  const grossEvidence = [];
  for (const cid of scored.gross.criteria) {
    const r = criteriaOut.find((x) => x.criterion_id === cid);
    for (const e of r?.evidence || []) grossEvidence.push({ line: e.line, quote: e.quote, speaker: e.speaker });
  }
  const review = reviewSignals(criteriaOut, scored.gross, trace);
  const now = new Date().toISOString();
  const costUsd = Number(trace?.cost_usd ?? 0) || 0;
  const ev = {
    id: id || newId('ev'),
    conversation_id: conv.conversation_id, group_id: groupId ?? conv.group_id ?? null,
    checklist_id: checklist.id, checklist_version: checklist.version,
    prompt_version: promptVersion ?? trace?.prompt_version ?? null,
    provider: provider ?? trace?.provider ?? null, model: model ?? trace?.model ?? null,
    created_at: now, status: 'final', mode,
    results: criteriaOut,
    total: scored.total, total_str: scored.total_str, calculated: scored.calculated, original_total: scored.total,
    section_totals,
    gross: { ...scored.gross, evidence: grossEvidence },
    ...review,
    transcript_hash: transcriptDigest(conv),
    operator_participated: conv.facts?.operator_participated ?? true,
    cost_usd: costUsd, cost_note: trace?.cost_note ?? null, latency_ms: Number(trace?.latency_ms ?? 0) || 0,
    trace: trace || {},
    scoring_errors: scored.errors,
    history: [{ at: now, action: 'evaluated', by: 'ai', total_after: scored.total, note: trace?.reused?.length ? `Повторно использованы результаты критериев: ${trace.reused.join(', ')}` : undefined }, ...extraHistory],
  };
  return ev;
}

/** Recompute totals and the review signals after a reviewer decision; mutates and returns the evaluation. */
export function rescoreEvaluation(ev, checklist, conv) {
  const scored = scoreEvaluation(checklist, answersFromResults(checklist, ev.results));
  if (scored.errors.length) throw new HttpError(400, `Новое значение не проходит проверку движка: ${scored.errors.join('; ')}`);
  const byId = Object.fromEntries(checklist.criteria.map((c) => [c.id, c]));
  for (const r of ev.results) {
    const per = scored.per_criterion[r.criterion_id] || {};
    r.points = per.points ?? null;
    r.effective_weight = per.effective_weight ?? null;
    r.answer_label = answerLabel(byId[r.criterion_id], r);
    if (conv) r.evidence = enrichEvidence(conv, r.evidence);
  }
  const sectionsById = Object.fromEntries((checklist.sections || []).map((s) => [s.id, s.title]));
  ev.section_totals = {};
  for (const [sec, v] of Object.entries(scored.section_totals)) ev.section_totals[sec] = { title: sectionsById[sec] ?? sec, ...v };
  const grossEvidence = [];
  for (const cid of scored.gross.criteria) for (const e of ev.results.find((x) => x.criterion_id === cid)?.evidence || []) grossEvidence.push({ line: e.line, quote: e.quote, speaker: e.speaker });
  ev.gross = { ...scored.gross, evidence: grossEvidence };
  ev.total = scored.total; ev.total_str = scored.total_str; ev.calculated = scored.calculated;
  ev.scoring_errors = scored.errors;
  // same queue rules as on creation: a decided gross error or uncertain criterion leaves the review queue
  Object.assign(ev, reviewSignals(ev.results, ev.gross, ev.trace));
  return ev;
}

/** Validate a reviewer-provided new value against the criterion definition. */
export function normalizeNewValue(c, nv) {
  if (!nv || typeof nv !== 'object') throw new HttpError(400, 'new_value is required for decision "change"');
  const out = { applicable: nv.applicable !== false, answer: null, scale_value: null, flag_types: [] };
  if (!out.applicable) {
    if (!naAllowed(c)) throw new HttpError(400, `Критерий ${c.code} не допускает N/A`);
    return out;
  }
  if (isScale(c)) {
    const v = Number(nv.scale_value);
    const steps = (c.scale || []).map((s) => Number(s.value));
    if (!steps.includes(v)) throw new HttpError(400, `Значение шкалы ${nv.scale_value} не входит в [${steps.join(', ')}]`);
    out.scale_value = v;
  } else {
    if (nv.answer !== 'yes' && nv.answer !== 'no') throw new HttpError(400, 'answer must be "yes" or "no"');
    out.answer = nv.answer;
    if (isFlag(c)) out.flag_types = Array.isArray(nv.flag_types) ? nv.flag_types.map(String) : [];
  }
  return out;
}

/** Short summary row used by list endpoints. */
export function evaluationSummary(ev) {
  if (!ev) return null;
  return {
    evaluation_id: ev.id, checklist_version: ev.checklist_version, total: ev.total, total_str: ev.total_str, calculated: ev.calculated,
    gross_flag: !!ev.gross?.flag, gross_types: ev.gross?.types || [], min_confidence: ev.min_confidence, needs_review: ev.needs_review, review_reasons: ev.review_reasons || [],
    status: ev.status, created_at: ev.created_at, model: ev.model, cost_usd: ev.cost_usd ?? 0,
  };
}
