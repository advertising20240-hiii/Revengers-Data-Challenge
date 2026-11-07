// Checklist versions: validation, activation, restore, diff, criterion replacement, templates.
import { ANSWER_TYPES, isScale, isFlag } from '../../packages/scoring/index.js';
import { hashJson } from '../lib/hash.js';
import { HttpError } from '../lib/http.js';

const CRITERION_FIELDS = ['code', 'title', 'section', 'answer_type', 'weight', 'scored', 'na_allowed', 'na_condition', 'definition', 'scale', 'evaluator', 'params', 'guidance', 'answer_guidance', 'flag_types', 'flags_config'];

/** Hash of the parts of a criterion that influence the model's answer (used for result reuse). */
export function criterionHash(c) {
  const sub = {};
  for (const f of CRITERION_FIELDS) if (c[f] !== undefined) sub[f] = c[f];
  return hashJson(sub);
}

export function validateChecklist(cl, { maxCriteria = 50 } = {}) {
  const errors = [];
  if (!cl || typeof cl !== 'object') return ['checklist must be an object'];
  if (!Array.isArray(cl.criteria)) return ['checklist.criteria must be an array'];
  if (cl.criteria.length === 0) errors.push('checklist must contain at least one criterion');
  if (cl.criteria.length > maxCriteria) errors.push(`too many criteria (${cl.criteria.length} > ${maxCriteria})`);
  const ids = new Set();
  const sectionIds = new Set((cl.sections || []).map((s) => s.id));
  cl.criteria.forEach((c, i) => {
    const tag = c?.id ? `criterion ${c.id}` : `criterion #${i + 1}`;
    if (!c || typeof c !== 'object') { errors.push(`${tag}: must be an object`); return; }
    if (!c.id || typeof c.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(c.id)) errors.push(`${tag}: id must be a short identifier`);
    else if (ids.has(c.id)) errors.push(`${tag}: duplicate id`);
    ids.add(c.id);
    if (!c.title || typeof c.title !== 'string') errors.push(`${tag}: title is required`);
    if (!ANSWER_TYPES.includes(c.answer_type)) errors.push(`${tag}: answer_type must be one of ${ANSWER_TYPES.join(', ')}`);
    const w = Number(c.weight ?? 0);
    if (!Number.isFinite(w) || w < 0) errors.push(`${tag}: weight must be a number >= 0`);
    if (isFlag(c) && w !== 0) errors.push(`${tag}: flag criteria carry no weight (weight must be 0)`);
    if (isScale(c)) {
      const steps = Array.isArray(c.scale) ? c.scale : [];
      if (steps.length < 2) errors.push(`${tag}: scale needs at least two steps`);
      const vals = steps.map((s) => Number(s?.value));
      if (vals.some((v) => !Number.isFinite(v))) errors.push(`${tag}: scale step values must be numeric`);
      else {
        if (Math.max(...vals) <= 0) errors.push(`${tag}: scale max must be > 0`);
        if (new Set(vals).size !== vals.length) errors.push(`${tag}: scale step values must be unique`);
      }
    }
    if (c.na_allowed === true && !['yes_no_na', 'scale_na'].includes(c.answer_type)) errors.push(`${tag}: na_allowed requires answer_type yes_no_na or scale_na`);
    if (c.section && sectionIds.size && !sectionIds.has(c.section)) errors.push(`${tag}: unknown section "${c.section}"`);
    if (c.evaluator && typeof c.evaluator === 'string' && !/^(llm|rule:[a-z_]+)$/.test(c.evaluator)) errors.push(`${tag}: evaluator must be "llm" or "rule:<name>"`);
  });
  return errors;
}

