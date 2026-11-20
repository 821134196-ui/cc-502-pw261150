import React from 'react';
import { Link } from 'react-router-dom';
import { apiCall, fmtDay, pct, useAsync } from '../lib.js';
import { Empty, Legend, StateBadge } from '../components/ui.jsx';

const LAYERS = [
  ['raw', 'Raw', 0],
  ['staging', 'Staging', 1],
  ['dim', 'Dimension', 2],
  ['mart', 'Mart', 3],
];

export function LineagePage() {
  const { data, loading } = useAsync(() => apiCall('/lineage'), []);
  const [origin, setOrigin] = React.useState('raw.orders_ingest');
  const [day, setDay] = React.useState(null);
  const impact = useAsync(() => (day ? apiCall(`/impact/${origin}?day=${day}`) : apiCall(`/impact/${origin}`)), [origin, day]);

  React.useEffect(() => {
    if (data && !day) setDay(data.today);
  }, [data, day]);

  if (loading && !data) return <div className="empty">Loading lineage…</div>;
  if (!data) return <Empty>No lineage</Empty>;

  const byLayer = LAYERS.map(([key, label, idx]) => ({
    key,
    label,
    idx,
    nodes: data.nodes.filter((n) => n.layer === key),
  }));
  const imp = impact.data;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Lineage & impact</h1>
          <div className="sub">
            Trace which contracts a missing upstream asset can starve. Impact analysis runs the same evaluation as the
            scheduler but writes nothing.
          </div>
        </div>
        <div className="row">
          <label className="field">
            Origin asset
            <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {data.nodes.map((n) => (
                <option key={n.key} value={n.key}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Fault day
            <input type="date" value={day || data.today} max={data.today} onChange={(e) => setDay(e.target.value)} />
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Lineage graph</h2>
            <div className="sub">
              Origin highlighted; downstream reach shaded. {data.edges.length} edges with declared propagation lag.
            </div>
          </div>
          <Legend
            items={[
              { label: 'Origin', color: 'var(--series-1)' },
              { label: 'Downstream exposure', color: 'var(--series-4)' },
              { label: 'Unaffected', color: 'var(--grid)' },
            ]}
          />
        </div>
        <LineageGraph nodes={data.nodes} edges={data.edges} origin={origin} impacted={imp?.descendants || []} onSelect={setOrigin} />
      </div>

      {imp && (
        <>
          <div className="grid cols-4">
            <div className="tile">
              <span className="label">Assets exposed</span>
              <span className="value">{imp.summary.assets_exposed}</span>
              <span className="foot">at or below {imp.origin.name}</span>
            </div>
            <div className="tile">
              <span className="label">SLOs affected</span>
              <span className="value">{imp.summary.slos_affected}</span>
              <span className="foot">{imp.summary.slos_missing_data} would evaluate no-data</span>
            </div>
            <div className="tile">
              <span className="label">Live alerts</span>
              <span className="value">{imp.summary.live_alerts}</span>
              <span className="foot">on affected contracts</span>
            </div>
            <div className="tile">
              <span className="label">Analysis day</span>
              <span className="value" style={{ fontSize: 18 }}>{fmtDay(imp.day)}</span>
              <span className="foot">no writes performed</span>
            </div>
          </div>

          <div className="card pad-0">
            <div style={{ padding: '14px 18px 4px' }}>
              <h2>Contract impact</h2>
              <div className="sub">
                <span className="mono">{imp.origin.key}</span> row loss propagates as missing data downstream — a stale local
                timestamp is not treated as fresh.
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Asset</th>
                  <th className="num">Hops away</th>
                  <th>State</th>
                  <th>Missing dimensions</th>
                  <th>Gap origins</th>
                  <th>Live alerts</th>
                </tr>
              </thead>
              <tbody>
                {imp.slo_impact.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/slos/${s.id}`} style={{ fontWeight: 550 }}>
                        {s.name}
                      </Link>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {s.asset_key}
                    </td>
                    <td className="num">{s.days_behind}</td>
                    <td>
                      <StateBadge state={s.effective_state} />
                    </td>
                    <td>
                      {s.missing_metrics?.length ? s.missing_metrics.join(', ') : <span className="muted">none</span>}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {s.gap_origins?.length ? s.gap_origins.join(', ') : <span className="muted">—</span>}
                    </td>
                    <td>
                      {s.active_alerts.length ? (
                        s.active_alerts.map((a) => (
                          <Link key={a.id} to={`/alerts?focus=${a.id}`} className={`badge ${a.state}`} style={{ marginRight: 4 }}>
                            #{a.id} {a.state}
                          </Link>
                        ))
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2 style={{ fontSize: 14 }}>Asset health on {fmtDay(imp.day)}</h2>
            <div className="sub" style={{ marginBottom: 10 }}>
              Recent completeness average · blank means missing rows.
            </div>
            <div className="grid cols-3">
              {imp.graph.nodes.map((n) => (
                <button
                  key={n.key}
                  className="mini-metric"
                  onClick={() => setOrigin(n.key)}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderColor: n.role === 'origin' ? 'var(--series-1)' : n.role === 'downstream' ? 'var(--series-4)' : 'var(--border)',
                  }}
                >
                  <div className="k">{n.layer}</div>
                  <div style={{ fontWeight: 550, marginTop: 2 }}>{n.name}</div>
                  <div className="v" style={{ fontSize: 15 }}>
                    {data.nodes.find((x) => x.key === n.key)?.recent_completeness == null
                      ? '—'
                      : pct(data.nodes.find((x) => x.key === n.key).recent_completeness)}
                  </div>
                  <div className="s">{n.role === 'origin' ? 'origin' : n.role === 'downstream' ? 'downstream' : 'unaffected'}</div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LineageGraph({ nodes, edges, origin, impacted, onSelect }) {
  const width = 1100;
  const height = 380;
  const colW = width / LAYERS.length;
  const positions = new Map();
  for (const [layer, , idx] of LAYERS) {
    const inLayer = nodes.filter((n) => n.layer === layer);
    inLayer.forEach((n, i) => {
      const x = colW * idx + colW / 2;
      const y = 54 + ((height - 110) / Math.max(1, inLayer.length)) * i + 34;
      positions.set(n.key, { x, y, node: n });
    });
  }
  const colorFor = (key) =>
    key === origin ? 'var(--series-1)' : impacted.includes(key) ? 'var(--series-4)' : 'var(--axis)';
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Asset lineage graph">
      {LAYERS.map(([key, label, idx]) => (
        <g key={key}>
          <text x={colW * idx + colW / 2} y={20} textAnchor="middle" fontSize="11" fill="var(--text-muted)" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {label}
          </text>
          <line x1={colW * idx} x2={colW * idx} y1={32} y2={height - 8} stroke="var(--grid)" strokeWidth="1" />
        </g>
      ))}
      {edges.map((e) => {
        const a = positions.get(e.src);
        const b = positions.get(e.dst);
        if (!a || !b) return null;
        const hot = e.src === origin || impacted.includes(e.src) || e.dst === origin;
        const mid = (a.x + b.x) / 2;
        return (
          <g key={`${e.src}-${e.dst}`}>
            <path
              d={`M${a.x + 84} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x - 84} ${b.y}`}
              fill="none"
              stroke={hot ? 'var(--series-4)' : 'var(--axis)'}
              strokeWidth={hot ? 1.8 : 1}
              opacity={hot ? 0.9 : 0.5}
            />
            {hot && (
              <text x={mid} y={(a.y + b.y) / 2 - 4} textAnchor="middle" fontSize="9.5" fill="var(--text-muted)">
                {e.lag_minutes}m
              </text>
            )}
          </g>
        );
      })}
      {[...positions.values()].map(({ x, y, node }) => {
        const isOrigin = node.key === origin;
        return (
          <g key={node.key} onClick={() => onSelect(node.key)} style={{ cursor: 'pointer' }} tabIndex={0} role="button" aria-label={`Select ${node.name}`}>
            <rect
              x={x - 84}
              y={y - 22}
              width={168}
              height={44}
              rx={9}
              fill="var(--surface-2)"
              stroke={colorFor(node.key)}
              strokeWidth={isOrigin ? 2 : 1.2}
            />
            <text x={x - 72} y={y - 4} fontSize="12" fontWeight="600" fill="var(--text-primary)">
              {node.name}
            </text>
            <text x={x - 72} y={y + 12} fontSize="9.5" fill="var(--text-muted)" className="mono">
              {node.key}
            </text>
            {isOrigin && <circle cx={x + 72} cy={y - 12} r="3.4" fill="var(--series-1)" />}
          </g>
        );
      })}
    </svg>
  );
}
