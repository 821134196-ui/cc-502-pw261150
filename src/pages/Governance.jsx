import React from 'react';
import { Link } from 'react-router-dom';
import { apiCall, fmtDay, pct, relTime, useAsync } from '../lib.js';
import { Empty } from '../components/ui.jsx';

export function GovernancePage() {
  const audit = useAsync(() => apiCall('/audit'), []);
  const ex = useAsync(() => apiCall('/exemptions'), []);
  const mw = useAsync(() => apiCall('/maintenance'), []);
  const rules = useAsync(() => apiCall('/bootstrap'), []);

  const ruleRows = React.useMemo(() => {
    const list = rules.data?.rules || [];
    const sloName = Object.fromEntries((rules.data?.slos || []).map((s) => [s.id, s.name]));
    return list
      .map((r) => ({ ...r, slo_name: sloName[r.slo_id] }))
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.version - a.version);
  }, [rules.data]);

  // Exemptions store a rule_version_id; the registry speaks in human versions.
  const versionOfRuleId = React.useMemo(
    () => Object.fromEntries((rules.data?.rules || []).map((r) => [r.id, r.version])),
    [rules.data],
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Governance</h1>
          <div className="sub">
            Three independent records: rule versions, exemptions, and maintenance windows. The audit log captures every
            mutation with actor and detail.
          </div>
        </div>
      </div>

      <div className="card pad-0">
        <div style={{ padding: '14px 18px 4px' }}>
          <h2>Rule version registry</h2>
          <div className="sub">Append-only. A version takes effect from its date; earlier days keep their original rule.</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Version</th>
              <th>Effective</th>
              <th className="num">Target</th>
              <th className="num">Window</th>
              <th>Weights</th>
              <th>Author</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {ruleRows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/slos/${r.slo_id}`}>{r.slo_name || r.slo_id}</Link>
                </td>
                <td>
                  <span className="badge">v{r.version}</span>
                </td>
                <td>{fmtDay(r.effective_from)}</td>
                <td className="num">{pct(r.target)}</td>
                <td className="num">{r.window_days}d</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {r.weights.quality.toFixed(2)}/{r.weights.latency.toFixed(2)}/{r.weights.completeness.toFixed(2)}
                </td>
                <td>{r.authored_by}</td>
                <td className="muted" style={{ maxWidth: 300 }}>{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid cols-2">
        <div className="card pad-0">
          <div style={{ padding: '14px 18px 4px' }}>
            <h2>Exemptions</h2>
            <div className="sub">Scope: SLO or asset; optionally pinned to one rule version.</div>
          </div>
          {(ex.data || []).length === 0 ? (
            <Empty>None</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Window</th>
                  <th>Rule pin</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {ex.data.map((x) => (
                  <tr key={x.id} style={{ opacity: x.status === 'revoked' ? 0.6 : 1 }}>
                    <td className="mono" style={{ fontSize: 12 }}>{x.scope_id}</td>
                    <td>
                      {fmtDay(x.starts_on)} → {fmtDay(x.ends_on)}
                    </td>
                    <td>
                      {x.rule_version_id ? (
                        <span className="badge" title={`rule version id ${x.rule_version_id}`}>
                          v{versionOfRuleId[x.rule_version_id] ?? '?'}
                        </span>
                      ) : (
                        <span className="muted">any</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${x.status === 'active' ? 'suppressed' : ''}`}>{x.status}</span>
                    </td>
                    <td className="muted" style={{ maxWidth: 260 }}>{x.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card pad-0">
          <div style={{ padding: '14px 18px 4px' }}>
            <h2>Maintenance windows</h2>
            <div className="sub">Planned work, tracked separately from exemptions.</div>
          </div>
          {(mw.data || []).length === 0 ? (
            <Empty>None</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scope</th>
                  <th>Window</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {mw.data.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.name}
                      <div className="sub">{m.reason}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{m.scope_slo || m.scope_asset}</td>
                    <td>
                      {fmtDay(m.starts_on)} → {fmtDay(m.ends_on)}
                    </td>
                    <td>
                      <span className={`badge ${['completed', 'cancelled'].includes(m.status) ? '' : 'suppressed'}`}>{m.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card pad-0">
        <div style={{ padding: '14px 18px 4px' }}>
          <h2>Audit log</h2>
          <div className="sub">Immutable at the database level — update and delete triggers reject any rewrite.</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data || []).slice(0, 80).map((a) => (
              <tr key={a.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{relTime(a.at)}</td>
                <td>{a.actor}</td>
                <td>
                  <span className="badge">{a.action}</span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {a.entity_type}:{a.entity_id}
                </td>
                <td className="muted mono" style={{ fontSize: 11.5, maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {JSON.stringify(a.detail)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
