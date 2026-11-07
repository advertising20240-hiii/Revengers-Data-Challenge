#!/usr/bin/env node
// Builds the Dynamics 365 HTML web-resource variant of the UI: one self-contained HTML file.
//
//   npm run build:d365            -> dist/d365/cqa.html
//   node scripts/build-d365.mjs --public public --out dist/d365/cqa.html --root .
//
// What it does
//   1. Reads public/index.html.
//   2. Follows the ES-module graph of every <script type="module"> (static relative imports only,
//      plus absolute "/packages/..." imports resolved against the repo root) and rewrites each module
//      into a function in a small in-page module registry, so the result is ONE classic <script>.
//   3. Inlines every <link rel="stylesheet"> and every classic <script src>.
//   4. Inlines public/i18n/*.json (and any other JSON under public/) and shims fetch() so that
//      relative requests for those files are answered from memory.
//   5. Prepends the Dynamics 365 hook: window.CQA_CONFIG stays overridable; apiBase can be passed
//      through the web-resource "data" query parameter (Xrm.Navigation.openWebResource) and the
//      Dataverse client URL is read via Xrm.Utility.getGlobalContext().getClientUrl() when present.
//   6. Asserts: output < 5 MB (default MaxUploadFileSize of a Dataverse organization) and no
//      absolute "/WebResources/" paths. Prints the final size.
//
// Supported module syntax (by design, see docs/DYNAMICS365.md): static `import {a as b} from './x.js'`,
// `import * as ns from`, `import x from './data.json' with {type:'json'}`, side-effect imports,
// `export function|async function|class|const|let|var NAME`, `export {a, b as c}`,
// `export {a} from './x.js'`, `export * from './x.js'`, `export default`. No dynamic import(),
// no top-level await.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------- module graph

function toId(root, absPath) {
  return '/' + relative(root, absPath).split('\\').join('/');
}

function resolveSpecifier(spec, fromFile, root, publicDir) {
  if (spec.startsWith('./') || spec.startsWith('../')) return resolve(dirname(fromFile), spec);
  if (spec.startsWith('/')) {
    // "/packages/x.js" is served by the dev server from the repo root; everything else from public/.
    if (spec.startsWith('/packages/')) return resolve(root, '.' + spec);
    return resolve(publicDir, '.' + spec);
  }
  throw new Error(`Unsupported import specifier "${spec}" in ${fromFile}: only relative paths and /packages/... are bundled.`);
}

const RE_IMPORT_FROM = /^[ \t]*import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"](?:\s*(?:with|assert)\s*\{[^}]*\})?\s*;?[ \t]*$/gm;
const RE_IMPORT_SIDE = /^[ \t]*import\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const RE_EXPORT_FROM = /^[ \t]*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const RE_EXPORT_STAR = /^[ \t]*export\s*\*\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const RE_EXPORT_DECL = /^([ \t]*)export\s+(async\s+function\*?|function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const RE_EXPORT_LIST = /^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;
const RE_EXPORT_DEFAULT = /^([ \t]*)export\s+default\s+/gm;

function parseBindings(list) {
  // "a, b as c, default as d" -> [{imported:'a', local:'a'}, {imported:'b', local:'c'}, ...]
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (!m) throw new Error(`Cannot parse binding "${s}"`);
    return { imported: m[1], local: m[2] || m[1] };
  });
}

