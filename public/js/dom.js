// Tiny DOM builder. h('div', {class:'x', onclick:fn, aria: {label:'...'}}, children...)
// Children may be strings, nodes, arrays or null/undefined/false (skipped). Text is never parsed as HTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'aria') for (const [a, av] of Object.entries(v)) el.setAttribute(`aria-${a}`, av);
      else if (k === 'html') el.innerHTML = v; // only for trusted, app-generated markup
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function replace(el, ...children) { clear(el); return append(el, children); }

const NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function frag(...children) { return append(document.createDocumentFragment(), children); }

export function on(el, evt, selector, fn) {
  el.addEventListener(evt, (e) => {
    const t = e.target.closest(selector);
    if (t && el.contains(t)) fn(e, t);
  });
}
