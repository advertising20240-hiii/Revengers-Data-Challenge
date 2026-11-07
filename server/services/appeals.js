// Appeals: an operator disputes one criterion; a reviewer confirms or changes it with a mandatory note.
// The original AI result stays visible; totals are recomputed through the shared scoring engine.
import { rescoreEvaluation, normalizeNewValue, answerLabel } from './evaluations.js';
import { newId } from '../lib/hash.js';
import { HttpError } from '../lib/http.js';

export const OUTCOMES = ['score_changed', 'criterion_change', 'stands_explanation', 'stands_coaching'];

export class AppealService {
  constructor({ db, config, data, checklists, engine }) {
    this.db = db; this.config = config; this.data = data; this.checklists = checklists; this.engine = engine;
  }

  get(id) { const a = this.db.appeals.get(id); if (!a) throw new HttpError(404, `Appeal ${id} not found`); return a; }

  statusFor(evaluationId) {
    const list = this.db.appeals.find((a) => a.evaluation_id === evaluationId);
    if (!list.length) return 'none';
    return list.some((a) => a.status === 'open') ? 'open' : 'resolved';
  }

  open({ evaluation_id, criterion_id, comment, by = 'operator' }) {
    const ev = this.db.evaluations.get(evaluation_id);
    if (!ev) throw new HttpError(404, `Evaluation ${evaluation_id} not found`);
    if (ev.mode !== 'stored') throw new HttpError(400, 'Результаты симуляции нельзя оспорить');
    const result = ev.results.find((r) => r.criterion_id === criterion_id);
    if (!result) throw new HttpError(404, `Criterion ${criterion_id} is not part of evaluation ${evaluation_id}`);
    if (!comment || !String(comment).trim()) throw new HttpError(400, 'Комментарий к апелляции обязателен');
    const dup = this.db.appeals.find((a) => a.evaluation_id === evaluation_id && a.criterion_id === criterion_id && a.status === 'open');
    if (dup.length) throw new HttpError(409, `По критерию ${result.code} уже есть открытая апелляция (${dup[0].id})`);
    const row = this.data.resolve(ev.conversation_id, ev.group_id);
    const conv = this.data.prepare(row);
    const now = new Date().toISOString();
    const appeal = {
      id: newId('ap'), evaluation_id, conversation_id: ev.conversation_id, group_id: ev.group_id, criterion_id, criterion_title: result.title, criterion_code: result.code,
      comment: String(comment), created_at: now, status: 'open',
      original: { answer_label: result.answer_label, applicable: result.applicable, answer: result.answer, scale_value: result.scale_value, flag_types: result.flag_types, points: result.points, confidence: result.confidence, explanation: result.explanation },
      decision: null, final: null, total_before: ev.total, total_after: null, checklist_version: ev.checklist_version,
      excerpt: this.excerpt(conv, result),
      min_confidence: ev.min_confidence, confidence: result.confidence,
    };
    this.db.appeals.put(appeal);
    ev.status = 'under_appeal';
    ev.history.push({ at: now, action: 'appeal_opened', by, criterion_id, appeal_id: appeal.id, from: result.answer_label, note: appeal.comment, total_before: ev.total });
    this.db.evaluations.put(ev);
    this.db.scheduleSave();
    return appeal;
  }

  excerpt(conv, result, context = 1) {
    const lines = new Set();
    for (const e of result.evidence || []) for (let n = e.line - context; n <= e.line + context; n++) if (n >= 1 && n <= conv.lines.length) lines.add(n);
    return [...lines].sort((a, b) => a - b).map((n) => { const l = conv.lines[n - 1]; return `[#${n} ${l.offset_label} ${l.speaker}] ${l.text}`; }).join('\n').slice(0, 1500);
  }