/** Rewrite one ES module into registry form. Returns {code, deps}. */
export function transformModule(source, id, resolveDep) {
  const deps = [];
  const exportsMap = []; // [{exported, local}]
  const reexports = []; // code lines appended at the end
  let code = source;

  const dep = (spec) => { const d = resolveDep(spec); if (!deps.includes(d)) deps.push(d); return d; };

  // export {a} from './x.js'  /  export * from './x.js'
  code = code.replace(RE_EXPORT_FROM, (_, list, spec) => {
    const d = dep(spec);
    for (const b of parseBindings(list)) reexports.push(`Object.defineProperty(__exports, ${JSON.stringify(b.local)}, { enumerable: true, get: () => __cqa_require(${JSON.stringify(d)})[${JSON.stringify(b.imported)}] });`);
    return '';
  });
  code = code.replace(RE_EXPORT_STAR, (_, spec) => {
    const d = dep(spec);
    reexports.push(`for (const __k of Object.keys(__cqa_require(${JSON.stringify(d)}))) if (__k !== 'default' && !(__k in __exports)) Object.defineProperty(__exports, __k, { enumerable: true, get: () => __cqa_require(${JSON.stringify(d)})[__k] });`);
    return '';
  });

  // import ... from
  code = code.replace(RE_IMPORT_FROM, (_, clause, spec) => {
    const d = dep(spec);
    const req = `__cqa_require(${JSON.stringify(d)})`;
    clause = clause.trim();
    const out = [];
    let m;
    if ((m = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/))) {
      out.push(`const ${m[1]} = ${req};`);
    } else {
      // optional default binding, optional named list
      let rest = clause;
      const dm = rest.match(/^([A-Za-z_$][\w$]*)\s*(,\s*)?/);
      if (dm && !rest.startsWith('{')) {
        out.push(`const ${dm[1]} = ${req}.default;`);
        rest = rest.slice(dm[0].length).trim();
      }
      if (rest.startsWith('{')) {
        const list = rest.slice(1, rest.lastIndexOf('}'));
        const parts = parseBindings(list).map((b) => (b.imported === b.local ? b.local : `${b.imported}: ${b.local}`));
        if (parts.length) out.push(`const { ${parts.join(', ')} } = ${req};`);
      } else if (rest.length) {
        throw new Error(`Cannot parse import clause "${clause}" in ${id}`);
      }
    }
    return out.join(' ');
  });
  code = code.replace(RE_IMPORT_SIDE, (_, spec) => `__cqa_require(${JSON.stringify(dep(spec))});`);

  // export declarations
  code = code.replace(RE_EXPORT_DECL, (_, indent, kind, name) => {
    exportsMap.push({ exported: name, local: name });
    return `${indent}${kind} ${name}`;
  });
  code = code.replace(RE_EXPORT_LIST, (_, list) => {
    for (const b of parseBindings(list)) exportsMap.push({ exported: b.local, local: b.imported });
    return '';
  });
  code = code.replace(RE_EXPORT_DEFAULT, (_, indent) => {
    exportsMap.push({ exported: 'default', local: '__cqa_default' });
    return `${indent}const __cqa_default = `;
  });

  // import.meta is illegal in a classic script; the module id is the closest meaningful value.
  code = code.replace(/import\.meta\.url/g, JSON.stringify(id)).replace(/import\.meta/g, `({ url: ${JSON.stringify(id)} })`);

  const defs = exportsMap.map((e) => `${JSON.stringify(e.exported)}: { enumerable: true, get: () => ${e.local} }`);
  const header = defs.length ? `Object.defineProperties(__exports, { ${defs.join(', ')} });\n` : '';
  const body = `${header}${code}\n${reexports.join('\n')}`;
  return { code: body, deps };
}

function jsonModule(source) {
  return { code: `Object.defineProperty(__exports, 'default', { enumerable: true, value: ${source.trim()} });`, deps: [] };
}

function collectGraph(entryFiles, inlineModules, root, publicDir) {
  const modules = new Map(); // id -> code
  const order = [];
  const visit = (absPath, source) => {
    const id = toId(root, absPath);
    if (modules.has(id)) return id;
    modules.set(id, null); // mark
    if (source === undefined && !existsSync(absPath)) { const e = new Error(`Module not found at ${absPath}`); e.code = 'ENOENT'; throw e; }
    const src = source ?? readFileSync(absPath, 'utf8');
    const t = extname(absPath) === '.json'
      ? jsonModule(src)
      : transformModule(src, id, (spec) => {
        const target = resolveSpecifier(spec, absPath, root, publicDir);
        if (!existsSync(target)) throw new Error(`Import "${spec}" from ${id} not found at ${target}`);
        return visit(target, undefined);
      });
    modules.set(id, t.code);
    order.push(id);
    return id;
  };
  const entries = entryFiles.map((f) => visit(f, undefined));
  inlineModules.forEach((src, i) => entries.push(visit(join(publicDir, `__inline_${i}.js`), src)));
  return { modules, order, entries };
}

// ---------------------------------------------------------------- html assembly

function escapeInlineScript(js) {
  return js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

function walkJson(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJson(p, base, out);
    else if (extname(name) === '.json') out.push(posix.join(...relative(base, p).split('\\').join('/').split('/')));
  }
  return out;
}

function hookScript(assets) {
  return `
// --- Dynamics 365 web-resource hook -------------------------------------------------------
(function () {
  var cfg = window.CQA_CONFIG = Object.assign({ apiBase: '', lang: 'ru', embedded: true }, window.CQA_CONFIG || {});
  // 1) Xrm.Navigation.openWebResource(name, data) passes "data" as a query parameter.
  //    Accepts a JSON object ({"apiBase":"https://cqa.example.kz"}) or a bare URL string.
  try {
    var raw = new URLSearchParams(window.location.search).get('data');
    if (raw) {
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = { apiBase: raw }; }
      if (parsed && typeof parsed === 'object') for (var k in parsed) if (cfg[k] === undefined || cfg[k] === '' ) cfg[k] = parsed[k];
    }
  } catch (e) { /* no query string available */ }
  // 2) Dataverse client URL, when the page runs inside Dynamics 365.
  try {
    var xrm = window.Xrm || (window.parent && window.parent.Xrm);
    if (xrm && xrm.Utility && xrm.Utility.getGlobalContext) cfg.clientUrl = xrm.Utility.getGlobalContext().getClientUrl();
  } catch (e) { /* not inside Dynamics 365 */ }
  // 3) Inlined static JSON (i18n etc.): answer relative fetches from memory.
  var assets = ${JSON.stringify(assets)};
  window.CQA_ASSETS = assets;
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var path = url.split('?')[0].replace(/^(\\.\\/|\\/)+/, '');
    var key = null;
    for (var k in assets) if (path === k || path.slice(-k.length - 1) === '/' + k) { key = k; break; }
    if (key !== null) {
      return Promise.resolve(new Response(JSON.stringify(assets[key]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (!realFetch) return Promise.reject(new Error('fetch unavailable'));
    return realFetch(input, init);
  };
})();
`;
}

