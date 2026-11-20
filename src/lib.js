import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export const ACTOR_KEY = 'meridian.actor';
export const THEME_KEY = 'meridian.theme';

export async function apiCall(path, options = {}) {
  const actor = localStorage.getItem(ACTOR_KEY) || 'operator';
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-actor': actor,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const post = (path, body) => apiCall(path, { method: 'POST', body: JSON.stringify(body || {}) });

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext) || { toast: () => {} };

/* -------- formatting -------- */

export const pct = (v, places = 2) =>
  v == null || Number.isNaN(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(places)}%`;

export const fmtNum = (v, places = 3) =>
  v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(places);

export const fmtDay = (d) => {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y.slice(2)}`;
};

export const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`;
};

/**
 * Relative label for a calendar day (YYYY-MM-DD). Day-granularity incidents are
 * stamped at the end of their day, so comparing them to a wall clock can read as
 * the future; compare UTC midnights instead.
 */
export const relDay = (day, ref = new Date().toISOString().slice(0, 10)) => {
  if (!day) return '—';
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${ref}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return '—';
  const days = Math.round((b - a) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
};

export const relTime = (iso) => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

export const STATE_LABEL = {
  healthy: 'Healthy',
  warning: 'At risk',
  breached: 'Breached',
  nodata: 'No data',
  suppressed: 'Suppressed',
  open: 'Open',
  acknowledged: 'Acknowledged',
  escalated: 'Escalated',
  merged: 'Merged',
  recovered: 'Recovered',
  closed: 'Closed',
};

export function ownerInitials(name) {
  if (!name) return '?';
  return name
    .split(/[.\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('');
}

export function useAsync(fn, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(fn)
      .then((data) => alive && setState({ data, loading: false, error: null }))
      .catch((err) => alive && setState({ data: null, loading: false, error: err.message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...(deps || []), nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

let toastSeq = 0;
export function useToastQueue() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, kind = 'ok') => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5600);
  }, []);
  return { toasts, push };
}
