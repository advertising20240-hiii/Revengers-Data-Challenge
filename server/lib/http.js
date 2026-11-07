// Tiny HTTP toolkit: router, JSON body parsing with a size limit, CORS, static files.
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, normalize, resolve, extname, sep } from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
};

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

/** Read a request body as text with a hard size limit (bytes). */
export function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body exceeds ${Math.round(limit / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJsonBody(req, limit) {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) {
    throw new HttpError(400, `Request body is not valid JSON: ${e.message}`);
  }
}

/** Path-pattern router: '/api/conversations/:id' → params.id. */
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\./g, '\\.') + '/?$');
    this.routes.push({ method, re, keys, handler, pattern });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = safeDecode(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** Resolve a URL path inside a root directory; null when it escapes the root. */
export function safePath(root, urlPath) {
  const rel = normalize(safeDecode(urlPath)).replace(/^([/\\])+/, '');
  if (rel.split(/[/\\]/).includes('..')) return null;
  const abs = resolve(root, rel);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  return abs;
}

/** Serve a static file (with index.html fallback for directories). Returns true when handled. */
export function serveStatic(req, res, root, urlPath, { fallbackIndex = false } = {}) {
  let file = safePath(root, urlPath);
  if (!file) { sendText(res, 403, 'Forbidden'); return true; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (fallbackIndex && !extname(urlPath)) {
      const idx = join(root, 'index.html');
      if (existsSync(idx)) file = idx; else return false;
    } else return false;
  }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const st = statSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}
