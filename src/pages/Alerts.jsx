import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiCall, fmtDay, fmtTime, post, relDay, relTime, useApp, useAsync } from '../lib.js';
import { Empty, StateBadge } from '../components/ui.jsx';

const FILTERS = [
  ['', 'All'],
  ['open', 'Open'],
  ['escalated', 'Escalated'],
  ['acknowledged', 'Acknowledged'],
  ['recovered', 'Recovered'],
  ['merged', 'Merged'],
  ['closed', 'Closed'],
];

export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const focusId = params.get('focus');
  const filter = params.get('state') || '';
  const { data, loading, reload } = useAsync(() => apiCall(`/alerts${filter ? `?state=${filter}` : ''}`), [filter]);
  const [selected, setSelected] = React.useState(focusId ? Number(focusId) : null);
  const { toast } = useApp();
  const [mergeMode, setMergeMode] = React.useState(false);
  const [picked, setPicked] = React.useState([]);

  React.useEffect(() => {
    if (focusId) setSelected(Number(focusId));
  }, [focusId]);

  const openSelected = (id) => {
    setSelected(id);
    const next = new URLSearchParams(params);
    next.set('focus', String(id));
    setParams(next, { replace: true });
  };

  const act = async (id, action, body) => {
    try {
      const res = await post(`/alerts/${id}/${action}`, body);
      toast(`Alert #${id} → ${res.state}`);
      reload();
      return res;
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const merge = async (groupId) => {
    try {
      const res = await post('/alerts/merge', { group_id: groupId, member_ids: picked });
      toast(`Merged ${res.members.length} incident(s) into #${groupId}`);
      setMergeMode(false);
      setPicked([]);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  if (loading && !data) return <div className="empty">Loading incidents…</div>;
  const alerts = data || [];
  const selectedAlert = alerts.find((a) => a.id === selected) || null;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Alert lifecycle</h1>
          <div className="sub">
            Every incident keeps an append-only event trail. Merge related incidents into a parent, escalate by clock or by
            hand, and close only after recovery.
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={reload}>
            Refresh
          </button>
          {mergeMode ? (
            <>
              <span className="muted">{picked.length} selected</span>
              <button className="btn" onClick={() => { setMergeMode(false); setPicked([]); }}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setMergeMode(true)} disabled={!alerts.some(isActive)}>
              Merge incidents
            </button>
          )}
        </div>
      </div>

      <div className="row">
        <div className="chip-row">
          {FILTERS.map(([v, label]) => (
            <button
              key={v || 'all'}
              className={`chip ${filter === v ? 'active' : ''}`}
              onClick={() => {
                const next = new URLSearchParams(params);
                if (v) next.set('state', v);
                else next.delete('state');
                setParams(next, { replace: true });
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mergeMode && (
        <div className="banner">
          Select two or more active incidents, then choose the group parent. The parent keeps the timeline; members are
          linked, not deleted.
        </div>
      )}

      <div className="card pad-0">
        <table>
          <thead>
            <tr>
              {mergeMode && <th style={{ width: 34 }} />}
              <th>Incident</th>
              <th>Severity</th>
              <th>State</th>
              <th>Window</th>
              <th>Opened</th>
              <th>Last seen</th>
              <th style={{ width: 220 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {alerts.length === 0 && (
              <tr>
                <td colSpan={mergeMode ? 8 : 7}>
                  <Empty>No incidents in this view.</Empty>
                </td>
              </tr>
            )}
            {alerts.map((a) => {
              const active = isActive(a);
              const checkable = mergeMode && active;
              return (
                <tr key={a.id} style={{ background: selected === a.id ? 'var(--wash)' : undefined }}>
                  {mergeMode && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select alert ${a.id} for merge`}
                        disabled={!checkable}
                        checked={picked.includes(a.id)}
                        onChange={(e) =>
                          setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))
                        }
                      />
                    </td>
                  )}
                  <td>
                    <button className="btn ghost sm" onClick={() => openSelected(a.id)} style={{ padding: 0, textAlign: 'left' }}>
                      <div style={{ fontWeight: 550 }}>#{a.id} · {a.slo_id}</div>
                      <div className="sub" style={{ maxWidth: 380 }}>{a.summary}</div>
                    </button>
                    {a.merged_into && <div className="sub">merged into #{a.merged_into}</div>}
                  </td>
                  <td>
                    <span className={`badge ${a.severity}`}>{a.severity}</span>
                  </td>
                  <td>
                    <StateBadge state={a.state} />
                    {a.state === 'escalated' && a.escalation_level > 1 && <div className="sub">level {a.escalation_level}</div>}
                  </td>
                  <td>
                    {fmtDay(a.first_seen_day)} → {fmtDay(a.last_seen_day)}
                  </td>
                  <td>{relTime(a.opened_at)}</td>
                  <td>{relDay(a.last_seen_day)}</td>
                  <td>
                    <div className="row" style={{ gap: 5 }}>
                      {mergeMode && active && (
                        <button className="btn sm primary" onClick={() => merge(a.id)} disabled={picked.filter((p) => p !== a.id).length === 0}>
                          Set as parent
                        </button>
                      )}
                      {!mergeMode && a.state === 'open' && (
                        <button className="btn sm" onClick={() => act(a.id, 'ack', { note: 'Acknowledged from console' })}>
                          Ack
                        </button>
                      )}
                      {!mergeMode && ['open', 'acknowledged'].includes(a.state) && (
                        <button className="btn sm" onClick={() => act(a.id, 'escalate', { reason: 'Manual escalation' })}>
                          Escalate
                        </button>
                      )}
                      {!mergeMode && active && (
                        <button className="btn sm" onClick={() => act(a.id, 'recover', { note: 'Manual recovery confirmation' })}>
                          Recover
                        </button>
                      )}
                      {!mergeMode && a.state === 'recovered' && (
                        <button className="btn sm" onClick={() => act(a.id, 'close', { note: 'Verified in data' })}>
                          Close
                        </button>
                      )}
                      {!mergeMode && !active && a.state !== 'recovered' && <span className="muted">—</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedAlert && (
        <AlertDrawer
          alert={selectedAlert}
          onClose={() => {
            setSelected(null);
            const next = new URLSearchParams(params);
            next.delete('focus');
            setParams(next, { replace: true });
          }}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function isActive(a) {
  return ['open', 'acknowledged', 'escalated'].includes(a.state);
}

const EVENT_COPY = {
  opened: 'Opened',
  acknowledged: 'Acknowledged',
  escalated: 'Escalated',
  recovered: 'Recovered',
  closed: 'Closed',
  merged: 'Merged away',
  merge_member: 'Merged a member in',
  extended: 'Breach extended',
  reopened: 'Reopened',
  suppressed: 'Silenced by exemption',
};

function AlertDrawer({ alert, onClose, onChanged }) {
  const { toast } = useApp();
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const ev = alert.evidence || {};

  const doAction = async (action) => {
    setBusy(true);
    try {
      const res = await post(`/alerts/${alert.id}/${action}`, { note, reason: note });
      toast(`Alert #${alert.id} → ${res?.state ?? action}`);
      setNote('');
      onChanged();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const active = isActive(alert);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Incident ${alert.id}`}>
        <div className="spread" style={{ marginBottom: 6 }}>
          <div>
            <div className="muted">Incident #{alert.id}</div>
            <h2 style={{ fontSize: 18 }}>{alert.summary}</h2>
          </div>
          <button className="btn sm" onClick={onClose}>
            Close panel
          </button>
        </div>
        <div className="row" style={{ gap: 8, marginBottom: 16 }}>
          <StateBadge state={alert.state} />
          <span className={`badge ${alert.severity}`}>{alert.severity}</span>
          <Link className="badge" to={`/slos/${alert.slo_id}`}>
            {alert.slo_id}
          </Link>
          <span className="badge">rule v{ev.rule_version ?? '—'}</span>
          {alert.acked_by && <span className="badge">acked by {alert.acked_by}</span>}
        </div>

        <div className="grid cols-2" style={{ gap: 12 }}>
          <div className="card" style={{ padding: 14 }}>
            <div className="section-title">Window</div>
            <dl className="kv" style={{ gridTemplateColumns: '100px 1fr' }}>
              <dt>First seen</dt>
              <dd>{fmtDay(alert.first_seen_day)}</dd>
              <dt>Last seen</dt>
              <dd>{fmtDay(alert.last_seen_day)}</dd>
              <dt>Opened at</dt>
              <dd>{fmtTime(alert.opened_at)}</dd>
              <dt>Recovered</dt>
              <dd>{alert.recovered_at ? fmtTime(alert.recovered_at) : '—'}</dd>
              <dt>Closed</dt>
              <dd>{alert.closed_at ? fmtTime(alert.closed_at) : '—'}</dd>
              <dt>Escalations</dt>
              <dd>{alert.escalation_level}</dd>
            </dl>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="section-title">Evidence</div>
            <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
              <dt>Target</dt>
              <dd>{ev.target != null ? `${(ev.target * 100).toFixed(2)}%` : '—'}</dd>
              <dt>Worst rolling</dt>
              <dd>{ev.worst != null ? `${(ev.worst * 100).toFixed(2)}%` : '—'}</dd>
              <dt>Window</dt>
              <dd>{ev.window_days ?? '—'}d</dd>
              <dt>Upstream gap</dt>
              <dd className="mono" style={{ fontSize: 12 }}>
                {ev.upstream_missing?.length ? ev.upstream_missing.join(', ') : 'none'}
              </dd>
            </dl>
            {ev.days?.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                {ev.days.slice(0, 8).map((d) => (
                  <div key={d.day} className="spread">
                    <span className="muted">{fmtDay(d.day)}</span>
                    <span>
                      {d.state} · {d.rolling != null ? `${(d.rolling * 100).toFixed(2)}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {alert.merged_members?.length > 0 && (
          <div className="card" style={{ marginTop: 12, padding: 14 }}>
            <div className="section-title">Merged members ({alert.merged_members.length})</div>
            {alert.merged_members.map((m) => (
              <div key={m.id} className="spread">
                <span>
                  #{m.id} · {m.summary}
                </span>
                <StateBadge state={m.state} />
              </div>
            ))}
          </div>
        )}

        <div className="card" style={{ marginTop: 12, padding: 14 }}>
          <div className="section-title">Lifecycle events</div>
          <div className="timeline">
            {alert.events.map((e) => (
              <div className="tl-item" key={e.id}>
                <div className="tl-dot" style={{ background: eventColor(e.kind) }} />
                <div className="tl-body">
                  <div className="spread">
                    <strong>{EVENT_COPY[e.kind] || e.kind}</strong>
                    <span className="tl-when">{fmtTime(e.at)}</span>
                  </div>
                  <div className="muted">
                    {e.actor}
                    {e.detail?.note ? ` · ${e.detail.note}` : ''}
                    {e.detail?.reason ? ` · ${e.detail.reason}` : ''}
                    {e.detail?.day ? ` · through ${fmtDay(e.detail.day)}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ marginTop: 12, padding: 14 }}>
          <div className="section-title">Take action</div>
          {alert.state === 'closed' ? (
            <div className="banner">
              This incident is sealed. Its evidence and event trail are immutable; a later metric revision cannot rewrite
              it.
            </div>
          ) : (
            <>
              <label className="field" style={{ marginBottom: 10 }}>
                Note (attached to the event)
                <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you find?" />
              </label>
              <div className="row">
                {alert.state === 'open' && (
                  <button className="btn" onClick={() => doAction('ack')} disabled={busy}>
                    Acknowledge
                  </button>
                )}
                {['open', 'acknowledged'].includes(alert.state) && (
                  <button className="btn" onClick={() => doAction('escalate')} disabled={busy}>
                    Escalate
                  </button>
                )}
                {active && (
                  <button className="btn" onClick={() => doAction('recover')} disabled={busy}>
                    Mark recovered
                  </button>
                )}
                {alert.state === 'recovered' && (
                  <button className="btn primary" onClick={() => doAction('close')} disabled={busy}>
                    Close incident
                  </button>
                )}
              </div>
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Closing requires recovery first — the console enforces the lifecycle so the record stays checkable.
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function eventColor(kind) {
  if (kind === 'opened') return 'var(--status-critical)';
  if (kind === 'escalated') return 'var(--status-serious)';
  if (kind === 'acknowledged') return 'var(--status-warning)';
  if (kind === 'recovered') return 'var(--status-good)';
  if (kind === 'closed') return 'var(--text-muted)';
  if (kind === 'suppressed' || kind === 'merged' || kind === 'merge_member') return 'var(--series-7)';
  return 'var(--text-muted)';
}
