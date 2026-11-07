// Deterministic part of the evaluator:
//  - rule criteria (`evaluator: 'rule:<name>'`) — fully deterministic, no model call;
//  - fact-based hints for the LLM judge (pre-decisions for 01/03/07/08 and defaults for the rest);
//  - the `heuristic` judge: hints turned into complete results (baseline / fallback when no model is available).
// All human-facing texts follow the QA style: «<Критерий> — <Ответ>. <Почему>. Основание — <строки и что они показывают>.»
import { isScale, isFlag, naAllowed, scaleSteps } from '../../packages/scoring/index.js';

export const NO_OPERATOR_REASON = 'Оператор не участвовал в диалоге';

const SENTENCE_RE = /[^.!?…]+[.!?…]*/gu;
const QUESTION_RE = /\?/u;
// 07: phrases that are pure courtesy or farewell. A closing made only of these is not a summary, next step or offer of help
// (checklist: «подвёл итог или предложил дальнейшую помощь и попрощался»).
const COURTESY_RE = /(всегда\s+)?пожалуйста|отлично|хорошо|ладно|конечно|рад[аы]?(\s+был[аи]?)?\s+помочь|спасибо(\s+(за\s+(обращение|ожидание|терпение)|что\s+(обратились|подождали)))?|благодарю(\s+за\s+обращение)?|до\s+свидания|всего\s+(доброго|хорошего)|хорошего\s+(дня|вечера)|удачного\s+дня|оқасы\s+жоқ|жақсы|жарайды|рақмет|рахмет|көмегім\s+тигеніне\s+қуаныштымын|көмектескеніме\s+қуаныштымын|сау\s+болыңыз|қош\s+болыңыз|күніңіз\s+сәтті\s+өтсін|you'?re\s+welcome|great|ok(ay)?|of\s+course|sure|happy\s+to\s+help|glad\s+(to\s+help|i\s+could\s+help|you\s+got\s+in|it\s+worked)|thanks?(\s+you)?(\s+for\s+(reaching\s+out|contacting\s+us|your\s+patience|waiting))?|good\s*bye|bye|take\s+care|have\s+a\s+(good|great|nice)\s+(day|evening|one)|\band\b/giu;
/** True when a sentence carries content beyond courtesy and farewell (a summary, next step or instruction). */
function substantive(sentence) {
  const rest = String(sentence || '').replace(COURTESY_RE, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return rest.split(/\s+/).filter((w) => w.length >= 3).length >= 2;
}
// client confirms the issue is resolved (RU / KZ / EN)
const CLIENT_CONFIRM_RE = /(спасибо|благодарю|понятно|понял|поняла|ясно|разобрал|получилось|нашёл|нашел|нашла|то,? что (я )?хотел|рақмет|рахмет|түсіндім|түсінікті|таптым|thank|thanks|got it|understood|that helps|found it|perfect)/iu;

const LANG_RU = { RU: 'русском', KZ: 'казахском', EN: 'английском' };
const FLAG_RU = { insult: 'оскорбление клиента', bypass: 'предложение услуги в обход компании', disclosure: 'раскрытие данных счёта без подтверждения личности' };

function opLines(conv) { return conv.lines.filter((l) => l.speaker === 'operator'); }
function clientLines(conv) { return conv.lines.filter((l) => l.speaker === 'client'); }
function opRange(conv) {
  const ops = opLines(conv);
  return ops.length ? [ops[0].n, ops[ops.length - 1].n] : null;
}

// ---------- text helpers ----------
/** Short quote of a line for the explanation («…»). */
function quote(text, max = 60) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return `«${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}»`;
}
const refs = (lines) => lines.map((n) => `#${n}`).join(', ');
/** Russian plural: plural(2, 'реплика', 'реплики', 'реплик') → «2 реплики». */
function plural(n, one, few, many) {
  const m10 = n % 10; const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}
