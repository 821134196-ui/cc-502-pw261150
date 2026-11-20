import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiCall, fmtDay, pct, post, relTime, useApp, useAsync } from '../lib.js';
import { Empty, Legend, Meter, Sparkline, StateBadge } from '../components/ui.jsx';

export function SlosPage() {
  const { data, loading } = useAsync(() => apiCall('/slos'), []);
  if (loading && !data) return <div className="empty">Loading contracts…</div>;
  if (!data) return <Empty>No SLOs</Empty>;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>SLO contracts</h1>
          <div className="sub">
            Each contract pins a rule version, weights per dimension, and a target over a rolling window. Missing
            upstream data becomes <em>no data</em>, never a free pass.
          </div>
        </div>
      </div>
      <div className="card pad-0">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Asset</th>
              <th>Rule</th>
              <th className="num">Target</th>
              <th className="num">Rolling</th>
              <th>Weights (Q / L / C)</th>
              <th>Trend</th>
              <th>State</th>
              <th>Incidents</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/slos/${s.id}`} style={{ fontWeight: 550 }}>
                    {s.name}
                  </Link>
                  <div className="sub">{s.owner}</div>
                </td>
                <td>
                  <div>{s.asset_name}</div>
                  <div className="sub mono">{s.asset_key}</div>
                </td>
                <td>
                  <span className="badge">v{s.rule_version}</span>
                </td>
                <td className="num">{pct(s.target)}</td>
                <td className="num">
                  <strong>{pct(s.rolling)}</strong>
                  <Meter value={s.rolling} target={s.target} />
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {(s.weights?.quality ?? 0).toFixed(2)} / {(s.weights?.latency ?? 0).toFixed(2)} /{' '}
                  {(s.weights?.completeness ?? 0).toFixed(2)}
                </td>
                <td>
                  <Sparkline values={s.trend.map((t) => t.rolling)} color="var(--series-1)" ariaLabel={`${s.name} trend`} />
                </td>
                <td>
                  <StateBadge state={s.suppression ? 'suppressed' : s.effective_state} />
                  {s.suppression === 'maintenance' && <div className="sub">maintenance</div>}
                  {s.suppression === 'exemption' && <div className="sub">exemption</div>}
                </td>
                <td>
                  {s.active_alerts > 0 && <span className="badge breached">{s.active_alerts} live</span>}{' '}
                  {s.closed_incidents > 0 && <span className="badge">{s.closed_incidents} closed</span>}
                  {s.active_alerts === 0 && s.closed_incidents === 0 && <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SloDetailPage() {
  const { id } = useParams();
  return <SloDetail id={id} />;
}

function SloDetail({ id }) {
  const { data, loading, reload } = useAsync(() => apiCall(`/slos/${id}`), [id]);
  const [tab, setTab] = React.useState('trend');
  const { toast } = useApp();
  if (loading && !data) return <div className="empty">Loading…</div>;
  if (!data) return <Empty>SLO not found</Empty>;
  const { summary: s, rules, evaluations, alerts, exemptions, maintenance, revisions, upstream, downstream, slo } = data;
  const current = rules[rules.length - 1];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <Link to="/slos" className="muted">
              ← SLOs
            </Link>
            <StateBadge state={s.suppression ? 'suppressed' : s.effective_state} />
            <span className="badge">rule v{current.version}</span>
          </div>
          <h1>{s.name}</h1>
          <div className="sub">
            {slo.description} · owner <strong>{s.owner}</strong> · asset <span className="mono">{s.asset_key}</span>
          </div>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="tile">
          <span className="label">Rolling score</span>
          <span className="value">{pct(s.rolling)}</span>
          <span className="foot">
            target {pct(s.target)} · window {current.window_days}d
          </span>
        </div>
        <div className="tile">
          <span className="label">Latest composite</span>
          <span className="value">{pct(s.composite)}</span>
          <span className="foot">as of {fmtDay(s.day)}</span>
        </div>
        <div className="tile">
          <span className="label">Upstream dependencies</span>
          <span className="value">{upstream.length}</span>
          <span className="foot">{downstream.length} consumers downstream</span>
        </div>
        <div className="tile">
          <span className="label">Incidents</span>
          <span className="value">{alerts.filter((a) => ['open', 'acknowledged', 'escalated'].includes(a.state)).length}</span>
          <span className="foot">{alerts.filter((a) => a.state === 'closed').length} closed</span>
        </div>
      </div>

      <div className="metric-strip">
        {Object.entries(current.weights).map(([m, w]) => (
          <div key={m} className="mini-metric">
            <div className="k">{m}</div>
            <div className="v">{pct(s?.day ? latestDim(evaluations, s.day, m) : null)}</div>
            <div className="s">weight {w.toFixed(2)}</div>
          </div>
        ))}
        <div className="mini-metric">
          <div className="k">warning margin</div>
          <div className="v">{pct(current.warn_margin, 1)}</div>
          <div className="s">above target</div>
        </div>
        <div className="mini-metric">
          <div className="k">recovery</div>
          <div className="v">{current.recovery_evals}d</div>
          <div className="s">healthy streak to close</div>
        </div>
        <div className="mini-metric">
          <div className="k">escalation</div>
          <div className="v">{current.escalation_hours}h</div>
          <div className="s">unacknowledged → escalate</div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {[
          ['trend', 'Trend & evidence'],
          ['rules', 'Rule versions'],
          ['alerts', `Alerts (${alerts.length})`],
          ['suppressions', `Exemptions & maintenance (${exemptions.length + maintenance.length})`],
          ['lineage', 'Dependencies'],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'trend' && <TrendEvidence data={data} />}
      {tab === 'rules' && <RuleVersions data={data} onChange={reload} toast={toast} />}
      {tab === 'alerts' && <SloAlerts alerts={alerts} onChanged={reload} />}
      {tab === 'suppressions' && <Suppressions data={data} onChange={reload} />}
      {tab === 'lineage' && <SloLineage upstream={upstream} downstream={downstream} assetKey={slo.asset_key} />}
    </div>
  );
}

function latestDim(evaluations, day, metric) {
  const e = evaluations.find((x) => x.day === day);
  return e?.dims?.[metric]?.value ?? null;
}

/* ------------------------------------------------------------------ */
/* Trend & evidence                                                    */
/* ------------------------------------------------------------------ */

function TrendEvidence({ data }) {
  const { summary: s, evaluations, rules, asset_series: series } = data;
  const [selected, setSelected] = React.useState(evaluations[evaluations.length - 1]?.day);
  const evalDay = evaluations.find((e) => e.day === selected) || evaluations[evaluations.length - 1];
  const rule = rules.find((r) => r.id === evalDay?.rule_version_id) || rules[rules.length - 1];
  const byRule = React.useMemo(() => {
    const map = new Map();
    for (const e of evaluations) {
      if (!map.has(e.rule_version_id)) map.set(e.rule_version_id, []);
      map.get(e.rule_version_id).push(e);
    }
    return map;
  }, [evaluations]);

  const revMarkers = React.useMemo(() => {
    const out = [];
    for (const e of evaluations) if (e.revision_id) out.push(e);
    return out;
  }, [evaluations]);

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>Rolling score vs target</h2>
            <div className="sub">
              Click any day to inspect its evidence. Gaps are days with insufficient coverage — they are not zeroes.
            </div>
          </div>
          <Legend
            items={[
              { label: 'Healthy', color: 'var(--series-3)' },
              { label: 'At risk', color: 'var(--series-4)' },
              { label: 'Breached', color: 'var(--status-critical)' },
              { label: 'No data', color: 'var(--text-muted)' },
            ]}
          />
        </div>
        <TrendChart
          evaluations={evaluations}
          rules={rules}
          selected={evalDay?.day}
          onSelect={setSelected}
          revisions={revMarkers}
        />
      </div>

      {evalDay && (
        <div className="grid cols-2">
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Evidence · {fmtDay(evalDay.day)}</h2>
                <div className="sub">
                  Rule v{rule.version} · target {pct(rule.target)} · window {rule.window_days}d
                </div>
              </div>
              <StateBadge state={evalDay.effective_state} />
            </div>
            <dl className="kv">
              <dt>Composite</dt>
              <dd>{pct(evalDay.composite)}</dd>
              <dt>Rolling score</dt>
              <dd>
                {pct(evalDay.rolling)} · {evalDay.evidence.sampled_days}/{evalDay.evidence.expected_days} days sampled
              </dd>
              <dt>Coverage</dt>
              <dd>{pct(evalDay.evidence.coverage)} of configured weight</dd>
              <dt>Raw state</dt>
              <dd>
                <StateBadge state={evalDay.state} />
                {evalDay.suppression && (
                  <>
                    {' '}
                    <span className="muted">→ suppressed by {evalDay.suppression}</span>
                  </>
                )}
              </dd>
              <dt>Missing metrics</dt>
              <dd>{evalDay.evidence.missing_metrics?.length ? evalDay.evidence.missing_metrics.join(', ') : 'none'}</dd>
              <dt>Missing upstream</dt>
              <dd>
                {evalDay.evidence.upstream_missing?.length ? (
                  <span className="mono">{evalDay.evidence.upstream_missing.join(', ')}</span>
                ) : (
                  'none'
                )}
              </dd>
              <dt>Revision applied</dt>
              <dd>{evalDay.revision_id ? `#${evalDay.revision_id}` : 'none'}</dd>
              <dt>Computed</dt>
              <dd>{relTime(evalDay.computed_at)}</dd>
            </dl>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Dimension evidence</h2>
                <div className="sub">Each dimension carries its own source and sampled value.</div>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Dimension</th>
                  <th className="num">Value</th>
                  <th className="num">Weight</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(evalDay.dims).map(([m, d]) => (
                  <tr key={m}>
                    <td style={{ textTransform: 'capitalize' }}>{m}</td>
                    <td className="num">{d.value == null ? '—' : pct(d.value)}</td>
                    <td className="num">{d.weight.toFixed(2)}</td>
                    <td>
                      <span className={`badge ${d.source === 'measured' ? '' : 'breached'}`}>
                        {d.source === 'measured' ? 'Measured' : d.source === 'upstream-missing' ? 'Upstream missing' : 'Missing rows'}
                      </span>
                      {d.revision_id && <span className="badge" style={{ marginLeft: 6 }}>rev #{d.revision_id}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Metric inputs</h2>
            <div className="sub">Underlying stored points for the SLO asset. Blank gaps are absent rows.</div>
          </div>
          <Legend
            items={[
              { label: 'Quality', color: 'var(--series-1)', line: true },
              { label: 'Latency', color: 'var(--series-2)', line: true },
              { label: 'Completeness', color: 'var(--series-3)', line: true },
            ]}
          />
        </div>
        <MetricInputs series={series} rules={rules} />
      </div>
    </div>
  );
}

function TrendChart({ evaluations, rules, selected, onSelect, revisions }) {
  const [hover, setHover] = React.useState(null);
  const width = 1100;
  const height = 240;
  const pad = { left: 54, right: 42, top: 16, bottom: 28 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const days = evaluations.map((e) => e.day);
  const vals = evaluations.map((e) => e.rolling).filter((v) => v != null);
  const lo = Math.min(...vals, ...rules.map((r) => r.target)) - 0.02;
  const hi = Math.max(...vals, ...rules.map((r) => r.target)) + 0.012;
  const x = (i) => pad.left + (days.length > 1 ? (i / (days.length - 1)) * innerW : innerW / 2);
  const y = (v) => pad.top + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) / ticks) * i);
  const bandY0 = y(ruleAt(rules, days[0])?.target ?? 0);
  const stateColor = { healthy: 'var(--series-3)', warning: 'var(--series-4)', breached: 'var(--status-critical)', nodata: 'var(--text-muted)' };

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block', cursor: 'pointer' }}
        role="img"
        aria-label="Rolling SLO score over time with target line"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          const idx = Math.round(((px - pad.left) / innerW) * (days.length - 1));
          if (idx >= 0 && idx < days.length) setHover(idx);
        }}
        onClick={() => hover != null && onSelect(days[hover])}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={pad.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {(t * 100).toFixed(1)}
            </text>
          </g>
        ))}
        {/* step-wise target lines per rule version */}
        {rules.map((r, ri) => {
          const start = Math.max(0, days.findIndex((d) => d >= r.effective_from));
          const end = rules[ri + 1]
            ? Math.max(0, days.findIndex((d) => d >= rules[ri + 1].effective_from) - 1)
            : days.length - 1;
          if (start < 0 || end < start) return null;
          // Caption anchors just inside the segment's left edge; the small
          // offset below the dashed line keeps it clear of the line itself and
          // of the score curve, which sits above target on most days.
          return (
            <g key={r.id}>
              <line x1={x(start)} x2={x(end)} y1={y(r.target)} y2={y(r.target)} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="4 4" />
              <text
                x={x(start) + 5}
                y={y(r.target) + 13}
                fontSize="10"
                fill="var(--text-muted)"
                stroke="var(--surface-1)"
                strokeWidth="3"
                paintOrder="stroke"
              >
                v{r.version} target {pct(r.target)}
              </text>
            </g>
          );
        })}
        {evaluations.map((e, i) => {
          const next = evaluations[i + 1];
          const segEnd = next ? x(i + 1) : x(i);
          if (e.effective_state === 'suppressed') {
            return <rect key={e.day} x={x(i)} y={pad.top} width={Math.max(1, segEnd - x(i))} height={innerH} fill="rgba(98,80,214,0.08)" />;
          }
          return null;
        })}
        {evaluations.map((e, i) => {
          if (e.rolling == null) return null;
          const next = evaluations[i + 1];
          const nx = next && next.rolling != null && next.effective_state !== 'suppressed' ? x(i + 1) : null;
          return (
            <line
              key={`seg-${e.day}`}
              x1={x(i)}
              y1={y(e.rolling)}
              x2={nx ?? x(i)}
              y2={nx != null ? y(next.rolling) : y(e.rolling)}
              stroke={e.effective_state === 'suppressed' ? 'var(--text-muted)' : stateColor[e.state] || 'var(--series-1)'}
              strokeWidth="2"
              strokeLinecap="round"
              opacity={e.effective_state === 'suppressed' ? 0.45 : 1}
            />
          );
        })}
        {revisions.map((e) => {
          const i = days.indexOf(e.day);
          if (i < 0) return null;
          return (
            <g key={`rev-${e.day}`}>
              <line x1={x(i)} x2={x(i)} y1={pad.top} y2={pad.top + innerH} stroke="var(--series-7)" strokeWidth="1" strokeDasharray="2 3" opacity="0.7" />
              <circle cx={x(i)} cy={pad.top + 4} r="2.4" fill="var(--series-7)" />
            </g>
          );
        })}
        {days.map((d, i) =>
          i % Math.ceil(days.length / 7) === 0 || i === days.length - 1 ? (
            <text key={d} x={x(i)} y={height - 8} textAnchor="middle" fontSize="10.5" fill="var(--text-muted)">
              {fmtDay(d)}
            </text>
          ) : null,
        )}
        {selected && days.includes(selected) && (
          <line
            x1={x(days.indexOf(selected))}
            x2={x(days.indexOf(selected))}
            y1={pad.top}
            y2={pad.top + innerH}
            stroke="var(--text-primary)"
            strokeWidth="1.4"
          />
        )}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--axis)" strokeWidth="1" />}
        {hover != null && evaluations[hover]?.rolling != null && (
          <circle cx={x(hover)} cy={y(evaluations[hover].rolling)} r="3.6" fill="var(--surface-1)" stroke="var(--text-primary)" strokeWidth="2" />
        )}
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, flexWrap: 'wrap' }}>
        <span>Solid = rolling score by day-state</span>
        <span>Dashed = rule target (per version)</span>
        <span>
          <span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(98,80,214,0.18)', borderRadius: 2, verticalAlign: -1 }} /> exemption /
          maintenance
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 10, height: 2, background: 'var(--series-7)', verticalAlign: 3 }} /> metric revision
        </span>
      </div>
      {hover != null && evaluations[hover] && (
        <div
          style={{
            position: 'absolute',
            left: `${(x(hover) / width) * 100}%`,
            top: 0,
            transform: x(hover) > width * 0.6 ? 'translateX(-104%)' : 'translateX(14px)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            padding: '8px 11px',
            boxShadow: 'var(--shadow)',
            fontSize: 12,
            pointerEvents: 'none',
            minWidth: 200,
          }}
        >
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{fmtDay(evaluations[hover].day)}</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{pct(evaluations[hover].rolling)}</div>
          <div className="muted" style={{ marginTop: 2 }}>
            composite {pct(evaluations[hover].composite)} · coverage {pct(evaluations[hover].evidence.coverage)}
          </div>
          <div style={{ marginTop: 4 }}>
            <StateBadge state={evaluations[hover].effective_state} />
            {evaluations[hover].suppression && <span className="muted"> · {evaluations[hover].suppression}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function ruleAt(rules, day) {
  let chosen = rules[0];
  for (const r of rules) if (r.effective_from <= day) chosen = r;
  return chosen;
}

function MetricInputs({ series, rules }) {
  const [hover, setHover] = React.useState(null);
  const days = React.useMemo(() => [...new Set(series.map((s) => s.day))].sort(), [series]);
  const map = React.useMemo(() => {
    const m = new Map();
    for (const p of series) m.set(`${p.day}|${p.metric}`, p.value);
    return m;
  }, [series]);
  const width = 1100;
  const height = 180;
  const pad = { left: 54, right: 44, top: 14, bottom: 26 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const vals = series.map((p) => p.value).filter((v) => v != null);
  const lo = Math.max(0, Math.min(...vals) - 0.04);
  const hi = 1.005;
  const x = (i) => pad.left + (i / Math.max(1, days.length - 1)) * innerW;
  const y = (v) => pad.top + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const palette = { quality: 'var(--series-1)', latency: 'var(--series-2)', completeness: 'var(--series-3)' };
  const metrics = ['quality', 'latency', 'completeness'];
  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label="Stored quality, latency and completeness points"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          const idx = Math.round(((px - pad.left) / innerW) * (days.length - 1));
          if (idx >= 0 && idx < days.length) setHover(idx);
        }}
      >
        {[0.7, 0.8, 0.9, 1.0].map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={pad.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--text-muted)">
              {(t * 100).toFixed(0)}%
            </text>
          </g>
        ))}
        {metrics.map((m) => {
          let d = '';
          let open = false;
          days.forEach((day, i) => {
            const v = map.get(`${day}|${m}`);
            if (v == null) {
              open = false;
              return;
            }
            d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
            open = true;
          });
          return <path key={m} d={d} fill="none" stroke={palette[m]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />;
        })}
        {days.map((d, i) =>
          i % Math.ceil(days.length / 7) === 0 || i === days.length - 1 ? (
            <text key={d} x={x(i)} y={height - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
              {fmtDay(d)}
            </text>
          ) : null,
        )}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--axis)" strokeWidth="1" />}
      </svg>
      {hover != null && (
        <div
          style={{
            position: 'absolute',
            left: `${(x(hover) / width) * 100}%`,
            top: 0,
            transform: x(hover) > width * 0.6 ? 'translateX(-104%)' : 'translateX(12px)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            padding: '7px 10px',
            boxShadow: 'var(--shadow)',
            fontSize: 12,
            pointerEvents: 'none',
            minWidth: 150,
          }}
        >
          <div style={{ color: 'var(--text-muted)', marginBottom: 3 }}>{fmtDay(days[hover])}</div>
          {metrics.map((m) => {
            const v = map.get(`${days[hover]}|${m}`);
            return (
              <div key={m} className="spread" style={{ gap: 14 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textTransform: 'capitalize' }}>
                  <span style={{ width: 12, height: 2, background: palette[m], borderRadius: 1 }} />
                  {m}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v == null ? 'missing' : pct(v)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rule versions                                                       */
/* ------------------------------------------------------------------ */

function RuleVersions({ data, onChange, toast }) {
  const { rules, summary: s, slo } = data;
  const [form, setForm] = React.useState({
    target: rules[rules.length - 1].target,
    warn_margin: rules[rules.length - 1].warn_margin,
    window_days: rules[rules.length - 1].window_days,
    escalation_hours: rules[rules.length - 1].escalation_hours,
    recovery_evals: rules[rules.length - 1].recovery_evals,
    weights: rules[rules.length - 1].weights,
    effective_from: data.today,
    note: '',
  });
  const [busy, setBusy] = React.useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await post(`/slos/${slo.id}/rules`, {
        target: Number(form.target),
        warn_margin: Number(form.warn_margin),
        window_days: Number(form.window_days),
        escalation_hours: Number(form.escalation_hours),
        recovery_evals: Number(form.recovery_evals),
        weights: {
          quality: Number(form.weights.quality),
          latency: Number(form.weights.latency),
          completeness: Number(form.weights.completeness),
        },
        effective_from: form.effective_from,
        note: form.note,
      });
      toast(`Rule version v${res.version} appended — revisions are append-only`);
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="card pad-0">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Effective from</th>
              <th className="num">Target</th>
              <th className="num">Warn</th>
              <th className="num">Window</th>
              <th>Weights Q / L / C</th>
              <th className="num">Escalate</th>
              <th className="num">Recover</th>
              <th>Author</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>v{r.version}</strong>
                  {r.version === rules[rules.length - 1].version && <span className="badge" style={{ marginLeft: 6 }}>current</span>}
                </td>
                <td>{fmtDay(r.effective_from)}</td>
                <td className="num">{pct(r.target)}</td>
                <td className="num">{pct(r.warn_margin, 1)}</td>
                <td className="num">{r.window_days}d</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {r.weights.quality.toFixed(2)} / {r.weights.latency.toFixed(2)} / {r.weights.completeness.toFixed(2)}
                </td>
                <td className="num">{r.escalation_hours}h</td>
                <td className="num">{r.recovery_evals}d</td>
                <td>{r.authored_by}</td>
                <td className="muted" style={{ maxWidth: 240 }}>
                  {r.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card" onSubmit={submit}>
        <div className="card-head">
          <div>
            <h2>Publish a new rule version</h2>
            <div className="sub">
              Rule versions are append-only. Weights are normalized automatically; evaluations fill in from the effective
              date.
            </div>
          </div>
        </div>
        <div className="field-row">
          <label className="field">
            Target (0–1)
            <input type="number" step="0.001" min="0.001" max="1" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} required />
          </label>
          <label className="field">
            Warning margin
            <input type="number" step="0.001" min="0" value={form.warn_margin} onChange={(e) => setForm({ ...form, warn_margin: e.target.value })} />
          </label>
          <label className="field">
            Window (days)
            <input type="number" step="1" min="1" value={form.window_days} onChange={(e) => setForm({ ...form, window_days: e.target.value })} />
          </label>
          <label className="field">
            Escalate after (h)
            <input type="number" step="1" min="1" value={form.escalation_hours} onChange={(e) => setForm({ ...form, escalation_hours: e.target.value })} />
          </label>
          <label className="field">
            Recovery days
            <input type="number" step="1" min="1" value={form.recovery_evals} onChange={(e) => setForm({ ...form, recovery_evals: e.target.value })} />
          </label>
          <label className="field">
            Effective from
            <input type="date" value={form.effective_from} min={rules[rules.length - 1].effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
          </label>
        </div>
        <div className="field-row" style={{ marginTop: 10 }}>
          {['quality', 'latency', 'completeness'].map((m) => (
            <label className="field" key={m}>
              Weight · {m}
              <input
                type="number"
                step="0.05"
                min="0"
                value={form.weights[m]}
                onChange={(e) => setForm({ ...form, weights: { ...form.weights, [m]: e.target.value } })}
              />
            </label>
          ))}
          <label className="field" style={{ gridColumn: 'span 2' }}>
            Rationale
            <input type="text" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Why this change?" />
          </label>
        </div>
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy}>
            {busy ? 'Publishing…' : 'Append rule version'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts tab                                                          */
/* ------------------------------------------------------------------ */

function SloAlerts({ alerts, onChanged }) {
  return (
    <div className="card pad-0">
      <table>
        <thead>
          <tr>
            <th>Incident</th>
            <th>Severity</th>
            <th>State</th>
            <th>Window</th>
            <th>Rule</th>
            <th>Opened</th>
            <th>Events</th>
          </tr>
        </thead>
        <tbody>
          {alerts.length === 0 && (
            <tr>
              <td colSpan={7}>
                <Empty>No incidents recorded for this contract.</Empty>
              </td>
            </tr>
          )}
          {alerts.map((a) => (
            <tr key={a.id}>
              <td>
                <div style={{ fontWeight: 550 }}>#{a.id}</div>
                <div className="sub" style={{ maxWidth: 320 }}>
                  {a.summary}
                </div>
              </td>
              <td>
                <span className={`badge ${a.severity}`}>{a.severity}</span>
              </td>
              <td>
                <StateBadge state={a.state} />
              </td>
              <td>
                {fmtDay(a.first_seen_day)} → {fmtDay(a.last_seen_day)}
              </td>
              <td>v{rules_v(a)}</td>
              <td>{relTime(a.opened_at)}</td>
              <td className="muted" style={{ fontSize: 12 }}>
                {a.events.map((e) => e.kind).join(' → ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function rules_v(a) {
  return a.evidence?.rule_version ?? '—';
}

/* ------------------------------------------------------------------ */
/* Suppressions tab                                                    */
/* ------------------------------------------------------------------ */

function Suppressions({ data, onChange }) {
  const { exemptions, maintenance, slo, today } = data;
  const { toast } = useApp();
  const [exForm, setExForm] = React.useState({ scope_type: 'slo', starts_on: today, ends_on: today, reason: '' });
  const [mwForm, setMwForm] = React.useState({ name: '', starts_on: today, ends_on: today, reason: '', scope: 'asset' });
  const [busy, setBusy] = React.useState(false);

  const addEx = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/exemptions', { ...exForm, scope_id: slo.id });
      toast('Exemption recorded — evaluations recomputed for the window');
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id) => {
    try {
      await post(`/exemptions/${id}/revoke`, { reason: 'Revoked from SLO detail' });
      toast('Exemption revoked');
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const addMw = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/maintenance', {
        name: mwForm.name,
        starts_on: mwForm.starts_on,
        ends_on: mwForm.ends_on,
        reason: mwForm.reason,
        ...(mwForm.scope === 'asset' ? { scope_asset: slo.asset_key } : { scope_slo: slo.id }),
      });
      toast('Maintenance window scheduled');
      onChange();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const exemptions2 = exemptions;
  return (
    <div className="stack">
      <div className="grid cols-2">
        <div className="card pad-0">
          <div style={{ padding: '14px 18px 6px' }}>
            <h2>Exemptions</h2>
            <div className="sub">Time-boxed, reason-required suppression of the alert path. Never erases data.</div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Window</th>
                <th>Reason</th>
                <th>Author</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {exemptions2.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <Empty>None</Empty>
                  </td>
                </tr>
              )}
              {exemptions2.map((x) => (
                <tr key={x.id} style={{ opacity: x.status === 'revoked' ? 0.6 : 1 }}>
                  <td>
                    {fmtDay(x.starts_on)} → {fmtDay(x.ends_on)}
                    <div className="sub">{x.scope_type === 'asset' ? 'asset scope' : `slo scope${x.rule_version_id ? ' · rule-pinned' : ''}`}</div>
                  </td>
                  <td style={{ maxWidth: 240 }}>{x.reason}</td>
                  <td>{x.author}</td>
                  <td>
                    <span className={`badge ${x.status === 'active' ? 'suppressed' : ''}`}>{x.status}</span>
                  </td>
                  <td>
                    {x.status === 'active' && (
                      <button className="btn sm" onClick={() => revoke(x.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card pad-0">
          <div style={{ padding: '14px 18px 6px' }}>
            <h2>Maintenance windows</h2>
            <div className="sub">Tracked separately from exemptions — planned work gets its own audit row.</div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Window</th>
                <th>Name</th>
                <th>Status</th>
                <th>Author</th>
              </tr>
            </thead>
            <tbody>
              {maintenance.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <Empty>None</Empty>
                  </td>
                </tr>
              )}
              {maintenance.map((m) => (
                <tr key={m.id}>
                  <td>
                    {fmtDay(m.starts_on)} → {fmtDay(m.ends_on)}
                  </td>
                  <td>
                    {m.name}
                    <div className="sub">{m.reason}</div>
                  </td>
                  <td>
                    <span className={`badge ${m.status === 'completed' ? '' : 'suppressed'}`}>{m.status}</span>
                  </td>
                  <td>{m.author}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <form className="card" onSubmit={addEx}>
          <h2 style={{ fontSize: 14 }}>Add exemption</h2>
          <div className="field-row" style={{ marginTop: 10 }}>
            <label className="field">
              From
              <input type="date" value={exForm.starts_on} onChange={(e) => setExForm({ ...exForm, starts_on: e.target.value })} />
            </label>
            <label className="field">
              To
              <input type="date" value={exForm.ends_on} onChange={(e) => setExForm({ ...exForm, ends_on: e.target.value })} />
            </label>
          </div>
          <label className="field" style={{ marginTop: 10 }}>
            Reason (required)
            <input type="text" value={exForm.reason} onChange={(e) => setExForm({ ...exForm, reason: e.target.value })} required />
          </label>
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button className="btn" disabled={busy}>
              Record exemption
            </button>
          </div>
        </form>
        <form className="card" onSubmit={addMw}>
          <h2 style={{ fontSize: 14 }}>Schedule maintenance</h2>
          <div className="field-row" style={{ marginTop: 10 }}>
            <label className="field">
              Name
              <input type="text" value={mwForm.name} onChange={(e) => setMwForm({ ...mwForm, name: e.target.value })} required />
            </label>
            <label className="field">
              Scope
              <select value={mwForm.scope} onChange={(e) => setMwForm({ ...mwForm, scope: e.target.value })}>
                <option value="asset">Asset ({slo.asset_key})</option>
                <option value="slo">This SLO</option>
              </select>
            </label>
            <label className="field">
              From
              <input type="date" value={mwForm.starts_on} onChange={(e) => setMwForm({ ...mwForm, starts_on: e.target.value })} />
            </label>
            <label className="field">
              To
              <input type="date" value={mwForm.ends_on} onChange={(e) => setMwForm({ ...mwForm, ends_on: e.target.value })} />
            </label>
          </div>
          <label className="field" style={{ marginTop: 10 }}>
            Reason (required)
            <input type="text" value={mwForm.reason} onChange={(e) => setMwForm({ ...mwForm, reason: e.target.value })} required />
          </label>
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button className="btn" disabled={busy}>
              Schedule window
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lineage tab                                                         */
/* ------------------------------------------------------------------ */

function SloLineage({ upstream, downstream, assetKey }) {
  return (
    <div className="grid cols-2">
      <div className="card">
        <h2 style={{ fontSize: 14 }}>Upstream dependencies ({upstream.length})</h2>
        <div className="sub" style={{ marginBottom: 10 }}>
          If any of these stop producing rows, this contract evaluates to no data.
        </div>
        {upstream.length === 0 ? (
          <Empty>No upstream assets.</Empty>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {upstream.map((a) => (
              <div key={a.key} className="spread">
                <div>
                  <div style={{ fontWeight: 550 }}>{a.name}</div>
                  <div className="sub mono">{a.key}</div>
                </div>
                <span className="badge">{a.layer}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <h2 style={{ fontSize: 14 }}>Downstream consumers ({downstream.length})</h2>
        <div className="sub" style={{ marginBottom: 10 }}>
          A breach here is also their upstream risk.
        </div>
        {downstream.length === 0 ? (
          <Empty>Terminal asset — no consumers.</Empty>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {downstream.map((a) => (
              <div key={a.key} className="spread">
                <div>
                  <div style={{ fontWeight: 550 }}>{a.name}</div>
                  <div className="sub mono">{a.key}</div>
                </div>
                <span className="badge">{a.layer}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
