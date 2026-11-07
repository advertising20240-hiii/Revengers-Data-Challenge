#!/usr/bin/env node
// CLI evaluation without HTTP: uses the same server modules as the API.
//   npm run evaluate -- --group DEV [--checklist <version>] [--ids a,b] [--force] [--concurrency 2]
//   npm run evaluate -- --export-seed [--group DEV] [--out data/seed/DEV.evaluations.json]
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadEnv } from '../server/lib/env.js';
import { ROOT } from '../server/config.js';
import { createApp } from '../server/app.js';
import { writeJsonAtomic } from '../server/lib/store.js';

loadEnv(join(ROOT, '.env'));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const next = argv[i + 1];
      if (inline !== undefined) out[k] = inline;
      else if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage:
  npm run evaluate -- --group DEV [--checklist <version>] [--ids id1,id2] [--force] [--concurrency N]
  npm run evaluate -- --export-seed [--group DEV] [--out data/seed/DEV.evaluations.json]
  npm run evaluate -- --list-groups`);
  process.exit(0);
}

const log = (m) => process.stderr.write(`[evaluate] ${m}\n`);
const app = await createApp({ log, config: args.concurrency ? { concurrency: Number(args.concurrency) } : {} });
const groupId = args.group || 'DEV';

try {
  if (args['list-groups']) {
    for (const g of app.data.groups()) console.log(`${g.group_id}\t${g.count} conversations\t${g.source}`);
  } else if (args['export-seed']) {
    const out = args.out || join(ROOT, 'data', 'seed', `${groupId}.evaluations.json`);
    const rows = app.data.rows(groupId);
    const evaluations = [];
    for (const r of rows) {
      const list = app.engine.evaluationsFor(r.group_id, r.conversation_id);
      // one evaluation per checklist version (latest), so the demo shows every version that was applied
      const seen = new Set();
      for (const e of list) { if (seen.has(e.checklist_version)) continue; seen.add(e.checklist_version); evaluations.push(e); }
    }
    const appeals = app.db.appeals.find((a) => a.group_id === groupId);
    const checklists = app.db.checklists.all();
    mkdirSync(join(out, '..'), { recursive: true });
    writeJsonAtomic(out, { exported_at: new Date().toISOString(), group_id: groupId, checklists, evaluations, appeals });
    const covered = new Set(evaluations.map((e) => e.conversation_id)).size;
    log(`exported ${evaluations.length} evaluations (${covered}/${rows.length} conversations), ${appeals.length} appeals -> ${out}`);
    if (covered < rows.length) log(`missing: ${rows.filter((r) => !evaluations.some((e) => e.conversation_id === r.conversation_id)).map((r) => r.conversation_id).join(', ')}`);
  } else {
    const p = app.engine.providerInfo();
    if (!p.available) { log(`evaluator unavailable: ${p.reason}`); process.exit(2); }
    const checklist = app.checklists.resolve(args.checklist);
    if (!checklist) { log('no checklist installed'); process.exit(2); }
    let rows = app.data.rows(groupId);
    if (args.ids) { const ids = String(args.ids).split(',').map((s) => s.trim()).filter(Boolean); rows = rows.filter((r) => ids.includes(r.conversation_id)); }
    if (!rows.length) { log(`no conversations in group ${groupId}`); process.exit(2); }
    log(`provider ${p.provider} / ${p.model}; checklist v${checklist.version}; ${rows.length} conversations; concurrency ${app.config.concurrency}${args.force ? '; force' : ''}`);
    const t0 = Date.now();
    let done = 0; let cost = 0; let costNote = null;
    const job = app.jobs.create({
      kind: 'evaluate', items: rows.map((r) => ({ key: r.id, conversation_id: r.conversation_id, group_id: r.group_id })), checklist_version: checklist.version, group_id: groupId, meta: { force: !!args.force, source: 'cli' },
      worker: async (item, signal) => {
        const row = app.db.conversations.get(item.key);
        const ev = await app.engine.evaluate(row, checklist, { force: !!args.force, signal });
        done++; cost += ev.cost_usd || 0; costNote = ev.cost_note || costNote;
        const reused = ev.trace?.reused?.length ? ` reused=${ev.trace.reused.length}` : '';
        console.log(`${String(done).padStart(3)}/${rows.length}  ${ev.conversation_id.padEnd(12)} total=${(ev.total_str ?? 'n/a').padStart(6)}  gross=${ev.gross.flag ? ev.gross.types.join('|') : '-'}  min_conf=${ev.min_confidence}  cost=$${(ev.cost_usd || 0).toFixed(4)}  ${ev.latency_ms}ms${reused}`);
        return { conversation_id: item.conversation_id, evaluation_id: ev.id, total_str: ev.total_str, cost_usd: ev.cost_usd };
      },
    });
    process.on('SIGINT', () => { log('cancelling…'); app.jobs.cancel(job.id); });
    const final = await app.jobs.wait(job.id);
    const failed = final.results.filter((r) => r.error);
    for (const f of failed) console.log(`FAILED ${f.conversation_id}: ${f.error}`);
    const totals = final.results.filter((r) => r.total_str).map((r) => Number(r.total_str));
    const avg = totals.length ? (totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(2) : 'n/a';
    log(`${final.status}: ${final.results.length - failed.length} ok, ${failed.length} failed, avg total ${avg}, cost $${cost.toFixed(4)}${costNote ? ` (${costNote})` : ''}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} finally {
  app.flush();
  await app.close().catch(() => {});
}