/** Human label of a decision: Да / Нет / N/A / «N из M». */
export function decisionLabel(criterion, value) {
  if (!value || value.applicable === false) return 'N/A';
  if (value.scale_value != null) return `${value.scale_value} из ${Math.max(...scaleSteps(criterion))}`;
  return value.answer === 'yes' ? 'Да' : 'Нет';
}
/** «<Критерий> — <Ответ>. <Причина>. Основание — <что показывают строки>.» */
function explain(criterion, value, reason, basis) {
  const end = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);
  return `${criterion.title} — ${decisionLabel(criterion, value)}. ${end(reason)} Основание — ${end(basis)}`;
}
/** At most `max` lines: the first ones and the last one (long calls). */
function sample(lines, max = 6) {
  return lines.length <= max ? lines : [...lines.slice(0, max - 1), lines[lines.length - 1]];
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
    rule_applied: 'Оператор не участвовал в диалоге',
    explanation: `${criterion.title} — N/A. Оператор не участвовал в диалоге, оценивать нечего. Основание — в транскрипте нет ни одной реплики оператора.`,
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
    const ruleName = `Первая реакция не позднее ${threshold} с после обращения`;
    if (sec == null || first == null) {
      if (naAllowed(criterion)) {
        return baseResult(criterion, { applicable: false, na_reason: 'Время первой реакции измерить невозможно: нет реплики оператора или меток времени.', rule_applied: ruleName, explanation: explain(criterion, { applicable: false }, 'Время первой реакции измерить невозможно', first ? `у реплики оператора #${first} или обращения клиента нет метки времени` : 'в транскрипте нет реплики оператора'), confidence: 1 });
      }
      return baseResult(criterion, { answer: 'no', evidence: first ? [{ line: first, why: 'первая реплика оператора' }] : [], checked_range: opRange(conv) || [1, conv.lines.length], rule_applied: ruleName, explanation: explain(criterion, { answer: 'no' }, 'Время первой реакции подтвердить нельзя: в транскрипте нет меток времени', first ? `первая реплика оператора #${first} без метки времени` : 'реплик оператора нет'), confidence: 0.6 });
    }
    const ok = sec <= threshold;
    const from = anchor ? `после обращения клиента #${anchor}` : 'после начала диалога';
    const basis = `первая реплика оператора #${first}${anchor ? ` и обращение клиента #${anchor}` : ''} по меткам времени`;
    return baseResult(criterion, {
      answer: ok ? 'yes' : 'no',
      evidence: [{ line: first, why: `первая реплика оператора через ${Math.round(sec)} с ${from}` }],
      checked_range: ok ? null : [anchor || 1, first],
      rule_applied: ruleName,
      explanation: ok
        ? explain(criterion, { answer: 'yes' }, `Оператор ответил через ${Math.round(sec)} с ${from} — в пределах порога ${threshold} с`, basis)
        : explain(criterion, { answer: 'no' }, `Оператор ответил только через ${Math.round(sec)} с ${from}, порог ${threshold} с превышен`, basis),
      confidence: 1,
    });
  },
};

export function isRuleCriterion(c) { return typeof c.evaluator === 'string' && c.evaluator.startsWith('rule:'); }

export function applyRule(conv, criterion) {
  const name = criterion.evaluator.slice('rule:'.length);
  const fn = RULES[name];
  if (!fn) {
    const na = naAllowed(criterion);
    return baseResult(criterion, {
      applicable: na ? false : true,
      na_reason: na ? `Правило «${name}» системе неизвестно, автоматическая оценка невозможна.` : null,
      answer: na ? null : 'no',
      checked_range: na ? null : (opRange(conv) || [1, Math.max(1, conv.lines.length)]),
      rule_applied: `Правило «${name}» не реализовано`,
      explanation: explain(criterion, na ? { applicable: false } : { answer: 'no' }, `Правило «${name}» системе неизвестно, выставлена консервативная оценка; нужна ручная проверка`, 'настройка критерия в чек-листе, транскрипт не анализировался'),
      confidence: 0.3,
    });
  }
  return { ...fn(conv, criterion), source: 'rule' };
}

