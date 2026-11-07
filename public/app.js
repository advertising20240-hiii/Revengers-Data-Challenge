// Revengers CQA — application entry: header, router, screen mounting.
import { h, clear, replace } from './js/dom.js';
import { loadDict, t, LANGS, getLang, initialLang, saveLang } from './js/i18n.js';
import { api, apiBase } from './js/api.js';
import { state, subscribe, setRole, setHealth, providerAvailable, providerReason } from './js/state.js';
import { startRouter } from './js/router.js';
import { mountToasts, mountModals, toast } from './js/components.js';
import { renderDialogs } from './js/screens/dialogs.js';
import { renderCard } from './js/screens/card.js';
import { renderChecklist } from './js/screens/checklist.js';
import { renderAppeals } from './js/screens/appeals.js';
import { renderCalibration } from './js/screens/calibration.js';
import { renderInsights } from './js/screens/insights.js';

const root = document.getElementById('cqa-root');
const NAV = [
  ['dialogs', '#/', 'nav.dialogs'],
  ['checklist', '#/checklist', 'nav.checklist'],
  ['appeals', '#/appeals', 'nav.appeals'],
  ['calibration', '#/calibration', 'nav.calibration'],
  ['insights', '#/insights', 'nav.insights'],
];

let header, bannerBox, main, current = null;

function buildHeader() {
  const nav = h('nav', { class: 'nav', aria: { label: t('nav.aria') } });
  for (const [name, href, key] of NAV) nav.append(h('a', { href, dataset: { route: name } }, t(key), name === 'appeals' ? h('span', { class: 'count hidden', dataset: { appeals: '1' } }) : null));

  const roleSeg = h('div', { class: 'seg', role: 'group', aria: { label: t('role.aria') } },
    h('button', { type: 'button', dataset: { role: 'operator' }, 'aria-pressed': String(state.role === 'operator'), onclick: () => setRole('operator') }, t('role.operator')),
    h('button', { type: 'button', dataset: { role: 'reviewer' }, 'aria-pressed': String(state.role === 'reviewer'), onclick: () => setRole('reviewer') }, t('role.reviewer')));

  const langSeg = h('div', { class: 'seg lang-seg', role: 'group', aria: { label: t('lang.aria') } },
    LANGS.map((l) => h('button', { type: 'button', lang: l, title: t(`lang.${l}_full`), 'aria-pressed': String(getLang() === l), onclick: () => switchLang(l) }, t(`lang.${l}`))));

  const zoomBtn = h('button', { type: 'button', class: 'zoom-btn', 'aria-pressed': String(zoomOn()), title: t('zoom.title'), aria: { label: t('zoom.title') }, onclick: (e) => { const on = !zoomOn(); setZoom(on); e.currentTarget.setAttribute('aria-pressed', String(on)); } }, 'A+');

  const provider = h('div', { class: 'provider', dataset: { provider: '1' } }, h('span', { class: 'dot warn' }), h('span', null, t('health.loading')));
  const offline = h('div', { class: 'provider hidden', dataset: { offline: '1' } }, h('span', { class: 'dot off' }), h('span', null, t('health.offline')));

  return h('header', { class: 'hdr' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'mark', aria: { hidden: 'true' } }, 'R'), h('span', null, 'Revengers CQA'), h('span', { class: 'sub' }, t('brand.sub'))),
    nav,
    h('div', { class: 'hdr-right' }, offline, provider, zoomBtn, langSeg, roleSeg));
}

function updateHeader(route) {
  for (const a of header.querySelectorAll('.nav a')) {
    const active = a.dataset.route === route.name || (route.name === 'card' && a.dataset.route === 'dialogs');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function updateRole() {
  for (const b of header.querySelectorAll('.seg button[data-role]')) b.setAttribute('aria-pressed', String(b.dataset.role === state.role));
}

function updateHealth() {
  const hbox = header.querySelector('[data-provider]');
  const hd = state.health;
  clear(hbox);
  if (!hd) { hbox.append(h('span', { class: 'dot warn' }), h('span', null, t('health.loading'))); }
  else {
    const p = hd.provider || {};
    hbox.append(h('span', { class: `dot ${p.available ? '' : 'off'}` }),
      h('span', { title: p.reason || '' }, `${p.provider || '—'} · ${p.model || '—'}`));
  }
  header.querySelector('[data-offline]').classList.toggle('hidden', !state.offline);
  const cnt = header.querySelector('[data-appeals]');
  const open = hd && hd.counts ? hd.counts.appeals_open : 0;
  cnt.textContent = open || '';
  cnt.classList.toggle('hidden', !open);

  clear(bannerBox);
  if (hd && hd.provider && !hd.provider.available) {
    bannerBox.append(h('div', { class: 'banner warn', role: 'status' },
      h('strong', null, t('health.unavailable', { reason: providerReason() || '—' })), h('span', null, t('health.unavailable_hint'))));
  }
  if (state.offline) {
    bannerBox.append(h('div', { class: 'banner danger', role: 'alert' }, h('strong', null, t('health.offline')), h('span', null, t('health.offline_hint'))));
  }
}

async function refreshHealth() {
  try { setHealth(await api.health()); } catch (e) { /* offline flag is set by api.js */ updateHealth(); }
}

/** Presentation zoom for projectors: larger base font, remembered per browser. */
function zoomOn() { try { return window.localStorage.getItem('cqa.zoom') === '1'; } catch { return false; } }
function setZoom(on) {
  try { window.localStorage.setItem('cqa.zoom', on ? '1' : '0'); } catch { /* storage may be unavailable */ }
  document.documentElement.style.fontSize = on ? '118%' : '';
}

/** Language change: remember it and rebuild the whole UI (dictionary, dates, units) without losing the current route. */
function switchLang(l) {
  if (l === getLang()) return;
  saveLang(l);
  window.location.reload();
}

const SCREENS = { dialogs: renderDialogs, card: renderCard, checklist: renderChecklist, appeals: renderAppeals, calibration: renderCalibration, insights: renderInsights };

function route(r, last) {
  updateHeader(r);
  // Same card, only the line changed: let the card handle it without a full re-render.
  if (current && current.update && last && last.name === r.name && current.update(r.params)) return;
  if (current && current.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }
  clear(main);
  const screen = SCREENS[r.name] || renderDialogs;
  try {
    current = screen(main, r.params) || null;
  } catch (e) {
    console.error(e);
    main.append(h('div', { class: 'err', role: 'alert' }, `${t('error.title')} ${e.message}`));
  }
  window.scrollTo(0, 0);
}

async function boot() {
  await loadDict(apiBase(), initialLang(window.CQA_CONFIG && window.CQA_CONFIG.lang));
  document.documentElement.lang = getLang() === 'kk' ? 'kk' : getLang();
  if (zoomOn()) setZoom(true);
  document.title = `Revengers CQA — ${t('brand.sub')}`;
  header = buildHeader();
  bannerBox = h('div');
  main = h('main', { class: 'main', id: 'cqa-main' });
  replace(root, header, bannerBox, main);
  mountToasts(root);
  mountModals(root);
  subscribe((what) => {
    if (what === 'role') { updateRole(); toast(t(state.role === 'operator' ? 'role.now_operator' : 'role.now_reviewer')); }
    if (what === 'health' || what === 'offline') updateHealth();
  });
  updateHealth();
  refreshHealth();
  setInterval(refreshHealth, 30000);
  startRouter(route);
}

boot();

export { refreshHealth, providerAvailable };
