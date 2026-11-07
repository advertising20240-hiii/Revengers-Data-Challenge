// Entry point: `npm start` → API + static UI on http://localhost:8080
import { join } from 'node:path';
import { loadEnv } from './lib/env.js';
import { ROOT } from './config.js';
import { createApp } from './app.js';

loadEnv(join(ROOT, '.env'));

const log = (m) => console.log(`[cqa] ${m}`);
const app = await createApp({ log });
const addr = await app.listen();
if (typeof app.engine.evaluator?.probeProvider === 'function') {
  await Promise.race([app.engine.evaluator.probeProvider().catch(() => null), new Promise((r) => setTimeout(r, 3000))]);
}
const p = app.engine.providerInfo();
log(`listening on http://localhost:${addr.port}  (data: ${app.config.dataDir})`);
log(`conversations: ${app.db.conversations.size}, evaluations: ${app.db.evaluations.size}, checklists: ${app.db.checklists.size}`);
log(`evaluator: ${p.available ? `${p.provider} / ${p.model}` : `недоступен — ${p.reason}`}`);

const shutdown = () => { app.flush(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
