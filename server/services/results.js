// Organizers' results format ("Как сдать результаты", JSON 1.0): one object per file, one record per dialog.
// Criterion codes of the organizers' checklist map to fixed result ids; values: true / false / null (N/A) / scale step.

export const RESULT_IDS = {
  '01': 'contact', '02': 'discovery', '03': 'identification', '04': 'consultation',
  '05': 'empathy', '06': 'dialogue', '07': 'closure', '08': 'critical',
};
const ALLOWED = {
  contact: ['bool'], discovery: ['bool', 'null'], identification: ['bool', 'null'], consultation: [0, 5, 10, 15, 20, null],
  empathy: ['bool'], dialogue: [0, 4, 7, 10], closure: ['bool', 'null'], critical: ['bool'],
};

function valueOf(r) {
  if (!r || r.applicable === false) return null;
  if (typeof r.scale_value === 'number') return r.scale_value;
  if (r.answer === 'yes') return true;
  if (r.answer === 'no') return false;
  return undefined;
}

function clip(t, max = 300) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/**
 * Picks the stored evaluation (list is newest first) that covers all eight organizer criteria.
 * With `checklistVersion` the newest complete evaluation of that version wins, so an export reflects one checklist
 * (callers pass the active version); without one, or when that version has none, the newest complete evaluation is used.
 */
export function pickEvaluation(evaluations, { checklistVersion = null } = {}) {
  const codes = Object.keys(RESULT_IDS);
  const complete = (evaluations || []).filter((e) => codes.every((code) => (e.results || []).some((r) => r.code === code)));
  if (checklistVersion != null) {
    const same = complete.find((e) => e.checklist_version === Number(checklistVersion));
    if (same) return same;
  }
  return complete[0] || null;
}

/** One results[] record for a conversation. */
export function resultRecord(conversationId, evaluation, error = null) {
  if (!evaluation) {
    return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: error || 'Диалог не оценён.' };
  }
  const criteria = [];
  for (const [code, id] of Object.entries(RESULT_IDS)) {
    const r = evaluation.results.find((x) => x.code === code);
    const value = valueOf(r);
    if (value === undefined) return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: `Нет значения для критерия ${id}.` };
    const lines = [...new Set((r.evidence || []).map((e) => e.line).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
    criteria.push({ criterion_id: id, value, rationale: clip(r.explanation || r.na_reason || ''), evidence_turns: lines });
  }
  return {
    conversation_id: conversationId,
    status: 'ok',
    criteria,
    score: { final_score: evaluation.calculated ? evaluation.total : null, critical_flag: !!evaluation.gross?.flag },
  };
}

const RULES_NAME = 'детерминированные правила по фактам транскрипта';
const isModelName = (m) => !!m && !/^(heuristic|cache|rule)/.test(m);

/**
 * Model description from what actually produced these evaluations. A model is named only when it answered:
 * a model call in trace.calls (rule "calls" are code), or — for traces without calls (cache replay, reused results,
 * committed seeds) — model-judged results (source "ai", not a fallback) under a model provider.
 * Rules fallback / heuristic-only runs therefore say "rules" and are local.
 */
export function modelInfo(evaluations) {
  const models = new Set();
  let rules = false;
  let provider = null;
  for (const e of evaluations) {
    if (!e) continue;
    const results = e.results || [];
    if (results.some((r) => r.source === 'rule' || String(r.rule_applied || '').startsWith('fallback:'))) rules = true;
    if (e.provider === 'heuristic') continue;
    const called = (e.trace?.calls || []).filter((c) => c.role !== 'rule' && isModelName(c.model));
    const judged = results.some((r) => r.source === 'ai' && !String(r.rule_applied || '').startsWith('fallback:'));
    if (called.length) for (const c of called) models.add(c.model);
    else if (judged) {
      if (isModelName(e.model)) models.add(e.model);
      if (isModelName(e.trace?.kz_model)) models.add(e.trace.kz_model);
    }
    if ((called.length || judged) && e.provider) provider ??= e.provider;
  }
  if (!evaluations.length) return { mode: 'external_api', name: `${process.env.ALEM_MODEL_JUDGE || 'qwen3-8'} (alem.plus API) + ${RULES_NAME}` };
  const list = [...models];
  // offline replays answers the alem.plus judge produced earlier, so they are still credited to that API
  // rules are plain code on this machine: with no model answer the whole pipeline is local
  if (!list.length) return { mode: 'local', name: `${RULES_NAME} (без вызова модели)` };
  const name = [`${list.join(', ')}${provider === 'alem' || provider === 'offline' ? ' (alem.plus API)' : ''}`, rules ? RULES_NAME : null].filter(Boolean).join(' + ');
  // mode describes where the models run: every model call goes to the alem.plus API unless a local server is used
  const mode = provider === 'openai' || provider === 'ollama' ? 'local' : 'external_api';
  return { mode, name };
}

