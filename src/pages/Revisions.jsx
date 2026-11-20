import React from 'react';
import { Link } from 'react-router-dom';
import { apiCall, fmtDay, fmtNum, fmtTime, pct, post, relTime, useApp, useAsync } from '../lib.js';
import { Empty, Legend, StateBadge } from '../components/ui.jsx';

const MODES = [
  ['set', 'Set to value', { value: '0.995' }],
  ['offset', 'Adjust by delta', { delta: '0.01' }],
  ['scale', 'Scale by factor', { factor: '1.02' }],
  ['baseline', 'Restore captured baseline', {}],
];

export function RevisionsPage() {
  const { data: revisions, loading, reload } = useAsync(() => apiCall('/revisions'), []);
  const boot = useAsync(() => apiCall('/bootstrap'), []);
  const [selected, setSelected] = React.useState(null);
  const detail = useAsync(() => (selected ? apiCall(`/revisions/${selected}`) : Promise.resolve(null)), [selected]);

  // Default to the newest entry so the impact panel is never a blank column.
  React.useEffect(() => {
    if (selected == null && revisions?.length) setSelected(revisions[0].id);
  }, [revisions, selected]);

  if (loading && !revisions) return <div className="empty">Loading revision ledger…</div>;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Metric revisions</h1>
          <div className="sub">
            Corrections are append-only and provenance-stamped. Revisions recompute evaluations, but days sealed by a
            closed incident are never rewritten.
          </div>
        </div>
      </div>

      <RevisionForm
        assets={boot.data?.assets || []}
        today={boot.data?.today}
        onApplied={(res) => {
          setSelected(res.revision.id);
          reload();
        }}
      />

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="card pad-0">
          <div style={{ padding: '14px 18px 4px' }}>
            <h2>Ledger</h2>
            <div className="sub">Newest first · each entry records what changed and what it touched.</div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Rev</th>
                <th>Asset / metric</th>
                <th>Range</th>
                <th className="num">Points</th>
                <th>Author</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {(revisions || []).length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Empty>No revisions yet. Apply one above to see the impact diff.</Empty>
                  </td>
                </tr>
              )}
              {(revisions || []).map((r) => (
                <tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: 'pointer', background: selected === r.id ? 'var(--wash)' : undefined }}>
                  <td>
                    <strong>#{r.id}</strong>
                    <div className="sub">v{r.version}</div>
                  </td>
                  <td>
                    <div className="mono" style={{ fontSize: 12 }}>{r.asset_key}</div>
                    <div className="sub">{r.metric} · {r.mode}</div>
                  </td>
                  <td>
                    {fmtDay(r.day_from)} → {fmtDay(r.day_to)}
                  </td>
                  <td className="num">{r.change_count}</td>
                  <td>{r.author}</td>
                  <td>{relTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="stack">
          {detail.data ? <RevisionDetail data={detail.data} /> : <div className="card"><Empty>Select a revision to inspect its impact.</Empty></div>}
        </div>
      </div>
    </div>
  );
}

