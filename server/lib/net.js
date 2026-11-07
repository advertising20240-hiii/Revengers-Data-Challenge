// Outbound fetch guard for URLs that come from data (recording links in uploaded transcripts):
// only http(s), never loopback / private / link-local hosts, redirects re-checked hop by hop.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from './http.js';

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** True for addresses that must not be reached from the server (loopback, private, link-local, ULA, multicast, unspecified). */
export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return ipv4Private(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return true; // not an IP: never treat as safe
}

/** Throws HttpError(400) unless `raw` is an http(s) URL whose host resolves only to public addresses. */
export async function assertPublicUrl(raw, { resolve = lookup } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new HttpError(400, 'Некорректная ссылка на запись'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, `Ссылка на запись должна быть http(s), получено ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) throw new HttpError(400, `Адрес записи во внутренней сети запрещён (${host})`);
  let addrs;
  if (isIP(host)) addrs = [host];
  else {
    try { addrs = (await resolve(host, { all: true })).map((a) => a.address); } catch (e) { throw new HttpError(502, `Хост записи не найден (${host})`); }
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new HttpError(400, `Адрес записи во внутренней сети запрещён (${host})`);
  return u;
}

/** fetch() with manual redirects, each hop checked by assertPublicUrl. */
export async function guardedFetch(doFetch, url, init = {}, { maxRedirects = 5, resolve } = {}) {
  let target = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(target, { resolve });
    const res = await doFetch(target, { ...init, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    target = new URL(loc, target).toString();
  }
  throw new HttpError(502, 'Слишком много перенаправлений при загрузке записи');
}