/** Normalize fields the editor may leave out so the engine and the UI get a complete definition. */
export function normalizeChecklist(cl) {
  const out = { ...cl };
  out.id = out.id || 'custom-checklist';
  out.name = out.name || 'Чек-лист';
  out.language = out.language || 'ru';
  out.sections = Array.isArray(out.sections) ? out.sections : [];
  out.criteria = (out.criteria || []).map((c, i) => {
    const n = { ...c };
    n.code = n.code || String(i + 1).padStart(2, '0');
    n.weight = Number(n.weight ?? 0);
    n.scored = n.answer_type === 'flag' ? false : n.scored !== false;
    if (n.answer_type === 'flag') n.weight = 0;
    n.na_allowed = n.answer_type === 'yes_no_na' || n.answer_type === 'scale_na';
    n.evaluator = n.evaluator || 'llm';
    n.answer_guidance = n.answer_guidance || {};
    if (isScale(n)) n.scale = (n.scale || []).map((s) => ({ value: Number(s.value), label: String(s.label ?? '') }));
    return n;
  });
  return out;
}

export function criterionDiff(a, b) {
  const fields = [];
  for (const f of CRITERION_FIELDS) {
    const av = a[f]; const bv = b[f];
    if (JSON.stringify(av ?? null) !== JSON.stringify(bv ?? null)) fields.push({ field: f, from: av ?? null, to: bv ?? null });
  }
  return fields;
}

export function diffChecklists(from, to) {
  const fromMap = new Map(from.criteria.map((c) => [c.id, c]));
  const toMap = new Map(to.criteria.map((c) => [c.id, c]));
  const added = to.criteria.filter((c) => !fromMap.has(c.id));
  const removed = from.criteria.filter((c) => !toMap.has(c.id));
  const changed = [];
  for (const c of to.criteria) {
    const prev = fromMap.get(c.id);
    if (!prev) continue;
    const fields = criterionDiff(prev, c);
    if (fields.length) changed.push({ id: c.id, title: c.title, fields });
  }
  return { from: from.version, to: to.version, added, removed, changed };
}

export class ChecklistService {
  constructor(db, config) { this.db = db; this.config = config; }

  list() {
    return this.db.checklists.all().sort((a, b) => a.version - b.version)
      .map((c) => ({ id: c.id, version: c.version, name: c.name, status: c.status, created_at: c.created_at, note: c.note ?? null, criteria_count: c.criteria.length, parent_version: c.parent_version ?? null }));
  }
  get(version) {
    const v = Number(version);
    return this.db.checklists.all().find((c) => c.version === v) ?? null;
  }
  getOrThrow(version) {
    const c = this.get(version);
    if (!c) throw new HttpError(404, `Checklist version ${version} not found`);
    return c;
  }
  active() {
    const all = this.db.checklists.all();
    return all.find((c) => c.status === 'active') ?? all.sort((a, b) => b.version - a.version)[0] ?? null;
  }
  nextVersion() { return this.db.checklists.all().reduce((m, c) => Math.max(m, c.version), 0) + 1; }

  save(input, { note = null, activate = false, parentVersion = null, allowErrors = false } = {}) {
    const cl = normalizeChecklist(input);
    const errors = validateChecklist(cl, { maxCriteria: this.config.maxCriteria });
    if (errors.length && !allowErrors) throw new HttpError(400, `Checklist is invalid: ${errors.join('; ')}`, { errors });
    const version = this.nextVersion();
    const saved = {
      ...cl,
      version,
      id: `${(cl.id || 'checklist').replace(/@v\d+$/, '')}`,
      status: activate ? 'active' : 'draft',
      created_at: new Date().toISOString(),
      note,
      parent_version: parentVersion,
      criteria_hashes: Object.fromEntries(cl.criteria.map((c) => [c.id, criterionHash(c)])),
    };
    if (activate) for (const c of this.db.checklists.all()) if (c.status === 'active') { c.status = 'archived'; this.db.checklists.put(c); }
    this.db.checklists.put(saved);
    this.db.scheduleSave();
    return saved;
  }

  install(checklistJson) {
    // Version 1 from config, installed on first start.
    const cl = normalizeChecklist(checklistJson);
    const saved = { ...cl, version: 1, status: 'active', created_at: cl.created_at || new Date().toISOString(), note: 'Исходный чек-лист Freedom Broker', parent_version: null, criteria_hashes: Object.fromEntries(cl.criteria.map((c) => [c.id, criterionHash(c)])) };
    this.db.checklists.put(saved);
    return saved;
  }

