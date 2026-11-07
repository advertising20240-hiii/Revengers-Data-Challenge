// Hash router: #/ · #/c/<id> · #/c/<id>/l/<line> · #/c/<id>/g/<group>[/l/<line>] · #/checklist · #/appeals · #/appeals/<id> · #/calibration · #/insights

export function parseHash(hash = location.hash) {
  const raw = (hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: 'dialogs', params: {} };
  switch (parts[0]) {
    case 'c': {
      // optional key/value segments after the id: g/<group_id> (a dialog id may exist in DEV and in the control set), l/<line>
      const p = { id: parts[1], line: null, group: null };
      for (let i = 2; i + 1 < parts.length; i += 2) { if (parts[i] === 'l') p.line = Number(parts[i + 1]) || null; if (parts[i] === 'g') p.group = parts[i + 1]; }
      return { name: 'card', params: p };
    }
    case 'checklist': return { name: 'checklist', params: { version: parts[1] || null } };
    case 'appeals': return { name: 'appeals', params: { id: parts[1] || null } };
    case 'calibration': return { name: 'calibration', params: {} };
    case 'insights': return { name: 'insights', params: {} };
    default: return { name: 'dialogs', params: {} };
  }
}

export function cardHash(id, line, group) {
  // DEV is the default group on the server, so its links stay short
  return `#/c/${encodeURIComponent(id)}` + (group && group !== 'DEV' ? `/g/${encodeURIComponent(group)}` : '') + (line ? `/l/${line}` : '');
}

export function navigate(hash) { location.hash = hash; }

/** Update the address bar without triggering a route change (used by evidence links inside a card). */
export function replaceHash(hash) {
  if (location.hash === hash) return;
  history.replaceState(null, '', hash);
}

export function startRouter(onRoute) {
  let last = null;
  const fire = () => {
    const r = parseHash();
    onRoute(r, last);
    last = r;
  };
  window.addEventListener('hashchange', fire);
  fire();
}