  list(status = 'open') {
    let list = this.db.appeals.all();
    if (status === 'open') list = list.filter((a) => a.status === 'open');
    else if (status === 'resolved') list = list.filter((a) => a.status !== 'open');
    return list.sort((a, b) => {
      const ao = a.status === 'open' ? 0 : 1; const bo = b.status === 'open' ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ac = a.confidence ?? 1; const bc = b.confidence ?? 1;
      if (ac !== bc) return ac - bc;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }

  details(id) {
    const appeal = this.get(id);
    const evaluation = this.db.evaluations.get(appeal.evaluation_id);
    const checklist = this.checklists.get(evaluation?.checklist_version);
    const criterion = checklist?.criteria.find((c) => c.id === appeal.criterion_id) ?? null;
    const result = evaluation?.results.find((r) => r.criterion_id === appeal.criterion_id) ?? null;
    const row = this.data.resolve(appeal.conversation_id, appeal.group_id);
    const conv = this.data.prepare(row);
    const wanted = new Set();
    for (const e of result?.evidence || []) for (let n = e.line - 3; n <= e.line + 3; n++) if (n >= 1 && n <= conv.lines.length) wanted.add(n);
    if (result?.checked_range) for (let n = result.checked_range[0]; n <= Math.min(result.checked_range[1], result.checked_range[0] + 40); n++) if (n >= 1 && n <= conv.lines.length) wanted.add(n);
    const evidenceLines = new Set((result?.evidence || []).map((e) => e.line));
    const lines = [...wanted].sort((a, b) => a - b).map((n) => ({ ...conv.lines[n - 1], evidence: evidenceLines.has(n) }));
    return { appeal, evaluation, criterion, result, lines };
  }

  async secondOpinion(id) {
    const appeal = this.get(id);
    const evaluation = this.db.evaluations.get(appeal.evaluation_id);
    const checklist = this.checklists.getOrThrow(evaluation.checklist_version);
    const row = this.data.resolve(appeal.conversation_id, appeal.group_id);
    const so = await this.engine.secondOpinion(appeal, evaluation, checklist, row);
    appeal.second_opinion = so;
    this.db.appeals.put(appeal); this.db.scheduleSave();
    return so;
  }

  decide(id, { decision, outcome, new_value, reviewer_note, by = 'reviewer' }) {
    const appeal = this.get(id);
    if (appeal.status !== 'open') throw new HttpError(409, 'Апелляция уже решена; пересмотр возможен только через новую апелляцию');
    if (decision !== 'confirm' && decision !== 'change') throw new HttpError(400, 'decision must be "confirm" or "change"');
    if (!OUTCOMES.includes(outcome)) throw new HttpError(400, `outcome must be one of ${OUTCOMES.join(', ')}`);
    if (!reviewer_note || !String(reviewer_note).trim()) throw new HttpError(400, 'Комментарий проверяющего (reviewer_note) обязателен');
    if (decision === 'change' && outcome !== 'score_changed') throw new HttpError(400, 'Изменение оценки требует исхода score_changed');
    if (decision === 'confirm' && outcome === 'score_changed') throw new HttpError(400, 'Исход score_changed требует decision "change"');

    const ev = this.db.evaluations.get(appeal.evaluation_id);
    if (!ev) throw new HttpError(404, 'Evaluation not found');
    const checklist = this.checklists.getOrThrow(ev.checklist_version);
    const criterion = checklist.criteria.find((c) => c.id === appeal.criterion_id);
    const result = ev.results.find((r) => r.criterion_id === appeal.criterion_id);
    const row = this.data.resolve(ev.conversation_id, ev.group_id);
    const conv = this.data.prepare(row);
    const now = new Date().toISOString();
    const totalBefore = ev.total;
    const fromLabel = result.answer_label;

    if (decision === 'change') {
      const nv = normalizeNewValue(criterion, new_value);
      if (!result.ai_original) {
        const { ai_original, review, ...orig } = result;
        result.ai_original = { ...orig };
      }
      result.applicable = nv.applicable; result.answer = nv.answer; result.scale_value = nv.scale_value; result.flag_types = nv.flag_types;
      if (!nv.applicable) result.na_reason = criterion.na_condition || 'Проверяющий признал критерий неприменимым';
      else result.na_reason = null;
      result.source = 'review';
      result.explanation = `Решение проверяющего: ${String(reviewer_note).trim()}`;
      result.rule_applied = 'reviewer_decision';
      result.confidence = 1;
    }
    result.review = { appeal_id: appeal.id, decision, outcome, reviewer_note: String(reviewer_note).trim(), decided_at: now };
    rescoreEvaluation(ev, checklist, conv);

    appeal.status = decision === 'change' ? 'changed' : 'confirmed';
    appeal.decision = { decision, outcome, new_value: decision === 'change' ? { applicable: result.applicable, answer: result.answer, scale_value: result.scale_value, flag_types: result.flag_types } : null, reviewer_note: String(reviewer_note).trim(), decided_at: now };
    appeal.final = { answer_label: answerLabel(criterion, result), points: result.points, applicable: result.applicable, answer: result.answer, scale_value: result.scale_value };
    appeal.total_before = totalBefore; appeal.total_after = ev.total;

    const stillOpen = this.db.appeals.find((a) => a.evaluation_id === ev.id && a.status === 'open' && a.id !== appeal.id);
    ev.status = stillOpen.length ? 'under_appeal' : 'reviewed';
    ev.history.push({ at: now, action: 'decision', by, criterion_id: appeal.criterion_id, appeal_id: appeal.id, decision, outcome, from: fromLabel, to: appeal.final.answer_label, total_before: totalBefore, total_after: ev.total, note: appeal.decision.reviewer_note });
    this.db.appeals.put(appeal); this.db.evaluations.put(ev); this.db.scheduleSave();
    return { appeal, evaluation: ev };
  }

  /** Dispute metrics for stats. */
  metrics(groupId = null) {
    const all = this.db.appeals.all().filter((a) => !groupId || a.group_id === groupId);
    const resolved = all.filter((a) => a.status !== 'open');
    const changed = resolved.filter((a) => a.status === 'changed');
    const byC = new Map();
    for (const a of all) {
      const e = byC.get(a.criterion_id) || { criterion_id: a.criterion_id, title: a.criterion_title, code: a.criterion_code, total: 0, open: 0, changed: 0 };
      e.total++; if (a.status === 'open') e.open++; if (a.status === 'changed') e.changed++;
      byC.set(a.criterion_id, e);
    }
    const by_outcome = Object.fromEntries(OUTCOMES.map((o) => [o, resolved.filter((a) => a.decision?.outcome === o).length]));
    return {
      total: all.length, open: all.length - resolved.length, resolved: resolved.length, changed: changed.length,
      upheld_share: resolved.length ? Number(((resolved.length - changed.length) / resolved.length).toFixed(3)) : null,
      by_criterion: [...byC.values()].sort((a, b) => b.total - a.total), by_outcome,
    };
  }
}
