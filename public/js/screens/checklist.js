// Screen 3 — Чек-лист: versions, criterion editor, templates, replace criterion, diff, simulation, save & apply.
import { h, clear, replace } from '../dom.js';
import { t, pl } from '../i18n.js';
import { api, pollJob } from '../api.js';
import { state, providerAvailable, providerReason, subscribe } from '../state.js';
import { chip, toast, openModal, skeleton, emptyState, errorBox, progressBar, field, select, confirmModal } from '../components.js';
import { cardHash } from '../router.js';
import { num, date, shortDate, provenance } from '../format.js';
import { scoreEvaluation, isFlag, isScale, naAllowed } from '../../../packages/scoring/index.js';
import { selKey, fromKey } from './dialogs.js';

const TYPES = ['yes_no', 'yes_no_na', 'scale', 'scale_na', 'flag'];
// Criterion fields that change the answer (mirrors server/services/checklists.js); weight only changes the score.
const ANSWER_FIELDS = ['code', 'title', 'section', 'answer_type', 'scored', 'na_allowed', 'na_condition', 'definition', 'scale', 'evaluator', 'params', 'guidance', 'answer_guidance', 'flag_types', 'flags_config'];
const isRule = (c) => String(c.evaluator || 'llm').startsWith('rule:');

export function renderChecklist(main, params) {
  let versions = [], selected = params.version ? Number(params.version) : null, base = null, draft = null, templates = null, activeCl = null;
  const left = h('div', { class: 'card' });
  const right = h('div', { class: 'stack' });
  replace(main,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('cl.title')), h('p', { class: 'lead' }, t('cl.lead')))),
    h('div', { class: 'cl-layout' }, left, right));

  async function loadVersions(keepSelection = true) {
    replace(left, skeleton(6));
    try {
      versions = await api.checklists();
      versions.sort((a, b) => b.version - a.version);
      activeCl = await api.checklistActive().catch(() => null);
      if (!keepSelection || !selected || !versions.some((v) => v.version === selected)) {
        const act = versions.find((v) => v.status === 'active');
        selected = act ? act.version : (versions[0] ? versions[0].version : null);
      }
      drawVersions();
      if (selected !== null) await loadVersion(selected);
      else replace(right, h('div', { class: 'card' }, emptyState(t('cl.no_versions'), t('cl.no_versions_hint'))));
    } catch (e) { replace(left, errorBox(e, loadVersions)); }
  }

  function drawVersions() {
    replace(left, h('div', { class: 'card-h' }, h('h2', null, t('cl.versions'))),
      versions.map((v) => h('div', { class: `ver ${v.version === selected ? 'sel' : ''}`, role: 'button', tabindex: 0,
        onclick: () => pick(v.version), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(v.version); } } },
        h('div', { class: 'v' }, h('span', null, `v${v.version} · ${v.name || ''}`), chip(t(`cl.status_${v.status}`) || v.status, v.status === 'active' ? 'yes' : v.status === 'draft' ? 'warn' : 'na')),
        h('div', { class: 'd' }, `${shortDate(v.created_at)} · ${v.criteria_count == null ? '—' : pl(v.criteria_count, 'unit.criteria')}`),
        v.note ? h('div', { class: 'd' }, v.note) : null)));
  }

  async function pick(v) {
    if (draft && isDirty() && !(await confirmModal(t('cl.discard_title'), t('cl.discard_text'), t('cl.discard_ok')))) return;
    selected = v; drawVersions(); await loadVersion(v);
  }

  async function loadVersion(v) {
    replace(right, h('div', { class: 'card' }, skeleton(10)));
    try {
      base = await api.checklist(v);
      draft = JSON.parse(JSON.stringify(base));
      drawEditor();
    } catch (e) { replace(right, errorBox(e, () => loadVersion(v))); }
  }

  function isDirty() { return JSON.stringify(stripMeta(draft)) !== JSON.stringify(stripMeta(base)); }
  function stripMeta(c) { if (!c) return null; const { version, status, created_at, id, ...rest } = c; return rest; }

  /**
   * LLM criteria of the draft that are new or changed in an answer-affecting field compared with the active version
   * (stored evaluations belong to it). Only these need a model call; weights and rule criteria are re-scored locally.
   */
  function modelCriteria() {
    const ref = new Map((((activeCl || base) || {}).criteria || []).map((c) => [c.id, c]));
    return draft.criteria.filter((c) => {
      if (isRule(c)) return false;
      const old = ref.get(c.id);
      return !old || ANSWER_FIELDS.some((f) => JSON.stringify(c[f] ?? null) !== JSON.stringify(old[f] ?? null));
    });
  }
  const isOffline = () => !!(state.health && state.health.offline);

  // ---------- editor ----------
  function drawEditor() {
    const meta = versions.find((x) => x.version === selected) || {};
    const dirty = isDirty();
    // offline (cache replay only): new/changed LLM criteria would fail on every dialog, so running is blocked for them
    const needModel = providerAvailable() && isOffline() ? modelCriteria() : [];
    const okEval = providerAvailable() && !needModel.length;
    const evalTitle = !providerAvailable() ? t('health.eval_disabled', { reason: providerReason() || '—' })
      : needModel.length ? t('cl.offline_needs_model', { list: needModel.map((c) => c.code || c.id).join(', ') }) : '';
    const offlineNote = providerAvailable() && isOffline() && dirty
      ? h('div', { class: 'note', role: 'status', style: { margin: '0 1rem .75rem' } }, needModel.length ? evalTitle : t('cl.offline_rescore_only')) : null;
    const head = h('div', { class: 'card-h' },
      h('div', null, h('h2', { class: 'row' }, `v${draft.version ?? selected} · ${draft.name || ''}`, chip(t(`cl.status_${base.status}`) || base.status, base.status === 'active' ? 'yes' : base.status === 'draft' ? 'warn' : 'na'), dirty ? h('span', { class: 'dirty small' }, t('cl.dirty')) : null),
        h('div', { class: 'muted small' }, `${t('cl.created')} ${date(base.created_at)}${meta.note ? ' · ' + meta.note : ''}`)),
      h('div', { class: 'row' },
        base.status !== 'active' && !dirty ? h('button', { class: 'btn', type: 'button', onclick: activate }, t('cl.activate')) : null,
        base.status !== 'active' && !dirty ? h('button', { class: 'btn', type: 'button', onclick: restore }, t('cl.restore')) : null,
        h('button', { class: 'btn', type: 'button', onclick: openDiff }, t('cl.diff')),
        h('button', { class: 'btn', type: 'button', onclick: openTemplates }, t('cl.templates')),
        h('button', { class: 'btn', type: 'button', onclick: () => editCriterion(null) }, t('cl.add')),
        h('button', { class: 'btn', type: 'button', disabled: !okEval, title: evalTitle, onclick: openSimulation }, t('cl.simulate')),
        h('button', { class: 'btn', type: 'button', disabled: !dirty, onclick: () => saveVersion(false) }, t('cl.save')),
        h('button', { class: 'btn primary', type: 'button', disabled: !okEval, title: evalTitle, onclick: openSaveApply }, t('cl.save_apply'))));

    // weights preview via the shared engine (all applicable, all "yes")
    const answers = {};
    for (const c of draft.criteria) answers[c.id] = isScale(c) ? { applicable: true, scale_value: Math.max(...(c.scale || []).map((x) => Number(x.value)), 0) } : { applicable: true, answer: 'yes', flag_types: [] };
    let score = null;
    try { score = scoreEvaluation(draft, answers); } catch (e) { score = { errors: [e.message], per_criterion: {} }; }
    const sumW = draft.criteria.filter((c) => !isFlag(c)).reduce((a, c) => a + Number(c.weight || 0), 0);

    const rows = draft.criteria.map((c, i) => {
      const pc = (score.per_criterion || {})[c.id] || {};
      return h('tr', null,
        h('td', { class: 'mono' }, c.code || c.id),
        h('td', null, h('div', null, h('b', null, c.title)), c.definition ? h('div', { class: 'muted small' }, truncate(c.definition, 140)) : null),
        h('td', null, c.section || '—'),
        h('td', null, chip(t(`type.${c.answer_type}`) || c.answer_type, isFlag(c) ? 'flag' : isScale(c) ? 'scale' : 'neutral'), isScale(c) ? h('div', { class: 'muted small' }, (c.scale || []).map((x) => x.value).join(' / ')) : null),
        h('td', { class: 'num' }, isFlag(c) ? h('span', { class: 'muted' }, '—') : h('span', null, num(c.weight, 0), h('div', { class: 'muted small' }, `${num(pc.effective_weight)}%`))),
        h('td', null, naAllowed(c) ? chip(t('answer.na'), 'na') : h('span', { class: 'muted' }, '—')),
        h('td', null, h('span', { class: 'small mono' }, c.evaluator || 'llm')),
        h('td', { class: 'nowrap' },
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => editCriterion(i) }, t('btn.edit')),
          h('button', { class: 'btn sm', type: 'button', onclick: () => replaceCriterion(c) }, t('cl.replace')),
          h('button', { class: 'btn sm ghost danger', type: 'button', onclick: async () => { if (await confirmModal(t('cl.delete_title'), t('cl.delete_text', { c: c.title }), t('btn.delete'))) { draft.criteria.splice(i, 1); drawEditor(); } } }, t('btn.delete'))));
    });

    const table = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, t('cl.code')), h('th', null, t('cl.criterion')), h('th', null, t('cl.section')), h('th', null, t('cl.type')), h('th', null, t('cl.weight')), h('th', null, 'N/A'), h('th', null, t('cl.evaluator')), h('th', null, ''))),
      h('tbody', null, rows)));
    const sections = h('div', { class: 'row small muted', style: { padding: '.5rem 1rem' } }, h('span', null, `${t('cl.sections')}: `), (draft.sections || []).map((s_) => chip(`${s_.id}. ${s_.title}`, 'neutral')),
      h('button', { class: 'btn link sm', type: 'button', onclick: editSections }, t('btn.edit')));
    const note = h('div', { class: 'note', style: { margin: '0 1rem 1rem' } }, t('cl.weights_note', { sum: num(sumW, 0) }), (score.errors || []).length ? h('div', { class: 'dirty' }, score.errors.join('; ')) : null);
    const instr = h('details', { style: { padding: '0 1rem 1rem' } }, h('summary', null, t('cl.instructions')), h('textarea', { rows: 4, oninput: (e) => { draft.instructions = e.target.value; } }, draft.instructions || ''));
    replace(right, h('div', { class: 'card' }, head, offlineNote, sections, table, note, instr));
  }

  function editSections() {
    const list = h('div', { class: 'stack' });
    const secs = JSON.parse(JSON.stringify(draft.sections || []));
    const redraw = () => replace(list, secs.map((s_, i) => h('div', { class: 'row' },
      h('input', { type: 'text', value: s_.id, style: { width: '4rem' }, 'aria-label': 'ID', oninput: (e) => { s_.id = e.target.value.trim(); } }),
      h('input', { type: 'text', value: s_.title, class: 'grow', 'aria-label': t('cl.section'), oninput: (e) => { s_.title = e.target.value; } }),
      h('button', { class: 'btn sm ghost danger', type: 'button', onclick: () => { secs.splice(i, 1); redraw(); } }, '×'))),
      h('button', { class: 'btn sm', type: 'button', onclick: () => { secs.push({ id: String.fromCharCode(65 + secs.length), title: '' }); redraw(); } }, t('cl.add_section')));
    redraw();
    const m = openModal({ title: t('cl.sections'), body: list, actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('btn.cancel')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { draft.sections = secs.filter((x) => x.id); m.close(); drawEditor(); } }, t('btn.apply'))] });
  }

  function nextId() {
    const nums = draft.criteria.map((c) => Number(String(c.id).replace(/\D/g, ''))).filter((n) => !Number.isNaN(n));
    const n = (nums.length ? Math.max(...nums) : 0) + 1;
    return { id: `c${String(n).padStart(2, '0')}`, code: String(n).padStart(2, '0') };
  }

  function blankCriterion() {
    const { id, code } = nextId();
    return { id, code, title: '', section: (draft.sections && draft.sections[0] ? draft.sections[0].id : 'A'), answer_type: 'yes_no', weight: 5, scored: true, na_allowed: false, na_condition: null, definition: '', evaluator: 'llm', guidance: '', answer_guidance: { yes: '', no: '', na: '' }, scale: [] };
  }

  /** Criterion editor modal. index=null → new; onDone(criterion) overrides the default "write into draft". */
  function editCriterion(index, preset, onDone) {
    const c = JSON.parse(JSON.stringify(preset || (index !== null ? draft.criteria[index] : blankCriterion())));
    if (index === null && preset) { const { id, code } = nextId(); c.id = preset.id && !draft.criteria.some((x) => x.id === preset.id) ? preset.id : id; c.code = preset.code && !draft.criteria.some((x) => x.code === preset.code) ? preset.code : code; }
    c.answer_guidance = c.answer_guidance || {};
    c.scale = c.scale || [];
    const inp = (key, attrs = {}) => h('input', { type: 'text', value: c[key] ?? '', oninput: (e) => { c[key] = e.target.value; }, ...attrs });
    const ta = (obj, key, rows = 3) => h('textarea', { rows, oninput: (e) => { obj[key] = e.target.value; } }, obj[key] || '');
    const typeSel = select(TYPES.map((x) => ({ value: x, label: t(`type.${x}`) })), c.answer_type, (v) => { c.answer_type = v; c.scored = v !== 'flag'; c.na_allowed = v.endsWith('_na'); if (v === 'flag') c.weight = 0; syncType(); });
    const weight = h('input', { type: 'number', min: 0, step: 1, value: c.weight ?? 0, oninput: (e) => { c.weight = Number(e.target.value); } });
    const naCond = ta(c, 'na_condition', 2);
    const naBox = h('div', { class: 'span2' }, field(t('cl.f_na_condition'), naCond));
    const evalSel = select([{ value: 'llm', label: t('cl.eval_llm') }, { value: 'rule:first_reaction', label: t('cl.eval_rule_first_reaction') }, { value: 'rule:custom', label: t('cl.eval_rule_custom') }],
      String(c.evaluator || 'llm').startsWith('rule:') && c.evaluator !== 'rule:first_reaction' ? 'rule:custom' : (c.evaluator || 'llm'), (v) => { c.evaluator = v === 'rule:custom' ? (ruleName.value ? `rule:${ruleName.value}` : 'rule:') : v; syncType(); });
    const ruleName = h('input', { type: 'text', value: String(c.evaluator || '').startsWith('rule:') ? c.evaluator.slice(5) : '', placeholder: 'first_reaction', oninput: (e) => { c.evaluator = `rule:${e.target.value.trim()}`; } });
    const ruleParams = h('input', { type: 'text', value: c.params ? JSON.stringify(c.params) : '', placeholder: '{"threshold_seconds":180}', oninput: (e) => { try { c.params = e.target.value ? JSON.parse(e.target.value) : undefined; e.target.classList.remove('dirty'); } catch { e.target.classList.add('dirty'); } } });
    const ruleBox = h('div', { class: 'span2 form-grid' }, field(t('cl.f_rule_name'), ruleName), field(t('cl.f_rule_params'), ruleParams));
    const flagTypes = h('input', { type: 'text', value: (c.flag_types || []).join(', '), placeholder: 'insult, bypass, disclosure', oninput: (e) => { c.flag_types = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); } });
    const flagBox = h('div', { class: 'span2' }, field(t('cl.f_flag_types'), flagTypes));
    const steps = h('div', { class: 'scale-steps' });
    const drawSteps = () => replace(steps, c.scale.map((st, i) => h('div', { class: 'step' },
      h('input', { type: 'number', value: st.value, 'aria-label': t('cl.step_value'), oninput: (e) => { st.value = Number(e.target.value); } }),
      h('input', { type: 'text', value: st.label || '', placeholder: t('cl.step_label'), 'aria-label': t('cl.step_label'), oninput: (e) => { st.label = e.target.value; } }),
      h('button', { class: 'btn sm ghost danger', type: 'button', 'aria-label': t('btn.delete'), onclick: () => { c.scale.splice(i, 1); drawSteps(); } }, '×'))),
      h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: () => { c.scale.push({ value: c.scale.length ? Math.max(...c.scale.map((x) => Number(x.value))) + 5 : 0, label: '' }); drawSteps(); } }, t('cl.add_step'))));
    drawSteps();
    const scaleBox = h('div', { class: 'span2' }, h('div', { class: 'small muted', style: { marginBottom: '.3rem' } }, t('cl.f_scale')), steps);
    const naGuide = field(t('cl.f_guid_na'), ta(c.answer_guidance, 'na', 2));
    function syncType() {
      const isNa = c.answer_type.endsWith('_na');
      naBox.classList.toggle('hidden', !isNa); naGuide.classList.toggle('hidden', !isNa);
      scaleBox.classList.toggle('hidden', !isScale(c));
      flagBox.classList.toggle('hidden', c.answer_type !== 'flag');
      weight.disabled = c.answer_type === 'flag';
      ruleBox.classList.toggle('hidden', !String(c.evaluator || '').startsWith('rule:'));
    }
    syncType();
    const err = h('div');
    const form = h('div', { class: 'form-grid' },
      field(t('cl.f_code'), inp('code', { style: { width: '6rem' } })),
      field(t('cl.f_section'), select((draft.sections || []).map((s_) => ({ value: s_.id, label: `${s_.id}. ${s_.title}` })), c.section, (v) => { c.section = v; })),
      h('div', { class: 'span2' }, field(t('cl.f_title'), inp('title', { required: true }))),
      field(t('cl.f_type'), typeSel), field(t('cl.f_weight'), weight),
      field(t('cl.f_evaluator'), evalSel), h('div'),
      ruleBox, scaleBox, flagBox, naBox,
      h('div', { class: 'span2' }, field(t('cl.f_definition'), ta(c, 'definition', 3))),
      h('div', { class: 'span2' }, field(t('cl.f_guidance'), ta(c, 'guidance', 4))),
      field(t('cl.f_guid_yes'), ta(c.answer_guidance, 'yes', 2)), field(t('cl.f_guid_no'), ta(c.answer_guidance, 'no', 2)), naGuide,
      h('div', { class: 'span2' }, err));
    const m = openModal({
      title: index !== null && !preset ? `${t('btn.edit')}: ${c.code} ${c.title}` : t('cl.new_criterion'), wide: true, body: form,
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('btn.cancel')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => {
          const problems = validateCriterion(c, index);
          if (problems.length) { replace(err, errorBox(new Error(problems.join(' '))), null); return; }
          if (c.answer_type === 'flag') { c.scored = false; c.weight = 0; c.flag_types = c.flag_types && c.flag_types.length ? c.flag_types : ['insult', 'bypass', 'disclosure']; }
          else { c.scored = true; }
          c.na_allowed = c.answer_type.endsWith('_na');
          if (!c.na_allowed) { c.na_condition = null; delete c.answer_guidance.na; }
          if (!isScale(c)) delete c.scale;
          m.close();
          if (onDone) onDone(c); else { if (index === null) draft.criteria.push(c); else draft.criteria[index] = c; drawEditor(); }
        } }, t('btn.apply'))],
    });
  }

  function validateCriterion(c, index) {
    const p = [];
    if (!c.title || !c.title.trim()) p.push(t('cl.v_title'));
    if (!c.code) p.push(t('cl.v_code'));
    if (draft.criteria.some((x, i) => i !== index && (x.id === c.id || x.code === c.code))) p.push(t('cl.v_dup'));
    if (c.answer_type !== 'flag' && !(Number(c.weight) > 0)) p.push(t('cl.v_weight'));
    if (isScale(c) && (!c.scale || c.scale.length < 2)) p.push(t('cl.v_scale'));
    if (isScale(c) && c.scale && new Set(c.scale.map((x) => Number(x.value))).size !== c.scale.length) p.push(t('cl.v_scale_dup'));
    if (c.answer_type.endsWith('_na') && !(c.na_condition || '').trim()) p.push(t('cl.v_na'));
    if (String(c.evaluator || '').startsWith('rule:') && c.evaluator.length <= 5) p.push(t('cl.v_rule'));
    return p;
  }

  // ---------- templates ----------
  async function getTemplates() {
    if (templates) return templates;
    templates = await api.templates();
    return templates;
  }

  function templateCard(tp, onPick, selectedId) {
    const c = tp.criterion || {};
    return h('div', { class: `tpl ${selectedId === tp.template_id ? 'sel' : ''}` },
      h('div', { class: 't' }, tp.title), h('div', { class: 'd' }, tp.description || c.definition || ''),
      h('div', { class: 'row small' }, chip(t(`type.${c.answer_type}`) || c.answer_type, isFlag(c) ? 'flag' : isScale(c) ? 'scale' : 'neutral'), !isFlag(c) ? h('span', { class: 'muted' }, `${t('cl.weight')} ${c.weight}`) : null, h('span', { class: 'mono muted' }, c.evaluator || 'llm')),
      onPick ? h('button', { class: 'btn sm', type: 'button', onclick: () => onPick(tp) }, t('cl.use_template')) : null);
  }

  async function openTemplates() {
    const body = h('div', null, skeleton(4));
    const m = openModal({ title: t('cl.templates'), wide: true, body });
    try {
      const list = await getTemplates();
      replace(body, h('p', { class: 'muted' }, t('cl.templates_hint')), h('div', { class: 'grid-3' }, list.map((tp) => templateCard(tp, (p) => { m.close(); editCriterion(null, p.criterion); }))));
    } catch (e) { replace(body, errorBox(e)); }
  }

  // ---------- replace criterion ----------
  async function replaceCriterion(old) {
    const body = h('div', null, skeleton(4));
    const m = openModal({ title: `${t('cl.replace')}: ${old.code} ${old.title}`, wide: true, body });
    const proceed = (preset) => {
      m.close();
      editCriterion(null, preset || { ...blankCriterion(), section: old.section, weight: old.weight }, async (newC) => {
        try {
          const saved = await api.replaceCriterion({ base_version: base.version ?? selected, old_criterion_id: old.id, new_criterion: newC, activate: false });
          toast(t('cl.replaced', { v: saved.version }), 'ok');
          selected = saved.version; await loadVersions(true);
        } catch (e) { toast(e.message, 'err'); }
      });
    };
    try {
      const list = await getTemplates();
      replace(body, h('p', { class: 'muted' }, t('cl.replace_hint')),
        h('div', { class: 'row mb' }, h('button', { class: 'btn', type: 'button', onclick: () => proceed(null) }, t('cl.replace_blank'))),
        h('div', { class: 'grid-3' }, list.map((tp) => templateCard(tp, (p) => proceed({ ...p.criterion, section: p.criterion.section || old.section })))));
    } catch (e) { replace(body, errorBox(e)); }
  }

  // ---------- diff ----------
  function openDiff() {
    const others = versions.filter((v) => v.version !== selected);
    const from = select(others.map((v) => ({ value: v.version, label: `v${v.version} (${t(`cl.status_${v.status}`)})` })), others[0] ? others[0].version : '', () => run(), { 'aria-label': t('cl.diff_from') });
    const out = h('div');
    async function run() {
      replace(out, skeleton(4));
      try {
        const d = await api.diff(from.value, selected);
        replace(out, diffTable(d));
      } catch (e) { replace(out, errorBox(e)); }
    }
    openModal({ title: t('cl.diff'), wide: true, body: h('div', { class: 'stack' }, h('div', { class: 'row' }, h('span', null, t('cl.diff_from')), from, h('span', null, '→'), h('b', null, `v${selected}`)), out) });
    if (others.length) run(); else replace(out, h('p', { class: 'muted' }, t('cl.diff_none')));
  }

  function diffTable(d) {
    if (!d.added.length && !d.removed.length && !d.changed.length) return h('p', { class: 'muted' }, t('cl.diff_equal'));
    const rows = [];
    for (const c of d.added) rows.push(h('tr', { class: 'add' }, h('td', null, chip(t('cl.diff_added'), 'yes')), h('td', null, `${c.code || c.id} · ${c.title}`), h('td', null, `${t(`type.${c.answer_type}`)}, ${t('cl.weight')} ${c.weight}`)));
    for (const c of d.removed) rows.push(h('tr', { class: 'del' }, h('td', null, chip(t('cl.diff_removed'), 'no')), h('td', null, `${c.code || c.id} · ${c.title}`), h('td', null, `${t(`type.${c.answer_type}`)}, ${t('cl.weight')} ${c.weight}`)));
    for (const c of d.changed) rows.push(h('tr', { class: 'chg' }, h('td', null, chip(t('cl.diff_changed'), 'scale')), h('td', null, `${c.id} · ${c.title}`),
      h('td', null, h('ul', { class: 'small', style: { margin: 0, paddingLeft: '1rem' } }, (c.fields || []).map((f) => h('li', null, h('b', null, f.field), ': ', h('span', { class: 'muted' }, fmt(f.from)), ' → ', fmt(f.to)))))));
    return h('div', { class: 'tbl-wrap diff' }, h('table', { class: 'tbl' }, h('tbody', null, rows)));
  }
  const fmt = (v) => v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

  // ---------- activate / restore / save ----------
  async function activate() {
    if (!(await confirmModal(t('cl.activate'), t('cl.activate_text', { v: selected }), t('cl.activate')))) return;
    try { await api.activateChecklist(selected); toast(t('cl.activated', { v: selected }), 'ok'); await loadVersions(true); } catch (e) { toast(e.message, 'err'); }
  }
  async function restore() {
    if (!(await confirmModal(t('cl.restore'), t('cl.restore_text', { v: selected }), t('cl.restore')))) return;
    try { const c = await api.restoreChecklist(selected); toast(t('cl.restored', { v: c.version }), 'ok'); selected = c.version; await loadVersions(true); } catch (e) { toast(e.message, 'err'); }
  }

  function saveVersion(activateNow) {
    return new Promise((resolve) => {
      const note = h('input', { type: 'text', placeholder: t('cl.note_ph') });
      const act = h('input', { type: 'checkbox' }); act.checked = !!activateNow;
      const err = h('div');
      const m = openModal({ title: t('cl.save'), body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('cl.save_hint')), field(t('cl.note'), note), h('label', { class: 'chk' }, act, t('cl.activate_now')), err),
        actions: [h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); resolve(null); } }, t('btn.cancel')),
          h('button', { class: 'btn primary', type: 'button', onclick: async () => {
            try {
              const saved = await api.saveChecklist(stripMeta(draft), note.value.trim() || undefined, act.checked);
              toast(t('cl.saved', { v: saved.version }), 'ok'); m.close(); selected = saved.version; await loadVersions(true); resolve(saved);
            } catch (e) { replace(err, errorBox(e)); }
          } }, t('btn.save'))], onClose: () => resolve(null) });
    });
  }

  // ---------- conversation picker ----------
  async function conversationPicker(defaultN = 5) {
    const list = await api.conversations({ group_id: state.group || undefined });
    // keys carry the group so that an id present in two groups (DEV and the control set) resolves to the right dialog
    const chosen = new Set([...state.selection].filter((k) => list.some((c) => selKey(c) === k)));
    if (!chosen.size) list.slice(0, defaultN).forEach((c) => chosen.add(selKey(c)));
    const nInp = h('input', { type: 'number', min: 1, max: list.length, value: defaultN, style: { width: '5rem' } });
    const box = h('div', { style: { maxHeight: '260px', overflow: 'auto', border: '1px solid var(--cqa-border)', borderRadius: '6px', padding: '.4rem .6rem' } });
    const counter = h('span', { class: 'muted small' });
    const redraw = () => {
      replace(box, list.map((c) => { const k = selKey(c); const cb = h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) chosen.add(k); else chosen.delete(k); counter.textContent = t('cl.picked', { n: chosen.size }); } }); cb.checked = chosen.has(k);
        return h('label', { class: 'chk', style: { display: 'flex', padding: '.15rem 0' } }, cb, h('span', { class: 'mono' }, c.conversation_id), h('span', { class: 'muted small' }, ` ${c.group_id || ''} · ${c.language} · ${c.latest && c.latest.total_str ? c.latest.total_str : '—'}`)); }));
      counter.textContent = t('cl.picked', { n: chosen.size });
    };
    redraw();
    const el = h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('span', null, t('cl.first_n')), nInp, h('button', { class: 'btn sm', type: 'button', onclick: () => { chosen.clear(); list.slice(0, Number(nInp.value) || defaultN).forEach((c) => chosen.add(selKey(c))); redraw(); } }, t('btn.apply')),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { chosen.clear(); redraw(); } }, t('cl.clear')), h('span', { class: 'grow' }), counter),
      box);
    return { el, ids: () => [...chosen].map(fromKey) };
  }

  // ---------- simulation ----------
  async function openSimulation() {
    const body = h('div', null, skeleton(4));
    const m = openModal({ title: t('cl.simulate'), wide: true, body });
    let picker;
    try { picker = await conversationPicker(5); } catch (e) { replace(body, errorBox(e)); return; }
    const out = h('div');
    const run = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const ids = picker.ids();
      if (!ids.length) return;
      run.disabled = true; replace(out, h('div', { class: 'stack' }, h('div', { class: 'muted' }, t('job.queued')), progressBar(0, ids.length)));
      try {
        const { job_id } = await api.simulate(stripMeta(draft), ids);
        const job = await pollJob(job_id, (j) => replace(out, h('div', { class: 'stack' }, h('div', { class: 'muted' }, t('job.progress', { done: j.done || 0, total: j.total || ids.length, failed: j.failed || 0 })), progressBar((j.done || 0) + (j.failed || 0), j.total || ids.length))));
        replace(out, simulationTable(job));
      } catch (e) { replace(out, errorBox(e)); }
      run.disabled = false;
    } }, t('cl.simulate_run'));
    replace(body, h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('cl.simulate_hint')), picker.el, h('div', { class: 'row' }, run), out));
  }

  function simulationTable(job) {
    const rows = (job.results || []).map((r) => {
      const cmp = r.comparison || r;
      const ev = r.evaluation || {};
      const sim = cmp.simulated_total ?? ev.total ?? null;
      const stored = cmp.stored_total ?? null;
      const changed = cmp.changed_criteria || [];
      return h('tr', null,
        h('td', null, h('a', { href: cardHash(r.conversation_id), class: 'mono' }, r.conversation_id)),
        h('td', { class: 'num' }, stored === null ? '—' : num(stored)),
        h('td', { class: 'num' }, r.error ? h('span', { class: 'dirty' }, r.error) : h('b', null, sim === null ? t('card.not_calculated') : num(sim))),
        h('td', { class: 'num' }, sim !== null && stored !== null ? h('span', { class: sim - stored > 0 ? 'cache-hit' : sim - stored < 0 ? 'dirty' : 'muted' }, `${sim - stored > 0 ? '+' : ''}${num(sim - stored)}`) : '—'),
        h('td', null, changed.length ? changed.map((c) => chip(typeof c === 'string' ? c : `${c.code || c.criterion_id || c.id}${c.from !== undefined ? `: ${fmt(c.from)} → ${fmt(c.to)}` : ''}`, 'scale')) : h('span', { class: 'muted' }, t('cl.no_changes'))));
    });
    return h('div', { class: 'stack' }, h('div', { class: 'note' }, t('cl.simulate_note')),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, t('col.id')), h('th', null, t('cl.stored')), h('th', null, t('cl.simulated')), h('th', null, 'Δ'), h('th', null, t('cl.changed_criteria')))), h('tbody', null, rows))));
  }

  // ---------- save & apply ----------
  async function openSaveApply() {
    const body = h('div', null, skeleton(4));
    const m = openModal({ title: t('cl.save_apply'), wide: true, body });
    let picker;
    try { picker = await conversationPicker(5); } catch (e) { replace(body, errorBox(e)); return; }
    const note = h('input', { type: 'text', placeholder: t('cl.note_ph') });
    const out = h('div');
    const go = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      const ids = picker.ids();
      if (!ids.length) return;
      go.disabled = true;
      try {
        let ver = base.version ?? selected;
        if (isDirty()) {
          replace(out, h('div', { class: 'muted' }, t('cl.step_saving')));
          const saved = await api.saveChecklist(stripMeta(draft), note.value.trim() || undefined, true);
          ver = saved.version;
        } else if (base.status !== 'active') {
          await api.activateChecklist(ver);
        }
        replace(out, h('div', { class: 'stack' }, h('div', { class: 'muted' }, t('cl.step_evaluating', { v: ver })), progressBar(0, ids.length)));
        const { job_id } = await api.evaluate({ conversation_ids: ids, checklist_version: ver });
        const job = await pollJob(job_id, (j) => replace(out, h('div', { class: 'stack' }, h('div', { class: 'muted' }, t('job.progress', { done: j.done || 0, total: j.total || ids.length, failed: j.failed || 0 })), progressBar((j.done || 0) + (j.failed || 0), j.total || ids.length))));
        const evals = await Promise.all((job.results || []).map(async (r) => { if (!r.evaluation_id) return { r, e: null }; try { return { r, e: await api.evaluation(r.evaluation_id) }; } catch { return { r, e: null }; } }));
        replace(out, applyTable(evals, ver));
        selected = ver; await loadVersions(true);
      } catch (e) { replace(out, errorBox(e)); go.disabled = false; }
    } }, t('cl.save_apply_go'));
    replace(body, h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('cl.save_apply_hint')), isDirty() ? field(t('cl.note'), note) : h('div', { class: 'note' }, t('cl.not_dirty_note', { v: selected })), picker.el, h('div', { class: 'row' }, go), out));
  }

  function applyTable(evals, ver) {
    const rows = evals.map(({ r, e }) => {
      const cache = (e && e.trace && e.trace.cache) || { hits: [], misses: [] };
      const codeOf = (id) => { const c = (e && e.results || []).find((x) => x.criterion_id === id); return c ? c.code : id; };
      return h('tr', null,
        h('td', null, h('a', { href: cardHash(r.conversation_id), class: 'mono' }, r.conversation_id)),
        h('td', { class: 'num' }, r.error ? h('span', { class: 'dirty' }, r.error) : h('b', null, r.total_str ?? (e && e.total_str) ?? t('card.not_calculated'))),
        h('td', null, (cache.misses || []).length ? h('span', { class: 'cache-miss' }, (cache.misses || []).map(codeOf).join(', ')) : h('span', { class: 'muted' }, '—')),
        h('td', null, (cache.hits || []).length ? h('span', { class: 'cache-hit' }, (cache.hits || []).map(codeOf).join(', ')) : h('span', { class: 'muted' }, '—')),
        h('td', null, e ? h('span', { class: 'small muted' }, provenance(e).time || '—') : ''));
    });
    return h('div', { class: 'stack' }, h('div', { class: 'note' }, t('cl.apply_note', { v: ver })),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, t('col.id')), h('th', null, t('col.total')), h('th', null, t('cl.sent_to_model')), h('th', null, t('cl.from_cache')), h('th', null, t('cl.latency')))), h('tbody', null, rows))));
  }

  // provider / offline state arrives with /api/health: re-evaluate which buttons may run
  // (only when that state changes, so periodic health polls do not reset an open editor)
  const gate = () => `${providerAvailable()}|${isOffline()}`;
  let lastGate = gate();
  const unsub = subscribe((what) => {
    if (what !== 'health' && what !== 'offline') return;
    const g = gate();
    if (g !== lastGate && draft && base) { lastGate = g; drawEditor(); }
  });
  loadVersions(true);
  return { destroy() { unsub(); } };
}

function truncate(str, n) { str = String(str ?? ''); return str.length > n ? str.slice(0, n - 1) + '…' : str; }