  activate(version) {
    const target = this.getOrThrow(version);
    for (const c of this.db.checklists.all()) {
      if (c.version === target.version) c.status = 'active';
      else if (c.status === 'active') c.status = 'archived';
      this.db.checklists.put(c);
    }
    this.db.scheduleSave();
    return target;
  }

  restore(version) {
    const src = this.getOrThrow(version);
    const copy = { ...src };
    delete copy.version; delete copy.status; delete copy.created_at; delete copy.criteria_hashes;
    return this.save(copy, { note: `Восстановлено из версии ${src.version}`, activate: true, parentVersion: src.version });
  }

  diff(fromV, toV) { return diffChecklists(this.getOrThrow(fromV), this.getOrThrow(toV)); }

  replaceCriterion({ base_version, old_criterion_id, new_criterion, activate = false, note = null }) {
    const base = this.getOrThrow(base_version ?? this.active()?.version);
    if (!new_criterion || typeof new_criterion !== 'object') throw new HttpError(400, 'new_criterion is required');
    const idx = base.criteria.findIndex((c) => c.id === old_criterion_id);
    if (idx < 0) throw new HttpError(404, `Criterion ${old_criterion_id} not found in version ${base.version}`);
    const old = base.criteria[idx];
    const nc = { ...new_criterion };
    nc.id = nc.id || old.id;
    nc.code = nc.code || old.code;
    nc.section = nc.section || old.section;
    const criteria = base.criteria.slice();
    criteria[idx] = nc;
    const copy = { ...base, criteria };
    delete copy.version; delete copy.status; delete copy.created_at; delete copy.criteria_hashes;
    return this.save(copy, { note: note ?? `Критерий ${old.code} «${old.title}» заменён на «${nc.title}»`, activate, parentVersion: base.version });
  }

  /** Checklist for a given version number, or the active one. */
  resolve(version) { return version != null && version !== '' ? this.getOrThrow(version) : this.active(); }
}

