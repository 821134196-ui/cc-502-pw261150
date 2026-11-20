import React, { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { ACTOR_KEY, AppContext, THEME_KEY, apiCall, useToastQueue } from './lib.js';
import { OverviewPage } from './pages/Overview.jsx';
import { SlosPage, SloDetailPage } from './pages/Slos.jsx';
import { AlertsPage } from './pages/Alerts.jsx';
import { LineagePage } from './pages/Lineage.jsx';
import { RevisionsPage } from './pages/Revisions.jsx';
import { ScenariosPage } from './pages/Scenarios.jsx';
import { GovernancePage } from './pages/Governance.jsx';

const NAV = [
  ['/', 'Overview'],
  ['/slos', 'SLOs'],
  ['/alerts', 'Alerts'],
  ['/lineage', 'Lineage'],
  ['/revisions', 'Revisions'],
  ['/scenarios', 'Verification'],
  ['/governance', 'Governance'],
];

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');
  const [actor, setActor] = useState(() => localStorage.getItem(ACTOR_KEY) || 'operator');
  const [bootstrap, setBootstrap] = useState(null);
  const [error, setError] = useState(null);
  const { toasts, push } = useToastQueue();
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    apiCall('/bootstrap')
      .then(setBootstrap)
      .catch((e) => setError(e.message));
  }, []);

  const changeActor = (a) => {
    localStorage.setItem(ACTOR_KEY, a);
    setActor(a);
    push(`Acting as ${a}`, 'ok');
  };

  const ctx = {
    bootstrap,
    actor,
    setActor: changeActor,
    theme,
    setTheme,
    toast: push,
    navigate,
    reloadBootstrap: () => apiCall('/bootstrap').then(setBootstrap).catch(() => {}),
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              M
            </span>
            Meridian
          </div>
          <nav className="nav" aria-label="Primary">
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="topbar-right">
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <span className="muted">Acting as</span>
              <select value={actor} onChange={(e) => changeActor(e.target.value)} aria-label="Acting user">
                {(bootstrap?.actors || ['operator', 'nadia.p', 'marco.b', 'grace.l', 'oncall.eng']).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn ghost sm" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
              {theme === 'light' ? 'Dark mode' : 'Light mode'}
            </button>
          </div>
        </header>
        <main className="main">
          {error && <div className="banner danger">API unavailable: {error}</div>}
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/slos" element={<SlosPage />} />
            <Route path="/slos/:id" element={<SloDetailPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/lineage" element={<LineagePage />} />
            <Route path="/revisions" element={<RevisionsPage />} />
            <Route path="/scenarios" element={<ScenariosPage />} />
            <Route path="/governance" element={<GovernancePage />} />
            <Route path="*" element={<div className="empty">Not found</div>} />
          </Routes>
        </main>
      </div>
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
