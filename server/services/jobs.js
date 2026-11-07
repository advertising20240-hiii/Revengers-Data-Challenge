// In-process job queue for batch evaluation and simulation: bounded concurrency, progress,
// partial results, cancel (AbortSignal), resume, persisted state.
import { newId } from '../lib/hash.js';
import { HttpError } from '../lib/http.js';

// A job may contain the same conversation_id from two groups (DEV and the control set): rows are matched by both.
// Rows written before group_id was recorded match by conversation_id alone.
const sameItem = (r, it) => r.conversation_id === it.conversation_id && (r.group_id == null || it.group_id == null || r.group_id === it.group_id);

export class JobService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.controllers = new Map(); // job id -> AbortController
    this.active = new Map();     // job id -> Promise
    // Jobs interrupted by a restart are marked for resume.
    for (const j of this.db.jobs.all()) {
      if (j.status === 'running' || j.status === 'queued') { j.status = 'cancelled'; j.interrupted = true; j.running = []; this.db.jobs.put(j); }
    }
    this.db.scheduleSave();
  }

  list(limit = 20) {
    return this.db.jobs.all().sort((a, b) => (b.started_at || '').localeCompare(a.started_at || '')).slice(0, limit).map((j) => this.view(j));
  }
  get(id) { const j = this.db.jobs.get(id); if (!j) throw new HttpError(404, `Job ${id} not found`); return j; }
  view(j) {
    return {
      id: j.id, kind: j.kind, status: j.status, total: j.items.length, done: j.results.filter((r) => !r.error).length,
      failed: j.results.filter((r) => r.error).length, running: j.running || [], results: j.results, cost_usd: j.cost_usd || 0, cost_note: j.cost_note ?? null,
      started_at: j.started_at, finished_at: j.finished_at, checklist_version: j.checklist_version, group_id: j.group_id ?? null,
      interrupted: !!j.interrupted, error: j.error ?? null,
    };
  }

  /**
   * Create and start a job. `items` = conversation keys; `worker(item, signal, job)` returns a result row.
   */
  create({ kind, items, worker, checklist_version = null, group_id = null, meta = {} }) {
    const job = {
      id: newId('job'), kind, status: 'queued', items, results: [], running: [], cost_usd: 0,
      started_at: new Date().toISOString(), finished_at: null, checklist_version, group_id, ...meta,
    };
    this.db.jobs.put(job);
    // keep the job history bounded (simulation results carry full evaluations)
    const finished = this.db.jobs.all().filter((j) => !['running', 'queued'].includes(j.status)).sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
    for (const old of finished.slice(50)) this.db.jobs.remove(old.id);
    this.db.scheduleSave();
    this.workers = this.workers || new Map();
    this.workers.set(job.id, worker);
    this.run(job.id);
    return job;
  }

  run(id) {
    const job = this.get(id);
    const worker = this.workers?.get(id);
    if (!worker) throw new HttpError(409, 'Задача создана до перезапуска сервера; запустите оценку заново');
    const ac = new AbortController();
    this.controllers.set(id, ac);
    job.status = 'running'; job.finished_at = null; job.interrupted = false; job.error = null;
    this.db.jobs.put(job); this.db.scheduleSave();
    const pending = job.items.filter((it) => !job.results.some((r) => sameItem(r, it)));
    const limit = Math.max(1, Number(job.concurrency || this.config.concurrency || 2));
    let cursor = 0;
    const next = async () => {
      while (!ac.signal.aborted && cursor < pending.length) {
        const item = pending[cursor++];
        job.running = [...job.running, item.conversation_id];
        this.db.jobs.put(job);
        let row;
        try {
          row = await worker(item, ac.signal, job);
        } catch (e) {
          if (ac.signal.aborted) { job.running = job.running.filter((x) => x !== item.conversation_id); return; }
          row = { conversation_id: item.conversation_id, group_id: item.group_id, error: e?.message || String(e) };
        }
        job.running = job.running.filter((x) => x !== item.conversation_id);
        if (ac.signal.aborted && !row) return;
        if (row) {
          row.group_id ??= item.group_id;
          job.results = job.results.filter((r) => !sameItem(r, item)).concat([row]);
          job.cost_usd = Number((job.results.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0)).toFixed(6));
          if (row.cost_note) job.cost_note = row.cost_note;
        }
        this.db.jobs.put(job); this.db.scheduleSave();
      }
    };
    const p = Promise.all(Array.from({ length: Math.min(limit, pending.length || 1) }, next)).then(() => {
      job.running = [];
      if (ac.signal.aborted) job.status = 'cancelled';
      else job.status = job.results.length && job.results.every((r) => r.error) ? 'failed' : 'done';
      job.finished_at = new Date().toISOString();
      this.controllers.delete(id); this.active.delete(id);
      this.db.jobs.put(job); this.db.scheduleSave();
    }).catch((e) => {
      job.status = 'failed'; job.error = e?.message || String(e); job.running = []; job.finished_at = new Date().toISOString();
      this.controllers.delete(id); this.active.delete(id);
      this.db.jobs.put(job); this.db.scheduleSave();
    });
    this.active.set(id, p);
    return job;
  }

  cancel(id) {
    const job = this.get(id);
    const ac = this.controllers.get(id);
    if (ac) ac.abort();
    if (job.status === 'running' || job.status === 'queued') job.status = 'cancelled';
    job.running = [];
    job.finished_at = new Date().toISOString();
    this.db.jobs.put(job); this.db.scheduleSave();
    return job;
  }

  resume(id) {
    const job = this.get(id);
    if (job.status === 'running') return job;
    job.results = job.results.filter((r) => !r.error); // failed rows are retried
    if (job.items.every((it) => job.results.some((r) => sameItem(r, it)))) { job.status = 'done'; this.db.jobs.put(job); this.db.scheduleSave(); return job; }
    return this.run(id);
  }

  /** Wait until a job finishes (tests and CLI). */
  async wait(id) { const p = this.active.get(id); if (p) await p; return this.get(id); }
}