/** Criterion templates from the product brief (§10.4), ready to drop into the editor. */
export function templates() {
  return [
    {
      template_id: 'first_reaction', title: 'Скорость первой реакции',
      description: 'Детерминированное правило: первая реплика оператора не позднее 180 с после эскалации (или первой реплики клиента).',
      criterion: {
        id: 'c_first_reaction', code: '09', title: 'Скорость первой реакции', section: 'A', answer_type: 'yes_no', weight: 5, scored: true, na_allowed: false, na_condition: null,
        definition: 'Да — первая реплика оператора появилась не позднее 3 минут после передачи диалога оператору.',
        evaluator: 'rule:first_reaction', params: { threshold_seconds: 180 },
        guidance: 'Правило считается автоматически по меткам времени: offset первой реплики оператора − offset эскалации ≤ 180 с.',
        answer_guidance: { yes: 'Первая реакция ≤ 180 с.', no: 'Первая реакция > 180 с.' },
      },
    },
    {
      template_id: 'standard_address', title: 'Обращение по стандарту',
      description: 'Оператор обращается к клиенту вежливо и по принятому стандарту (на «Вы», по имени, если оно известно).',
      criterion: {
        id: 'c_standard_address', code: '10', title: 'Обращение по стандарту', section: 'C', answer_type: 'yes_no', weight: 5, scored: true, na_allowed: false, na_condition: null,
        definition: 'Да — оператор обращается к клиенту на «Вы» и по имени, если клиент его назвал; тон соответствует деловому стандарту.',
        evaluator: 'llm',
        guidance: 'Проверяйте все реплики оператора. Нет — обращение на «ты», фамильярность, пренебрежительный тон. Маска [Имя скрыто] считается именем.',
        answer_guidance: { yes: 'Везде на «Вы», деловой тон.', no: 'Есть обращение на «ты» или фамильярный тон.' },
      },
    },
    {
      template_id: 'offer_extra_help', title: 'Предложение дополнительной помощи',
      description: 'После решения вопроса оператор предложил дополнительную помощь. N/A — диалог оборвался.',
      criterion: {
        id: 'c_offer_help', code: '11', title: 'Предложение дополнительной помощи', section: 'C', answer_type: 'yes_no_na', weight: 5, scored: true, na_allowed: true,
        na_condition: 'Диалог оборвался до завершения основного вопроса.',
        definition: 'Да — после решения вопроса оператор спросил, нужна ли ещё помощь. N/A — диалог оборвался до завершения основного вопроса.',
        evaluator: 'llm',
        guidance: 'Ищите фразы «Могу ли ещё чем-то помочь?», «Остались вопросы?», «Басқа сұрақтарыңыз бар ма?», «Anything else I can help with?». Нет — вопрос решён, но предложения нет.',
        answer_guidance: { yes: 'Явно предложил дополнительную помощь.', no: 'Вопрос решён без предложения помощи.', na: 'Диалог оборвался раньше.' },
      },
    },
    {
      template_id: 'product_accuracy', title: 'Точность информации о продукте',
      description: 'Шкала 0/5/10: фактическая корректность информации о продуктах, тарифах и процедурах.',
      criterion: {
        id: 'c_product_accuracy', code: '12', title: 'Точность информации о продукте', section: 'B', answer_type: 'scale', weight: 10, scored: true, na_allowed: false, na_condition: null,
        definition: 'Оцените фактическую точность сведений о продуктах, тарифах и процедурах по шкале.',
        scale: [
          { value: 0, label: 'Есть фактическая ошибка в ключевой информации.' },
          { value: 5, label: 'Информация в целом верна, но неполна или неточна в деталях.' },
          { value: 10, label: 'Информация точна и полна.' },
        ],
        evaluator: 'llm',
        guidance: 'Оценивайте только утверждения оператора о продуктах/процедурах. Противоречие с общеизвестными правилами брокера или с системными сообщениями — ошибка.',
        answer_guidance: {},
      },
    },
    {
      template_id: 'confidentiality', title: 'Соблюдение конфиденциальности',
      description: 'Флаг без баллов: раскрытие персональных или внутренних данных.',
      criterion: {
        id: 'c_confidentiality', code: '13', title: 'Соблюдение конфиденциальности', section: 'D', answer_type: 'flag', weight: 0, scored: false, na_allowed: false, na_condition: null,
        definition: 'Да — оператор раскрыл персональные данные третьих лиц, внутреннюю информацию компании или данные счёта неидентифицированному лицу.',
        evaluator: 'llm', flag_types: ['disclosure', 'third_party', 'internal'], flags_config: { disclosure: true },
        guidance: 'Флаг не влияет на итоговый балл. Укажите тип нарушения и строку-доказательство.',
        answer_guidance: { yes: 'Есть раскрытие (укажите тип).', no: 'Раскрытия нет.' },
      },
    },
    {
      template_id: 'understanding_check', title: 'Проверка понимания клиентом',
      description: 'Оператор убедился, что клиент понял инструкцию или решение. N/A — инструкции не давались.',
      criterion: {
        id: 'c_understanding', code: '14', title: 'Проверка понимания клиентом', section: 'C', answer_type: 'yes_no_na', weight: 5, scored: true, na_allowed: true,
        na_condition: 'Оператор не давал клиенту инструкций.',
        definition: 'Да — после инструкции оператор уточнил, понятно ли клиенту, или клиент подтвердил выполнение, а оператор это зафиксировал. N/A — инструкций не было.',
        evaluator: 'llm',
        guidance: 'Ищите «Получилось?», «Всё понятно?», «Түсінікті ме?», «Does that make sense?» или подтверждение результата клиентом с реакцией оператора.',
        answer_guidance: { yes: 'Проверил понимание или подтвердил результат.', no: 'Дал инструкцию и не проверил понимание.', na: 'Инструкций не было.' },
      },
    },
  ];
}
