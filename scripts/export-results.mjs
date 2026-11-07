#!/usr/bin/env node
// Writes the organizers' results file (JSON 1.0) from stored evaluations.
//   npm run export:results -- --group DEV  --out results/dev/results.json
//   npm run export:results -- --group <control group_id> --out results/prod/results.json --expect 10
// Every conversation of the group gets exactly one record; a dialog without a complete evaluation is written
// with status "error" (never hidden, never replaced by a zero score).
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnv } from '../server/lib/env.js';
import { ROOT } from '../server/config.js';
import { createApp } from '../server/app.js';
import { buildResultsFile, validateResultsFile } from '../server/services/results.js';

loadEnv(join(ROOT, '.env'));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const n = process.argv[i + 1]; if (n && !n.startsWith('--')) { args[a.slice(2)] = n; i++; } else args[a.slice(2)] = true; }
}
const groupId = args.group || 'DEV';
const out = args.out || join(ROOT, 'results', groupId === 'DEV' ? 'dev' : 'prod', 'results.json');
const log = (m) => process.stderr.write(`[results] ${m}\n`);

const app = await createApp({ log: () => {} });
const rows = app.data.rows(groupId).map((r) => ({ conversation_id: r.conversation_id, evaluations: app.engine.evaluationsFor(r.group_id, r.conversation_id) }));
if (!rows.length) { log(`группа ${groupId} не загружена`); process.exit(2); }
const file = buildResultsFile({ teamName: args.team || process.env.CQA_TEAM_NAME || 'Revengers', rows });
const problems = validateResultsFile(file, { expectedCount: args.expect ? Number(args.expect) : null });
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
const ok = file.results.filter((r) => r.status === 'ok').length;
log(`${out}: ${file.results.length} записей (ok ${ok}, error ${file.results.length - ok}); model: ${file.model.mode} — ${file.model.name}`);
if (problems.length) { log(`ПРОВЕРКА НЕ ПРОЙДЕНА:\n  ${problems.join('\n  ')}`); process.exit(1); }
log('проверка формата пройдена');
app.flush?.();
process.exit(0);
