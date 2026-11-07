// Deterministic part of the evaluator:
//  - rule criteria (`evaluator: 'rule:<name>'`) — fully deterministic, no model call;
//  - fact-based hints for the LLM judge (pre-decisions for 01/03/07/08 and defaults for the rest);
//  - the `heuristic` judge: hints turned into complete results (baseline / fallback when no model is available).
import { isScale, isFlag, naAllowed, scaleSteps } from '../../packages/scoring/index.js';

export const NO_OPERATOR_REASON = 'Оператор не участвовал в диалоге';

const SENTENCE_RE = /[^.!?…]+[.!?…]*/gu;
const QUESTION_RE = /\?/u;
// client confirms the issue is resolved (RU / KZ / EN)
const CLIENT_CONFIRM_RE = /(спасибо|благодарю|понятно|понял|поняла|ясно|разобрал|получилось|нашёл|нашел|нашла|то,? что (я )?хотел|рақмет|рахмет|түсіндім|түсінікті|таптым|thank|thanks|got it|understood|that helps|found it|perfect)/iu;

function opLines(conv) { return conv.lines.filter((l) => l.speaker === 'operator'); }
function clientLines(conv) { return conv.lines.filter((l) => l.speaker === 'client'); }
function opRange(conv) {
  const ops = opLines(conv);
  return ops.length ? [ops[0].n, ops[ops.length - 1].n] : null;
}

export function baseResult(criterion, extra = {}) {
  return {
    criterion_id: criterion.id,
    applicable: true,
    na_reason: null,
    answer: null,
    scale_value: null,
    flag_types: [],
    evidence: [],
    checked_range: null,
    rule_applied: '',
    explanation: '',
    confidence: 0.5,
    source: 'rule',
    ...extra,
  };
}

/** Every criterion N/A because the operator never spoke. */
export function noOperatorResult(criterion) {
  return baseResult(criterion, {
    applicable: false,
    na_reason: NO_OPERATOR_REASON,
    rule_applied: 'operator_absent',
    explanation: `${NO_OPERATOR_REASON}: в транскрипте нет реплик оператора, критерий не применяется.`,
    confidence: 1,
    source: 'rule',
  });
}

