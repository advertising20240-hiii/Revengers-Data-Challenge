// Minimal .env loader: KEY=VALUE lines, '#' comments, optional single/double quotes.
// Existing process.env values always win, so the shell can override the file.
import { readFileSync, existsSync } from 'node:fs';

export function loadEnv(file) {
  if (!file || !existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '');
    out[key] = val;
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return out;
}
