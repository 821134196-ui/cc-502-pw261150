import { addDays, dayList, daysAgo, dayStamp, isoDay, todayUTC } from './time.js';
import { audit, j, tx, withoutGuards } from './db.js';
import { DEFAULT_WEIGHTS, assetGraph, evaluateAllSlo, reconcileAll, rulesForSlo, ruleForDay } from './engine.js';
import { applyRevision } from './revisions.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20261120);
const noise = (amp) => (rnd() * 2 - 1) * amp;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const ASSETS = [
  {
    key: 'raw.orders_ingest',
    name: 'Orders Ingest',
    layer: 'raw',
    owner: 'ingest-platform',
    description: 'Kafka → lake landing for order events; 15-minute micro-batches.',
    sla_tier: 'tier-1',
    baseline: { quality: 0.996, latency: 0.992, completeness: 0.999 },
  },
  {
    key: 'raw.payments_ingest',
    name: 'Payments Ingest',
    layer: 'raw',
    owner: 'payments-data',
    description: 'PSP settlement feed captured from SFTP and object storage.',
    sla_tier: 'tier-1',
    baseline: { quality: 0.994, latency: 0.984, completeness: 0.998 },
  },
  {
    key: 'staging.orders_clean',
    name: 'Orders Clean',
    layer: 'staging',
    owner: 'core-data',
    description: 'Deduplicated, schema-validated order events with currency normalization.',
    sla_tier: 'tier-1',
    baseline: { quality: 0.993, latency: 0.988, completeness: 0.997 },
  },
  {
    key: 'staging.payments_clean',
    name: 'Payments Clean',
    layer: 'staging',
    owner: 'payments-data',
    description: 'Settled payments with chargeback flags and merchant mapping.',
    sla_tier: 'tier-2',
    baseline: { quality: 0.991, latency: 0.981, completeness: 0.996 },
  },
  {
    key: 'dim.customer',
    name: 'Customer Dimension',
    layer: 'dim',
    owner: 'core-data',
    description: 'SCD2 customer profile built from order and payment identity keys.',
    sla_tier: 'tier-2',
    baseline: { quality: 0.989, latency: 0.979, completeness: 0.995 },
  },
  {
    key: 'mart.revenue_daily',
    name: 'Revenue Daily Mart',
    layer: 'mart',
    owner: 'analytics-eng',
    description: 'Board-reporting revenue mart; powers finance and growth dashboards.',
    sla_tier: 'tier-1',
    baseline: { quality: 0.992, latency: 0.986, completeness: 0.998 },
  },
];

export const EDGES = [
  { src: 'raw.orders_ingest', dst: 'staging.orders_clean', lag_minutes: 20 },
  { src: 'raw.payments_ingest', dst: 'staging.payments_clean', lag_minutes: 45 },
  { src: 'staging.orders_clean', dst: 'dim.customer', lag_minutes: 60 },
  { src: 'staging.payments_clean', dst: 'dim.customer', lag_minutes: 60 },
  { src: 'staging.orders_clean', dst: 'mart.revenue_daily', lag_minutes: 90 },
  { src: 'staging.payments_clean', dst: 'mart.revenue_daily', lag_minutes: 90 },
  { src: 'dim.customer', dst: 'mart.revenue_daily', lag_minutes: 30 },
];