// ---------- fact-based hints ----------
/**
 * Hint = { value: {applicable, answer?, scale_value?, flag_types?}, confidence, evidence, checked_range, rule, text }.
 * `text` is the Russian justification shown to the model inside <FACTS> and to the jury on the card; `value` is also the heuristic judge's answer.
 */
export function hintFor(conv, criterion) {
  const code = criterion.code || criterion.id.replace(/^c/, '');
  const f = conv.facts || {};
  const ops = opLines(conv);
  const range = opRange(conv);
  const line = (n) => conv.lines[n - 1];
  const H = (value, confidence, evidence, rule, reason, basis, checked_range = null) => ({ value, confidence, evidence, checked_range, rule, text: explain(criterion, value, reason, basis) });
  switch (code) {
    case '01': {
      const fo = f.first_operator;
      if (!fo) return null;
      const ok = fo.greeting_in_client_language && fo.introduction;
      const lang = LANG_RU[f.client_language] || f.client_language;
      const missing = [];
      if (!fo.greeting_in_client_language) missing.push(`приветствия на языке клиента (${lang})`);
      if (!fo.introduction) missing.push('представления по имени');
      return H({ applicable: true, answer: ok ? 'yes' : 'no' }, ok ? 0.85 : 0.75,
        [{ line: fo.line, why: ok ? 'приветствие на языке клиента и имя оператора' : `нет ${missing.join(' и ')}` }],
        'Приветствие на языке клиента и имя в первой реплике оператора',
        ok ? `В первой реплике оператор поздоровался на ${lang} языке и представился` : `В первой реплике оператора нет ${missing.join(' и ')}`,
        `первая реплика оператора #${fo.line} ${quote(fo.text)}`,
        ok ? null : [fo.line, fo.line]);
    }
    case '02': {
      const fo = f.first_operator;
      if (!fo) return null;
      const asks = QUESTION_RE.test(fo.text);
      const value = asks ? { applicable: true, answer: 'yes' } : (naAllowed(criterion) ? { applicable: false } : { applicable: true, answer: 'yes' });
      // the client's request with details: the last substantive client line before the operator (not a one-word «да» to the bot)
      const prior = clientLines(conv).filter((l) => l.n < fo.line);
      const req = prior.filter((l) => l.text.replace(/\[[^\]]*\]/g, '').trim().length > 12).pop() || prior[0];
      const evidence = [];
      if (req) evidence.push({ line: req.n, why: 'запрос клиента с известными деталями' });
      evidence.push({ line: fo.line, why: asks ? 'уточняющий вопрос оператора' : 'ответ оператора без уточнений' });
      const basis = `${req ? `запрос клиента #${req.n} ${quote(req.text, 50)} и ` : ''}первая реплика оператора #${fo.line} ${quote(fo.text, 50)}`;
      if (asks) return H(value, 0.4, evidence, 'Уточняющий вопрос до ответа', 'Оператор до ответа уточнил недостающие детали запроса', basis);
      if (value.applicable === false) return H(value, 0.4, evidence, 'Данных для ответа хватало с самого начала', 'Данных для ответа хватало с самого начала: клиент изложил запрос, и оператор ответил по известным деталям без уточнений', basis);
      return H(value, 0.4, evidence, 'Ответ по известным деталям без уточнений', 'Оператор ответил, опираясь на детали, которые клиент уже сообщил', basis);
    }
    case '03': {
      const verified = [...(f.identity_verified_lines || []), ...(f.spoken_identity_lines || [])].sort((a, b) => a - b);
      const disc = f.disclosure_signals || [];
      const before = f.disclosure_before_verification || [];
      if (!verified.length && !disc.length) {
        const shown = sample(ops.map((l) => l.n), 4);
        return H({ applicable: false }, 0.65, shown.map((n) => ({ line: n, why: 'общая информация, данные счёта не раскрыты' })),
          'Идентификация не требовалась: раскрытия данных счёта нет',
          'Запрос не требовал идентификации: оператор дал общую информацию (навигация, продукты, процессы), данные конкретного счёта не раскрыл и защищённых действий не обещал',
          `реплики оператора ${refs(shown)} содержат только общие сведения; системного события «Личность клиента подтверждена» в диалоге нет`);
      }
      if (before.length) {
        const d = before[0];
        const evidence = [{ line: d.line, why: `данные счёта (${quote(d.matches[0], 30)}) без подтверждения личности` }];
        if (verified.length) evidence.push({ line: verified[0], why: 'подтверждение личности уже после раскрытия' });
        return H({ applicable: true, answer: 'no' }, verified.length ? 0.8 : 0.7, evidence,
          'Раскрытие данных счёта до подтверждения личности',
          `Оператор раскрыл данные счёта (${quote(d.matches[0], 30)}) ${verified.length ? `до подтверждения личности — оно появилось только в #${verified[0]}` : 'без подтверждения личности: такого события в диалоге нет'}`,
          `реплика оператора #${d.line} ${quote(line(d.line)?.text, 50)}${verified.length ? ` и системное сообщение #${verified[0]}, которое стоит позже` : ''}`,
          [1, d.line]);
      }
      const v = verified[0];
      const evidence = [{ line: v, why: 'подтверждение личности' }];
      if (disc.length) evidence.push({ line: disc[0].line, why: 'данные счёта раскрыты после подтверждения' });
      return H({ applicable: true, answer: 'yes' }, 0.8, evidence, 'Подтверждение личности раньше раскрытия данных',
        disc.length ? 'Личность клиента подтверждена до того, как оператор раскрыл данные счёта' : 'Личность клиента подтверждена, данные счёта до этого не раскрывались',
        `системное сообщение «Личность клиента подтверждена» #${v}${disc.length ? `, данные счёта оператор сообщает в #${disc[0].line} — после подтверждения` : '; явного раскрытия данных счёта в репликах оператора не найдено'}`);
    }
    case '04': {
      if (!range) return null;
      const lo = f.last_operator;
      const after = lo?.client_lines_after || [];
      const openLines = after.filter((n) => QUESTION_RE.test(line(n)?.text || ''));
      const openQ = openLines.length > 0;
      const steps = scaleSteps(criterion);
      const max = Math.max(...steps);
      const mid = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)];
      const value = { applicable: true, scale_value: openQ ? mid : max };
      const last = lo?.line ?? range[1];
      const evidence = [{ line: last, why: 'последний ответ оператора' }, ...openLines.map((n) => ({ line: n, why: 'вопрос клиента без ответа' }))];
      return H(value, 0.35, evidence, openQ ? 'Вопрос клиента после последнего ответа оператора остался без ответа' : 'Открытых вопросов клиента после последнего ответа нет',
        openQ ? `После последнего ответа оператора клиент задал вопрос (${refs(openLines)}), который остался без ответа, поэтому существенный вопрос считается открытым` : 'После последнего ответа оператора вопросов у клиента не осталось',
        `последняя реплика оператора #${last} ${quote(lo?.text || line(last)?.text, 50)}${openQ ? ` и вопрос клиента ${refs(openLines)} ${quote(line(openLines[0])?.text, 50)}` : ', реплик клиента с вопросами после неё нет'}`);
    }
    case '05': {
      if (!range) return null;
      const ins = f.insult_signals || [];
      const comp = f.complaint_signals || [];
      const lo = f.last_operator;
      const closedOnClient = f.end_event?.type === 'operator_closed' && (lo?.client_lines_after || []).length > 0;
      if (ins.length) return H({ applicable: true, answer: 'no' }, 0.85, [{ line: ins[0].line, why: `оскорбление (${quote(ins[0].matches[0], 30)})` }], 'Оскорбление клиента в реплике оператора', `Оператор допустил оскорбительную формулировку в адрес клиента (${quote(ins[0].matches[0], 30)})`, `реплика оператора #${ins[0].line} ${quote(line(ins[0].line)?.text, 50)}`, range);
      const last = lo?.line ?? range[1];
      const compNote = comp.length ? `клиент выражал недовольство (${refs(comp.map((c) => c.line))})` : '';
      if (closedOnClient) {
        const evidence = [{ line: last, why: 'последний ответ оператора' }, { line: lo.client_lines_after[0], why: 'реплика клиента, оставшаяся без ответа' }];
        if (f.end_event?.line) evidence.push({ line: f.end_event.line, why: 'закрытие чата оператором' });
        return H({ applicable: true, answer: 'no' }, 0.55, evidence, 'Чат закрыт при реплике клиента без ответа',
          `Оператор закрыл чат, не ответив на реплику клиента ${refs(lo.client_lines_after)}${compNote ? `; до этого ${compNote}` : ''}`,
          `последняя реплика оператора #${last}, сообщение клиента #${lo.client_lines_after[0]} ${quote(line(lo.client_lines_after[0])?.text, 50)} и сообщение о закрытии чата #${f.end_event.line}`, range);
      }
      const evidence = [{ line: last, why: 'тон последней реплики оператора' }, ...comp.slice(0, 2).map((c) => ({ line: c.line, why: 'недовольство клиента' }))];
      return H({ applicable: true, answer: 'yes' }, 0.5, evidence, 'Вежливый тон, грубости нет',
        comp.length ? `Оператор вежлив: ${compNote}, грубости или отмахивания в ответах оператора нет, диалог доведён до ответа` : 'Оператор вежлив: грубости, сарказма и отмахивания в его репликах нет, недовольства клиент не выражал',
        `реплики оператора #${range[0]}–#${range[1]}${comp.length ? `, реплика клиента с недовольством #${comp[0].line} ${quote(line(comp[0].line)?.text, 50)}` : ''}; последняя реплика оператора #${last} ${quote(lo?.text || line(last)?.text, 50)}`);
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
      const holds = (f.segments || []).filter((s) => s.kind === 'hold');
      const holdNote = holds.length ? ` Удержаний в звонке: ${holds.length}.` : '';
      const pause = (w) => `пауза ${Math.round(w.seconds)} с между #${w.from_line} и #${w.to_line}`;
      if (unwarned.length) {
        return H({ applicable: true, scale_value: val }, 0.4, unwarned.slice(0, 3).map((w) => ({ line: w.to_line, why: `ответ после паузы ${Math.round(w.seconds)} с без предупреждения` })),
          'Пауза в середине диалога без предупреждения об ожидании',
          `Оператор не предупредил клиента об ожидании: ${unwarned.map(pause).join('; ')} — без слов «сейчас проверю» или «прошу ожидать»${unwarned.length >= 2 ? '; таких пауз несколько' : ''}.${holdNote}`,
          `реплики оператора ${refs(unwarned.map((w) => w.to_line))} и метки времени предыдущих реплик ${refs(unwarned.map((w) => w.from_line))}`);
      }
      return H({ applicable: true, scale_value: val }, 0.4, [{ line: waits.length ? waits[0].to_line : range[0], why: waits.length ? 'ответ после объявленной паузы' : 'реплики оператора' }],
        waits.length ? 'Паузы объявлены заранее, ответы связные' : 'Длительных пауз нет, ответы связные',
        waits.length ? `Ответы оператора связные; ${waits.map(pause).join('; ')} — об ожидании оператор предупредил заранее.${holdNote}` : `Ответы оператора ясные и связные, пауз дольше 90 с в середине диалога нет.${holdNote}`,
        `реплики оператора #${range[0]}–#${range[1]}${waits.length ? `, предупреждение об ожидании перед ${refs(waits.map((w) => w.to_line))}` : ' и метки времени между ними'}`);
    }
    case '07': {
      const lo = f.last_operator;
      if (!lo) return null;
      const sentences = (lo.text.match(SENTENCE_RE) || []).map((s) => s.trim()).filter(Boolean);
      const clientAfter = lo.client_lines_after || [];
      const dropped = f.end_event?.type === 'client_left' || (f.client_left_lines || []).length > 0;
      const openLines = clientAfter.filter((n) => QUESTION_RE.test(line(n)?.text || ''));
      const openQ = openLines.length > 0;
      // closing context: the client's last message before the operator's final line
      const prevClient = conv.lines.slice(0, lo.line - 1).reverse().find((l) => l.speaker === 'client');
      const prevQ = !!prevClient && QUESTION_RE.test(prevClient.text);
      const clientConfirmed = !!prevClient && !prevQ && CLIENT_CONFIRM_RE.test(prevClient.text);
      const lastRef = `последняя реплика оператора #${lo.line} ${quote(lo.text)}`;
      if (lo.farewell && prevQ && !openQ && !lo.offer_help) {
        return H({ applicable: true, answer: 'no' }, 0.65, [{ line: prevClient.n, why: 'вопрос клиента перед завершением' }, { line: lo.line, why: 'прощание без ответа на этот вопрос' }],
          'Прощание при открытом вопросе клиента',
          `Клиент задал вопрос (#${prevClient.n} ${quote(prevClient.text, 50)}), а оператор завершил диалог прощанием, не ответив на него`,
          `сообщение клиента #${prevClient.n} и ${lastRef}`, [prevClient.n, conv.lines.length]);
      }
      const summary = sentences.some(substantive);
      if (lo.farewell && (lo.offer_help || summary) && !openQ) {
        const evidence = prevClient ? [{ line: prevClient.n, why: 'последнее сообщение клиента перед завершением' }] : [];
        evidence.push({ line: lo.line, why: lo.offer_help ? 'прощание и предложение помощи' : 'прощание и итог' });
        return H({ applicable: true, answer: 'yes' }, 0.75, evidence, 'Прощание с итогом или предложением помощи',
          `Оператор завершил диалог прощанием и ${lo.offer_help ? 'предложением дальнейшей помощи' : 'итогом по вопросу'}; открытых вопросов клиента после этого нет`,
          `${lastRef}${prevClient ? `, перед ней сообщение клиента #${prevClient.n} без вопроса` : ''}`);
      }
      if (!lo.farewell && dropped && naAllowed(criterion)) {
        const leftLine = f.end_event?.type === 'client_left' ? f.end_event.line : (f.client_left_lines || [])[0];
        const evidence = [{ line: lo.line, why: 'последняя реплика оператора до обрыва' }];
        if (leftLine) evidence.push({ line: leftLine, why: 'клиент покинул чат / связь прервалась' });
        return H({ applicable: false }, 0.6, evidence, 'Чат оборвался до возможности его завершить',
          'Чат оборвался до того, как оператор мог его завершить: клиент покинул диалог или связь прервалась, прощания оператор дать не успел',
          `${lastRef}${leftLine ? ` и системное сообщение об уходе клиента #${leftLine}` : ''}`);
      }
      const closedLine = f.end_event?.type === 'operator_closed' ? f.end_event.line : null;
      const why = !lo.farewell ? 'нет прощания' : openQ ? 'прощание при открытом вопросе клиента' : 'только прощание без итога и предложения помощи';
      const reason = !lo.farewell
        ? `Оператор ${closedLine ? 'закрыл чат' : 'завершил диалог'} без прощания`
        : openQ ? `Оператор попрощался, хотя вопрос клиента (${refs(openLines)} ${quote(line(openLines[0])?.text, 50)}) остался без ответа`
          : clientConfirmed ? 'Клиент поблагодарил, но оператор ответил только вежливой фразой и прощанием — без итога, следующего шага или предложения дальнейшей помощи'
          : 'Оператор только попрощался, не подведя итог и не предложив дальнейшую помощь';
      const evidence = [{ line: lo.line, why }, ...openLines.slice(0, 1).map((n) => ({ line: n, why: 'вопрос клиента без ответа' }))];
      if (closedLine) evidence.push({ line: closedLine, why: 'сообщение о закрытии чата' });
      return H({ applicable: true, answer: 'no' }, 0.6, evidence, 'Завершение без прощания или без итога',
        reason, `${lastRef}${closedLine ? ` и сообщение о закрытии чата #${closedLine}` : ''}${openQ ? `, вопрос клиента ${refs(openLines)}` : ''}`, [lo.line, conv.lines.length]);
    }
    case '08': {
      if (!range) return null;
      const types = [];
      const ev = [];
      const allowed = criterion.flag_types || ['insult', 'bypass', 'disclosure'];
      const discOn = criterion.flags_config?.disclosure !== false;
      for (const s of f.insult_signals || []) { if (allowed.includes('insult') && !types.includes('insult')) types.push('insult'); ev.push({ line: s.line, why: `оскорбление (${quote(s.matches[0], 30)})` }); }
      for (const s of f.bypass_signals || []) { if (allowed.includes('bypass') && !types.includes('bypass')) types.push('bypass'); ev.push({ line: s.line, why: `предложение услуги в обход компании (${quote(s.matches[0], 30)})` }); }
      if (discOn && allowed.includes('disclosure')) for (const s of (f.disclosure_before_verification || []).filter((d) => d.kind !== 'protected_action')) { if (!types.includes('disclosure')) types.push('disclosure'); ev.push({ line: s.line, why: 'данные счёта без подтверждения личности' }); }
      if (types.length) {
        const names = types.map((t) => FLAG_RU[t] || t);
        return H({ applicable: true, answer: 'yes', flag_types: types }, 0.8, ev, `Грубое нарушение: ${names.join(', ')}`,
          `Выявлено грубое нарушение — ${names.join(', ')}${ev.length === 1 ? ` (${quote(line(ev[0].line)?.text, 60)})` : ''}`,
          `реплик${ev.length === 1 ? 'а' : 'и'} оператора ${refs(ev.map((e) => e.line))}`);
      }
      const checked = sample(ops.map((l) => l.n));
      const kinds = `оскорбления, предложения услуг в обход компании${discOn ? ' и раскрытия конфиденциальных данных' : ''}`;
      return H({ applicable: true, answer: 'no', flag_types: [] }, 0.7, checked.map((n) => ({ line: n, why: 'реплика оператора без признаков нарушения' })), 'Нарушений в репликах оператора не выявлено',
        `Ни одного из грубых нарушений — ${kinds} — в репликах оператора нет${discOn ? '' : '. Тип «раскрытие данных» в настройках критерия отключён'}`,
        `проверены все реплики оператора #${range[0]}–#${range[1]} (${plural(ops.length, 'реплика', 'реплики', 'реплик')})`, range);
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
    const r = baseResult(criterion, { rule_applied: 'Автоматическая проверка для критерия не настроена', confidence: 0.3, source: 'rule' });
    const basis = `реплики оператора #${range[0]}–#${range[1]}; детерминированных признаков по этому критерию в транскрипте нет, модель недоступна`;
    if (isFlag(criterion)) { r.answer = 'no'; r.flag_types = []; r.checked_range = range; r.explanation = explain(criterion, r, 'Детерминированных признаков нарушения в репликах оператора нет; нужна ручная проверка', basis); }
    else if (naAllowed(criterion)) { r.applicable = false; r.na_reason = 'Автоматическая оценка недоступна, критерий требует ручной проверки.'; r.explanation = explain(criterion, r, 'Автоматическая оценка по этому критерию недоступна, требуется ручная проверка', basis); }
    else if (isScale(criterion)) { const s = scaleSteps(criterion).sort((a, b) => a - b); r.scale_value = s[Math.floor(s.length / 2)]; r.explanation = explain(criterion, r, 'Выставлен средний шаг шкалы как консервативная оценка; требуется ручная проверка', basis); }
    else { r.answer = 'no'; r.checked_range = range; r.explanation = explain(criterion, r, 'Выставлена консервативная оценка; требуется ручная проверка', basis); }
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
    explanation: h.text,
    confidence: Math.min(fallback ? 0.5 : 0.95, h.confidence),
    source: 'rule',
  });
  if (fallback) {
    r.explanation = `${h.text} Ответ модели не прошёл проверку (${issues.slice(0, 3).join('; ') || 'нет ответа'}), поэтому оценка выставлена по фактам транскрипта.`;
    r.rule_applied = `fallback:${h.rule}`;
  }
  return r;
}
