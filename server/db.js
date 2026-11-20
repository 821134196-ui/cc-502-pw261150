import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS assets (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('raw','staging','dim','mart')),
  owner TEXT NOT NULL,
  description TEXT,
  sla_tier TEXT NOT NULL DEFAULT 'tier-2',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS asset_edges (
  src TEXT NOT NULL REFERENCES assets(key),
  dst TEXT NOT NULL REFERENCES assets(key),
  lag_minutes INTEGER NOT NULL DEFAULT 60,
  PRIMARY KEY (src, dst)
);

CREATE TABLE IF NOT EXISTS metric_points (
  asset_key TEXT NOT NULL REFERENCES assets(key),
  metric TEXT NOT NULL CHECK (metric IN ('quality','latency','completeness')),
  day TEXT NOT NULL,
  value REAL,
  revision_id INTEGER,
  PRIMARY KEY (asset_key, metric, day)
);

CREATE TABLE IF NOT EXISTS metric_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  day_from TEXT NOT NULL,
  day_to TEXT NOT NULL,
  version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  reason TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  change_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metric_revision_rows (
  revision_id INTEGER NOT NULL REFERENCES metric_revisions(id),
  asset_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,
  old_value REAL,
  new_value REAL,
  PRIMARY KEY (revision_id, asset_key, metric, day)
);

CREATE TABLE IF NOT EXISTS revision_impacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES metric_revisions(id),
  alert_id INTEGER,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slo_defs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  asset_key TEXT NOT NULL REFERENCES assets(key),
  owner TEXT NOT NULL,
  description TEXT,
  runbook TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slo_rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slo_id TEXT NOT NULL REFERENCES slo_defs(id),
  version INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  target REAL NOT NULL,
  warn_margin REAL NOT NULL DEFAULT 0.012,
  window_days INTEGER NOT NULL DEFAULT 7,
  weights TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  escalation_hours INTEGER NOT NULL DEFAULT 24,
  recovery_evals INTEGER NOT NULL DEFAULT 2,
  authored_by TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (slo_id, version)
);

CREATE TABLE IF NOT EXISTS exemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('slo','asset')),
  scope_id TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  reason TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at TEXT,
  rule_version_id INTEGER
);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scope_asset TEXT,
  scope_slo TEXT,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  reason TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','completed','cancelled'))
);

CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slo_id TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  composite REAL NOT NULL,
  rolling REAL NOT NULL,
  state TEXT NOT NULL,
  effective_state TEXT NOT NULL,
  suppression TEXT,
  dims TEXT NOT NULL,
  evidence TEXT NOT NULL,
  revision_id INTEGER,
  computed_at TEXT NOT NULL,
  UNIQUE (slo_id, day, rule_version_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL UNIQUE,
  slo_id TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  state TEXT NOT NULL CHECK (state IN ('open','acknowledged','escalated','merged','recovered','closed')),
  escalation_level INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  first_seen_day TEXT NOT NULL,
  last_seen_day TEXT NOT NULL,
  acked_by TEXT,
  acked_at TEXT,
  ack_note TEXT,
  escalated_at TEXT,
  recovered_at TEXT,
  closed_at TEXT,
  merged_into INTEGER,
  summary TEXT NOT NULL,
  evidence TEXT NOT NULL,
  revision_id INTEGER
);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS scenario_snapshots (
  scenario TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  day TEXT NOT NULL,
  value REAL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (scenario, asset_key, metric, day)
);

CREATE TABLE IF NOT EXISTS scenario_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upstream_gap','backfill','restore')),
  asset_key TEXT NOT NULL,
  day_from TEXT NOT NULL,
  day_to TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  report TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_slo_day ON evaluations (slo_id, day);
CREATE INDEX IF NOT EXISTS idx_alert_slo ON alerts (slo_id, state);
CREATE INDEX IF NOT EXISTS idx_alert_opened ON alerts (opened_at);
CREATE INDEX IF NOT EXISTS idx_events_alert ON alert_events (alert_id, at);
CREATE INDEX IF NOT EXISTS idx_points_asset ON metric_points (asset_key, day);
CREATE INDEX IF NOT EXISTS idx_revision_asset ON metric_revisions (asset_key, created_at);
CREATE INDEX IF NOT EXISTS idx_exempt_scope ON exemptions (scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_maint_days ON maintenance_windows (starts_on, ends_on);

-- Immutability guarantees ---------------------------------------------------
-- A closed incident is historical record. Neither metric revisions, rule
-- edits, nor API mutations may rewrite its row.
CREATE TRIGGER IF NOT EXISTS trg_alerts_closed_update
BEFORE UPDATE ON alerts
FOR EACH ROW WHEN OLD.state = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'closed alerts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_alerts_closed_delete
BEFORE DELETE ON alerts
FOR EACH ROW WHEN OLD.state = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'closed alerts cannot be deleted');
END;

-- Rule versions are append-only.
CREATE TRIGGER IF NOT EXISTS trg_rule_versions_update
BEFORE UPDATE ON slo_rule_versions
BEGIN
  SELECT RAISE(ABORT, 'rule versions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_rule_versions_delete
BEFORE DELETE ON slo_rule_versions
BEGIN
  SELECT RAISE(ABORT, 'rule versions are append-only');
END;

-- Metric revision ledger is append-only.
CREATE TRIGGER IF NOT EXISTS trg_metric_revisions_update
BEFORE UPDATE ON metric_revisions
BEGIN
  SELECT RAISE(ABORT, 'metric revisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_metric_revisions_delete
BEFORE DELETE ON metric_revisions
BEGIN
  SELECT RAISE(ABORT, 'metric revisions are append-only');
END;

-- Evidence trail is append-only.
CREATE TRIGGER IF NOT EXISTS trg_alert_events_update
BEFORE UPDATE ON alert_events
BEGIN
  SELECT RAISE(ABORT, 'alert events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_alert_events_delete
BEFORE DELETE ON alert_events
BEGIN
  SELECT RAISE(ABORT, 'alert events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;
`;

const GUARDED_TRIGGERS = [
  'trg_alerts_closed_update',
  'trg_alerts_closed_delete',
  'trg_rule_versions_update',
  'trg_rule_versions_delete',
  'trg_metric_revisions_update',
  'trg_metric_revisions_delete',
  'trg_alert_events_update',
  'trg_alert_events_delete',
  'trg_audit_update',
  'trg_audit_delete',
];

/**
 * Append-only guards also block the wipe used when reseeding a workspace. The
 * only sanctioned path around them is an explicit, audited operator reset: drop
 * the guards, clear the tables, then recreate the guards from the schema.
 */
export function withoutGuards(db, fn) {
  for (const name of GUARDED_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name};`);
  try {
    return fn();
  } finally {
    db.exec(SCHEMA);
  }
}

export function openDb(file = process.env.MERIDIAN_DB || path.join(process.cwd(), 'data', 'meridian.sqlite')) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}

export function audit(db, { actor, action, entityType, entityId, detail, at }) {
  db.prepare(
    `INSERT INTO audit_log (at, actor, action, entity_type, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    at || new Date().toISOString(),
    actor || 'system',
    action,
    entityType,
    String(entityId),
    detail == null ? null : JSON.stringify(detail),
  );
}

export function addEvent(db, alertId, kind, actor, detail, at) {
  db.prepare(
    `INSERT INTO alert_events (alert_id, kind, actor, at, detail) VALUES (?, ?, ?, ?, ?)`,
  ).run(alertId, kind, actor || 'system', at || new Date().toISOString(), detail == null ? null : JSON.stringify(detail));
}

export function j(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
