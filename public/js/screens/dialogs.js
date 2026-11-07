// Screen 1 — Диалоги: dataset loading, table with filters, batch evaluation with progress, export.
import { h, clear, replace } from '../dom.js';
import { t, pl } from '../i18n.js';
import { api, pollJob } from '../api.js';
import { state, setGroup, setJob, subscribe, providerAvailable, providerReason } from '../state.js';
import { chip, langTag, toast, openModal, skeleton, emptyState, errorBox, progressBar, field, select } from '../components.js';
import { cardHash, navigate } from '../router.js';
import { channelLabel, grossTypeLabel, secs, reviewReasons } from '../format.js';

// Selection keys carry the group: the same conversation_id may exist in DEV and in the control set.
export const selKey = (r) => JSON.stringify([r.group_id || '', r.conversation_id]);
export const fromKey = (k) => { const [group_id, conversation_id] = JSON.parse(k); return group_id ? { conversation_id, group_id } : { conversation_id }; };

export function renderDialogs(main) {
  const filters = { group_id: state.group, lang: '', channel: '', flag: false, needs_review: false, status: '', q: '' };
  let rows = [], loading = true, error = null, sort = { key: 'conversation_id', dir: 1 };
  let unsub = null, pollAbort = null;

  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, t('dialogs.title')), h('p', { class: 'lead' }, t('dialogs.lead'))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: openFetchModal }, t('dialogs.fetch')),
      h('button', { class: 'btn', type: 'button', onclick: openUploadModal }, t('dialogs.upload')),
      h('a', { class: 'btn', href: api.exportUrl(filters.group_id), dataset: { export: '1' }, download: 'cqa-export.csv' }, t('dialogs.export')),
      h('a', { class: 'btn', href: api.resultsUrl(filters.group_id || 'DEV'), dataset: { results: '1' }, download: 'results.json', title: t('dialogs.results_json_hint') }, t('dialogs.results_json'))));

  const groupSel = select([{ value: '', label: t('dialogs.all_groups') }], filters.group_id, (v) => { filters.group_id = v; setGroup(v); load(); }, { 'aria-label': t('col.group') });
  const langSel = select([{ value: '', label: t('dialogs.all_langs') }, { value: 'RU', label: 'RU' }, { value: 'KZ', label: 'KZ' }, { value: 'EN', label: 'EN' }], '', (v) => { filters.lang = v; draw(); }, { 'aria-label': t('col.lang') });
  const chSel = select([{ value: '', label: t('dialogs.all_channels') }, { value: 'agent chat', label: t('channel.chat') }, { value: 'voice call', label: t('channel.voice') }], '', (v) => { filters.channel = v; draw(); }, { 'aria-label': t('col.channel') });
  const flagChk = h('input', { type: 'checkbox', onchange: (e) => { filters.flag = e.target.checked; draw(); } });
  const nrChk = h('input', { type: 'checkbox', onchange: (e) => { filters.needs_review = e.target.checked; draw(); } });
  // Enter opens the card when the query matches exactly one dialog (or one id exactly) — two keystrokes to any demo dialog.
  const search = h('input', { type: 'search', class: 'search', placeholder: t('dialogs.search'), 'aria-label': t('dialogs.search'), autocomplete: 'off',
    oninput: (e) => { filters.q = e.target.value.trim().toLowerCase(); draw(); },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      const list = filtered();
      const exact = list.find((r) => r.conversation_id.toLowerCase() === filters.q);
      const hit = exact || (list.length === 1 ? list[0] : null);
      if (hit) navigate(cardHash(hit.conversation_id, null, hit.group_id));
    } });

  const evalAllBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => startEvaluate({ all: true }) }, t('dialogs.eval_all'));
  const evalSelBtn = h('button', { class: 'btn', type: 'button', onclick: () => startEvaluate({ ids: [...state.selection].map(fromKey) }) }, t('dialogs.eval_selected'));
  const selInfo = h('span', { class: 'muted small' });

  const toolbar = h('div', { class: 'toolbar' },
    groupSel, langSel, chSel,
    h('label', { class: 'chk' }, flagChk, t('dialogs.only_gross')),
    h('label', { class: 'chk' }, nrChk, t('dialogs.only_review')),
    search,
    h('span', { class: 'grow' }),
    selInfo, evalSelBtn, evalAllBtn);

  const jobBox = h('div');
  const body = h('div');
  const card = h('div', { class: 'card' }, toolbar, jobBox, body);
  replace(main, head, card);

  function updateEvalButtons() {
    const ok = providerAvailable();
    const title = ok ? '' : t('health.eval_disabled', { reason: providerReason() || '—' });
    evalAllBtn.disabled = !ok || !rows.length;
    evalSelBtn.disabled = !ok || state.selection.size === 0;
    evalAllBtn.title = title; evalSelBtn.title = title;
    selInfo.textContent = state.selection.size ? t('dialogs.selected', { n: state.selection.size }) : '';
  }

  /** Validates the organizers' results file for the current set and shows the outcome on the download button. */
  async function checkResults() {
    const a = head.querySelector('[data-results]');
    const g = filters.group_id || 'DEV';
    try {
      const f = await api.results(g);
      const problems = f._validation || [];
      const n = (f.results || []).length;
      a.textContent = problems.length ? t('dialogs.results_bad', { n }) : t('dialogs.results_ok', { n });
      a.classList.toggle('ok', !problems.length);
      a.title = problems.length ? problems.slice(0, 5).join('\n') : t('dialogs.results_json_hint');
    } catch { a.textContent = t('dialogs.results_json'); }
  }

  async function load() {
    loading = true; error = null; draw();
    try {
      const [groups, list] = await Promise.all([api.groups().catch(() => []), api.conversations({ group_id: filters.group_id || undefined })]);
      const opts = [{ value: '', label: t('dialogs.all_groups') }, ...groups.map((g) => ({ value: g.group_id, label: `${g.group_id} (${g.count})` }))];
      replace(groupSel, opts.map((o) => { const op = h('option', { value: o.value }, o.label); if (o.value === filters.group_id) op.selected = true; return op; }));
      rows = list;
      head.querySelector('[data-export]').href = api.exportUrl(filters.group_id);
      head.querySelector('[data-results]').href = api.resultsUrl(filters.group_id || 'DEV');
      checkResults();
    } catch (e) { error = e; }
    loading = false; draw();
  }

  function filtered() {
    return rows.filter((r) => {
      if (filters.lang && r.language !== filters.lang) return false;
      if (filters.channel && r.channel !== filters.channel) return false;
      if (filters.flag && !(r.latest && r.latest.gross_flag)) return false;
      if (filters.needs_review && !(r.latest && r.latest.needs_review)) return false;
      if (filters.q) {
        const hay = `${r.conversation_id} ${r.operator_name || ''} ${r.group_id || ''}`.toLowerCase();
        if (!hay.includes(filters.q)) return false;
      }
      return true;
    }).sort((a, b) => {
      const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return (va > vb ? 1 : -1) * sort.dir;
    });
  }

  function sortVal(r, k) {
    switch (k) {
      case 'total': return r.latest ? r.latest.total : null;
      case 'conf': return r.latest ? r.latest.min_confidence : null;
      case 'gross': return r.latest ? (r.latest.gross_flag ? 1 : 0) : null;
      case 'appeal': return r.appeal_status;
      case 'version': return r.latest ? r.latest.checklist_version : null;
      default: return r[k];
    }
  }

  function th(label, key) {
    const b = h('button', { type: 'button', onclick: () => { if (sort.key === key) sort.dir = -sort.dir; else { sort.key = key; sort.dir = 1; } draw(); }, 'aria-sort': sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
      label, sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : '');
    return h('th', { scope: 'col' }, b);
  }

  function draw() {
    updateEvalButtons();
    clear(body);
    if (loading) { body.append(skeleton(8)); return; }
    if (error) { body.append(errorBox(error, load)); return; }
    if (!rows.length) {
      body.append(emptyState(t('dialogs.empty_title'), t('dialogs.empty_hint'), h('button', { class: 'btn primary', type: 'button', onclick: openFetchModal }, t('dialogs.fetch'))));
      return;
    }
    const list = filtered();
    if (!list.length) { body.append(emptyState(t('dialogs.nomatch_title'), t('dialogs.nomatch_hint'))); return; }
    const allChk = h('input', { type: 'checkbox', 'aria-label': t('dialogs.select_all'), onchange: (e) => { for (const r of list) { if (e.target.checked) state.selection.add(selKey(r)); else state.selection.delete(selKey(r)); } draw(); } });
    allChk.checked = list.every((r) => state.selection.has(selKey(r)));
    const table = h('table', { class: 'tbl' },
      h('thead', null, h('tr', null,
        h('th', null, allChk), th(t('col.id'), 'conversation_id'), th(t('col.lang'), 'language'), th(t('col.channel'), 'channel'), th(t('col.operator'), 'operator_name'),
        th(t('col.total'), 'total'), th(t('col.gross'), 'gross'), th(t('col.conf'), 'conf'), th(t('col.appeal'), 'appeal'), th(t('col.version'), 'version'))),
      h('tbody', null, list.map(rowEl)));
    body.append(h('div', { class: 'tbl-wrap' }, table), h('div', { class: 'row between', style: { padding: '.6rem 1rem' } },
      h('span', { class: 'muted small' }, t('dialogs.count', { n: list.length, total: rows.length })),
      h('span', { class: 'muted small' }, `${t('dialogs.hint_open')} · ${t('dialogs.hint_enter')}`)));
  }

  function rowEl(r) {
    const L = r.latest;
    const chk = h('input', { type: 'checkbox', 'aria-label': r.conversation_id, onchange: (e) => { if (e.target.checked) state.selection.add(selKey(r)); else state.selection.delete(selKey(r)); updateEvalButtons(); e.target.closest('tr').classList.toggle('sel', e.target.checked); } });
    chk.checked = state.selection.has(selKey(r));
    const totalCell = L ? (L.calculated ? h('span', { class: 'total-cell' }, L.total_str) : h('span', { class: 'total-cell na' }, t('card.not_calculated'))) : h('span', { class: 'muted' }, '—');
    const gross = L ? (L.gross_flag ? chip((L.gross_types || []).map(grossTypeLabel).join(', ') || t('answer.yes'), 'flag') : h('span', { class: 'muted' }, '—')) : h('span', { class: 'muted' }, '—');
    const reasons = L ? reviewReasons(L) : [];
    const conf = L && L.min_confidence !== null && L.min_confidence !== undefined
      ? h('span', null, h('span', { class: 'row', style: { gap: '.35rem' } }, `${Math.round(L.min_confidence * 100)}%`, L.needs_review ? h('span', { class: 'chip warn', title: reasons.join('; ') || t('card.needs_review') }, t('card.needs_review')) : null),
        L.needs_review && reasons.length ? h('div', { class: 'muted small reasons', title: reasons.join('; ') }, reasons.join(' · ')) : null)
      : h('span', { class: 'muted' }, '—');
    const ap = r.appeal_status === 'open' ? chip(t('status.under_appeal'), 'warn') : r.appeal_status === 'resolved' ? chip(t('status.reviewed'), 'info') : h('span', { class: 'muted' }, '—');
    return h('tr', { class: chk.checked ? 'sel' : '' },
      h('td', null, chk),
      h('td', null, h('a', { href: cardHash(r.conversation_id, null, r.group_id), class: 'mono' }, r.conversation_id), r.first_client_text ? h('div', { class: 'small first-msg', title: r.first_client_text }, r.first_client_text) : null, r.lines_count ? h('div', { class: 'muted small' }, `${pl(r.lines_count, 'unit.lines')} · ${secs(r.duration_seconds)}`) : null),
      h('td', null, langTag(r.language)),
      h('td', null, channelLabel(r.channel)),
      h('td', null, r.operator_name || h('span', { class: 'muted' }, '—')),
      h('td', { class: 'num' }, totalCell),
      h('td', null, gross),
      h('td', null, conf),
      h('td', null, ap),
      h('td', null, L ? `v${L.checklist_version}` : h('span', { class: 'muted' }, '—')));
  }

  // ---- dataset loading ----
  function openFetchModal() {
    const gid = h('input', { type: 'text', value: filters.group_id || 'DEV', placeholder: 'DEV', required: true });
    const status = h('div', { class: 'small muted' });
    const okBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      okBtn.disabled = true; status.textContent = t('dialogs.fetching');
      try {
        const r = await api.fetchDataset(gid.value.trim());
        toast(t('dialogs.fetched', { n: r.total, src: r.source === 'cache' ? t('dialogs.src_cache') : t('dialogs.src_api') }), 'ok');
        filters.group_id = r.group_id; setGroup(r.group_id); m.close(); load();
      } catch (e) { status.textContent = ''; replace(status, errorBox(e)); okBtn.disabled = false; }
    } }, t('dialogs.fetch_go'));
    const m = openModal({
      title: t('dialogs.fetch'),
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('dialogs.fetch_hint')), field(t('col.group'), gid), h('p', { class: 'muted small' }, t('dialogs.fetch_url_fixed')), status),
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('btn.cancel')), okBtn],
    });
  }

  function openUploadModal() {
    const gid = h('input', { type: 'text', value: filters.group_id || '', placeholder: t('dialogs.upload_group_ph') });
    const file = h('input', { type: 'file', accept: 'application/json,.json' });
    const ta = h('textarea', { placeholder: t('dialogs.paste_ph'), rows: 8 });
    const status = h('div', { class: 'small muted' });
    // The organizers' API response names its set (data.dataset_group_id): use it instead of the pre-filled filter group,
    // otherwise a control file uploaded while DEV is selected would be merged into DEV.
    const groupFromFile = () => {
      try { const p = JSON.parse(ta.value); const g = p && (p.data?.dataset_group_id ?? p.dataset_group_id ?? (Array.isArray(p) ? null : p.group_id)); if (typeof g === 'string' && g.trim()) gid.value = g.trim(); } catch { /* not JSON yet */ }
    };
    ta.addEventListener('input', groupFromFile);
    file.addEventListener('change', () => { const f = file.files[0]; if (f) f.text().then((txt) => { ta.value = txt; groupFromFile(); }); });
    const okBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      let payload;
      try { payload = JSON.parse(ta.value); } catch { replace(status, errorBox(new Error(t('dialogs.bad_json')))); return; }
      okBtn.disabled = true;
      try {
        const r = await api.upload(payload, gid.value.trim() || undefined);
        toast(t('dialogs.uploaded', { n: r.added, g: r.group_id }), 'ok');
        filters.group_id = r.group_id; setGroup(r.group_id); m.close(); load();
      } catch (e) { replace(status, errorBox(e)); okBtn.disabled = false; }
    } }, t('dialogs.upload_go'));
    const m = openModal({
      title: t('dialogs.upload'),
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('dialogs.upload_hint')), field(t('col.group'), gid), field(t('dialogs.upload_file'), file), field(t('dialogs.paste'), ta), status),
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('btn.cancel')), okBtn],
    });
  }

  // ---- batch evaluation ----
  async function startEvaluate({ all, ids }) {
    if (!all && (!ids || !ids.length)) return;
    const n = all ? rows.length : ids.length;
    const version = await pickChecklist(n);
    if (version === null) return;
    try {
      const body = all ? { all: true, group_id: filters.group_id || undefined } : { conversation_ids: ids };
      if (version !== '') body.checklist_version = Number(version);
      const r = await api.evaluate(body);
      setJob({ id: r.job_id, kind: 'evaluate' });
      trackJob(r.job_id);
    } catch (e) { toast(e.message, 'err'); }
  }

  /** Confirmation with the checklist version to evaluate against (default: active). Resolves to a version, '' (server default) or null (cancelled). */
  async function pickChecklist(n) {
    let versions = [];
    try { versions = (await api.checklists()).sort((a, b) => b.version - a.version); } catch { /* the server then uses the active version */ }
    const active = versions.find((v) => v.status === 'active');
    const verSel = select(versions.map((v) => ({ value: v.version, label: `v${v.version} · ${v.name || ''} (${t(`cl.status_${v.status}`) || v.status})` })), active ? active.version : (versions[0] ? versions[0].version : ''), null, { 'aria-label': t('dialogs.eval_checklist') });
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      const m = openModal({
        title: t('dialogs.eval_confirm_title'),
        body: h('div', { class: 'stack' }, h('p', null, t('dialogs.eval_confirm', { n })),
          versions.length ? field(t('dialogs.eval_checklist'), verSel) : null,
          versions.length ? h('p', { class: 'muted small' }, t('dialogs.eval_checklist_hint')) : null),
        actions: [h('button', { class: 'btn', type: 'button', onclick: () => { finish(null); m.close(); } }, t('btn.cancel')),
          h('button', { class: 'btn primary', type: 'button', onclick: () => { finish(versions.length ? String(verSel.value) : ''); m.close(); } }, t('dialogs.eval_go'))],
        onClose: () => finish(null),
      });
    });
  }

  function trackJob(id) {
    if (pollAbort) pollAbort.abort();
    pollAbort = new AbortController();
    let lastDone = -1;
    pollJob(id, (job) => {
      drawJob(job);
      if (job.done + job.failed !== lastDone) { lastDone = job.done + job.failed; refreshRowsQuiet(); }
    }, { signal: pollAbort.signal }).then((job) => {
      if (!job) return;
      drawJob(job);
      refreshRowsQuiet();
      if (job.status === 'done') toast(t('job.finished', { n: job.done, f: job.failed }), job.failed ? '' : 'ok');
    }).catch((e) => { clear(jobBox); jobBox.append(h('div', { class: 'jobbar' }, errorBox(e))); });
  }

  async function refreshRowsQuiet() {
    try { rows = await api.conversations({ group_id: filters.group_id || undefined }); draw(); } catch { /* keep the old rows */ }
  }

  function drawJob(job) {
    clear(jobBox);
    const active = job.status === 'queued' || job.status === 'running';
    const total = job.total || 0, done = (job.done || 0) + (job.failed || 0);
    const bar = progressBar(done, total, job.status === 'done' ? 'done' : '');
    const actions = h('div', { class: 'row' });
    if (active) actions.append(h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api.cancelJob(job.id); } catch (e) { toast(e.message, 'err'); } } }, t('job.cancel')));
    if (job.status === 'cancelled' || job.status === 'failed' || (job.status === 'done' && job.failed > 0)) {
      actions.append(h('button', { class: 'btn sm', type: 'button', disabled: !providerAvailable(), title: providerAvailable() ? '' : t('health.eval_disabled', { reason: providerReason() }), onclick: async () => { try { await api.resumeJob(job.id); trackJob(job.id); } catch (e) { toast(e.message, 'err'); } } }, t('job.resume')));
    }
    if (!active) actions.append(h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { clear(jobBox); setJob(null); } }, t('job.hide')));
    const failed = (job.results || []).filter((r) => r.error);
    jobBox.append(h('div', { class: 'jobbar', aria: { live: 'polite' } },
      h('div', { class: 'row between' },
        h('div', null, h('strong', null, t(`job.${job.status}`) || job.status), ' ', h('span', { class: 'muted' }, t('job.progress', { done: job.done || 0, total, failed: job.failed || 0 })),
          job.running && job.running.length ? h('span', { class: 'muted small' }, ` · ${t('job.running_now')}: ${job.running.join(', ')}`) : null),
        actions),
      bar,
      failed.length ? h('details', { class: 'small' }, h('summary', null, t('job.failed_list', { n: failed.length })), h('ul', null, failed.map((f) => h('li', null, h('a', { href: cardHash(f.conversation_id), class: 'mono' }, f.conversation_id), f.group_id ? h('span', { class: 'muted' }, ` · ${f.group_id}`) : null, ' — ', f.error)))) : null));
  }

  // resume tracking a job after reload
  if (state.job && state.job.kind === 'evaluate') trackJob(state.job.id);

  unsub = subscribe((what) => { if (what === 'health' || what === 'offline') updateEvalButtons(); });
  load();

  return { destroy() { if (unsub) unsub(); if (pollAbort) pollAbort.abort(); } };
}
