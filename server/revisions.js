import { addDays, dayList, isoDay, nowIso } from './time.js';
import { addEvent, audit, j, tx } from './db.js';
import {
  alertView,
  ancestorsOf,
  assetGraph,
  descendantsOf,
  evaluateSlo,
  parseRule,
  reconcileSlo,
  rollingFor,
  round,
  rulesForSlo,
  ruleForDay,
  computeDay,
  suppressionFor,
} from './engine.js';

/* ------------------------------------------------------------------ */
/* Frozen days                                                         */
/* ------------------------------------------------------------------ */

/**
 * Days covered by a closed incident are sealed. Evaluations for those days are
 * never rewritten by a metric revision — the incident's evidence must keep
 * matching the row a human signed off on.
 */
export function frozenDays(db, sloId, ruleVersionId) {
  const rows = db
    .prepare(
      `SELECT first_seen_day, last_seen_day FROM alerts
       WHERE slo_id = ? AND rule_version_id = ? AND state = 'closed'`,
    )
    .all(sloId, ruleVersionId);
  const set = new Set();
  for (const r of rows) {
    for (let d = r.first_seen_day; d <= r.last_seen_day; d = addDays(d, 1)) set.add(d);
  }
  return set;
}

/* ------------------------------------------------------------------ */
/* Revision preview / apply                                            */
/* ------------------------------------------------------------------ */

function applyMode(mode, oldValue, params) {
  if (oldValue == null) return null;
  switch (mode) {
    case 'offset':
      return Math.max(0, Math.min(1, oldValue + Number(params.delta || 0)));
    case 'scale':
      return Math.max(0, Math.min(1, oldValue * Number(params.factor ?? 1)));
    case 'set':
      return params.value == null ? null : Math.max(0, Math.min(1, Number(params.value)));
    case 'baseline':
      return params.value == null ? null : Math.max(0, Math.min(1, Number(params.value)));
    default:
      throw new Error(`unknown revision mode: ${mode}`);
  }
}

function collectRevisionRows(db, { assetKey, metric, from, to, mode, params, scenario }) {
  const days = dayList(from, to);
  let planned = [];
  if (mode === 'baseline') {
    const snaps = db
      .prepare(
        `SELECT day, value FROM scenario_snapshots WHERE scenario = ? AND asset_key = ? AND metric = ? AND day BETWEEN ? AND ?`,
      )
      .all(scenario || 'healthy', assetKey, metric, from, to);
    const byDay = new Map(snaps.map((s) => [s.day, s.value]));
    for (const day of days) {
      const cur = db
        .prepare('SELECT value FROM metric_points WHERE asset_key = ? AND metric = ? AND day = ?')
        .get(assetKey, metric, day);
      const next = byDay.has(day) ? byDay.get(day) : null;
      planned.push({ day, oldValue: cur?.value ?? null, newValue: next == null ? null : round(next) });
    }
  } else {
    for (const day of days) {
    const cur = db
      .prepare('SELECT value FROM metric_points WHERE asset_key = ? AND metric = ? AND day = ?')
      .get(assetKey, metric, day);
    const next = applyMode(mode, cur?.value ?? null, params || {});
    planned.push({ day, oldValue: cur?.value ?? null, newValue: next == null ? null : Number(next.toFixed(9)) });
    }
  }
  planned = planned.filter((p) => Math.abs((p.oldValue ?? 0) - (p.newValue ?? 0)) > 1e-9);
  return planned;
}

export function previewRevision(db, input) {
  const rows = collectRevisionRows(db, input);
  const assetOk = db.prepare('SELECT 1 AS ok FROM assets WHERE key = ?').get(input.assetKey);
  if (!assetOk) throw new Error(`unknown asset ${input.assetKey}`);
  const graph = assetGraph(db);
  const affected = [input.assetKey, ...descendantsOf(graph, input.assetKey)];
  const slos = db
    .prepare(`SELECT * FROM slo_defs WHERE asset_key IN (${affected.map(() => '?').join(',')})`)
    .all(...affected);
  return { rows, change_count: rows.length, affected_assets: affected, affected_slos: slos.map((s) => ({ id: s.id, name: s.name })) };
}

