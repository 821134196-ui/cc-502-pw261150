import React from 'react';
import { Link } from 'react-router-dom';
import { apiCall, fmtDay, pct, post, relTime, useApp, useAsync } from '../lib.js';
import { Empty, StateBadge } from '../components/ui.jsx';

const STEPS = [
  ['Choose the fault', 'Pick a raw or staging asset and the days its rows went missing.'],
  ['Observe propagation', 'Dependent contracts flip to no-data and critical incidents open.'],
  ['Replay the backfill', 'Restore the captured rows; alerts recover after the healthy streak.'],
  ['Verify the record', 'Closed incidents stay sealed; open ones recover without losing history.'],
];

export function ScenariosPage() {
  const boot = useAsync(() => apiCall('/bootstrap'), []);
  const runs = useAsync(() => apiCall('/scenarios'), []);
  const [form, setForm] = React.useState({ asset_key: 'raw.payments_ingest', from: '', to: '' });
  const [last, setLast] = React.useState(null);
  const [step, setStep] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const { toast } = useApp();

  React.useEffect(() => {
    if (boot.data && !form.from) {
      setForm((f) => ({ ...f, from: shiftDay(boot.data.today, -2), to: shiftDay(boot.data.today, -1) }));
    }
  }, [boot.data, form.from]);

  const refresh = () => {
    runs.reload();
    boot.reload?.();
  };

  const run = async (kind) => {
    setBusy(true);
    try {
      const res = await post(`/scenarios/${kind}`, { ...form, actor: undefined });
      setLast({ kind, res });
      setStep(kind === 'upstream-gap' ? 1 : 3);
      toast(
        kind === 'upstream-gap'
          ? `Gap applied · ${res.alerts_opened} alert(s) opened`
          : kind === 'backfill'
            ? `Backfill applied · ${res.alerts_recovered} alert(s) recovered`
            : 'Baseline restored',
      );
      refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await post('/scenarios/reset', {});
      toast('Workspace reseeded to its initial state');
      setLast(null);
      setStep(0);
      refresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const assets = (boot.data?.assets || []).filter((a) => ['raw', 'staging'].includes(a.layer));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Verification lab</h1>
          <div className="sub">
            Prove the pipeline end to end: a source outage must surface as missing data with the right gap origin, and a
            replay must recover it without erasing incident history.
          </div>
        </div>
        <button className="btn" onClick={reset} disabled={busy}>
          Reset workspace
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Upstream gap → backfill</h2>
            <div className="sub">Simulations write real rows and real alerts so you can inspect every downstream effect.</div>
          </div>
          <span className={`badge ${step === 1 ? 'breached' : step >= 2 ? 'healthy' : ''}`}>
            {step === 0 ? 'Idle' : step === 1 ? 'Gap active' : step >= 3 ? 'Verified' : 'Replaying'}
          </span>
        </div>

        <div className="field-row">
          <label className="field">
            Source asset
            <select value={form.asset_key} onChange={(e) => setForm({ ...form, asset_key: e.target.value })}>
              {assets.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name} ({a.layer})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            From
            <input type="date" value={form.from} max={boot.data?.today} onChange={(e) => setForm({ ...form, from: e.target.value })} />
          </label>
          <label className="field">
            To
            <input type="date" value={form.to} max={boot.data?.today} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          </label>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <span className="muted">Steps</span>
            <div className="row">
              <button className="btn danger" onClick={() => run('upstream-gap')} disabled={busy || !form.from || !form.to}>
                1 · Drop rows
              </button>
              <button className="btn primary" onClick={() => run('backfill')} disabled={busy || !form.from || !form.to}>
                2 · Backfill
              </button>
              <button className="btn" onClick={() => run('restore')} disabled={busy || !form.from || !form.to}>
                Restore baseline
              </button>
            </div>
          </div>
        </div>

        <ol className="stack" style={{ gap: 8, marginTop: 14, paddingLeft: 18, fontSize: 13 }}>
          {STEPS.map(([t, d], i) => (
            <li key={t} style={{ color: i <= step ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              <strong>{t}.</strong> {d}
            </li>
          ))}
        </ol>
      </div>

      {last && <ScenarioReport kind={last.kind} res={last.res} />}

      <div className="card pad-0">
        <div style={{ padding: '14px 18px 4px' }}>
          <h2>Run history</h2>
          <div className="sub">Each simulation is recorded with its before/after contract states.</div>
        </div>
        {(runs.data || []).length === 0 ? (
          <Empty>No simulation runs recorded yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Asset</th>
                <th>Range</th>
                <th>Actor</th>
                <th>When</th>
                <th>Before → after</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data || []).map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={`badge ${r.kind === 'upstream_gap' ? 'breached' : 'healthy'}`}>
                      {r.kind.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.asset_key}</td>
                  <td>
                    {fmtDay(r.day_from)} → {fmtDay(r.day_to)}
                  </td>
                  <td>{r.actor}</td>
                  <td>{relTime(r.at)}</td>
                  <td className="muted">
                    {r.report.open_alerts_before != null
                      ? `${r.report.open_alerts_before} → ${r.report.open_alerts_after} open`
                      : `${r.report.alerts_recovered ?? 0} recovered · ${r.report.closed_incidents_preserved ?? 0} sealed`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ScenarioReport({ kind, res }) {
  const sloEntries = Object.entries(res.slo_states || {});
  const isGap = res.kind === 'upstream_gap';
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{isGap ? 'Propagation observed' : 'Replay verified'}</h2>
          <div className="sub">{res.explanation}</div>
        </div>
        <span className={`badge ${isGap ? 'breached' : 'healthy'}`}>{isGap ? 'No-data propagation' : 'Recovered'}</span>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 12 }}>
        <div className="mini-metric">
          <div className="k">Assets affected</div>
          <div className="v">{res.affected_assets.length}</div>
        </div>
        <div className="mini-metric">
          <div className="k">Contracts touched</div>
          <div className="v">{sloEntries.length}</div>
        </div>
        <div className="mini-metric">
          <div className="k">{isGap ? 'Alerts opened' : 'Alerts recovered'}</div>
          <div className="v">{isGap ? res.alerts_opened : res.alerts_recovered}</div>
        </div>
        <div className="mini-metric">
          <div className="k">{isGap ? 'Open before → after' : 'Sealed incidents'}</div>
          <div className="v" style={{ fontSize: 16 }}>
            {isGap ? `${res.open_alerts_before} → ${res.open_alerts_after}` : res.closed_incidents_preserved}
          </div>
        </div>
      </div>

      <div className="section-title">Contract states per day</div>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              {(res.days || []).map((d) => (
                <th key={d} className="num">
                  {fmtDay(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sloEntries.map(([sloId, rows]) => (
              <tr key={sloId}>
                <td>
                  <Link to={`/slos/${sloId}`}>{sloId}</Link>
                </td>
                {(res.days || []).map((d) => {
                  const row = rows.find((r) => r.day === d);
                  return (
                    <td key={d} className="num">
                      <StateBadge state={row?.effective_state || 'nodata'} label={row ? undefined : '—'} />
                      <div className="sub">{row?.rolling != null ? pct(row.rolling) : '—'}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="banner" style={{ marginTop: 12 }}>
        {isGap
          ? 'Rows vanished at the source only — downstream tables still carried stale readings. The engine walked lineage and marked dependent contracts no-data, so the outage could not hide behind a fresh-looking downstream timestamp.'
          : 'Replayed rows restored the days. Alerts moved to recovered after the healthy streak; the closed incident below was not rewritten.'}
      </div>
    </div>
  );
}

function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