function registryScript(graph) {
  const parts = ['var __cqa_modules = {}; var __cqa_cache = {};',
    'function __cqa_require(id) { if (__cqa_cache[id]) return __cqa_cache[id]; var __exports = __cqa_cache[id] = {}; if (!__cqa_modules[id]) throw new Error("Module not bundled: " + id); __cqa_modules[id](__exports); return __exports; }'];
  for (const id of graph.order) {
    parts.push(`__cqa_modules[${JSON.stringify(id)}] = function (__exports) {\n${graph.modules.get(id)}\n};`);
  }
  for (const e of graph.entries) parts.push(`__cqa_require(${JSON.stringify(e)});`);
  return parts.join('\n');
}

/**
 * Build the single-file web resource.
 * @param {{publicDir:string, root:string, outFile:string, quiet?:boolean}} opts
 * @returns {{outFile:string, bytes:number, modules:string[], html:string}}
 */
export function buildD365({ publicDir, root, outFile, quiet = false }) {
  const indexPath = join(publicDir, 'index.html');
  if (!existsSync(indexPath)) throw new Error(`No ${indexPath}; the UI is not built yet.`);
  let html = readFileSync(indexPath, 'utf8');

  // Entry modules.
  const entryFiles = [];
  const inlineModules = [];
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1];
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (type === 'module') {
      if (src) entryFiles.push(resolveSpecifier(src.startsWith('.') || src.startsWith('/') ? src : './' + src, indexPath, root, publicDir));
      else inlineModules.push(body);
      return '<!--cqa:bundle-->';
    }
    if (src && !/^https?:/i.test(src)) {
      // Classic script: inline verbatim.
      const p = resolveSpecifier(src.startsWith('.') || src.startsWith('/') ? src : './' + src, indexPath, root, publicDir);
      return `<script>\n${escapeInlineScript(readFileSync(p, 'utf8'))}\n</script>`;
    }
    return full;
  });

  // Stylesheets.
  html = html.replace(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi, (tag) => {
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href || /^https?:/i.test(href)) return tag;
    const p = resolveSpecifier(href.startsWith('.') || href.startsWith('/') ? href : './' + href, indexPath, root, publicDir);
    return `<style>\n${readFileSync(p, 'utf8').replace(/<\/style/gi, '<\\/style')}\n</style>`;
  });

  // Static JSON assets (i18n etc.).
  const assets = {};
  for (const rel of walkJson(publicDir)) assets[rel] = JSON.parse(readFileSync(join(publicDir, rel), 'utf8'));

  const graph = collectGraph(entryFiles, inlineModules, root, publicDir);
  const bundle = `<script>\n${escapeInlineScript(hookScript(assets))}\n${escapeInlineScript(registryScript(graph))}\n</script>`;

  // Replace the first marker with the bundle, drop the others (all modules load once, in order).
  let placed = false;
  html = html.replace(/<!--cqa:bundle-->/g, () => { if (placed) return ''; placed = true; return bundle; });
  if (!placed) html = html.replace(/<\/body>/i, `${bundle}\n</body>`);
  html = `<!-- Revengers CQA — Dynamics 365 HTML web resource build. Generated by scripts/build-d365.mjs; do not edit by hand. -->\n` + html;

  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes >= MAX_BYTES) throw new Error(`Output is ${bytes} bytes; a Dataverse web resource must stay below ${MAX_BYTES} bytes.`);
  if (/\/WebResources\//i.test(html)) throw new Error('Output contains an absolute /WebResources/ path; use relative paths only.');

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html, 'utf8');
  if (!quiet) console.log(`built ${outFile}: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB, limit 5 MiB), ${graph.order.length} modules, ${Object.keys(assets).length} JSON assets`);
  return { outFile, bytes, modules: graph.order, html };
}

// ---------------------------------------------------------------- CLI

function argValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(argValue('--root', resolve(dirname(fileURLToPath(import.meta.url)), '..')));
  const publicDir = resolve(root, argValue('--public', 'public'));
  const outFile = resolve(root, argValue('--out', 'dist/d365/cqa.html'));
  try {
    buildD365({ publicDir, root, outFile });
  } catch (e) {
    console.error(`build:d365 failed: ${e.message}`);
    process.exit(2);
  }
}
