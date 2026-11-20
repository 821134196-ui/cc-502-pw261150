import React from 'react';
import { Link } from 'react-router-dom';
import { apiCall, fmtDay, pct, post, relTime, useApp, useAsync } from '../lib.js';
import { Empty, Legend, Meter, Sparkline, StateBadge } from '../components/ui.jsx';

export function OverviewPage() {
  const { data, loading, reload } = useAsync(() => apiCall('/overview'), []);
  const { toast } = useApp();
  const [busy, setBusy] = React.useState(false);

  const runTick = async () => {
    setBusy(true);
    try {
      const res = await post('/evaluations/run', {});
      toast(`Re-evaluated ${res.evaluated} SLO-days · ${res.actions.length} lifecycle action(s)`);
      reload();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <div className="empty">Loading workspace…</div>;
  if (!data) return <div className="empty">No data</div>;

  const { health, slos, active_alerts: activeAlerts, alert_counts: counts, recent_closed: recentClosed } = data;
  const worst = slos.slice().sort((a, b) => (a.rolling ?? 0) - (b.rolling ?? 0));
  // Color follows the entity, not its rank in this view — a contract keeps its
  // hue when the sort order changes between refreshes.
  const colorById = Object.fromEntries(
    slos
      .map((s) => s.id)
      .sort()
      .map((id, i) => [id, `var(--series-${(i % 8) + 1})`]),
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Reliability overview</h1>
          <div className="sub">
            Composite SLOs blend quality, latency, and completeness on each asset, with lineage-aware missing-data
            handling. Data through <strong>{fmtDay(data.today)}</strong>.
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={reload} disabled={busy}>
            Refresh
          </button>
          <button className="btn primary" onClick={runTick} disabled={busy}>
            {busy ? 'Evaluating…' : 'Run evaluation'}
          </button>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="tile">
          <span className="label">SLOs at risk</span>
          <span className="value">{health.slos_at_risk}</span>
          <span className="foot">of {slos.length} tracked contracts</span>
        </div>
        <div className="tile">
          <span className="label">Active incidents</span>
          <span className="value">{activeAlerts.length}</span>
          <span className="foot">
            {counts.escalated || 0} escalated · {counts.acknowledged || 0} acknowledged
          </span>
        </div>
        <div className="tile">
          <span className="label">Sealed incidents</span>
          <span className="value">{counts.closed || 0}</span>
          <span className="foot">closed records, immutable evidence</span>
        </div>
        <div className="tile">
          <span className="label">Assets degraded</span>
          <span className="value">{health.assets_degraded}</span>
          <span className="foot">of {health.assets_total} in lineage</span>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Composite score trend</h2>
            <div className="sub">30-day rolling composite per contract; dashed rule target is version-aware.</div>
          </div>
          <Legend
            items={worst.map((s) => ({ label: s.name, color: colorById[s.id], line: true }))}
          />
        </div>
        <CompositeTrend slos={worst} colorById={colorById} />
      </div>

      <div className="card pad-0">
        <div className="card-head" style={{ padding: '14px 18px 0' }}>
          <div>
            <h2>Contracts</h2>
            <div className="sub">Lowest rolling score first. State comes from the latest evaluated day.</div>
          </div>
          <Link className="btn sm" to="/slos">
            All SLOs
          </Link>
        </div>
        <div style={{ padding: '8px 0 0' }}>
          <div className="slo-row" style={{ borderBottom: '1px solid var(--border)', background: 'transparent' }}>
            <span className="muted">Contract</span>
            <span className="muted">Rolling</span>
            <span className="muted">Target</span>
            <span className="muted">Composite</span>
            <span className="muted">Incidents</span>
            <span className="muted">Trend</span>
            <span className="muted">State</span>
          </div>
          {worst.map((s) => (
            <Link key={s.id} to={`/slos/${s.id}`} className="slo-row" style={{ display: 'grid' }}>
              <div>
                <div className="slo-name">{s.name}</div>
                <div className="sub">
                  {s.asset_name} · v{s.rule_version} · {s.owner}
                </div>
              </div>
              <div>
                <div className="num" style={{ textAlign: 'left', fontWeight: 600 }}>
                  {pct(s.rolling)}
                </div>
                <Meter value={s.rolling} target={s.target} />
              </div>
              <div className="num" style={{ textAlign: 'left' }}>
                {pct(s.target)}
              </div>
              <div className="num" style={{ textAlign: 'left' }}>
                {pct(s.composite)}
              </div>
              <div>
                {s.active_alerts > 0 ? (
                  <span className="badge breached">{s.active_alerts} live</span>
                ) : s.closed_incidents > 0 ? (
                  <span className="badge">{s.closed_incidents} closed</span>
                ) : (
                  <span className="muted">none</span>
                )}
              </div>
              <div>
                <Sparkline
                  values={s.trend.map((t) => t.rolling)}
                  min={Math.min(s.target - 0.02, ...s.trend.map((t) => t.rolling ?? 1))}
                  max={Math.max(s.target + 0.015, ...s.trend.map((t) => t.rolling ?? 0))}
                  color={s.effective_state === 'healthy' ? 'var(--series-3)' : 'var(--series-1)'}
                  ariaLabel={`${s.name} rolling score trend`}
                />
              </div>
              <div>
                <StateBadge state={s.suppression ? 'suppressed' : s.effective_state} />
                {s.suppression === 'maintenance' && <div className="sub">maintenance</div>}
                {s.suppression === 'exemption' && <div className="sub">exemption</div>}
              </div>
            </Link>
          ))}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Active incidents</h2>
              <div className="sub">Open → acknowledged → escalated → recovered → closed.</div>
            </div>
            <Link className="btn sm" to="/alerts">
              Alert console
            </Link>
          </div>
          {activeAlerts.length === 0 ? (
            <Empty>No active incidents. Recovery keeps the lifecycle record until a human closes it.</Empty>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {activeAlerts.slice(0, 5).map((a) => (
                <Link key={a.id} to={`/alerts?focus=${a.id}`} className="spread" style={{ gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 550 }}>{a.summary}</div>
                    <div className="sub">
                      #{a.id} · {a.slo_id} · rule v{a.evidence?.rule_version ?? '—'} · opened {relTime(a.opened_at)}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <span className={`badge ${a.severity}`}>{a.severity}</span>
                    <StateBadge state={a.state} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Recently sealed</h2>
              <div className="sub">Closed incidents are immutable — revisions can't rewrite them.</div>
            </div>
          </div>
          {recentClosed.length === 0 ? (
            <Empty>Nothing closed yet.</Empty>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {recentClosed.map((a) => (
                <div key={a.id} className="spread">
                  <div>
                    <div style={{ fontWeight: 550 }}>{a.summary}</div>
                    <div className="sub">
                      #{a.id} · {fmtDay(a.first_seen_day)} → {fmtDay(a.last_seen_day)} · closed {relTime(a.closed_at)}
                    </div>
                  </div>
                  <StateBadge state="closed" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function mergeTrend(slos) {
  const days = new Map();
  for (const s of slos) {
    for (const t of s.trend) {
      if (!days.has(t.day)) days.set(t.day, { day: t.day });
      days.get(t.day)[s.id] = t.rolling;
    }
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Hand-built SVG line chart with crosshair + tooltip — one y-axis, 2px lines,
 * legend above, target reference lines per contract in muted ink.
 */
function CompositeTrend({ slos, colorById }) {
  const [hover, setHover] = React.useState(null);
  const rows = React.useMemo(() => mergeTrend(slos), [slos]);
  const width = 1100;
  const height = 250;
  const pad = { left: 52, right: 104, top: 16, bottom: 38 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const colorOf = (s) => colorById?.[s.id] || 'var(--series-1)';
  // Domain: everything, unless one early-history ramp (a contract whose window
  // began mid-period) would compress every other series into a few pixels. Then
  // the floor lifts to just under the worst rule target. Out-of-range points are
  // drawn as off-scale dashes dropping below the plot — never silently pinned to
  // a value they do not have.
  const allVals = rows.flatMap((r) => slos.map((s) => r[s.id]).filter((v) => v != null));
  const rawLo = Math.min(...allVals, ...slos.map((s) => s.target ?? 1));
  const rawHi = Math.max(...allVals, ...slos.map((s) => s.target ?? 1));
  const floor = Math.min(...slos.map((s) => s.target ?? 1)) - 0.02;
  const compressed = rawHi - rawLo > 0.04;
  const lo = compressed ? Math.max(rawLo, floor) - 0.004 : rawLo - 0.004;
  const hi = Math.max(rawHi, lo + 0.02) + 0.006;
  const clipped = rawLo < lo;
  const x = (i) => pad.left + (rows.length > 1 ? (i / (rows.length - 1)) * innerW : innerW / 2);
  const yClamped = (v) => pad.top + innerH - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * innerH;
  const y = (v) => pad.top + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) / ticks) * i);
  const series = slos.map((s) => ({
    s,
    color: colorOf(s),
    last: [...rows].reverse().find((r) => r[s.id] != null),
  }));
  // Direct-label endpoints without collisions: reserve label slots top-to-bottom.
  const labelSlots = series
    .map((d) => (d.last ? { ...d, v: d.last[d.s.id], y: yClamped(d.last[d.s.id]) } : null))
    .filter(Boolean)
    .sort((a, b) => a.y - b.y);
  labelSlots.forEach((d, i) => {
    d.labelY = i === 0 ? d.y : Math.max(d.y, labelSlots[i - 1].labelY + 13);
  });

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label="Rolling composite score by contract over the last 30 days"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          const idx = Math.round(((px - pad.left) / innerW) * (rows.length - 1));
          if (idx >= 0 && idx < rows.length) setHover(idx);
        }}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={pad.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {(t * 100).toFixed(1)}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i % Math.ceil(rows.length / 6) === 0 || i === rows.length - 1 ? (
            <text key={r.day} x={x(i)} y={height - 8} textAnchor="middle" fontSize="10.5" fill="var(--text-muted)">
              {fmtDay(r.day)}
            </text>
          ) : null,
        )}
        {slos.map((s) => {
          // Points below the floor sit on a baseline strip and are joined with a
          // dashed connector, so the shape of the ramp survives without stating
          // a y-value the axis doesn't carry.
          const baseY = pad.top + innerH + 7;
          const pts = [];
          rows.forEach((r, i) => {
            const v = r[s.id];
            if (v == null) {
              pts.push(null);
              return;
            }
            const off = v < lo;
            pts.push({ x: x(i), y: off ? baseY - 4 : yClamped(v), off });
          });
          const segs = [];
          for (let i = 1; i < pts.length; i++) {
            if (!pts[i - 1] || !pts[i]) continue;
            segs.push([pts[i - 1], pts[i], pts[i - 1].off || pts[i].off]);
          }
          const dots = pts.filter(Boolean);
          return (
            <g key={s.id}>
              {segs.map(([a, b, dashed], i) => (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={colorOf(s)}
                  strokeWidth={dashed ? 1.4 : 2}
                  strokeDasharray={dashed ? '2 3' : undefined}
                  strokeOpacity={dashed ? 0.6 : 1}
                  strokeLinecap="round"
                />
              ))}
              {dots
                .filter((p) => p.off)
                .map((p, i) => (
                  <polygon
                    key={`off-${i}`}
                    points={`${p.x - 3.4},${baseY - 4} ${p.x + 3.4},${baseY - 4} ${p.x},${baseY}`}
                    fill={colorOf(s)}
                    opacity="0.7"
                  />
                ))}
            </g>
          );
        })}
        {labelSlots.map((d) => {
          const lastIdx = rows.findIndex((r) => r.day === d.last.day);
          return (
            <g key={`lab-${d.s.id}`}>
              <circle cx={x(lastIdx)} cy={d.y} r="3.2" fill={d.color} stroke="var(--surface-1)" strokeWidth="2" />
              {Math.abs(d.labelY - d.y) > 0.5 && (
                <line x1={x(lastIdx) + 3} y1={d.y} x2={x(lastIdx) + 9} y2={d.labelY - 3} stroke={d.color} strokeWidth="1" opacity="0.5" />
              )}
              <text x={x(lastIdx) + 10} y={d.labelY + 3.5} fontSize="10.5" fill="var(--text-secondary)">
                {d.s.id.replace('slo-', '')} {(d.v * 100).toFixed(1)}
              </text>
            </g>
          );
        })}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--axis)" strokeWidth="1" />
        )}
        {clipped && (
          <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH + 7} y2={pad.top + innerH + 7} stroke="var(--axis)" strokeWidth="1" opacity="0.35" />
        )}
        {hover != null &&
          slos.map((s) => {
            const v = rows[hover]?.[s.id];
            if (v == null) return null;
            const cy = v < lo ? pad.top + innerH + 3 : yClamped(v);
            return <circle key={`h-${s.id}`} cx={x(hover)} cy={cy} r="3.4" fill={colorOf(s)} stroke="var(--surface-1)" strokeWidth="2" />;
          })}
      </svg>
      {clipped && (
        <div className="sub" style={{ marginTop: 2 }}>
          Scale starts at {(lo * 100).toFixed(1)}%. Downward ticks on the baseline mark days below it — hover any day for
          the exact score.
        </div>
      )}
      {hover != null && (
        <div
          style={{
            position: 'absolute',
            left: `${(x(hover) / width) * 100}%`,
            top: 8,
            transform: x(hover) > width * 0.62 ? 'translateX(-105%)' : 'translateX(12px)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            padding: '8px 10px',
            boxShadow: 'var(--shadow)',
            fontSize: 12,
            pointerEvents: 'none',
            minWidth: 168,
          }}
        >
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{fmtDay(rows[hover].day)}</div>
          {slos.map((s) => {
            const v = rows[hover][s.id];
            return (
              <div key={s.id} className="spread" style={{ gap: 12 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 12, height: 2, background: colorOf(s), borderRadius: 1 }} />
                  {s.id.replace('slo-', '')}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v == null ? 'no data' : pct(v)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
