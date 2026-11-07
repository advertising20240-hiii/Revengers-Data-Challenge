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

/** Picks the stored evaluation that covers all eight organizer criteria (newest first). */
export function pickEvaluation(evaluations) {
  const codes = Object.keys(RESULT_IDS);
  return (evaluations || []).find((e) => codes.every((code) => (e.results || []).some((r) => r.code === code))) || null;
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

/** Model description from what was actually called while producing these evaluations. */
export function modelInfo(evaluations) {
  const models = new Set();
  let rules = false;
  for (const e of evaluations) {
    if (e?.model && !/^heuristic|^cache/.test(e.model)) models.add(e.model);
    for (const c of e?.trace?.calls || []) if (c.model) models.add(c.model);
    if (e?.trace?.kz_model) models.add(e.trace.kz_model);
    if ((e?.results || []).some((r) => r.source === 'rule')) rules = true;
  }
  const provider = evaluations.find((e) => e?.provider)?.provider;
  const list = [...models];
  const name = [list.length ? `${list.join(', ')}${provider === 'alem' ? ' (alem.plus API)' : ''}` : null, rules ? 'детерминированные правила по фактам транскрипта' : null].filter(Boolean).join(' + ');
  const mode = list.length && rules ? 'hybrid' : list.length ? (provider === 'openai' || provider === 'ollama' ? 'local' : 'external_api') : 'local';
  return { mode, name: name || 'детерминированные правила' };
}

/** Full results file; `rows` = [{conversation_id, evaluations:[newest first]}]. */
export function buildResultsFile({ teamName, rows }) {
  const records = [];
  const used = [];
  for (const row of rows) {
    const ev = pickEvaluation(row.evaluations);
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
