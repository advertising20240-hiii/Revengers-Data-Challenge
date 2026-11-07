// Deterministic validator for model output. Returns a list of human-readable violations (empty = valid)
// and a normalized result. The judge is re-asked once with the violations; on failure the heuristic fallback applies.
import { isScale, isFlag, naAllowed, scaleSteps } from '../../packages/scoring/index.js';

const SPEAKERS_BY_CODE = {
  '01': ['operator'],
  '05': ['operator'],
  '06': ['operator'],
  '07': ['operator'],
  '08': ['operator'],
};

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

/** Coerce loosely-typed model output into the CriterionResult shape (no judgement here). */
function clip(t, max) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.»'));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')) + (end > max * 0.5 ? '' : '…');
}

export function normalizeResult(raw, criterion) {
  const r = raw || {};
  const out = {
    criterion_id: criterion.id,
    applicable: true,
    na_reason: null,
    answer: null,
    scale_value: null,
    flag_types: [],
    evidence: [],
    checked_range: null,
    rule_applied: typeof r.rule_applied === 'string' ? r.rule_applied : '',
    explanation: typeof r.explanation === 'string' ? r.explanation : (typeof r.explanation_ru === 'string' ? r.explanation_ru : ''),
    confidence: 0.5,
    source: 'ai',
  };
  const app = r.applicable;
  if (app === false || app === 'false' || app === 'na' || app === 'N/A' || r.answer === 'na' || r.answer === 'N/A' || r.answer === 'NA') out.applicable = false;
  if (r.na_reason) out.na_reason = String(r.na_reason);
  if (typeof r.answer === 'string') {
    const a = r.answer.trim().toLowerCase();
    if (['yes', 'да', 'y', 'true'].includes(a)) out.answer = 'yes';
    else if (['no', 'нет', 'n', 'false'].includes(a)) out.answer = 'no';
  } else if (typeof r.answer === 'boolean') out.answer = r.answer ? 'yes' : 'no';
  if (r.scale_value != null && r.scale_value !== '') out.scale_value = num(r.scale_value);
  // keep model text short and clean (a model may leak its reasoning into free-text fields)
  out.explanation = clip(out.explanation, 600);
  out.rule_applied = clip(out.rule_applied, 160);
  // A model often expresses N/A as {applicable:true, answer:null, na_reason:"..."}: treat it as N/A when N/A is allowed
  if (!isFlag(criterion) && out.answer == null && out.scale_value == null && out.na_reason && naAllowed(criterion)) out.applicable = false;
  if (isFlag(criterion)) {
    const ft = Array.isArray(r.flag_types) ? r.flag_types : (typeof r.flag_types === 'string' && r.flag_types ? [r.flag_types] : []);
    out.flag_types = [...new Set(ft.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    if (out.answer == null) out.answer = out.flag_types.length ? 'yes' : (out.applicable ? 'no' : null);
  }
  if (isScale(criterion) && out.scale_value == null && out.answer && !out.applicable === false) { /* keep */ }
  const ev = Array.isArray(r.evidence) ? r.evidence : [];
  out.evidence = ev.map((e) => (typeof e === 'number' ? { line: e, why: '' } : { line: num(e?.line ?? e?.n), why: clip(e?.why ?? e?.quote ?? '', 200) })).filter((e) => e.line != null);
  if (Array.isArray(r.checked_range) && r.checked_range.length === 2) {
    const a = num(r.checked_range[0]); const b = num(r.checked_range[1]);
    if (a != null && b != null) out.checked_range = [Math.min(a, b), Math.max(a, b)];
  } else if (r.checked_range && typeof r.checked_range === 'object' && 'from' in r.checked_range) {
    const a = num(r.checked_range.from); const b = num(r.checked_range.to);
    if (a != null && b != null) out.checked_range = [Math.min(a, b), Math.max(a, b)];
  }
  const c = num(r.confidence);
  out.confidence = c == null ? 0.5 : Math.max(0, Math.min(1, c > 1 ? c / 100 : c));
  if (out.applicable === false) { out.answer = null; out.scale_value = null; }
  return out;
}

/**
 * Validate one normalized result against the criterion definition, the transcript and the facts.
 * @returns {string[]} violations (Russian, listed in the repair prompt)
 */
export function validateResult(res, criterion, conv) {
  const v = [];
  const code = criterion.code || criterion.id.replace(/^c/, '');
  const L = conv.lines || [];
  const n = L.length;
  const facts = conv.facts || {};
  const lineOk = (x) => Number.isInteger(x) && x >= 1 && x <= n;
  const speakerOf = (x) => L[x - 1]?.speaker;

  if (!res.applicable) {
    if (!naAllowed(criterion)) v.push(`${code}: N/A не разрешён для этого критерия`);
    if (!res.na_reason) v.push(`${code}: для N/A нужна причина na_reason`);
    return v; // nothing else to check for N/A
  }

  if (isScale(criterion)) {
    const steps = scaleSteps(criterion);
    if (res.scale_value == null || !steps.includes(res.scale_value)) v.push(`${code}: scale_value ${res.scale_value} не входит в шаги шкалы [${steps.join(', ')}]`);
  } else if (res.answer !== 'yes' && res.answer !== 'no') {
    v.push(`${code}: answer должен быть "yes" или "no"`);
  }

  if (!res.evidence.length) v.push(`${code}: нужна хотя бы одна строка доказательства`);
  for (const e of res.evidence) if (!lineOk(e.line)) v.push(`${code}: строка доказательства #${e.line} не существует (всего строк ${n})`);
  const valid = res.evidence.filter((e) => lineOk(e.line));
  const need = SPEAKERS_BY_CODE[code];
  if (need && valid.length && !valid.some((e) => need.includes(speakerOf(e.line)))) {
    v.push(`${code}: среди доказательств должна быть реплика оператора (указаны: ${valid.map((e) => `#${e.line} ${speakerOf(e.line)}`).join(', ')})`);
  }
  if (valid.length && !valid.some((e) => speakerOf(e.line) !== 'bot')) v.push(`${code}: доказательства не могут состоять только из реплик бота`);

  if (res.answer === 'no' && !res.checked_range) v.push(`${code}: для «Нет» нужен checked_range [от, до]`);
  if (res.checked_range && (!lineOk(res.checked_range[0]) || !lineOk(res.checked_range[1]))) v.push(`${code}: checked_range выходит за пределы транскрипта`);

  // criterion-specific policy checks (on the standard checklist codes)
  if (code === '01' && facts.first_operator) {
    const first = facts.first_operator.line;
    if (valid.length && !valid.some((e) => e.line === first)) v.push(`01: доказательство должно быть ПЕРВОЙ репликой оператора (#${first})`);
  }
  if (code === '03' && res.answer === 'yes') {
    const verified = facts.identity_verified_lines || [];
    const disc = facts.disclosure_signals || [];
    if (conv.channel === 'agent chat') {
      if (!verified.length) v.push('03: «Да» невозможно — в чате нет события «Личность клиента подтверждена»');
      else if (disc.length && !verified.some((vl) => vl < disc[0].line)) v.push(`03: подтверждение личности (#${verified[0]}) стоит ПОСЛЕ первого раскрытия (#${disc[0].line}) — должно быть «Нет»`);
    } else if (disc.length && valid.length && !valid.some((e) => e.line < disc[0].line)) {
      v.push(`03: для «Да» нужна строка подтверждения личности раньше первого раскрытия (#${disc[0].line})`);
    }
  }
  if (code === '08' || isFlag(criterion)) {
    const allowed = criterion.flag_types || [];
    const bad = res.flag_types.filter((t) => !allowed.includes(t));
    if (bad.length) v.push(`${code}: недопустимые типы флага: ${bad.join(', ')} (разрешены: ${allowed.join(', ')})`);
    if (criterion.flags_config && res.flag_types.some((t) => criterion.flags_config[t] === false)) v.push(`${code}: тип ${res.flag_types.filter((t) => criterion.flags_config[t] === false).join(', ')} отключён в настройках критерия`);
    if (res.answer === 'yes') {
      if (!res.flag_types.length && allowed.length) v.push(`${code}: при «Да» нужен хотя бы один тип флага`);
      if (valid.length && !valid.some((e) => speakerOf(e.line) === 'operator')) v.push(`${code}: доказательство нарушения должно быть репликой оператора`);
    }
    if (res.answer === 'no' && res.flag_types.length) v.push(`${code}: при «Нет» список flag_types должен быть пустым`);
  }
  return v;
}

/** Last-resort automatic fixes that do not change the verdict (evidence to first operator line for 01, etc.). */
export function autoFix(res, criterion, conv) {
  const code = criterion.code || criterion.id.replace(/^c/, '');
  const facts = conv.facts || {};
  const n = conv.lines.length;
  const out = { ...res, evidence: res.evidence.filter((e) => Number.isInteger(e.line) && e.line >= 1 && e.line <= n) };
  if (code === '01' && facts.first_operator && !out.evidence.some((e) => e.line === facts.first_operator.line)) {
    out.evidence = [{ line: facts.first_operator.line, why: 'первая реплика оператора' }, ...out.evidence];
  }
  if (out.answer === 'no' && !out.checked_range) {
    const ops = conv.lines.filter((l) => l.speaker === 'operator');
    out.checked_range = ops.length ? [ops[0].n, ops[ops.length - 1].n] : [1, Math.max(1, n)];
  }
  if (out.checked_range) out.checked_range = [Math.max(1, out.checked_range[0]), Math.min(n, out.checked_range[1])];
  if (!out.applicable && !out.na_reason) out.na_reason = criterion.na_condition || 'Условие N/A выполнено.';
  if (isFlag(criterion) && out.answer === 'no') out.flag_types = [];
  // «Нет» for a flag (no violation found) needs evidence: the operator lines that were checked
  if (out.applicable && out.answer === 'no' && !out.evidence.some((e) => conv.lines[e.line - 1]?.speaker === 'operator')) {
    const ops = conv.lines.filter((l) => l.speaker === 'operator');
    if (ops.length) out.evidence = [...out.evidence, { line: ops[ops.length - 1].n, why: 'реплики оператора проверены' }];
  }
  return out;
}
