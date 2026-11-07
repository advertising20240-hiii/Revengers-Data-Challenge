// Small shared state with subscriptions: role, health, offline flag, current group, active job.

const listeners = new Set();
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

export const state = {
  role: LS.get('cqa.role', 'reviewer'),       // 'operator' | 'reviewer'
  health: null,
  offline: false,
  group: LS.get('cqa.group', ''),
  job: LS.get('cqa.job', null),                // {id, kind} of the last batch job (for resume after reload)
  selection: new Set(),                        // selected conversation ids on the Диалоги screen
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { for (const fn of listeners) { try { fn(what, state); } catch (e) { console.error(e); } } }

export function setRole(role) { state.role = role; LS.set('cqa.role', role); emit('role'); }
export function setHealth(h) { state.health = h; emit('health'); }
export function setOffline(v) { if (state.offline !== v) { state.offline = v; emit('offline'); } }
export function setGroup(g) { state.group = g || ''; LS.set('cqa.group', state.group); emit('group'); }
export function setJob(j) { state.job = j; LS.set('cqa.job', j); emit('job'); }

export function isReviewer() { return state.role === 'reviewer'; }
export function isOperator() { return state.role === 'operator'; }
export function providerAvailable() { return !!(state.health && state.health.provider && state.health.provider.available); }
export function providerReason() { return (state.health && state.health.provider && state.health.provider.reason) || ''; }
