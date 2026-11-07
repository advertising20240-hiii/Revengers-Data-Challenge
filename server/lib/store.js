// JSON-file collections with atomic writes (temp file + rename).
// Everything is held in memory; every mutation is persisted through `save()`.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function writeJsonAtomic(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    // Windows may refuse to replace a file that another handle is reading; retry once.
    try { unlinkSync(file); } catch { /* ignore */ }
    renameSync(tmp, file);
  }
}

export function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** A keyed collection persisted as a single JSON file `<dir>/<name>.json`. */
export class Collection {
  constructor(dir, name, keyOf = (it) => it.id) {
    this.file = join(dir, `${name}.json`);
    this.name = name;
    this.keyOf = keyOf;
    this.items = new Map();
    this.dirty = false;
    const data = readJson(this.file, null);
    if (data && typeof data === 'object') {
      const list = Array.isArray(data) ? data : Object.values(data);
      for (const it of list) if (it && this.keyOf(it) != null) this.items.set(String(this.keyOf(it)), it);
    }
  }
  get(id) { return this.items.get(String(id)) ?? null; }
  has(id) { return this.items.has(String(id)); }
  all() { return [...this.items.values()]; }
  get size() { return this.items.size; }
  put(item) { this.items.set(String(this.keyOf(item)), item); this.dirty = true; return item; }
  remove(id) { const ok = this.items.delete(String(id)); if (ok) this.dirty = true; return ok; }
  find(pred) { return this.all().filter(pred); }
  save(force = false) {
    if (!this.dirty && !force) return;
    writeJsonAtomic(this.file, this.all());
    this.dirty = false;
  }
}

/** Database = a set of collections under one directory. */
export class Db {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.conversations = new Collection(dir, 'conversations');
    this.groups = new Collection(dir, 'groups');
    this.checklists = new Collection(dir, 'checklists', (c) => c.version);
    this.evaluations = new Collection(dir, 'evaluations');
    this.appeals = new Collection(dir, 'appeals');
    this.jobs = new Collection(dir, 'jobs');
    this._timer = null;
  }
  get collections() { return [this.conversations, this.groups, this.checklists, this.evaluations, this.appeals, this.jobs]; }
  get isEmpty() { return this.collections.every((c) => c.size === 0); }
  saveAll() { for (const c of this.collections) c.save(); }
  /** Coalesce many mutations into one disk write per tick. */
  scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.saveAll(); }, 50);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.saveAll();
  }
}

export function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
}