export const SLO_DEFS = [
  {
    id: 'slo-revenue',
    name: 'Revenue Daily Integrity',
    asset_key: 'mart.revenue_daily',
    owner: 'analytics-eng',
    description: 'Board-facing revenue must be fresh, complete, and reconcile to source within a day.',
    runbook: 'runbooks/revenue-daily.md',
    rules: [
      {
        version: 1,
        effective_offset: 90,
        target: 0.975,
        warn_margin: 0.01,
        window_days: 7,
        weights: { quality: 0.35, latency: 0.3, completeness: 0.35 },
        thresholds: { minCoverage: 0.7 },
        escalation_hours: 36,
        recovery_evals: 2,
        authored_by: 'nadia.p',
        note: 'Initial composite contract.',
      },
      {
        version: 2,
        effective_offset: 45,
        target: 0.985,
        warn_margin: 0.012,
        window_days: 7,
        weights: DEFAULT_WEIGHTS,
        thresholds: { minCoverage: 0.7 },
        escalation_hours: 24,
        recovery_evals: 2,
        authored_by: 'nadia.p',
        note: 'Tightened after Q3 finance review; quality weight raised.',
      },
    ],
  },
  {
    id: 'slo-orders',
    name: 'Orders Clean Contract',
    asset_key: 'staging.orders_clean',
    owner: 'core-data',
    description: 'Downstream marts depend on validated, deduplicated order events.',
    runbook: 'runbooks/orders-clean.md',
    rules: [
      {
        version: 1,
        effective_offset: 90,
        target: 0.98,
        warn_margin: 0.01,
        window_days: 5,
        weights: { quality: 0.5, latency: 0.2, completeness: 0.3 },
        thresholds: { minCoverage: 0.6 },
        escalation_hours: 48,
        recovery_evals: 2,
        authored_by: 'marco.b',
        note: 'Initial contract.',
      },
      {
        version: 2,
        effective_offset: 33,
        target: 0.985,
        warn_margin: 0.01,
        window_days: 5,
        weights: { quality: 0.45, latency: 0.25, completeness: 0.3 },
        thresholds: { minCoverage: 0.6 },
        escalation_hours: 36,
        recovery_evals: 2,
        authored_by: 'marco.b',
        note: 'Rebalance after latency incidents; pages less on transient lag.',
      },
    ],
  },
  {
    id: 'slo-customer',
    name: 'Customer Dimension Integrity',
    asset_key: 'dim.customer',
    owner: 'core-data',
    description: 'Identity resolution quality gates the customer 360 launch.',
    runbook: 'runbooks/customer-dim.md',
    rules: [
      {
        version: 1,
        effective_offset: 60,
        target: 0.97,
        warn_margin: 0.015,
        window_days: 7,
        weights: { quality: 0.5, latency: 0.15, completeness: 0.35 },
        thresholds: { minCoverage: 0.65 },
        escalation_hours: 48,
        recovery_evals: 2,
        authored_by: 'grace.l',
        note: 'Customer 360 gate.',
      },
    ],
  },
];

const GAP_START = daysAgo(12);
const GAP_END = daysAgo(10);
const STAGING_DIP_START = daysAgo(20);
const STAGING_DIP_END = daysAgo(18);
const MART_DIP_START = daysAgo(4);
const MART_DIP_END = daysAgo(1);
const EXEMPTION_START = daysAgo(35);
const EXEMPTION_END = daysAgo(32);
const MAINT_START = daysAgo(60);
const MAINT_END = daysAgo(59);

