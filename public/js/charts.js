// Inline SVG charts, no libraries. All charts are responsive (viewBox) and use the shared palette.
import { s, h } from './dom.js';

export const PALETTE = {
  primary: '#1f4f8f', secondary: '#7a9cc9', yes: '#1a7f4b', no: '#b42c2c', na: '#8a93a0', warn: '#c77d00', doom: '#1e3b2e', grid: '#d9dee6',
};

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * p;
}

/**
 * Horizontal bar chart. items: [{label, value, color?, hint?}], opts: {max, format, width, barH, valueSuffix}
 */
export function barChart(items, opts = {}) {
  const width = opts.width || 640, barH = opts.barH || 26, gap = 8, labelW = opts.labelW || 220, pad = 10;
  const max = opts.max ?? niceMax(Math.max(...items.map((i) => Number(i.value) || 0), 0));
  const height = pad * 2 + items.length * (barH + gap);
  const plotW = width - labelW - 80;
  const fmt = opts.format || ((v) => String(v));
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.title || '' });
  if (opts.title) svg.append(s('title', null, opts.title));
  items.forEach((it, i) => {
    const y = pad + i * (barH + gap);
    const w = Math.max(0, (Number(it.value) || 0) / max * plotW);
    svg.append(s('text', { x: labelW - 8, y: y + barH / 2 + 5, 'text-anchor': 'end', class: 'lab' }, truncate(it.label, 30)));
    svg.append(s('rect', { x: labelW, y, width: plotW, height: barH, fill: '#f1f3f6', rx: 4 }));
    svg.append(s('rect', { x: labelW, y, width: w, height: barH, fill: it.color || PALETTE.primary, rx: 4 }, s('title', null, it.hint || `${it.label}: ${fmt(it.value)}`)));
    svg.append(s('text', { x: labelW + w + 8, y: y + barH / 2 + 5, class: 'val' }, fmt(it.value)));
  });
  if (opts.threshold !== undefined) {
    const x = labelW + opts.threshold / max * plotW;
    svg.append(s('line', { x1: x, x2: x, y1: pad - 4, y2: height - pad + 4, stroke: PALETTE.no, 'stroke-width': 2, 'stroke-dasharray': '4 3' }));
  }
  return svg;
}

/**
 * Vertical histogram. buckets: [{bucket, count}], opts: {width, height, color, highlight(bucket)->color}
 */
