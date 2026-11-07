// Single HTTP client. Every request goes through here so apiBase, errors and offline state are handled once.
import { setOffline } from './state.js';
import { t } from './i18n.js';

export function apiBase() { return (window.CQA_CONFIG && window.CQA_CONFIG.apiBase) || ''; }

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

async function request(method, path, body, opts = {}) {
  const url = apiBase() + path;
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (opts.signal) init.signal = opts.signal;
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    setOffline(true);
    throw new ApiError(`${t('health.offline')}. ${t('health.offline_hint')}`, 0, null);
  }
  setOffline(false);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.error) ? data.error : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b ?? {}, o),

  health: () => request('GET', '/api/health'),
  groups: () => request('GET', '/api/groups'),
  fetchDataset: (group_id, url) => request('POST', '/api/datasets/fetch', url ? { group_id, url } : { group_id }),
  upload: (payload, group_id) => request('POST', '/api/transcripts/upload', group_id ? { group_id, payload } : { payload }),
  conversations: (q = {}) => request('GET', '/api/conversations' + qs(q)),
  conversation: (id, version, group) => request('GET', `/api/conversations/${enc(id)}?` + [version ? `checklist_version=${enc(version)}` : '', group ? `group_id=${enc(group)}` : ''].filter(Boolean).join('&')),
  audioUrl: (id, group) => `${apiBase()}/api/audio/${enc(id)}` + (group ? `?group_id=${enc(group)}` : ''),
  exportUrl: (group_id) => `${apiBase()}/api/export.csv` + qs({ group_id }),

  checklists: () => request('GET', '/api/checklists'),
  checklistActive: () => request('GET', '/api/checklists/active'),
  checklist: (v) => request('GET', `/api/checklists/${enc(v)}`),
  saveChecklist: (checklist, note, activate) => request('POST', '/api/checklists', { checklist, note, activate: !!activate }),
  activateChecklist: (v) => request('POST', `/api/checklists/${enc(v)}/activate`),
  restoreChecklist: (v) => request('POST', `/api/checklists/${enc(v)}/restore`),
  diff: (from, to) => request('GET', `/api/checklists/diff?from=${enc(from)}&to=${enc(to)}`),
  replaceCriterion: (b) => request('POST', '/api/checklists/replace-criterion', b),
  templates: () => request('GET', '/api/templates'),
  simulate: (checklist, conversation_ids, criteria_ids) => request('POST', '/api/simulate', criteria_ids ? { checklist, conversation_ids, criteria_ids } : { checklist, conversation_ids }),

  evaluate: (b) => request('POST', '/api/evaluate', b),
  job: (id) => request('GET', `/api/jobs/${enc(id)}`),
  jobs: () => request('GET', '/api/jobs'),
  cancelJob: (id) => request('POST', `/api/jobs/${enc(id)}/cancel`),
  resumeJob: (id) => request('POST', `/api/jobs/${enc(id)}/resume`),
  evaluation: (id) => request('GET', `/api/evaluations/${enc(id)}`),

  createAppeal: (b) => request('POST', '/api/appeals', b),
  appeals: (status = 'all') => request('GET', `/api/appeals?status=${enc(status)}`),
  appeal: (id) => request('GET', `/api/appeals/${enc(id)}`),
  secondOpinion: (id) => request('POST', `/api/appeals/${enc(id)}/second-opinion`),
  decide: (id, b) => request('POST', `/api/appeals/${enc(id)}/decision`, b),

  stats: (group_id) => request('GET', '/api/stats' + qs({ group_id })),
  calibration: () => request('GET', '/api/calibration'),
  runCalibration: () => request('POST', '/api/calibration/run'),
};

function enc(v) { return encodeURIComponent(String(v)); }
function qs(q) {
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([k, v]) => `${enc(k)}=${enc(v === true ? 1 : v)}`);
  return p.length ? '?' + p.join('&') : '';
}

/** Poll a job until it leaves queued/running. onTick(job) is called after every poll. */
export function pollJob(id, onTick, { interval = 1200, signal } = {}) {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const stop = () => { stopped = true; };
    if (signal) signal.addEventListener('abort', stop);
    const tick = async () => {
      if (stopped) return resolve(null);
      let job;
      try { job = await api.job(id); } catch (e) { return reject(e); }
      try { onTick && onTick(job); } catch (e) { console.error(e); }
      if (job.status === 'queued' || job.status === 'running') setTimeout(tick, interval);
      else resolve(job);
    };
    tick();
  });
}