export function seed(db, { reset = true } = {}) {
  if (reset) {
    // Guards are lifted only for this explicit workspace reset; the target DDL
    // recreates them immediately after the wipe.
    withoutGuards(db, () =>
      db.exec(`
      DELETE FROM scenario_runs;
      DELETE FROM scenario_snapshots;
      DELETE FROM audit_log;
      DELETE FROM alert_events;
      DELETE FROM alerts;
      DELETE FROM evaluations;
      DELETE FROM maintenance_windows;
      DELETE FROM exemptions;
      DELETE FROM slo_rule_versions;
      DELETE FROM slo_defs;
      DELETE FROM revision_impacts;
      DELETE FROM metric_revision_rows;
      DELETE FROM metric_revisions;
      DELETE FROM metric_points;
      DELETE FROM asset_edges;
      DELETE FROM assets;
      DELETE FROM sqlite_sequence;
    `),
    );
  }

  const today = todayUTC();
  const start = daysAgo(89);
  const days = dayList(start, today);
  const now = new Date().toISOString();

  tx(db, () => {
    const insAsset = db.prepare(
      'INSERT INTO assets (key, name, layer, owner, description, sla_tier, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    ASSETS.forEach((a, i) => insAsset.run(a.key, a.name, a.layer, a.owner, a.description, a.sla_tier, i));
    const insEdge = db.prepare('INSERT INTO asset_edges (src, dst, lag_minutes) VALUES (?, ?, ?)');
    EDGES.forEach((e) => insEdge.run(e.src, e.dst, e.lag_minutes));

    const insPoint = db.prepare(
      'INSERT INTO metric_points (asset_key, metric, day, value, revision_id) VALUES (?, ?, ?, ?, NULL)',
    );
    const snap = db.prepare(
      'INSERT OR REPLACE INTO scenario_snapshots (scenario, asset_key, metric, day, value, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const baseline = new Map();

    for (const asset of ASSETS) {
      for (const day of days) {
        const isRawGap = asset.key === 'raw.payments_ingest' && day >= GAP_START && day <= GAP_END;
        for (const metric of ['quality', 'latency', 'completeness']) {
          let value = clamp01(asset.baseline[metric] + noise(0.004));
          if (metric === 'completeness') value = Math.min(1, value);
          baseline.set(`${asset.key}|${metric}|${day}`, value);
          insPoint.run(asset.key, metric, day, isRawGap ? null : value);
        }
      }
    }

    // Snapshot healthy baseline metrics for scenario restore (before incident injections).
    for (const [k, value] of baseline) {
      const [assetKey, metric] = k.split('|');
      const day = k.split('|')[2];
      snap.run('healthy', assetKey, metric, day, value, now);
    }

    const setPoint = db.prepare('UPDATE metric_points SET value = ? WHERE asset_key = ? AND metric = ? AND day = ?');

    // Historical staging quality dip — closed incident later.
    for (let d = STAGING_DIP_START; d <= STAGING_DIP_END; d = addDays(d, 1)) {
      setPoint.run(clamp01(0.86 + noise(0.01)), 'staging.orders_clean', 'quality', d);
    }
    // Planned migration: completeness collapsed but covered by an exemption.
    for (let d = EXEMPTION_START; d <= EXEMPTION_END; d = addDays(d, 1)) {
      setPoint.run(clamp01(0.5 + noise(0.02)), 'mart.revenue_daily', 'completeness', d);
      setPoint.run(clamp01(0.9 + noise(0.01)), 'mart.revenue_daily', 'quality', d);
    }
    // Maintenance window: latency deliberately suppressed while re-indexing.
    for (let d = MAINT_START; d <= MAINT_END; d = addDays(d, 1)) {
      setPoint.run(clamp01(0.35 + noise(0.02)), 'mart.revenue_daily', 'latency', d);
    }
    // Live revenue quality regression, still ongoing at the data horizon.
    for (let d = MART_DIP_START; d <= MART_DIP_END; d = addDays(d, 1)) {
      setPoint.run(clamp01(0.87 + noise(0.006)), 'mart.revenue_daily', 'quality', d);
    }

    // SLOs + rule versions
    const insSlo = db.prepare(
      'INSERT INTO slo_defs (id, name, asset_key, owner, description, runbook, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insRule = db.prepare(
      `INSERT INTO slo_rule_versions
        (slo_id, version, effective_from, target, warn_margin, window_days, weights, thresholds,
         escalation_hours, recovery_evals, authored_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of SLO_DEFS) {
      insSlo.run(s.id, s.name, s.asset_key, s.owner, s.description, s.runbook, `${addDays(today, -90)}T08:00:00.000Z`);
      for (const r of s.rules) {
        insRule.run(
          s.id,
          r.version,
          addDays(today, -r.effective_offset),
          r.target,
          r.warn_margin,
          r.window_days,
          JSON.stringify(r.weights),
          JSON.stringify(r.thresholds),
          r.escalation_hours,
          r.recovery_evals,
          r.authored_by,
          r.note,
          `${addDays(today, -r.effective_offset)}T00:05:00.000Z`,
        );
      }
    }

    // Exemption: planned migration (asset scoped), and a rule-version-scoped
    // exemption retained for the retired v1 revenue rule.
    db.prepare(
      `INSERT INTO exemptions (scope_type, scope_id, starts_on, ends_on, reason, author, created_at, status, rule_version_id)
       VALUES ('asset', 'mart.revenue_daily', ?, ?, ?, ?, ?, 'active', NULL)`,
    ).run(
      EXEMPTION_START,
      EXEMPTION_END,
      'Planned warehouse migration — completeness below gate by design (CHG-4412).',
      'nadia.p',
      `${EXEMPTION_START}T07:00:00.000Z`,
    );
    const ordersV1 = db
      .prepare("SELECT id FROM slo_rule_versions WHERE slo_id = 'slo-orders' AND version = 1")
      .get();
    db.prepare(
      `INSERT INTO exemptions (scope_type, scope_id, starts_on, ends_on, reason, author, created_at, status, rule_version_id)
       VALUES ('slo', 'slo-orders', ?, ?, ?, ?, ?, 'revoked', ?)`,
    ).run(
      daysAgo(50),
      daysAgo(48),
      'Legacy dedupe bug under v1 contract only; retired with v2.',
      'marco.b',
      `${daysAgo(50)}T12:00:00.000Z`,
      ordersV1.id,
    );

    db.prepare(
      `INSERT INTO maintenance_windows (name, scope_asset, scope_slo, starts_on, ends_on, reason, author, created_at, status)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'completed')`,
    ).run(
      'Revenue mart re-index',
      'mart.revenue_daily',
      MAINT_START,
      MAINT_END,
      'Search index rebuild during release 26.11 — latency degraded intentionally.',
      'analytics-eng',
      `${addDays(MAINT_START, -3)}T10:00:00.000Z`,
    );
    db.prepare(
      `INSERT INTO maintenance_windows (name, scope_asset, scope_slo, starts_on, ends_on, reason, author, created_at, status)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'scheduled')`,
    ).run(
      'Customer 360 schema cutover',
      'slo-customer',
      addDays(today, 2),
      addDays(today, 2),
      'Dimension column rename; consumers validated in shadow mode.',
      'grace.l',
      now,
    );

    audit(db, { actor: 'seed', action: 'seed', entityType: 'workspace', entityId: 'meridian', detail: { today }, at: now });
  });

  // Evaluate full history, then seed historical incidents, then reconcile live.
  evaluateAllSlo(db);

  const sloByKey = Object.fromEntries(
    db.prepare('SELECT * FROM slo_defs').all().map((s) => [s.id, s]),
  );

  const insAlert = db.prepare(
    `INSERT INTO alerts (alert_key, slo_id, rule_version_id, severity, state, escalation_level, opened_at,
        first_seen_day, last_seen_day, acked_by, acked_at, ack_note, escalated_at, recovered_at, closed_at,
        merged_into, summary, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const insEvent = db.prepare(
    'INSERT INTO alert_events (alert_id, kind, actor, at, detail) VALUES (?, ?, ?, ?, ?)',
  );

  const evalRange = (sloId, from, to) => {
    const rules = rulesForSlo(db, sloId);
    const rule = ruleForDay(rules, from);
    return db
      .prepare('SELECT * FROM evaluations WHERE slo_id = ? AND rule_version_id = ? AND day >= ? AND day <= ? ORDER BY day')
      .all(sloId, rule.id, from, to);
  };

  for (const [sloId, from, to] of [
    ['slo-orders', STAGING_DIP_START, STAGING_DIP_END],
    ['slo-revenue', GAP_START, GAP_END],
  ]) {
    const slo = sloByKey[sloId];
    const episode = evalRange(sloId, from, to);
    if (!episode.length) continue;
    const first = episode[0];
    const last = episode[episode.length - 1];
    const ruleRow = db.prepare('SELECT * FROM slo_rule_versions WHERE id = ?').get(first.rule_version_id);
    const key = `${sloId}:v${ruleRow.version}:${first.day}`;
    const worst = episode.reduce((m, e) => (e.rolling != null && (m == null || e.rolling < m) ? e.rolling : m), null);
    const summary =
      first.state === 'nodata'
        ? `Coverage gap on ${slo.asset_key} — upstream rows absent`
        : `${slo.name} below ${(ruleRow.target * 100).toFixed(2)}% target (${(worst * 100).toFixed(2)}%)`;
    const evidence = j(last.evidence, {});
    const ackAt = `${first.day}T09:20:00.000Z`;
    const escAt = `${first.day}T11:05:00.000Z`;
    const recAt = `${addDays(last.day, 2)}T08:40:00.000Z`;
    const closeAt = `${addDays(last.day, 2)}T09:00:00.000Z`;
    const info = insAlert.run(
      key,
      sloId,
      ruleRow.id,
      first.state === 'nodata' || worst < ruleRow.target - 0.02 ? 'critical' : 'warning',
      'closed',
      1,
      `${first.day}T09:12:00.000Z`,
      first.day,
      last.day,
      'marco.b',
      ackAt,
      'Upstream feed confirmed missing; bridging replay scheduled.',
      escAt,
      recAt,
      closeAt,
      summary,
      JSON.stringify({ ...evidence, seeded_incident: true }),
    );
    const id = Number(info.lastInsertRowid);
    insEvent.run(id, 'opened', 'evaluator', `${first.day}T09:12:00.000Z`, JSON.stringify({ state: first.state }));
    insEvent.run(id, 'acknowledged', 'marco.b', ackAt, JSON.stringify({ note: 'Upstream feed confirmed missing; bridging replay scheduled.' }));
    insEvent.run(id, 'escalated', 'scheduler', escAt, JSON.stringify({ reason: 'ack_sla_exceeded' }));
    insEvent.run(id, 'recovered', 'evaluator', recAt, JSON.stringify({ reason: 'auto' }));
    insEvent.run(id, 'closed', 'marco.b', closeAt, JSON.stringify({ note: 'Replay verified; root cause filed.' }));
  }

  reconcileAll(db, { actor: 'evaluator', autoEscalate: false });

  // A correction that overlaps the sealed incident window: it rewrites the
  // underlying latency points but the closed incident's evaluations stay put.
  // The range is deliberately one day wider than the incident so both the
  // sealed and the freely-recomputed days are visible side by side.
  applyRevision(db, {
    assetKey: 'staging.orders_clean',
    metric: 'latency',
    from: addDays(STAGING_DIP_START, -1),
    to: addDays(STAGING_DIP_END, 1),
    mode: 'set',
    params: { value: 0.995 },
    reason: 'Collector clock skew under-reported latency during the replay window; re-timed after CHG-4427.',
    author: 'marco.b',
  });

  return { days: days.length, today };
}

export function isSeeded(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM assets').get();
  return Number(row.n) > 0;
}