export function histogram(buckets, opts = {}) {
  const width = opts.width || 640, height = opts.height || 220, padL = 44, padB = 34, padT = 14, padR = 10;
  const max = niceMax(Math.max(...buckets.map((b) => Number(b.count) || 0), 0));
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const bw = buckets.length ? plotW / buckets.length : plotW;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.title || '' });
  if (opts.title) svg.append(s('title', null, opts.title));
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = max / ticks * i, y = padT + plotH - v / max * plotH;
    svg.append(s('line', { x1: padL, x2: width - padR, y1: y, y2: y, class: 'grid' }));
    svg.append(s('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end', class: 'lab' }, Number.isInteger(v) ? v : v.toFixed(1)));
  }
  buckets.forEach((b, i) => {
    const c = Number(b.count) || 0;
    const bh = c / max * plotH;
    const x = padL + i * bw + 3, y = padT + plotH - bh;
    svg.append(s('rect', { x, y, width: Math.max(1, bw - 6), height: bh, fill: (opts.highlight && opts.highlight(b)) || opts.color || PALETTE.primary, rx: 3 },
      s('title', null, `${b.bucket}: ${c}`)));
    if (c) svg.append(s('text', { x: x + (bw - 6) / 2, y: y - 4, 'text-anchor': 'middle', class: 'val' }, c));
    svg.append(s('text', { x: x + (bw - 6) / 2, y: height - padB + 16, 'text-anchor': 'middle', class: 'lab' }, String(b.bucket)));
  });
  svg.append(s('line', { x1: padL, x2: width - padR, y1: padT + plotH, y2: padT + plotH, class: 'axis' }));
  if (opts.xLabel) svg.append(s('text', { x: padL + plotW / 2, y: height - 4, 'text-anchor': 'middle', class: 'lab' }, opts.xLabel));
  if (opts.yLabel) svg.append(s('text', { x: 12, y: padT + plotH / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${padT + plotH / 2})`, class: 'lab' }, opts.yLabel));
  return svg;
}

/**
 * Dot-and-whisker chart for a metric with 95% CI. items: [{label, value, lo, hi, ref?}], opts: {min, max, format, width}
 */
export function ciChart(items, opts = {}) {
  const width = opts.width || 640, rowH = 30, labelW = opts.labelW || 220, pad = 12, padR = 70;
  const min = opts.min ?? 0, max = opts.max ?? 1;
  const plotW = width - labelW - padR;
  const height = pad * 2 + items.length * rowH + 18;
  const x = (v) => labelW + (Math.min(max, Math.max(min, v)) - min) / (max - min) * plotW;
  const fmt = opts.format || ((v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2)));
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.title || '' });
  if (opts.title) svg.append(s('title', null, opts.title));
  const steps = opts.steps || 5;
  for (let i = 0; i <= steps; i++) {
    const v = min + (max - min) / steps * i, gx = x(v);
    svg.append(s('line', { x1: gx, x2: gx, y1: pad, y2: height - 18, class: 'grid' }));
    svg.append(s('text', { x: gx, y: height - 4, 'text-anchor': 'middle', class: 'lab' }, fmt(v)));
  }
  if (opts.refLine !== undefined) {
    const gx = x(opts.refLine);
    svg.append(s('line', { x1: gx, x2: gx, y1: pad, y2: height - 18, stroke: PALETTE.warn, 'stroke-width': 2, 'stroke-dasharray': '5 3' }));
  }
  items.forEach((it, i) => {
    const cy = pad + i * rowH + rowH / 2;
    svg.append(s('text', { x: labelW - 8, y: cy + 4, 'text-anchor': 'end', class: 'lab' }, truncate(it.label, 30)));
    if (it.value === null || it.value === undefined || Number.isNaN(Number(it.value))) {
      svg.append(s('text', { x: labelW + 4, y: cy + 4, class: 'lab' }, '—'));
      return;
    }
    const col = it.color || (it.value >= (opts.good ?? 0.6) ? PALETTE.yes : it.value >= (opts.ok ?? 0.4) ? PALETTE.warn : PALETTE.no);
    if (it.lo !== undefined && it.hi !== undefined && it.lo !== null && it.hi !== null) {
      svg.append(s('line', { x1: x(it.lo), x2: x(it.hi), y1: cy, y2: cy, stroke: col, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: .55 }));
      svg.append(s('line', { x1: x(it.lo), x2: x(it.lo), y1: cy - 5, y2: cy + 5, stroke: col, 'stroke-width': 2 }));
      svg.append(s('line', { x1: x(it.hi), x2: x(it.hi), y1: cy - 5, y2: cy + 5, stroke: col, 'stroke-width': 2 }));
    }
    svg.append(s('circle', { cx: x(it.value), cy, r: 6, fill: col }, s('title', null, `${it.label}: ${fmt(it.value)} [${fmt(it.lo)}; ${fmt(it.hi)}]`)));
    svg.append(s('text', { x: width - padR + 8, y: cy + 4, class: 'val' }, fmt(it.value)));
  });
  return svg;
}

/** Confusion matrix as an HTML table (rows = human, cols = AI). */
export function confusionMatrix(cm, labels = {}) {
  if (!cm || !cm.labels || !cm.matrix) return h('span', { class: 'muted' }, '—');
  const tbl = h('table', { class: 'cm' });
  const head = h('tr', null, h('th', null, labels.corner || 'чел. \\ ИИ'));
  for (const l of cm.labels) head.append(h('th', null, String(l)));
  tbl.append(h('thead', null, head));
  const body = h('tbody');
  cm.matrix.forEach((row, i) => {
    const tr = h('tr', null, h('th', null, String(cm.labels[i])));
    row.forEach((v, j) => {
      const diag = i === j;
      const cell = h('td', { class: diag ? 'diag' : '' }, String(v));
      if (v > 0) cell.style.background = diag ? '#dff3e7' : `rgba(180,44,44,${Math.min(0.55, 0.12 + v * 0.08)})`;
      tr.append(cell);
    });
    body.append(tr);
  });
  tbl.append(body);
  return tbl;
}

/** Simple stacked proportion bar (e.g. yes/no/na shares). parts: [{value, color, label}] */
export function stackBar(parts, opts = {}) {
  const width = opts.width || 300, hgt = opts.height || 14;
  const total = parts.reduce((a, p) => a + (Number(p.value) || 0), 0) || 1;
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${hgt}`, role: 'img', 'aria-label': opts.title || '', style: 'max-width:300px' });
  let x = 0;
  for (const p of parts) {
    const w = (Number(p.value) || 0) / total * width;
    if (w > 0) svg.append(s('rect', { x, y: 0, width: w, height: hgt, fill: p.color, rx: 2 }, s('title', null, `${p.label}: ${p.value}`)));
    x += w;
  }
  return svg;
}

export function legend(items) {
  return h('div', { class: 'legend' }, items.map((i) => h('span', null, h('i', { style: { background: i.color } }), i.label)));
}

function truncate(str, n) { str = String(str ?? ''); return str.length > n ? str.slice(0, n - 1) + '…' : str; }
