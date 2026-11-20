import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, audit, j, tx } from './db.js';
import { addDays, dayList, daysAgo, isoDay, todayUTC } from './time.js';
import {
  alertView,
  ancestorsOf,
  assetGraph,
  descendantsOf,
  ackAlert,
  closeAlert,
  escalateAlert,
  mergeAlerts,
  parseRule,
  recoverAlert,
  reconcileAll,
  reconcileSlo,
  round,
  rulesForSlo,
  ruleForDay,
  evaluateAllSlo,
  evaluateSlo,
  METRICS,
  normalizeWeights,
  previewSloDay,
  gapOrigins,
} from './engine.js';
import {
  applyRevision,
  previewRevision,
  revisionDetail,
  revisionList,
  runBackfill,
  runUpstreamGap,
  restoreBaseline,
  scenarioRuns,
} from './revisions.js';
import { isSeeded, seed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-actor');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  const wrap = (fn) => (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result !== undefined) res.json(result);
    } catch (err) {
      const status = /not found|^unknown/i.test(err.message) ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  };

  const actorOf = (req) => req.get('x-actor') || req.body?.actor || 'operator';

  /* ---------------------------------------------------------------- */
  /* Reference data                                                    */
  /* ---------------------------------------------------------------- */

  app.get('/api/health', wrap(() => ({ ok: true, today: todayUTC() })));

  app.get(
    '/api/bootstrap',
    wrap((req) => {
      const today = todayUTC();
      const assets = db.prepare('SELECT * FROM assets ORDER BY position').all();
      const edges = db.prepare('SELECT * FROM asset_edges').all();
      const slos = db.prepare('SELECT * FROM slo_defs ORDER BY id').all();
      const rules = db.prepare('SELECT * FROM slo_rule_versions ORDER BY slo_id, version').all().map(parseRule);
      const actor = req.get('x-actor') || 'operator';
      return {
        today,
        assets,
        edges,
        slos,
        rules,
        actors: ['nadia.p', 'marco.b', 'grace.l', 'oncall.eng', actor].filter((v, i, a) => a.indexOf(v) === i),
      };
    }),
  );

  app.get('/api/audit', wrap(() =>
    db
      .prepare('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT 200')
      .all()
      .map((r) => ({ ...r, detail: j(r.detail, {}) })),
  ));

  /* ---------------------------------------------------------------- */
  /* Overview                                                          */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/overview',
    wrap(() => {
      const today = todayUTC();
      const slos = db.prepare('SELECT * FROM slo_defs ORDER BY id').all();
      const graph = assetGraph(db);
      const summaries = slos.map((s) => summarizeSlo(db, s, graph, today));
      const activeStates = ['open', 'acknowledged', 'escalated'];
      const alerts = db
        .prepare(`SELECT * FROM alerts WHERE state IN (${activeStates.map(() => '?').join(',')}) ORDER BY opened_at DESC`)
        .all(...activeStates)
        .map((a) => ({ ...a, evidence: j(a.evidence, {}) }));
      const counts = db.prepare('SELECT state, COUNT(*) AS n FROM alerts GROUP BY state').all();
      const recentClosed = db
        .prepare("SELECT * FROM alerts WHERE state = 'closed' ORDER BY closed_at DESC LIMIT 3")
        .all()
        .map((a) => ({ ...a, evidence: j(a.evidence, {}) }));
      const revisions = db
        .prepare('SELECT * FROM metric_revisions ORDER BY created_at DESC LIMIT 5')
        .all();
      return {
        today,
        slos: summaries,
        active_alerts: alerts,
        alert_counts: Object.fromEntries(counts.map((c) => [c.state, c.n])),
        recent_closed: recentClosed,
        recent_revisions: revisions,
        health: {
          assets_total: graph.assets.length,
          assets_degraded: summaries.filter((s) => s.effective_state !== 'healthy').length,
          slos_at_risk: summaries.filter((s) => ['breached', 'warning', 'nodata'].includes(s.effective_state)).length,
        },
      };
    }),
  );

  function summarizeSlo(db, slo, graph, today) {
    const rules = rulesForSlo(db, slo.id);
    const rule = ruleForDay(rules, today);
    const latest = db
      .prepare('SELECT * FROM evaluations WHERE slo_id = ? ORDER BY day DESC LIMIT 1')
      .get(slo.id);
    const lastEval = latest ? { ...latest, evidence: j(latest.evidence, {}), dims: j(latest.dims, {}) } : null;
    const active = db
      .prepare(
        `SELECT * FROM alerts WHERE slo_id = ? AND state IN ('open','acknowledged','escalated') ORDER BY opened_at DESC`,
      )
      .all(slo.id);
    const closedCount = db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE slo_id = ? AND state = 'closed'")
      .get(slo.id);
    const asset = db.prepare('SELECT * FROM assets WHERE key = ?').get(slo.asset_key);
    const trend = db
      .prepare('SELECT day, composite, rolling, state, effective_state, suppression FROM evaluations WHERE slo_id = ? ORDER BY day DESC LIMIT 30')
      .all(slo.id)
      .reverse();
    return {
      id: slo.id,
      name: slo.name,
      owner: slo.owner,
      description: slo.description,
      asset_key: slo.asset_key,
      asset_name: asset?.name,
      layer: asset?.layer,
      sla_tier: asset?.sla_tier,
      rule_version: rule?.version ?? null,
      target: rule?.target ?? null,
      window_days: rule?.window_days ?? null,
      weights: rule?.weights ?? null,
      effective_state: lastEval?.effective_state ?? 'nodata',
      state: lastEval?.state ?? 'nodata',
      rolling: lastEval?.rolling ?? null,
      composite: lastEval?.composite ?? null,
      day: lastEval?.day ?? null,
      suppression: lastEval?.suppression ?? null,
      active_alerts: active.length,
      closed_incidents: Number(closedCount.n),
      upstream_count: ancestorsOf(graph, slo.asset_key).length,
      downstream_count: descendantsOf(graph, slo.asset_key).length,
      trend,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Assets & lineage                                                  */
  /* ---------------------------------------------------------------- */

  app.get('/api/assets', wrap(() => db.prepare('SELECT * FROM assets ORDER BY position').all()));

  app.get(
    '/api/assets/:key',
    wrap((req) => {
      const graph = assetGraph(db);
      const asset = db.prepare('SELECT * FROM assets WHERE key = ?').get(req.params.key);
      if (!asset) throw new Error('unknown asset');
      const today = todayUTC();
      const days = dayList(daysAgo(29), today);
      const series = days.map((day) => {
        const row = { day };
        for (const m of METRICS) {
          const r = db
            .prepare('SELECT value FROM metric_points WHERE asset_key = ? AND metric = ? AND day = ?')
            .get(asset.key, m, day);
          row[m] = r?.value ?? null;
        }
        return row;
      });
      const slos = db
        .prepare('SELECT * FROM slo_defs WHERE asset_key = ?')
        .all(asset.key)
        .map((s) => summarizeSlo(db, s, graph, today));
      const inbound = db
        .prepare('SELECT e.*, a.name AS src_name FROM asset_edges e JOIN assets a ON a.key = e.src WHERE e.dst = ?')
        .all(asset.key);
      const outbound = db
        .prepare('SELECT e.*, a.name AS dst_name FROM asset_edges e JOIN assets a ON a.key = e.dst WHERE e.src = ?')
        .all(asset.key);
      const revisions = db
        .prepare('SELECT * FROM metric_revisions WHERE asset_key = ? ORDER BY created_at DESC LIMIT 10')
        .all(asset.key);
      return {
        asset,
        series,
        slos,
        inbound,
        outbound,
        ancestors: ancestorsOf(graph, asset.key),
        descendants: descendantsOf(graph, asset.key),
        revisions,
      };
    }),
  );

  app.get(
    '/api/lineage',
    wrap(() => {
      const graph = assetGraph(db);
      const today = todayUTC();
      const nodes = graph.assets.map((a) => {
        const comp = db
          .prepare("SELECT AVG(value) AS v FROM metric_points WHERE asset_key = ? AND metric = 'completeness' AND day >= ?")
          .get(a.key, daysAgo(6));
        return {
          ...a,
          parents: (graph.parents.get(a.key) || []).map((p) => p.key),
          children: (graph.children.get(a.key) || []).map((c) => c.key),
          recent_completeness: comp.v == null ? null : round(comp.v, 4),
        };
      });
      return { nodes, edges: graph.edges, today };
    }),
  );

  /**
   * Impact analysis: given an asset and an optional fault day, report which
   * downstream assets and SLOs are exposed, whether their readings are missing,
   * and which alerts are live. This is the same propagation the engine uses.
   */
  app.get(
    '/api/impact/:key',
    wrap((req) => {
      const graph = assetGraph(db);
      const asset = db.prepare('SELECT * FROM assets WHERE key = ?').get(req.params.key);
      if (!asset) throw new Error('unknown asset');
      const day = req.query.day || todayUTC();
      const descendants = descendantsOf(graph, asset.key);
      const affected = [asset.key, ...descendants];
      const slos = db
        .prepare(`SELECT * FROM slo_defs WHERE asset_key IN (${affected.map(() => '?').join(',')})`)
        .all(...affected);
      const graphOut = {
        nodes: graph.assets.map((a) => ({
          ...a,
          role: a.key === asset.key ? 'origin' : affected.includes(a.key) ? 'downstream' : 'unaffected',
        })),
        edges: graph.edges,
      };
      const sloImpact = slos.map((s) => {
        const preview = previewSloDay(db, s, day, graph);
        const active = db
          .prepare(
            `SELECT id, alert_key, severity, state, summary FROM alerts WHERE slo_id = ? AND state IN ('open','acknowledged','escalated')`,
          )
          .all(s.id);
        return {
          id: s.id,
          name: s.name,
          asset_key: s.asset_key,
          days_behind: descendants.includes(s.asset_key) ? pathLength(graph, asset.key, s.asset_key) : 0,
          state: preview?.state ?? 'nodata',
          effective_state: preview?.effective_state ?? 'nodata',
          rolling: preview?.rolling ?? null,
          rule_version: preview?.rule?.version ?? null,
          missing_metrics: preview?.missing_metrics || [],
          upstream_missing: preview?.upstream_missing || [],
          gap_origins: preview?.state === 'nodata' ? gapOrigins(db, graph, s.asset_key, day) : [],
          active_alerts: active,
        };
      });
      return {
        origin: asset,
        day,
        descendants,
        graph: graphOut,
        slo_impact: sloImpact,
        summary: {
          assets_exposed: descendants.length,
          slos_affected: sloImpact.length,
          slos_missing_data: sloImpact.filter((s) => s.state === 'nodata').length,
          live_alerts: sloImpact.reduce((n, s) => n + s.active_alerts.length, 0),
        },
      };
    }),
  );

  function pathLength(graph, from, to) {
    const q = [[from, 0]];
    const seen = new Set([from]);
    while (q.length) {
      const [cur, d] = q.shift();
      if (cur === to) return d;
      for (const c of graph.children.get(cur) || []) {
        if (!seen.has(c.key)) {
          seen.add(c.key);
          q.push([c.key, d + 1]);
        }
      }
    }
    return 0;
  }

  /* ---------------------------------------------------------------- */
  /* SLOs                                                              */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/slos',
    wrap(() => {
      const today = todayUTC();
      const graph = assetGraph(db);
      return db.prepare('SELECT * FROM slo_defs ORDER BY id').all().map((s) => summarizeSlo(db, s, graph, today));
    }),
  );

  app.get(
    '/api/slos/:id',
    wrap((req) => {
      const slo = db.prepare('SELECT * FROM slo_defs WHERE id = ?').get(req.params.id);
      if (!slo) throw new Error('unknown slo');
      const today = todayUTC();
      const graph = assetGraph(db);
      const rules = rulesForSlo(db, slo.id);
      const evals = db
        .prepare('SELECT * FROM evaluations WHERE slo_id = ? ORDER BY day')
        .all(slo.id)
        .map((e) => ({
          ...e,
          evidence: j(e.evidence, {}),
          dims: j(e.dims, {}),
        }));
      const alerts = db
        .prepare('SELECT * FROM alerts WHERE slo_id = ? ORDER BY opened_at DESC')
        .all(slo.id)
        .map((a) => alertView(db, a));
      const exemptions = db
        .prepare(`SELECT * FROM exemptions WHERE (scope_type = 'slo' AND scope_id = ?) OR (scope_type = 'asset' AND scope_id = ?) ORDER BY starts_on DESC`)
        .all(slo.id, slo.asset_key);
      const maintenance = db
        .prepare(`SELECT * FROM maintenance_windows WHERE scope_slo = ? OR scope_asset = ? ORDER BY starts_on DESC`)
        .all(slo.id, slo.asset_key);
      const revisions = db
        .prepare('SELECT * FROM metric_revisions WHERE asset_key = ? ORDER BY created_at DESC LIMIT 10')
        .all(slo.asset_key);
      const assetSeries = db
        .prepare('SELECT day, metric, value FROM metric_points WHERE asset_key = ? ORDER BY day')
        .all(slo.asset_key);
      const summary = summarizeSlo(db, slo, graph, today);
      return {
        slo,
        summary,
        rules,
        evaluations: evals,
        alerts,
        exemptions,
        maintenance,
        revisions,
        asset_series: assetSeries,
        upstream: ancestorsOf(graph, slo.asset_key).map((k) => db.prepare('SELECT * FROM assets WHERE key = ?').get(k)),
        downstream: descendantsOf(graph, slo.asset_key).map((k) => db.prepare('SELECT * FROM assets WHERE key = ?').get(k)),
        today,
      };
    }),
  );

  app.post(
    '/api/slos/:id/rules',
    wrap((req, res) => {
      const slo = db.prepare('SELECT * FROM slo_defs WHERE id = ?').get(req.params.id);
      if (!slo) throw new Error('unknown slo');
      const body = req.body || {};
      const rules = rulesForSlo(db, slo.id);
      const current = rules[rules.length - 1];
      const effective_from = body.effective_from || todayUTC();
      if (effective_from < current.effective_from) {
        throw new Error('a new rule version cannot be effective before the current version');
      }
      const target = Number(body.target ?? current.target);
      if (!(target > 0 && target <= 1)) throw new Error('target must be in (0, 1]');
      const warn = Number(body.warn_margin ?? current.warn_margin);
      if (!(warn >= 0)) throw new Error('warn_margin must be >= 0');
      const windowDays = Number(body.window_days ?? current.window_days);
      if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error('window_days must be a positive integer');
      const weights = normalizeWeights(body.weights ?? current.weights);
      const thresholds = { ...current.thresholds, ...(body.thresholds || {}) };
      const esc = Number(body.escalation_hours ?? current.escalation_hours);
      const rec = Number(body.recovery_evals ?? current.recovery_evals);
      const authored_by = body.authored_by || actorOf(req);
      const now = new Date().toISOString();
      const version = current.version + 1;
      const info = db
        .prepare(
          `INSERT INTO slo_rule_versions (slo_id, version, effective_from, target, warn_margin, window_days, weights,
             thresholds, escalation_hours, recovery_evals, authored_by, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          slo.id,
          version,
          effective_from,
          target,
          warn,
          windowDays,
          JSON.stringify(weights),
          JSON.stringify(thresholds),
          esc,
          rec,
          authored_by,
          body.note || null,
          now,
        );
      audit(db, {
        actor: authored_by,
        action: 'rule.version.create',
        entityType: 'slo',
        entityId: slo.id,
        detail: { version, effective_from, target, weights },
        at: now,
      });
      // Backfill evaluations from the new effective date forward.
      evaluateSlo(db, slo.id, { from: effective_from, computedAt: now });
      reconcileSlo(db, slo.id, { actor: authored_by, at: now, autoEscalate: false });
      res.status(201).json({ id: Number(info.lastInsertRowid), version });
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Exemptions & maintenance                                          */
  /* ---------------------------------------------------------------- */

  app.get('/api/exemptions', wrap(() => db.prepare('SELECT * FROM exemptions ORDER BY starts_on DESC').all()));

  app.post(
    '/api/exemptions',
    wrap((req, res) => {
      const b = req.body || {};
      if (!['slo', 'asset'].includes(b.scope_type)) throw new Error('scope_type must be slo or asset');
      if (!b.scope_id) throw new Error('scope_id is required');
      if (!b.starts_on || !b.ends_on) throw new Error('starts_on and ends_on are required');
      if (b.ends_on < b.starts_on) throw new Error('ends_on must be on or after starts_on');
      if (!b.reason) throw new Error('a reason is required for an exemption');
      if (b.scope_type === 'slo' && !db.prepare('SELECT 1 FROM slo_defs WHERE id = ?').get(b.scope_id)) {
        throw new Error('unknown slo');
      }
      if (b.scope_type === 'asset' && !db.prepare('SELECT 1 FROM assets WHERE key = ?').get(b.scope_id)) {
        throw new Error('unknown asset');
      }
      if (b.rule_version_id) {
        const rv = db.prepare('SELECT * FROM slo_rule_versions WHERE id = ?').get(Number(b.rule_version_id));
        if (!rv) throw new Error('unknown rule version');
      }
      const now = new Date().toISOString();
      const actor = b.author || actorOf(req);
      const info = db
        .prepare(
          `INSERT INTO exemptions (scope_type, scope_id, starts_on, ends_on, reason, author, created_at, status, rule_version_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(b.scope_type, b.scope_id, b.starts_on, b.ends_on, b.reason, actor, now, b.rule_version_id ? Number(b.rule_version_id) : null);
      audit(db, {
        actor,
        action: 'exemption.create',
        entityType: 'exemption',
        entityId: Number(info.lastInsertRowid),
        detail: b,
        at: now,
      });
      reevaluateScope(db, { scope_type: b.scope_type, scope_id: b.scope_id }, b.starts_on, b.ends_on, actor, now);
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    }),
  );

  app.post(
    '/api/exemptions/:id/revoke',
    wrap((req) => {
      const ex = db.prepare('SELECT * FROM exemptions WHERE id = ?').get(Number(req.params.id));
      if (!ex) throw new Error('exemption not found');
      if (ex.status === 'revoked') throw new Error('exemption is already revoked');
      const now = new Date().toISOString();
      const actor = req.body?.actor || actorOf(req);
      db.prepare(`UPDATE exemptions SET status = 'revoked', revoked_at = ? WHERE id = ?`).run(now, ex.id);
      audit(db, {
        actor,
        action: 'exemption.revoke',
        entityType: 'exemption',
        entityId: ex.id,
        detail: { reason: req.body?.reason || null },
        at: now,
      });
      reevaluateScope(db, { scope_type: ex.scope_type, scope_id: ex.scope_id }, ex.starts_on, ex.ends_on, actor, now);
      return { ok: true };
    }),
  );

  app.get('/api/maintenance', wrap(() =>
    db.prepare('SELECT * FROM maintenance_windows ORDER BY starts_on DESC').all(),
  ));

  app.post(
    '/api/maintenance',
    wrap((req, res) => {
      const b = req.body || {};
      if (!b.name) throw new Error('name is required');
      if (!b.starts_on || !b.ends_on) throw new Error('starts_on and ends_on are required');
      if (b.ends_on < b.starts_on) throw new Error('ends_on must be on or after starts_on');
      if (!b.scope_asset && !b.scope_slo) throw new Error('a scope is required');
      if (!b.reason) throw new Error('a reason is required for a maintenance window');
      const now = new Date().toISOString();
      const actor = b.author || actorOf(req);
      const info = db
        .prepare(
          `INSERT INTO maintenance_windows (name, scope_asset, scope_slo, starts_on, ends_on, reason, author, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
        )
        .run(b.name, b.scope_asset || null, b.scope_slo || null, b.starts_on, b.ends_on, b.reason, actor, now);
      audit(db, {
        actor,
        action: 'maintenance.create',
        entityType: 'maintenance',
        entityId: Number(info.lastInsertRowid),
        detail: b,
        at: now,
      });
      reevaluateScope(
        db,
        b.scope_slo ? { scope_type: 'slo', scope_id: b.scope_slo } : { scope_type: 'asset', scope_id: b.scope_asset },
        b.starts_on,
        b.ends_on,
        actor,
        now,
      );
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    }),
  );

  app.post(
    '/api/maintenance/:id/status',
    wrap((req) => {
      const w = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(Number(req.params.id));
      if (!w) throw new Error('maintenance window not found');
      const next = req.body?.status;
      if (!['scheduled', 'active', 'completed', 'cancelled'].includes(next)) throw new Error('invalid status');
      const now = new Date().toISOString();
      const actor = req.body?.actor || actorOf(req);
      db.prepare('UPDATE maintenance_windows SET status = ? WHERE id = ?').run(next, w.id);
      audit(db, { actor, action: 'maintenance.status', entityType: 'maintenance', entityId: w.id, detail: { next }, at: now });
      reevaluateScope(
        db,
        w.scope_slo ? { scope_type: 'slo', scope_id: w.scope_slo } : { scope_type: 'asset', scope_id: w.scope_asset },
        w.starts_on,
        w.ends_on,
        actor,
        now,
      );
      return { ok: true };
    }),
  );

  function reevaluateScope(db, scope, from, to, actor, now) {
    const slos =
      scope.scope_type === 'slo'
        ? db.prepare('SELECT * FROM slo_defs WHERE id = ?').all(scope.scope_id)
        : db.prepare('SELECT * FROM slo_defs WHERE asset_key = ?').all(scope.scope_id);
    for (const s of slos) {
      evaluateSlo(db, s.id, { from, to, computedAt: now });
      reconcileSlo(db, s.id, { actor, at: now, autoEscalate: false });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Evaluations                                                       */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/evaluations',
    wrap((req) => {
      const { slo, from, to } = req.query;
      const rows = db
        .prepare(
          `SELECT * FROM evaluations WHERE (? IS NULL OR slo_id = ?) AND (? IS NULL OR day >= ?) AND (? IS NULL OR day <= ?)
           ORDER BY day, slo_id`,
        )
        .all(slo || null, slo || null, from || null, from || null, to || null, to || null);
      return rows.map((e) => ({ ...e, evidence: j(e.evidence, {}), dims: j(e.dims, {}) }));
    }),
  );

  app.post(
    '/api/evaluations/run',
    wrap((req) => {
      const now = new Date().toISOString();
      const actor = actorOf(req);
      const sloId = req.body?.slo_id;
      var result;
      if (sloId) {
        result = evaluateSlo(db, sloId, { computedAt: now }).evals.length;
      } else {
        result = evaluateAllSlo(db, { computedAt: now }).reduce((n, r) => n + r.evals.length, 0);
      }
      const actions = sloId
        ? reconcileSlo(db, sloId, { actor, at: now, autoEscalate: true })
        : reconcileAll(db, { actor, at: now, autoEscalate: true });
      audit(db, { actor, action: 'evaluations.run', entityType: 'workspace', entityId: sloId || 'all', detail: { count: result, actions: actions.length }, at: now });
      return { evaluated: result, actions };
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Alerts                                                            */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/alerts',
    wrap((req) => {
      const state = req.query.state;
      const slo = req.query.slo;
      const rows = db
        .prepare(
          `SELECT * FROM alerts
           WHERE (? IS NULL OR state = ?) AND (? IS NULL OR slo_id = ?)
           ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'escalated' THEN 1 WHEN 'acknowledged' THEN 2 WHEN 'recovered' THEN 3 WHEN 'merged' THEN 4 ELSE 5 END, opened_at DESC`,
        )
        .all(state || null, state || null, slo || null, slo || null);
      return rows.map((a) => alertView(db, a));
    }),
  );

  app.get(
    '/api/alerts/:id',
    wrap((req) => {
      const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(req.params.id));
      if (!a) throw new Error('alert not found');
      return alertView(db, a);
    }),
  );

  const alertAction = (fn) =>
    wrap((req) => {
      const id = Number(req.params.id);
      const actor = req.body?.actor || actorOf(req);
      const now = new Date().toISOString();
      const result = fn({ id, body: req.body || {}, actor, now });
      return alertView(db, result);
    });

  app.post('/api/alerts/:id/ack', alertAction(({ id, body, actor, now }) => ackAlert(db, id, { actor, note: body.note, at: now })));
  app.post('/api/alerts/:id/escalate', alertAction(({ id, body, actor, now }) => escalateAlert(db, id, { actor, reason: body.reason, at: now })));
  app.post('/api/alerts/:id/recover', alertAction(({ id, body, actor, now }) => recoverAlert(db, id, { actor, note: body.note, at: now })));
  app.post('/api/alerts/:id/close', alertAction(({ id, body, actor, now }) => closeAlert(db, id, { actor, note: body.note, at: now })));

  app.post(
    '/api/alerts/merge',
    wrap((req) => {
      const b = req.body || {};
      const actor = b.actor || actorOf(req);
      const now = new Date().toISOString();
      const res = mergeAlerts(db, { groupId: Number(b.group_id), memberIds: (b.member_ids || []).map(Number), actor, at: now });
      return { group: alertView(db, res.group), members: res.members.map((m) => alertView(db, m)) };
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Metric revisions                                                  */
  /* ---------------------------------------------------------------- */

  app.get('/api/revisions', wrap(() => revisionList(db)));

  app.get(
    '/api/revisions/:id',
    wrap((req) => {
      const d = revisionDetail(db, Number(req.params.id));
      if (!d) throw new Error('revision not found');
      return d;
    }),
  );

  app.post('/api/revisions/preview', wrap((req) => previewRevision(db, {
    assetKey: req.body?.asset_key,
    metric: req.body?.metric,
    from: req.body?.from,
    to: req.body?.to,
    mode: req.body?.mode,
    params: req.body?.params,
    scenario: req.body?.scenario,
  })));

  app.post(
    '/api/revisions',
    wrap((req, res) => {
      const b = req.body || {};
      const result = applyRevision(db, {
        assetKey: b.asset_key,
        metric: b.metric,
        from: b.from,
        to: b.to,
        mode: b.mode,
        params: b.params,
        reason: b.reason,
        author: b.author || actorOf(req),
      });
      res.status(201).json(result);
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Scenarios                                                         */
  /* ---------------------------------------------------------------- */

  app.get('/api/scenarios', wrap(() => scenarioRuns(db)));

  app.post(
    '/api/scenarios/upstream-gap',
    wrap((req) => {
      const b = req.body || {};
      return runUpstreamGap(db, {
        assetKey: b.asset_key,
        from: b.from || daysAgo(2),
        to: b.to || todayUTC(),
        actor: b.actor || actorOf(req),
      });
    }),
  );

  app.post(
    '/api/scenarios/backfill',
    wrap((req) => {
      const b = req.body || {};
      return runBackfill(db, {
        assetKey: b.asset_key,
        from: b.from || daysAgo(2),
        to: b.to || todayUTC(),
        actor: b.actor || actorOf(req),
      });
    }),
  );

  app.post(
    '/api/scenarios/restore',
    wrap((req) => {
      const b = req.body || {};
      return restoreBaseline(db, {
        assetKey: b.asset_key,
        from: b.from || daysAgo(2),
        to: b.to || todayUTC(),
        actor: b.actor || actorOf(req),
      });
    }),
  );

  app.post(
    '/api/scenarios/reset',
    wrap((req) => {
      seed(db, { reset: true });
      return { ok: true, today: todayUTC() };
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Static build                                                      */
  /* ---------------------------------------------------------------- */

  const dist = path.join(process.cwd(), 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

export function createDb(file) {
  const db = openDb(file);
  if (!isSeeded(db)) seed(db);
  return db;
}