// ---------- rule criteria ----------
const RULES = {
  first_reaction(conv, criterion) {
    const threshold = Number(criterion.params?.threshold_seconds ?? 180);
    const f = conv.facts || {};
    const sec = f.first_reaction_seconds;
    const first = f.first_operator?.line ?? null;
    const anchor = f.escalation_lines?.[0] ?? clientLines(conv)[0]?.n ?? null;
    if (sec == null || first == null) {
      if (naAllowed(criterion)) {
        return baseResult(criterion, { applicable: false, na_reason: 'Невозможно измерить время первой реакции (нет оператора или меток времени).', rule_applied: 'rule:first_reaction', confidence: 1 });
      }
      return baseResult(criterion, { answer: 'no', evidence: first ? [{ line: first, why: 'первая реплика оператора' }] : [], checked_range: opRange(conv) || [1, conv.lines.length], rule_applied: 'rule:first_reaction', explanation: 'Время первой реакции не измерено — нет меток времени.', confidence: 0.6 });
    }
    const ok = sec <= threshold;
    return baseResult(criterion, {
      answer: ok ? 'yes' : 'no',
      evidence: [{ line: first, why: `первая реплика оператора через ${Math.round(sec)} с после ${anchor ? `строки #${anchor}` : 'начала'}` }],
      checked_range: ok ? null : [anchor || 1, first],
      rule_applied: `rule:first_reaction (порог ${threshold} с)`,
      explanation: ok
        ? `Правило first_reaction: первая реакция оператора через ${Math.round(sec)} с — в пределах порога ${threshold} с.`
        : `Правило first_reaction: первая реакция оператора через ${Math.round(sec)} с — порог ${threshold} с превышен.`,
      confidence: 1,
    });
  },
};

export function isRuleCriterion(c) { return typeof c.evaluator === 'string' && c.evaluator.startsWith('rule:'); }

export function applyRule(conv, criterion) {
  const name = criterion.evaluator.slice('rule:'.length);
  const fn = RULES[name];
  if (!fn) {
    return baseResult(criterion, {
      applicable: naAllowed(criterion) ? false : true,
      na_reason: naAllowed(criterion) ? `Правило «${name}» не реализовано.` : null,
      answer: naAllowed(criterion) ? null : 'no',
      checked_range: naAllowed(criterion) ? null : (opRange(conv) || [1, Math.max(1, conv.lines.length)]),
      rule_applied: `rule:${name}`,
      explanation: `Правило «${name}» неизвестно системе; результат консервативный.`,
      confidence: 0.3,
    });
  }
  return { ...fn(conv, criterion), source: 'rule' };
}

// ---------- fact-based hints ----------
/**
 * Hint = { value: {applicable, answer?, scale_value?, flag_types?}, confidence, evidence, checked_range, rule, text }.
 * `text` is the Russian one-liner shown to the model inside <FACTS>; `value` is also the heuristic judge's answer.
 */
export function hintFor(conv, criterion) {
  const code = criterion.code || criterion.id.replace(/^c/, '');
  const f = conv.facts || {};
  const ops = opLines(conv);
  const range = opRange(conv);
  const H = (value, confidence, evidence, rule, text, checked_range = null) => ({ value, confidence, evidence, checked_range, rule, text });
  switch (code) {
    case '01': {
      const fo = f.first_operator;
      if (!fo) return null;
      const ok = fo.greeting_in_client_language && fo.introduction;
      const parts = [`приветствие на языке клиента (${f.client_language}): ${fo.greeting_in_client_language ? 'да' : 'нет'}`, `представление (имя/[Имя скрыто]): ${fo.introduction ? 'да' : 'нет'}`];
      return H({ applicable: true, answer: ok ? 'yes' : 'no' }, ok ? 0.85 : 0.75,
        [{ line: fo.line, why: 'первая реплика оператора' }], '01: приветствие+имя в первой реплике',
        `01: первая реплика оператора — #${fo.line}; ${parts.join('; ')} → предварительно ${ok ? 'Да' : 'Нет'}`, ok ? null : [fo.line, fo.line]);
    }
    case '02': {
      const fo = f.first_operator;
      if (!fo) return null;
      const asks = QUESTION_RE.test(fo.text);
      const value = asks ? { applicable: true, answer: 'yes' } : (naAllowed(criterion) ? { applicable: false } : { applicable: true, answer: 'yes' });
      return H(value, 0.4, [{ line: fo.line, why: asks ? 'оператор задаёт уточняющий вопрос' : 'оператор отвечает без уточнений' }],
        '02: уточнение/использование известных деталей',
        `02: первая реплика оператора ${asks ? 'содержит вопрос' : 'не содержит вопроса'}; проверьте, не переспрашивает ли он то, что клиент уже сообщил (строки клиента до #${fo.line})`,
        null);
    }
    case '03': {
      const verified = f.identity_verified_lines || [];
      const disc = f.disclosure_signals || [];
      const before = f.disclosure_before_verification || [];
      if (!verified.length && !disc.length) {
        return H({ applicable: false }, 0.65, [], '03: нет раскрытия данных счёта',
          '03: событие подтверждения личности отсутствует; сигналов раскрытия данных счёта не найдено → вероятно N/A (проверьте, не раскрыты/обещаны ли данные или действия по счёту)');
      }
      if (before.length) {
        const d = before[0];
        return H({ applicable: true, answer: 'no' }, verified.length ? 0.8 : 0.7, [{ line: d.line, why: `раскрытие данных счёта («${d.matches[0]}») без подтверждения личности` }],
          '03: раскрытие до подтверждения личности',
          `03: раскрытие данных счёта в #${d.line} РАНЬШЕ подтверждения личности (${verified.length ? `подтверждение в #${verified[0]}` : 'подтверждения нет'}) → предварительно Нет`, [1, d.line]);
      }
      const v = verified[0];
      const evidence = [{ line: v, why: 'подтверждение личности' }];
      if (disc.length) evidence.push({ line: disc[0].line, why: 'раскрытие данных счёта после подтверждения' });
      return H({ applicable: true, answer: 'yes' }, 0.8, evidence, '03: подтверждение раньше раскрытия',
        `03: подтверждение личности в #${v}${disc.length ? `, раскрытие данных счёта в #${disc[0].line} (после)` : ''} → предварительно Да`);
    }
    case '04': {
      if (!range) return null;
      const lo = f.last_operator;
      const openQ = (lo?.client_lines_after || []).some((n) => QUESTION_RE.test(conv.lines[n - 1]?.text || ''));
      const steps = scaleSteps(criterion);
      const max = Math.max(...steps);
      const mid = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)];
      const value = { applicable: true, scale_value: openQ ? mid : max };
      return H(value, 0.35, [{ line: lo?.line ?? range[1], why: 'последний ответ оператора' }], '04: существенные вопросы клиента закрыты?',
        `04: ${openQ ? `после последней реплики оператора остался вопрос клиента (#${lo.client_lines_after.join(', #')})` : 'после последней реплики оператора вопросов клиента нет'}; перечислите существенные вопросы клиента и проверьте каждый`);
    }
    case '05': {
      if (!range) return null;
      const ins = f.insult_signals || [];
      const comp = f.complaint_signals || [];
      const lo = f.last_operator;
      const closedOnClient = f.end_event?.type === 'operator_closed' && (lo?.client_lines_after || []).length > 0;
      if (ins.length) return H({ applicable: true, answer: 'no' }, 0.85, [{ line: ins[0].line, why: 'оскорбление' }], '05: грубость', `05: оскорбление в #${ins[0].line} → Нет`, range);
      return H({ applicable: true, answer: closedOnClient ? 'no' : 'yes' }, closedOnClient ? 0.55 : 0.5,
        [{ line: lo?.line ?? range[1], why: 'тон последней реплики оператора' }], '05: вежливость и реакция на проблему',
        `05: сигналов грубости нет; жалобы/недовольство клиента: ${comp.length ? `#${comp.map((c) => c.line).join(', #')} — проверьте реакцию оператора` : 'не найдены'}${closedOnClient ? '; оператор закрыл чат при реплике клиента после его последнего ответа' : ''}`,
        closedOnClient ? range : null);
    }
    case '06': {
      if (!range) return null;
      const waits = f.waits_over_90s || [];
      const unwarned = waits.filter((w) => !w.warned);
      const steps = scaleSteps(criterion).sort((a, b) => a - b);
      const max = steps[steps.length - 1];
      let val = max;
      if (unwarned.length === 1) val = steps[Math.max(0, steps.length - 2)];
      if (unwarned.length >= 2) val = steps[Math.max(0, steps.length - 3)];
      const txt = waits.length
        ? waits.map((w) => `пауза ${Math.round(w.seconds)} с между #${w.from_line} и #${w.to_line} (${w.warned ? 'предупреждение было' : 'БЕЗ предупреждения'})`).join('; ')
        : 'пауз > 90 с в середине диалога нет';
      const holds = (f.segments || []).filter((s) => s.kind === 'hold');
      return H({ applicable: true, scale_value: val }, 0.4, [{ line: unwarned[0]?.to_line ?? range[0], why: unwarned.length ? 'реплика после необъявленной паузы' : 'реплики оператора' }],
        '06: ясность, порядок, предупреждение об ожидании', `06: ${txt}${holds.length ? `; удержаний в звонке: ${holds.length}` : ''}; проверьте, пришлось ли клиенту переспрашивать`);
    }
    case '07': {
      const lo = f.last_operator;
      if (!lo) return null;
      const sentences = (lo.text.match(SENTENCE_RE) || []).map((s) => s.trim()).filter(Boolean);
      const clientAfter = lo.client_lines_after || [];
      const dropped = f.end_event?.type === 'client_left' || (f.client_left_lines || []).length > 0;
      const openQ = clientAfter.some((n) => QUESTION_RE.test(conv.lines[n - 1]?.text || ''));
      // closing context: the client's last message before the operator's final line
      const prevClient = conv.lines.slice(0, lo.line - 1).reverse().find((l) => l.speaker === 'client');
      const prevQ = !!prevClient && QUESTION_RE.test(prevClient.text);
      const clientConfirmed = !!prevClient && !prevQ && CLIENT_CONFIRM_RE.test(prevClient.text);
      if (lo.farewell && prevQ && !openQ && !lo.offer_help) {
        return H({ applicable: true, answer: 'no' }, 0.65, [{ line: prevClient.n, why: 'вопрос клиента перед завершением' }, { line: lo.line, why: 'прощание без ответа на этот вопрос' }], '07: прощание при открытом вопросе', `07: клиент задал вопрос (#${prevClient.n}), а последняя реплика оператора #${lo.line} завершает диалог прощанием → предварительно Нет (проверьте, закрыт ли вопрос)`, [prevClient.n, conv.lines.length]);
      }
      if (lo.farewell && clientConfirmed && !openQ) {
        return H({ applicable: true, answer: 'yes' }, 0.75, [{ line: prevClient.n, why: 'клиент подтвердил, что вопрос решён' }, { line: lo.line, why: 'прощание оператора' }], '07: решение подтверждено + прощание', `07: клиент подтвердил решение (#${prevClient.n}: «${prevClient.text.slice(0, 40)}»), оператор попрощался (#${lo.line}) → предварительно Да`);
      }
      if (lo.farewell && (lo.offer_help || sentences.length >= 2) && !openQ) {
        return H({ applicable: true, answer: 'yes' }, 0.75, [{ line: lo.line, why: 'прощание + итог/предложение помощи' }], '07: прощание + итог', `07: последняя реплика оператора #${lo.line} содержит прощание и ${lo.offer_help ? 'предложение помощи' : 'ещё одно предложение (итог/подтверждение)'} → предварительно Да`);
      }
      if (!lo.farewell && dropped && naAllowed(criterion)) {
        return H({ applicable: false }, 0.6, [{ line: lo.line, why: 'последняя реплика оператора до обрыва' }], '07: обрыв связи', `07: прощания нет, связь/клиент прервал диалог (${(f.client_left_lines || []).map((n) => `#${n}`).join(', ') || 'событие'}) → вероятно N/A, если оператор не успел завершить`);
      }
      const why = !lo.farewell ? 'нет прощания' : openQ ? 'прощание при открытом вопросе клиента' : 'только прощание без итога/предложения помощи';
      return H({ applicable: true, answer: 'no' }, 0.6, [{ line: lo.line, why }], '07: завершение неполное', `07: последняя реплика оператора #${lo.line} («${lo.text.slice(0, 60)}») — ${why} → предварительно Нет`, [lo.line, conv.lines.length]);
    }
    case '08': {
      if (!range) return null;
      const types = [];
      const ev = [];
      const allowed = criterion.flag_types || ['insult', 'bypass', 'disclosure'];
      const discOn = criterion.flags_config?.disclosure !== false;
      for (const s of f.insult_signals || []) { if (allowed.includes('insult') && !types.includes('insult')) types.push('insult'); ev.push({ line: s.line, why: `оскорбление («${s.matches[0]}»)` }); }
      for (const s of f.bypass_signals || []) { if (allowed.includes('bypass') && !types.includes('bypass')) types.push('bypass'); ev.push({ line: s.line, why: `предложение услуги в обход компании («${s.matches[0]}»)` }); }
      if (discOn && allowed.includes('disclosure')) for (const s of f.disclosure_before_verification || []) { if (!types.includes('disclosure')) types.push('disclosure'); ev.push({ line: s.line, why: 'данные счёта без подтверждения личности' }); }
      if (types.length) return H({ applicable: true, answer: 'yes', flag_types: types }, 0.8, ev, '08: лексические сигналы нарушения', `08: сигналы нарушений — ${types.join(', ')} (${ev.map((e) => `#${e.line}`).join(', ')}) → предварительно Да; подтвердите по тексту`);
      return H({ applicable: true, answer: 'no', flag_types: [] }, 0.7, [{ line: range[1], why: 'реплики оператора проверены' }], '08: нарушений не найдено', `08: лексических сигналов оскорбления/обхода/раскрытия нет → предварительно Нет (проверьте текст оператора целиком)${discOn ? '' : '; тип disclosure отключён в настройках критерия'}`, range);
    }
    default:
      return null;
  }
}

/** Hints as text for the prompt (only for requested criteria). */
export function renderHints(conv, criteria) {
  return criteria.map((c) => hintFor(conv, c)?.text).filter(Boolean);
}

/** Complete heuristic result (no model): used as baseline and as conservative fallback. */
export function heuristicResult(conv, criterion, { fallback = false, issues = [] } = {}) {
  const h = hintFor(conv, criterion);
  const range = opRange(conv) || [1, Math.max(1, conv.lines.length)];
  if (!h) {
    // unknown custom criterion: conservative
    const r = baseResult(criterion, { rule_applied: 'heuristic:unknown', confidence: 0.3, source: 'rule' });
    if (isFlag(criterion)) { r.answer = 'no'; r.flag_types = []; r.checked_range = range; r.explanation = 'Детерминированных сигналов нарушения нет; модель недоступна.'; }
    else if (naAllowed(criterion)) { r.applicable = false; r.na_reason = 'Автоматическая оценка недоступна, критерий требует ручной проверки.'; r.explanation = r.na_reason; }
    else if (isScale(criterion)) { const s = scaleSteps(criterion).sort((a, b) => a - b); r.scale_value = s[Math.floor(s.length / 2)]; r.explanation = 'Средний шаг шкалы: модель недоступна, требуется ручная проверка.'; }
    else { r.answer = 'no'; r.checked_range = range; r.explanation = 'Консервативная оценка: модель недоступна, требуется ручная проверка.'; }
    r.evidence = [{ line: range[1], why: 'последняя реплика оператора' }];
    return r;
  }
  const v = h.value;
  const r = baseResult(criterion, {
    applicable: v.applicable !== false,
    na_reason: v.applicable === false ? (criterion.na_condition || 'Условие N/A выполнено по фактам транскрипта.') : null,
    answer: v.answer ?? null,
    scale_value: v.scale_value ?? null,
    flag_types: v.flag_types || [],
    evidence: h.evidence.length ? h.evidence : [{ line: range[1], why: 'реплики оператора' }],
    checked_range: h.checked_range || (v.answer === 'no' ? range : null),
    rule_applied: h.rule,
    explanation: `${h.text}.`,
    confidence: Math.min(fallback ? 0.5 : 0.95, h.confidence),
    source: 'rule',
  });
  if (fallback) {
    r.explanation = `Консервативная оценка по фактам транскрипта (ответ модели не прошёл проверку: ${issues.slice(0, 3).join('; ') || 'нет ответа'}). ${h.text}.`;
    r.rule_applied = `fallback:${h.rule}`;
  }
  return r;
}
