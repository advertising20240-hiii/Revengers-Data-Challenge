// Datasets: fetch from the organizers' API (with raw cache), upload, and conversation access.
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareConversation } from '../../packages/transcript/node.js';
import { extractOperatorName } from '../../packages/transcript/index.js';
import { writeJsonAtomic, readJson } from '../lib/store.js';
import { HttpError } from '../lib/http.js';
import { transcriptDigest } from './evaluations.js';

export const convKey = (groupId, conversationId) => `${groupId}::${conversationId}`;

/** Accept the full API response, {records}, {data:{records}}, an array, or a single record. */
export function extractRecords(payload) {
  if (payload == null) throw new HttpError(400, 'payload is empty');
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { throw new HttpError(400, 'payload must be JSON (object, array or API response)'); }
  }
  if (Array.isArray(payload)) return { records: payload, groupId: null };
  if (typeof payload !== 'object') throw new HttpError(400, 'payload must be a JSON object or array');
  if (payload.isSuccess === false) throw new HttpError(400, `API response reports failure: ${payload.error || 'unknown error'}`);
  if (payload.data && Array.isArray(payload.data.records)) return { records: payload.data.records, groupId: payload.data.dataset_group_id ?? null };
  if (Array.isArray(payload.records)) return { records: payload.records, groupId: payload.dataset_group_id ?? payload.group_id ?? null };
  if (payload.conversation_id) return { records: [payload], groupId: payload.group_id ?? null };
  throw new HttpError(400, 'payload has no records (expected API response, {records:[...]}, an array or a single record with conversation_id)');
}

export class DataService {
  constructor(db, config, { fetchImpl = globalThis.fetch } = {}) {
    this.db = db;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.rawDir = join(config.dataDir, 'raw');
    this.prepared = new Map();
  }

  // ---------- groups ----------
  groups() {
    return this.db.groups.all().map((g) => ({ group_id: g.id, count: this.db.conversations.find((c) => c.group_id === g.id).length, source: g.source, fetched_at: g.fetched_at, url: g.url ?? null }))
      .sort((a, b) => a.group_id.localeCompare(b.group_id));
  }

  /** Add records to a group; duplicates within the same group are replaced, same ids in other groups are kept apart. */
  addRecords(groupId, records, source = 'upload', meta = {}) {
    if (!groupId || typeof groupId !== 'string') throw new HttpError(400, 'group_id is required');
    const prepared = [];
    let skipped = 0;
    for (const rec of records) {
      if (!rec || typeof rec !== 'object' || !rec.conversation_id) { skipped++; continue; }
      let conv;
      try { conv = prepareConversation(rec, groupId); } catch (e) { skipped++; continue; }
      if (!conv.lines.length) { skipped++; continue; } // a dialog without a single line cannot be evaluated
      prepared.push({ rec, conv });
    }
    // nothing usable: refuse instead of creating an empty group
    if (!prepared.length) throw new HttpError(400, `Ни одна из записей (${records.length}) не прошла проверку: нужны conversation_id и transcript с репликами; группа «${groupId}» не создана.`, { skipped });
    const ids = [];
    const now = new Date().toISOString();
    for (const { rec, conv } of prepared) {
      const id = convKey(groupId, conv.conversation_id);
      const digest = transcriptDigest(conv);
      const old = this.db.conversations.get(id);
      let changedAt = old?.content_changed_at ?? null;
      if (old) {
        let oldDigest = old.transcript_hash;
        if (!oldDigest) { try { oldDigest = transcriptDigest(this.prepare(old)); } catch { oldDigest = null; } }
        // remembered so that evaluations of the previous content are not reused (see engine.sameTranscript)
        if (oldDigest !== digest) changedAt = now;
      }
      this.db.conversations.put({ id, group_id: groupId, conversation_id: conv.conversation_id, record: rec, added_at: now, source, transcript_hash: digest, ...(changedAt ? { content_changed_at: changedAt } : {}) });
      this.prepared.delete(id);
      ids.push(conv.conversation_id);
    }
    const existing = this.db.groups.get(groupId) || { id: groupId };
    this.db.groups.put({ ...existing, source, fetched_at: new Date().toISOString(), ...meta });
    this.db.scheduleSave();
    return { group_id: groupId, added: ids.length, skipped, ids };
  }

  upload(groupId, payload) {
    const { records, groupId: inferred } = extractRecords(payload);
    const gid = String(groupId || inferred || 'UPLOAD').trim();
    if (!records.length) throw new HttpError(400, 'payload contains no records');
    return this.addRecords(gid, records, 'upload');
  }

