// Reusable UI pieces: chips, toasts, modal, skeletons, empty/error states, progress.
import { h, clear } from './dom.js';
import { t } from './i18n.js';

export function chip(text, kind = 'neutral', extra = '') {
  return h('span', { class: `chip ${kind} ${extra}`.trim() }, text);
}

export function langTag(code) { return h('span', { class: 'lang', title: t('col.lang') }, code || '—'); }

// ---- toasts ----
let toastRoot = null;
export function mountToasts(root) { toastRoot = h('div', { class: 'toasts', role: 'status', aria: { live: 'polite' } }); root.append(toastRoot); }
export function toast(msg, kind = '') {
  if (!toastRoot) return;
  const el = h('div', { class: `toast ${kind}` }, msg);
  toastRoot.append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

// ---- modal ----
let modalRoot = null;
export function mountModals(root) { modalRoot = h('div'); root.append(modalRoot); }

/**
 * openModal({title, body: Node, actions: [Node], wide}) -> {close, el}
 * Esc closes, click on the backdrop closes, focus moves inside.
 */
export function openModal({ title, body, actions = [], wide = false, onClose }) {
  const prev = document.activeElement;
  const closeBtn = h('button', { class: 'x', type: 'button', aria: { label: t('modal.close') }, onclick: () => close() }, '×');
  const modal = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'm-h' }, h('h2', null, title), closeBtn),
    h('div', { class: 'm-b' }, body),
    actions.length ? h('div', { class: 'm-f' }, actions) : null);
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, modal);
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey);
  function close() {
    document.removeEventListener('keydown', onKey);
    bg.remove();
    if (onClose) onClose();
    if (prev && prev.focus) prev.focus();
  }
  modalRoot.append(bg);
  const first = modal.querySelector('input, textarea, select, button:not(.x)');
  (first || closeBtn).focus();
  return { close, el: modal };
}

export function confirmModal(title, text, okLabel) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: h('p', null, text),
      actions: [
        h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); resolve(false); } }, t('btn.cancel')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { m.close(); resolve(true); } }, okLabel || t('btn.ok')),
      ],
      onClose: () => resolve(false),
    });
  });
}

// ---- states ----
export function skeleton(rows = 6) {
  const b = h('div', { class: 'skel-block', aria: { busy: 'true' } });
  for (let i = 0; i < rows; i++) b.append(h('div', { class: 'skel', style: { width: `${55 + ((i * 37) % 45)}%` } }));
  return b;
}

export function emptyState(title, hint, action) {
  return h('div', { class: 'empty' }, h('h3', null, title), hint ? h('p', null, hint) : null, action || null);
}

export function errorBox(err, retry) {
  const msg = err && err.message ? err.message : String(err);
  return h('div', { class: 'err', role: 'alert' },
    h('div', null, h('strong', null, t('error.title')), ' ', msg),
    retry ? h('button', { class: 'btn sm mt', type: 'button', onclick: retry }, t('btn.retry')) : null);
}

export function progressBar(done, total, extraClass = '') {
  const p = total ? Math.round((done / total) * 100) : 0;
  return h('div', { class: `progress ${extraClass}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total || 0, 'aria-valuenow': done || 0 },
    h('span', { style: { width: `${p}%` } }));
}

export function confidence(v, lowThreshold = 0.6) {
  if (v === null || v === undefined) return null;
  const low = v < lowThreshold;
  return h('span', { class: `conf ${low ? 'low' : ''}`, title: t('card.confidence') },
    h('span', { class: 'bar' }, h('span', { style: { width: `${Math.round(v * 100)}%` } })),
    `${Math.round(v * 100)}%`,
    low ? chip(t('card.needs_review'), 'warn') : null);
}

export function sectionTitle(text, right) {
  return h('div', { class: 'card-h' }, h('h2', null, text), right || null);
}

export function field(label, control, span2 = false) {
  return h('label', { class: `f ${span2 ? 'span2' : ''}` }, label, control);
}

export function select(options, value, onchange, attrs = {}) {
  const sel = h('select', { ...attrs, onchange: (e) => onchange && onchange(e.target.value, e) });
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    sel.append(opt);
  }
  return sel;
}

export function setBusy(el, busy) { el.setAttribute('aria-busy', busy ? 'true' : 'false'); }

export { clear };