function RevisionForm({ assets, today, onApplied }) {
  const { toast } = useApp();
  const [form, setForm] = React.useState({
    asset_key: 'staging.orders_clean',
    metric: 'quality',
    from: '',
    to: '',
    mode: 'set',
    params: { value: '0.995' },
    reason: '',
  });
  const [preview, setPreview] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  // Prefill the range with the current rule window (last 7 days ending today).
  React.useEffect(() => {
    if (today && !form.from) {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 6);
      setForm((f) => ({ ...f, from: d.toISOString().slice(0, 10), to: today }));
    }
  }, [today, form.from]);

  const body = () => ({
    asset_key: form.asset_key,
    metric: form.metric,
    from: form.from,
    to: form.to,
    mode: form.mode,
    params: normalizeParams(form.params),
  });

  const runPreview = async () => {
    setBusy(true);
    try {
      const res = await post('/revisions/preview', body());
      setPreview(res);
      if (!res.change_count) toast('No metric points would change with these parameters', 'error');
    } catch (e) {
      toast(e.message, 'error');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!form.reason.trim()) {
      toast('A reason is required for a revision', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await post('/revisions', { ...body(), reason: form.reason });
      toast(
        `Revision #${res.revision.id} applied · ${res.changed_points} points · ${res.frozen_evaluation_days} sealed days preserved`,
      );
      setPreview(null);
      onApplied(res);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const modeEntry = MODES.find(([m]) => m === form.mode);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>New correction</h2>
          <div className="sub">Preview first — the dry run lists affected contracts before anything is written.</div>
        </div>
      </div>
      <div className="field-row">
        <label className="field">
          Asset
          <select value={form.asset_key} onChange={(e) => setForm({ ...form, asset_key: e.target.value })}>
            {assets.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Metric
          <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })}>
            <option value="quality">quality</option>
            <option value="latency">latency</option>
            <option value="completeness">completeness</option>
          </select>
        </label>
        <label className="field">
          From
          <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </label>
        <label className="field">
          To
          <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
        </label>
        <label className="field">
          Mode
          <select
            value={form.mode}
            onChange={(e) => {
              const entry = MODES.find(([m]) => m === e.target.value);
              setForm({ ...form, mode: e.target.value, params: { ...entry[2] } });
              setPreview(null);
            }}
          >
            {MODES.map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {Object.entries(modeEntry?.[2] || {}).map(([k, v]) => (
          <label className="field" key={k}>
            {k}
            <input
              type="number"
              step="0.001"
              value={form.params[k] ?? v}
              onChange={(e) => setForm({ ...form, params: { ...form.params, [k]: e.target.value } })}
            />
          </label>
        ))}
        <label className="field" style={{ gridColumn: 'span 2' }}>
          Reason (required to apply)
          <input type="text" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Ticket / root cause" />
        </label>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={runPreview} disabled={busy || !form.from || !form.to}>
          Preview impact
        </button>
        <button className="btn primary" onClick={apply} disabled={busy || !preview || !preview.change_count}>
          Apply revision
        </button>
      </div>

      {preview && (
        <div style={{ marginTop: 14 }}>
          {preview.change_count === 0 ? (
            <div className="banner warn">No values would change in this range — nothing to apply.</div>
          ) : (
            <div className="banner good">
              {preview.change_count} point(s) would change across {preview.affected_assets.length} asset(s);{' '}
              {preview.affected_slos.length} contract(s) would be re-evaluated:{' '}
              {preview.affected_slos.map((s) => s.id).join(', ') || 'none'}.
            </div>
          )}
          {preview.rows?.length > 0 && (
            <div className="card pad-0" style={{ marginTop: 10, maxHeight: 230, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Before</th>
                    <th className="num">After</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 40).map((r) => (
                    <tr key={r.day}>
                      <td>{fmtDay(r.day)}</td>
                      <td className="num">{r.oldValue == null ? 'missing' : fmtNum(r.oldValue, 4)}</td>
                      <td className="num">{r.newValue == null ? 'missing' : fmtNum(r.newValue, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function normalizeParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === '' || v == null) continue;
    out[k] = Number(v);
  }
  return out;
}

const IMPACT_COPY = {
  closed_frozen: ['Closed incident preserved', 'breached'],
  alert_updated: ['Live alert updated', 'warning'],
  alert_opened: ['Alert opened', 'breached'],
  evaluations_recomputed: ['Evaluations recomputed', ''],
  evaluations_sealed: ['Sealed days kept', 'suppressed'],
};

function RevisionDetail({ data }) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Revision #{data.id}</h2>
          <div className="sub">
            {data.asset_key} · {data.metric} · {data.mode} · by {data.author} · {fmtTime(data.created_at)}
          </div>
        </div>
        <span className="badge">v{data.version}</span>
      </div>
      <div className="banner" style={{ marginBottom: 12 }}>
        {data.reason}
      </div>
      <div className="grid cols-3" style={{ marginBottom: 12 }}>
        <div className="mini-metric">
          <div className="k">Points changed</div>
          <div className="v">{data.change_count}</div>
        </div>
        <div className="mini-metric">
          <div className="k">Range</div>
          <div className="v" style={{ fontSize: 13 }}>
            {fmtDay(data.day_from)} → {fmtDay(data.day_to)}
          </div>
        </div>
        <div className="mini-metric">
          <div className="k">Impacts logged</div>
          <div className="v">{data.impacts.length}</div>
        </div>
      </div>

      <div className="section-title">Impact</div>
      {data.impacts.length === 0 ? (
        <Empty>No lifecycle or sealed-record impact.</Empty>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {data.impacts.map((i) => {
            const [label, cls] = IMPACT_COPY[i.kind] || [i.kind, ''];
            return (
              <div key={i.id} className="spread" style={{ fontSize: 13 }}>
                <div>
                  <span className={`badge ${cls}`}>{label}</span>{' '}
                  {i.kind === 'closed_frozen' && (
                    <span className="muted">
                      alert #{i.alert_id} · {fmtDay(i.detail.window?.[0])} → {fmtDay(i.detail.window?.[1])}
                    </span>
                  )}
                  {i.kind === 'evaluations_recomputed' && <span className="muted">{i.detail.count} days changed state or score</span>}
                  {i.kind === 'evaluations_sealed' && <span className="muted">{i.detail.count} days held at their closed-incident values</span>}
                  {i.kind === 'alert_updated' && <span className="muted">alert #{i.alert_id} · {i.detail.from_state} → {i.detail.to_state}</span>}
                  {i.kind === 'alert_opened' && <span className="muted">alert #{i.alert_id} · {i.detail.state}</span>}
                </div>
                {i.alert_id && (
                  <Link className="btn sm" to={`/alerts?focus=${i.alert_id}`}>
                    View incident
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="section-title" style={{ marginTop: 14 }}>
        Changed points
      </div>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Before</th>
              <th className="num">After</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.day}>
                <td>{fmtDay(r.day)}</td>
                <td className="num">{r.old_value == null ? 'missing' : fmtNum(r.old_value, 4)}</td>
                <td className="num">{r.new_value == null ? 'missing' : fmtNum(r.new_value, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