  buildUrl(base, groupId) {
    const u = new URL(base);
    u.searchParams.set('group_id', groupId);
    return u.toString();
  }

  async fetchGroup(groupId, { url = null } = {}) {
    if (!groupId || typeof groupId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(groupId)) throw new HttpError(400, 'group_id must be a short identifier (letters, digits, - _ .)');
    // Only the configured organizers' endpoint (DEFAULT_DATA_URL or CQA_DATA_URL) is fetched: a client-supplied URL
    // would turn the server into an open proxy into whatever network it runs in.
    if (url && url !== this.config.dataUrl) throw new HttpError(400, 'Загрузка возможна только из API организаторов (CQA_DATA_URL); произвольный url не принимается.');
    const base = this.config.dataUrl;
    const target = this.buildUrl(base, groupId);
    const cacheFile = join(this.rawDir, `${groupId}.json`);
    let payload = null; let source = 'api'; let apiError = null;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.config.fetchTimeoutMs);
      const res = await this.fetchImpl(target, { signal: ac.signal, headers: { Accept: 'application/json' } }).finally(() => clearTimeout(timer));
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('response is not JSON'); }
      if (json.isSuccess === false || json.isSuccess === 'false') throw new Error(json.error || 'isSuccess=false (unknown group_id?)');
      const { records } = extractRecords(json);
      if (!records.length) throw new Error('response contains no records');
      payload = json;
      mkdirSync(this.rawDir, { recursive: true });
      writeJsonAtomic(cacheFile, json);
    } catch (e) {
      apiError = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
      const cached = readJson(cacheFile, null);
      if (cached) { payload = cached; source = 'cache'; }
    }
    if (!payload) throw new HttpError(502, `Не удалось загрузить набор «${groupId}» из API организаторов (${apiError}); локального кэша нет.`);
    const { records } = extractRecords(payload);
    const r = this.addRecords(groupId, records, source, { url: base, api_error: apiError });
    return { group_id: groupId, total: r.added, source, fetched_at: new Date().toISOString(), api_error: apiError, ids: r.ids };
  }

  /** Load a cached raw file without network (used at first start for DEV). */
  importFile(groupId, file, source = 'file') {
    if (!existsSync(file)) return null;
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const { records } = extractRecords(json);
    return this.addRecords(groupId, records, source);
  }

  // ---------- conversations ----------
  prepare(row) {
    let p = this.prepared.get(row.id);
    if (!p) { p = prepareConversation(row.record, row.group_id); this.prepared.set(row.id, p); }
    return p;
  }

  rows(groupId = null) {
    return this.db.conversations.all().filter((r) => !groupId || r.group_id === groupId);
  }

  /** Resolve by conversation_id (optionally scoped to a group); ambiguous ids need group_id. */
  resolve(conversationId, groupId = null) {
    if (groupId) {
      const row = this.db.conversations.get(convKey(groupId, conversationId));
      if (!row) throw new HttpError(404, `Conversation ${conversationId} not found in group ${groupId}`);
      return row;
    }
    const rows = this.db.conversations.find((r) => r.conversation_id === conversationId);
    if (!rows.length) throw new HttpError(404, `Conversation ${conversationId} not found`);
    if (rows.length > 1) {
      const dev = rows.find((r) => r.group_id === 'DEV');
      if (dev) return dev;
      throw new HttpError(409, `Conversation ${conversationId} exists in several groups (${rows.map((r) => r.group_id).join(', ')}); pass ?group_id=`);
    }
    return rows[0];
  }

  conversation(row) { return this.prepare(row); }

  operatorName(conv) {
    const f = conv.facts?.first_operator;
    if (f?.operator_name) return f.operator_name;
    for (const l of conv.lines) if (l.speaker === 'operator') { const n = extractOperatorName(l.text); if (n) return n; }
    return null;
  }

  summary(row) {
    const conv = this.prepare(row);
    return {
      conversation_id: conv.conversation_id,
      group_id: row.group_id,
      channel: conv.channel,
      language: conv.language,
      client_language: conv.facts.client_language,
      operator_name: this.operatorName(conv),
      operator_participated: conv.facts.operator_participated,
      lines_count: conv.lines.length,
      duration_seconds: conv.facts.duration_seconds,
      first_reaction_seconds: conv.facts.first_reaction_seconds,
      has_audio: !!conv.audio_url,
      // the client's first message: lets the reviewer recognise a dialog in the list without opening it
      first_client_text: (conv.lines.find((l) => l.speaker === 'client')?.text || '').slice(0, 160),
    };
  }
}