export function applyRevision(db, input) {
  const { assetKey, metric, from, to, mode, params, reason, author } = input;
  if (!reason || !author) throw new Error('reason and author are required for a metric revision');
  if (from > to) throw new Error('from must be on or before to');
  if (!['quality', 'latency', 'completeness'].includes(metric)) throw new Error('invalid metric');
  if (!['offset', 'scale', 'set', 'baseline'].includes(mode)) throw new Error('invalid mode');

  const preview = previewRevision(db, input);
  if (!preview.rows.length) throw new Error('revision would not change any metric points');

  const graph = assetGraph(db);
  const affectedAssets = preview.affected_assets;
  const affectedSloIds = preview.affected_slos.map((s) => s.id);
  const now = nowIso();

  // Snapshot what evaluations looked like before the rewrite, for impact diffing.
  const before = db
    .prepare(
      `SELECT * FROM evaluations WHERE slo_id IN (${affectedSloIds.map(() => '?').join(',') || "''"})`,
    )
    .all(...affectedSloIds);
  const beforeMap = new Map(before.map((e) => [`${e.slo_id}|${e.day}|${e.rule_version_id}`, e]));

  // Snapshot alert state for affected SLOs (closed alerts are handled read-only).
  const alertsBefore = db
    .prepare(`SELECT * FROM alerts WHERE slo_id IN (${affectedSloIds.map(() => '?').join(',') || "''"})`)
    .all(...affectedSloIds);

  const frozen = new Map();
  for (const s of preview.affected_slos) {
    for (const r of rulesForSlo(db, s.id)) frozen.set(`${s.id}|${r.id}`, frozenDays(db, s.id, r.id));
  }

  let revisionId;
  const impacts = [];

  tx(db, () => {
    const versionRow = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM metric_revisions WHERE asset_key = ? AND metric = ?')
      .get(assetKey, metric);
    const version = Number(versionRow.v) + 1;
    const info = db
      .prepare(
        `INSERT INTO metric_revisions (asset_key, metric, day_from, day_to, version, mode, reason, author, created_at, change_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(assetKey, metric, from, to, version, mode, reason, author, now, preview.rows.length);
    revisionId = Number(info.lastInsertRowid);

    const insRow = db.prepare(
      `INSERT INTO metric_revision_rows (revision_id, asset_key, metric, day, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const updPoint = db.prepare(
      `UPDATE metric_points SET value = ?, revision_id = ? WHERE asset_key = ? AND metric = ? AND day = ?`,
    );
    const insPoint = db.prepare(
      `INSERT INTO metric_points (asset_key, metric, day, value, revision_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (asset_key, metric, day) DO UPDATE SET value = excluded.value, revision_id = excluded.revision_id`,
    );
    for (const r of preview.rows) {
      insRow.run(revisionId, assetKey, metric, r.day, r.oldValue, r.newValue);
      const res = updPoint.run(r.newValue, revisionId, assetKey, metric, r.day);
      if (res.changes === 0) insPoint.run(assetKey, metric, r.day, r.newValue, revisionId);
    }
    audit(db, {
      actor: author,
      action: 'metric.revision',
      entityType: 'revision',
      entityId: revisionId,
      detail: { assetKey, metric, from, to, mode, params, reason, change_count: preview.rows.length, version },
      at: now,
    });
  });

  // Re-evaluate, honouring frozen days for closed incidents.
  const evalDetails = [];
  for (const sloId of affectedSloIds) {
    const { evals } = evaluateSlo(db, sloId, { from, to, computedAt: now, graph, revisionId });
    for (const e of evals) {
      const key = `${sloId}|${e.day}|${e.rule_version_id}`;
      const fz = frozen.get(`${sloId}|${e.rule_version_id}`);
      const prior = beforeMap.get(key);
      const isFrozen = fz && fz.has(e.day);
      evalDetails.push({
        slo_id: sloId,
        day: e.day,
        frozen: !!isFrozen,
        state_before: prior?.state ?? null,
        state_after: isFrozen ? prior?.state ?? null : e.state,
        rolling_before: prior?.rolling ?? null,
        rolling_after: isFrozen ? prior?.rolling ?? null : e.rolling,
        changed: !isFrozen && prior && (prior.state !== e.state || prior.rolling !== e.rolling),
      });
    }
  }

  // Sealed evaluation rows: restore any that the recompute may have overwritten.
  for (const [k, set] of frozen) {
    if (!set.size) continue;
    const [sloId, ruleId] = k.split('|');
    for (const d of set) {
      const key = `${sloId}|${d}|${ruleId}`;
      const prior = beforeMap.get(key);
      if (!prior) continue;
      db.prepare(
        `UPDATE evaluations SET composite = ?, rolling = ?, state = ?, effective_state = ?, suppression = ?, dims = ?, evidence = ?, revision_id = ?, computed_at = ?
         WHERE slo_id = ? AND day = ? AND rule_version_id = ?`,
      ).run(
        prior.composite,
        prior.rolling,
        prior.state,
        prior.effective_state,
        prior.suppression,
        prior.dims,
        prior.evidence,
        prior.revision_id,
        prior.computed_at,
        sloId,
        d,
        ruleId,
      );
    }
  }

  // Alert lifecycle: only open alerts respond to revised data.
  const reconcileActions = [];
  for (const sloId of affectedSloIds) reconcileActions.push(...reconcileSlo(db, sloId, { actor: author, at: now, autoEscalate: false }));
  const alertsAfter = db
    .prepare(`SELECT * FROM alerts WHERE slo_id IN (${affectedSloIds.map(() => '?').join(',') || "''"})`)
    .all(...affectedSloIds);
  const afterMap = new Map(alertsAfter.map((a) => [a.id, a]));

  const sloAsset = new Map(
    db.prepare('SELECT id, asset_key FROM slo_defs').all().map((s) => [s.id, s.asset_key]),
  );
  for (const a of alertsBefore) {
    const nowRow = afterMap.get(a.id);
    if (a.state === 'closed') {
      const impacted = revisionTouchesAlertWindow({
        assetKey,
        from,
        to,
        alert: a,
        sloAsset: sloAsset.get(a.slo_id),
        graph,
      });
      if (impacted) {
        impacts.push({
          revision_id: revisionId,
          alert_id: a.id,
          kind: 'closed_frozen',
          detail: {
            alert_key: a.alert_key,
            note: 'Closed incident preserved verbatim; revised metrics did not rewrite its evidence.',
            window: [a.first_seen_day, a.last_seen_day],
          },
        });
      }
      continue;
    }
    if (nowRow && (nowRow.state !== a.state || nowRow.last_seen_day !== a.last_seen_day)) {
      impacts.push({
        revision_id: revisionId,
        alert_id: a.id,
        kind: 'alert_updated',
        detail: { from_state: a.state, to_state: nowRow.state, day: nowRow.last_seen_day },
      });
    }
  }
  // Alerts newly opened by the revision.
  const beforeIds = new Set(alertsBefore.map((a) => a.id));
  for (const a of alertsAfter) {
    if (!beforeIds.has(a.id)) {
      impacts.push({ revision_id: revisionId, alert_id: a.id, kind: 'alert_opened', detail: { state: a.state, day: a.first_seen_day } });
    }
  }

  const changedEvals = evalDetails.filter((e) => e.changed);
  if (changedEvals.length) {
    impacts.push({
      revision_id: revisionId,
      alert_id: null,
      kind: 'evaluations_recomputed',
      detail: { count: changedEvals.length },
    });
  }
  const frozenEvals = evalDetails.filter((e) => e.frozen);
  if (frozenEvals.length) {
    impacts.push({
      revision_id: revisionId,
      alert_id: null,
      kind: 'evaluations_sealed',
      detail: { count: frozenEvals.length, days: frozenEvals.map((e) => e.day) },
    });
  }

  tx(db, () => {
    const ins = db.prepare(
      'INSERT INTO revision_impacts (revision_id, alert_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const i of impacts) ins.run(revisionId, i.alert_id, i.kind, JSON.stringify(i.detail), now);
  });

  return {
    revision: db.prepare('SELECT * FROM metric_revisions WHERE id = ?').get(revisionId),
    changed_points: preview.rows.length,
    affected_assets: affectedAssets,
    affected_slos: preview.affected_slos,
    evaluations: evalDetails.slice(0, 400),
    impacts,
    alert_actions: reconcileActions,
    frozen_evaluation_days: frozenEvals.length,
  };
}

function revisionTouchesAlertWindow({ assetKey, from, to, alert, sloAsset, graph }) {
  const overlaps = !(to < alert.first_seen_day || from > alert.last_seen_day);
  if (!overlaps) return false;
  if (!sloAsset) return false;
  if (assetKey === sloAsset) return true;
  return ancestorsOf(graph, sloAsset).includes(assetKey);
}

export function revisionList(db) {
  const rows = db.prepare('SELECT * FROM metric_revisions ORDER BY created_at DESC, id DESC').all();
  return rows.map((r) => {
    const impacts = db
      .prepare('SELECT * FROM revision_impacts WHERE revision_id = ? ORDER BY id')
      .all(r.id)
      .map((i) => ({ ...i, detail: j(i.detail, {}) }));
    return { ...r, impacts };
  });
}

export function revisionDetail(db, id) {
  const r = db.prepare('SELECT * FROM metric_revisions WHERE id = ?').get(id);
  if (!r) return null;
  const rows = db.prepare('SELECT * FROM metric_revision_rows WHERE revision_id = ? ORDER BY day').all(id);
  const impacts = db
    .prepare('SELECT * FROM revision_impacts WHERE revision_id = ? ORDER BY id')
    .all(id)
    .map((i) => ({ ...i, detail: j(i.detail, {}) }));
  return { ...r, rows, impacts };
}

/* ------------------------------------------------------------------ */
/* Scenario lab: upstream gap → backfill                               */
/* ------------------------------------------------------------------ */

function snapshotPoints(db, scenario, assetKeys, from, to, at) {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO scenario_snapshots (scenario, asset_key, metric, day, value, captured_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const assetKey of assetKeys) {
    const pts = db
      .prepare('SELECT metric, day, value FROM metric_points WHERE asset_key = ? AND day BETWEEN ? AND ?')
      .all(assetKey, from, to);
    for (const p of pts) ins.run(scenario, assetKey, p.metric, p.day, p.value, at);
  }
}

function summarizeSloStates(db, sloIds, days) {
  const out = {};
  for (const id of sloIds) {
    const rows = db
      .prepare(`SELECT day, state, effective_state, rolling FROM evaluations WHERE slo_id = ? AND day IN (${days.map(() => '?').join(',')}) ORDER BY day`)
      .all(id, ...days);
    out[id] = rows;
  }
  return out;
}

export function runUpstreamGap(db, { assetKey, from, to, actor = 'operator' }) {
  const asset = db.prepare('SELECT * FROM assets WHERE key = ?').get(assetKey);
  if (!asset) throw new Error(`unknown asset ${assetKey}`);
  if (!['raw', 'staging'].includes(asset.layer)) throw new Error('simulate gaps on raw or staging assets only');
  if (from > to) throw new Error('from must be on or before to');
  const graph = assetGraph(db);
  const affected = [assetKey, ...descendantsOf(graph, assetKey)];
  const slos = db.prepare('SELECT * FROM slo_defs').all().filter((s) => affected.includes(s.asset_key));
  const sloIds = slos.map((s) => s.id);
  const days = dayList(from, to);
  const now = nowIso();

  const openBefore = db
    .prepare(`SELECT COUNT(*) AS n FROM alerts WHERE slo_id IN (${sloIds.map(() => '?').join(',') || "''"}) AND state IN ('open','acknowledged','escalated')`)
    .get(...sloIds);

  snapshotPoints(db, 'gap-preview', affected, from, to, now);

  tx(db, () => {
    // Only the source loses its rows. Downstream assets still hold stale
    // timestamps, so the engine must derive "missing upstream" through lineage
    // rather than trusting the local reading.
    db.prepare(`UPDATE metric_points SET value = NULL WHERE asset_key = ? AND day BETWEEN ? AND ?`).run(
      assetKey,
      from,
      to,
    );
    audit(db, {
      actor,
      action: 'scenario.upstream_gap',
      entityType: 'asset',
      entityId: assetKey,
      detail: { from, to, affected },
      at: now,
    });
  });

  for (const id of sloIds) evaluateSlo(db, id, { from, to, computedAt: now, graph });
  const actions = [];
  for (const id of sloIds) actions.push(...reconcileSlo(db, id, { actor, at: now, autoEscalate: false }));

  const openAfter = db
    .prepare(`SELECT COUNT(*) AS n FROM alerts WHERE slo_id IN (${sloIds.map(() => '?').join(',') || "''"}) AND state IN ('open','acknowledged','escalated')`)
    .get(...sloIds);

  const report = {
    kind: 'upstream_gap',
    asset_key: assetKey,
    days,
    affected_assets: affected,
    slo_states: summarizeSloStates(db, sloIds, days),
    alerts_opened: actions.filter((a) => a.action === 'opened').length,
    open_alerts_before: Number(openBefore.n),
    open_alerts_after: Number(openAfter.n),
    explanation: `Rows absent at ${assetKey}. Completeness and latency propagate as missing downstream, so dependent SLOs evaluate to no-data rather than a silent pass.`,
  };

  tx(db, () => {
    db.prepare(
      `INSERT INTO scenario_runs (scenario, kind, asset_key, day_from, day_to, actor, at, status, report)
       VALUES (?, 'upstream_gap', ?, ?, ?, ?, ?, 'applied', ?)`,
    ).run('default', assetKey, from, to, actor, now, JSON.stringify(report));
  });
  return report;
}

export function runBackfill(db, { assetKey, from, to, actor = 'operator' }) {
  const asset = db.prepare('SELECT * FROM assets WHERE key = ?').get(assetKey);
  if (!asset) throw new Error(`unknown asset ${assetKey}`);
  const graph = assetGraph(db);
  const affected = [assetKey, ...descendantsOf(graph, assetKey)];
  const slos = db.prepare('SELECT * FROM slo_defs').all().filter((s) => affected.includes(s.asset_key));
  const sloIds = slos.map((s) => s.id);
  const days = dayList(from, to);
  const now = nowIso();

  const snapshotRows = db
    .prepare(
      `SELECT * FROM scenario_snapshots WHERE scenario = 'gap-preview' AND asset_key = ? AND day BETWEEN ? AND ?`,
    )
    .all(assetKey, from, to);
  if (!snapshotRows.length) throw new Error('no captured rows to backfill — run an upstream gap first');

  // Restore descendants from the captured snapshot as well.
  const downRows = db
    .prepare(
      `SELECT * FROM scenario_snapshots WHERE scenario = 'gap-preview' AND asset_key != ? AND day BETWEEN ? AND ?`,
    )
    .all(assetKey, from, to);
  tx(db, () => {
    const upd = db.prepare('UPDATE metric_points SET value = ? WHERE asset_key = ? AND metric = ? AND day = ?');
    for (const r of snapshotRows) upd.run(r.value, r.asset_key, r.metric, r.day);
    for (const r of downRows) upd.run(r.value, r.asset_key, r.metric, r.day);

    audit(db, {
      actor,
      action: 'scenario.backfill',
      entityType: 'asset',
      entityId: assetKey,
      detail: { from, to, restored: snapshotRows.length + downRows.length },
      at: now,
    });
  });

  for (const id of sloIds) evaluateSlo(db, id, { from, to, computedAt: now, graph });
  const actions = [];
  for (const id of sloIds) actions.push(...reconcileSlo(db, id, { actor, at: now, autoEscalate: false }));

  const closedTouched = db
    .prepare(
      `SELECT COUNT(*) AS n FROM alerts WHERE slo_id IN (${sloIds.map(() => '?').join(',') || "''"}) AND state = 'closed'`,
    )
    .get(...sloIds);

  const report = {
    kind: 'backfill',
    asset_key: assetKey,
    days,
    affected_assets: affected,
    slo_states: summarizeSloStates(db, sloIds, days),
    alerts_recovered: actions.filter((a) => a.action === 'recovered').length,
    alerts_opened: actions.filter((a) => a.action === 'opened').length,
    closed_incidents_preserved: Number(closedTouched.n),
    explanation:
      'Replayed rows restored the missing days. Open alerts auto-recover after the rule’s recovery streak; closed incidents stay sealed.',
  };

  tx(db, () => {
    db.prepare(
      `INSERT INTO scenario_runs (scenario, kind, asset_key, day_from, day_to, actor, at, status, report)
       VALUES (?, 'backfill', ?, ?, ?, ?, ?, 'applied', ?)`,
    ).run('default', assetKey, from, to, actor, now, JSON.stringify(report));
  });
  return report;
}

export function restoreBaseline(db, { assetKey, from, to, actor = 'operator' }) {
  const asset = db.prepare('SELECT * FROM assets WHERE key = ?').get(assetKey);
  if (!asset) throw new Error(`unknown asset ${assetKey}`);
  const graph = assetGraph(db);
  const affected = [assetKey, ...descendantsOf(graph, assetKey)];
  const snap = db
    .prepare(`SELECT * FROM scenario_snapshots WHERE scenario = 'healthy' AND asset_key = ? AND day BETWEEN ? AND ?`)
    .all(assetKey, from, to);
  if (!snap.length) throw new Error('no healthy baseline captured for that range');
  const now = nowIso();
  tx(db, () => {
    const upd = db.prepare('UPDATE metric_points SET value = ? WHERE asset_key = ? AND metric = ? AND day = ?');
    for (const r of snap) upd.run(r.value, r.asset_key, r.metric, r.day);
    audit(db, {
      actor,
      action: 'scenario.restore_baseline',
      entityType: 'asset',
      entityId: assetKey,
      detail: { from, to, restored: snap.length },
      at: now,
    });
  });
  const slos = db.prepare('SELECT * FROM slo_defs').all().filter((s) => affected.includes(s.asset_key));
  const sloIds = slos.map((s) => s.id);
  for (const id of sloIds) evaluateSlo(db, id, { from, to, computedAt: now, graph });
  const actions = [];
  for (const id of sloIds) actions.push(...reconcileSlo(db, id, { actor, at: now, autoEscalate: false }));
  return {
    kind: 'restore',
    restored: snap.length,
    affected_assets: affected,
    slo_states: summarizeSloStates(db, sloIds, dayList(from, to)),
    actions,
  };
}

export function scenarioRuns(db) {
  return db
    .prepare('SELECT * FROM scenario_runs ORDER BY at DESC, id DESC LIMIT 50')
    .all()
    .map((r) => ({ ...r, report: j(r.report, {}) }));
}