/** Full results file; `rows` = [{conversation_id, evaluations:[newest first]}]; `checklistVersion` = preferred version. */
export function buildResultsFile({ teamName, rows, checklistVersion = null }) {
  const records = [];
  const used = [];
  for (const row of rows) {
    const ev = pickEvaluation(row.evaluations, { checklistVersion });
    if (ev) used.push(ev);
    records.push(resultRecord(row.conversation_id, ev, row.error));
  }
  return { schema_version: '1.0', team_name: teamName, model: modelInfo(used), results: records };
}

/** Validation against the organizers' rules; returns a list of problems (empty = ok). */
export function validateResultsFile(file, { expectedCount = null } = {}) {
  const errs = [];
  if (file?.schema_version !== '1.0') errs.push('schema_version должен быть "1.0"');
  if (!file?.team_name) errs.push('team_name пуст');
  if (!['local', 'external_api', 'hybrid'].includes(file?.model?.mode)) errs.push('model.mode: local | external_api | hybrid');
  if (!file?.model?.name) errs.push('model.name пуст');
  const seen = new Set();
  for (const r of file?.results || []) {
    if (seen.has(r.conversation_id)) errs.push(`повторяющийся ID ${r.conversation_id}`);
    seen.add(r.conversation_id);
    if (r.status === 'error') {
      if (r.criteria?.length || r.score !== null || !r.error) errs.push(`${r.conversation_id}: запись error должна иметь criteria=[], score=null и error`);
      continue;
    }
    if (r.status !== 'ok') { errs.push(`${r.conversation_id}: status ok | error`); continue; }
    const ids = (r.criteria || []).map((c) => c.criterion_id);
    for (const id of Object.values(RESULT_IDS)) if (ids.filter((x) => x === id).length !== 1) errs.push(`${r.conversation_id}: критерий ${id} должен быть ровно один раз`);
    for (const c of r.criteria || []) {
      const ok = (ALLOWED[c.criterion_id] || []).some((a) => (a === 'bool' ? typeof c.value === 'boolean' : a === 'null' ? c.value === null : c.value === a));
      if (!ok) errs.push(`${r.conversation_id}: недопустимое значение ${JSON.stringify(c.value)} для ${c.criterion_id}`);
      if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((n) => !Number.isInteger(n) || n < 1)) errs.push(`${r.conversation_id}: evidence_turns для ${c.criterion_id}`);
      if (typeof c.rationale !== 'string') errs.push(`${r.conversation_id}: rationale для ${c.criterion_id}`);
    }
    const fs = r.score?.final_score;
    if (!(fs === null || (typeof fs === 'number' && fs >= 0 && fs <= 100 && Number(fs.toFixed(2)) === fs))) errs.push(`${r.conversation_id}: final_score 0..100, два знака`);
    const crit = r.criteria.find((c) => c.criterion_id === 'critical');
    if (crit && r.score?.critical_flag !== crit.value) errs.push(`${r.conversation_id}: critical_flag должен совпадать с critical`);
  }
  if (expectedCount != null && (file?.results || []).length !== expectedCount) errs.push(`ожидалось ${expectedCount} записей, получено ${(file?.results || []).length}`);
  return errs;
}
