import { addDays, dayDiff, dayList, isoDay, nowIso } from './time.js';
import { addEvent, audit, j, tx } from './db.js';

export const METRICS = ['quality', 'latency', 'completeness'];

export const DEFAULT_WEIGHTS = { quality: 0.4, latency: 0.25, completeness: 0.35 };

export function normalizeWeights(weights) {
  const out = {};
  let total = 0;
  for (const m of METRICS) {
    const v = Number(weights?.[m] ?? 0);
    if (!Number.isFinite(v) || v < 0) throw new Error(`invalid weight for ${m}`);
    out[m] = v;
    total += v;
  }
  if (total <= 0) throw new Error('weights must have a positive total');
  for (const m of METRICS) out[m] = Number((out[m] / total).toFixed(4));
  return out;
}

export function round(v, places = 4) {
  if (v == null || !Number.isFinite(v)) return v;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/* ------------------------------------------------------------------ */
/* Lineage                                                             */
/* ------------------------------------------------------------------ */

export function assetGraph(db) {
  const assets = db.prepare('SELECT * FROM assets ORDER BY position').all();
  const edges = db.prepare('SELECT * FROM asset_edges').all();
  const parents = new Map();
  const children = new Map();
  for (const a of assets) {
    parents.set(a.key, []);
    children.set(a.key, []);
  }
  for (const e of edges) {
    if (parents.has(e.dst)) parents.get(e.dst).push({ key: e.src, lag_minutes: e.lag_minutes });
    if (children.has(e.src)) children.get(e.src).push({ key: e.dst, lag_minutes: e.lag_minutes });
  }
  return { assets, edges, parents, children };
}

export function ancestorsOf(graph, key) {
  const seen = new Set();
  const stack = [...(graph.parents.get(key) || []).map((p) => p.key)];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of graph.parents.get(cur) || []) stack.push(p.key);
  }
  return [...seen];
}

export function descendantsOf(graph, key) {
  const seen = new Set();
  const stack = [...(graph.children.get(key) || []).map((c) => c.key)];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const c of graph.children.get(cur) || []) stack.push(c.key);
  }
  return [...seen];
}

/* ------------------------------------------------------------------ */
/* Metric reads with lineage propagation                               */
/* ------------------------------------------------------------------ */

function pointAll(db, assetKey, metric, day) {
  const row = db
    .prepare('SELECT value, revision_id FROM metric_points WHERE asset_key = ? AND metric = ? AND day = ?')
    .get(assetKey, metric, day);
  return row ? { value: row.value == null ? null : Number(row.value), revisionId: row.revision_id ?? null } : { value: null, revisionId: null, absent: true };
}

/**
 * Row-presence propagates downstream: if any ancestor could not produce rows,
 * a mart cannot have a completeness or latency reading for that day. Quality is
 * only measurable when rows exist at all.
 */
export function effectiveMetric(db, graph, assetKey, metric, day, cache = new Map()) {
  const ck = `${assetKey}|${metric}|${day}`;
  if (cache.has(ck)) return cache.get(ck);

  const direct = pointAll(db, assetKey, metric, day);
  const parentKeys = (graph.parents.get(assetKey) || []).map((p) => p.key);

  let missingUpstream = [];
  if (metric !== 'quality' || direct.value == null) {
    for (const pk of parentKeys) {
      const upC = effectiveMetric(db, graph, pk, 'completeness', day, cache);
      if (upC.value == null) missingUpstream.push(pk);
    }
  }

  let result;
  if (direct.value == null) {
    result = { value: null, revisionId: direct.revisionId, source: 'no-data', missingUpstream };
  } else if (metric === 'quality') {
    result = { value: direct.value, revisionId: direct.revisionId, source: 'measured', missingUpstream };
  } else if (metric === 'latency') {
    const staleParents = [];
    for (const pk of parentKeys) {
      for (const m of ['completeness', 'latency']) {
        const up = effectiveMetric(db, graph, pk, m, day, cache);
        if (up.value == null) staleParents.push(pk);
      }
    }
    if (staleParents.length) {
      result = { value: null, revisionId: direct.revisionId, source: 'upstream-missing', missingUpstream: [...new Set(staleParents)] };
    } else {
      result = { value: direct.value, revisionId: direct.revisionId, source: 'measured', missingUpstream: [] };
    }
  } else {
    if (missingUpstream.length) {
      result = { value: null, revisionId: direct.revisionId, source: 'upstream-missing', missingUpstream };
    } else {
      result = { value: direct.value, revisionId: direct.revisionId, source: 'measured', missingUpstream: [] };
    }
  }
  cache.set(ck, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Rule selection                                                      */
/* ------------------------------------------------------------------ */

export function parseRule(row) {
  if (!row) return null;
  return {
    ...row,
    target: Number(row.target),
    warn_margin: Number(row.warn_margin),
    weights: j(row.weights, DEFAULT_WEIGHTS),
    thresholds: j(row.thresholds, {}),
    escalation_hours: Number(row.escalation_hours),
    recovery_evals: Number(row.recovery_evals),
    window_days: Number(row.window_days),
  };
}

export function ruleForDay(rules, day) {
  const sorted = [...rules].sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.version - b.version);
  let chosen = null;
  for (const r of sorted) if (r.effective_from <= day) chosen = r;
  return chosen || sorted[0] || null;
}

export function rulesForSlo(db, sloId) {
  return db
    .prepare('SELECT * FROM slo_rule_versions WHERE slo_id = ? ORDER BY version')
    .all(sloId)
    .map(parseRule);
}

/* ------------------------------------------------------------------ */
/* Suppression: exemptions and maintenance windows                     */
/* ------------------------------------------------------------------ */

export function suppressionFor(db, { sloId, assetKey, rules, day }) {
  const ruleIds = new Set((rules || []).map((r) => r.id));
  const exemptions = db
    .prepare(
      `SELECT * FROM exemptions
       WHERE status = 'active' AND starts_on <= ? AND ends_on >= ?
         AND ((scope_type = 'slo' AND scope_id = ?) OR (scope_type = 'asset' AND scope_id = ?))
       ORDER BY id`,
    )
    .all(day, day, sloId, assetKey);
  const activeExemptions = exemptions.filter(
    (e) => !e.rule_version_id || ruleIds.has(Number(e.rule_version_id)),
  );
  const maint = db
    .prepare(
      `SELECT * FROM maintenance_windows
       WHERE status IN ('scheduled','active','completed') AND starts_on <= ? AND ends_on >= ?
         AND ((scope_slo IS NOT NULL AND scope_slo = ?) OR (scope_asset IS NOT NULL AND scope_asset = ?))
       ORDER BY id`,
    )
    .all(day, day, sloId, assetKey);
  if (activeExemptions.length) {
    return {
      kind: 'exemption',
      label: `Exemption · ${activeExemptions[0].reason}`,
      ids: activeExemptions.map((e) => e.id),
      details: activeExemptions,
    };
  }
  if (maint.length) {
    return {
      kind: 'maintenance',
      label: `Maintenance · ${maint[0].name}`,
      ids: maint.map((m) => m.id),
      details: maint,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Single-day evaluation                                               */
/* ------------------------------------------------------------------ */

export function computeDay(db, graph, slo, rule, day, cache = new Map()) {
  const dims = {};
  let coverage = 0;
  let weighted = 0;
  let revisionId = null;
  const missing = [];
  const upstreamMissing = new Set();

  for (const m of METRICS) {
    const w = rule.weights[m] ?? 0;
    if (w <= 0) continue;
    const eff = effectiveMetric(db, graph, slo.asset_key, m, day, cache);
    const present = eff.value != null && Number.isFinite(eff.value);
    dims[m] = {
      value: present ? round(eff.value, 4) : null,
      weight: w,
      source: present ? eff.source : eff.source === 'no-data' && eff.missingUpstream.length ? 'upstream-missing' : eff.source,
      revision_id: eff.revisionId,
    };
    if (eff.missingUpstream.length) eff.missingUpstream.forEach((a) => upstreamMissing.add(a));
    if (eff.source === 'no-data' && (eff.missingUpstream || []).length) {
      dims[m].source = 'upstream-missing';
    }
    if (present) {
      coverage += w;
      weighted += w * eff.value;
      if (eff.revisionId && eff.revisionId > (revisionId || 0)) revisionId = eff.revisionId;
    } else {
      missing.push(m);
    }
  }

  const composite = coverage > 0 ? round(weighted / coverage, 4) : null;
  const origins = coverage < 1 ? gapOrigins(db, graph, slo.asset_key, day, cache) : [];
  return {
    dims,
    composite,
    coverage: round(coverage, 4),
    missing,
    upstreamMissing: [...new Set([...upstreamMissing, ...origins])],
    gapOrigins: origins,
    revisionId,
  };
}

export function rollingFor(days, windowDays, rule, graph, db, slo, day) {
  const start = addDays(day, -(windowDays - 1));
  const slice = days.filter((d) => d.day >= start && d.day <= day && d.composite != null && d.coverage >= 0.6);
  const expected = Math.min(windowDays, Math.max(1, dayDiff(days[0]?.day || day, day) + 1));
  if (!slice.length) return { rolling: null, sampled: 0, expected };
  const rolling = slice.reduce((s, d) => s + d.composite, 0) / slice.length;
  return { rolling: round(rolling, 4), sampled: slice.length, expected };
}

/* ------------------------------------------------------------------ */
/* Evaluate one SLO across a day range, writing eval rows              */
/* ------------------------------------------------------------------ */

export function evaluateSlo(db, sloId, { from, to, computedAt, graph, force = false } = {}) {
  const slo = db.prepare('SELECT * FROM slo_defs WHERE id = ?').get(sloId);
  if (!slo) throw new Error(`unknown slo ${sloId}`);
  const g = graph || assetGraph(db);
  const rules = rulesForSlo(db, sloId);
  const allDays = db
    .prepare('SELECT DISTINCT day FROM metric_points WHERE asset_key = ? ORDER BY day')
    .all(slo.asset_key)
    .map((r) => r.day);
  if (!allDays.length || !rules.length) return { slo, evals: [] };
  const start = from || allDays[0];
  const end = to || allDays[allDays.length - 1];
  const firstEffective = rules[0].effective_from;
  const maxWindow = Math.max(...rules.map((r) => r.window_days), 1);
  // Rolling windows need history before `from`, otherwise a partial recompute
  // would produce different values than a full-history run.
  const scanStart = addDays(start, -(maxWindow - 1)) < allDays[0] ? allDays[0] : addDays(start, -(maxWindow - 1));
  const scanRange = dayList(scanStart, end);
  const cache = new Map();
  const days = [];
  const evals = [];
  const computedAtIso = computedAt || nowIso();

  for (const day of scanRange) {
    if (day < firstEffective) continue;
    const rule = ruleForDay(rules, day);
    if (!rule) continue;
    const computed = computeDay(db, g, slo, rule, day, cache);
    days.push({ day, composite: computed.composite, coverage: computed.coverage });
    if (day < start) continue;
    const roll = rollingFor(days, rule.window_days, rule, g, db, slo, day);
    const suppression = suppressionFor(db, { sloId, assetKey: slo.asset_key, rules: [rule], day });

    const minCoverage = Number(rule.thresholds.minCoverage ?? 0.6);
    let state;
    if (computed.coverage < minCoverage || roll.rolling == null) {
      state = 'nodata';
    } else if (roll.rolling < rule.target) {
      state = 'breached';
    } else if (roll.rolling < rule.target + rule.warn_margin) {
      state = 'warning';
    } else {
      state = 'healthy';
    }
    const effectiveState = suppression ? 'suppressed' : state;

    const evidence = {
      rule_version: rule.version,
      target: rule.target,
      warn_margin: rule.warn_margin,
      window_days: rule.window_days,
      rolling: roll.rolling,
      composite: computed.composite,
      coverage: computed.coverage,
      sampled_days: roll.sampled,
      expected_days: roll.expected,
      dims: computed.dims,
      missing_metrics: computed.missing,
      upstream_missing: computed.upstreamMissing,
      upstream_assets: ancestorsOf(g, slo.asset_key),
      suppression,
      min_coverage: minCoverage,
      evaluated_at: computedAtIso,
    };

    evals.push({
      slo_id: sloId,
      rule_version_id: rule.id,
      day,
      composite: computed.composite,
      rolling: roll.rolling,
      state,
      effective_state: effectiveState,
      suppression: suppression ? suppression.kind : null,
      dims: computed.dims,
      evidence,
      revision_id: computed.revisionId,
      computed_at: computedAtIso,
      rule,
      coverage: computed.coverage,
    });
  }

  if (evals.length) {
    const stmt = db.prepare(
      `INSERT INTO evaluations (slo_id, rule_version_id, day, composite, rolling, state, effective_state, suppression, dims, evidence, revision_id, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slo_id, day, rule_version_id) DO UPDATE SET
         composite = excluded.composite,
         rolling = excluded.rolling,
         state = excluded.state,
         effective_state = excluded.effective_state,
         suppression = excluded.suppression,
         dims = excluded.dims,
         evidence = excluded.evidence,
         revision_id = excluded.revision_id,
         computed_at = excluded.computed_at`,
    );
    for (const e of evals) {
      stmt.run(
        e.slo_id,
        e.rule_version_id,
        e.day,
        e.composite,
        e.rolling ?? null,
        e.state,
        e.effective_state,
        e.suppression,
        JSON.stringify(e.dims),
        JSON.stringify(e.evidence),
        e.revision_id,
        e.computed_at,
      );
    }
  }

  return { slo, evals };
}

export function evaluateAllSlo(db, opts = {}) {
  const slos = db.prepare('SELECT * FROM slo_defs ORDER BY id').all();
  const graph = assetGraph(db);
  const results = [];
  for (const s of slos) {
    results.push(evaluateSlo(db, s.id, { ...opts, graph }));
  }
  return results;
}

/**
 * Narrow a "missing upstream" set to the assets where the data actually first
 * disappeared: ancestors of the SLO that have no reading while all of their own
 * parents do. This is what an operator needs to page the right team.
 */
export function gapOrigins(db, graph, sloAsset, day, cache) {
  const chain = ancestorsOf(graph, sloAsset);
  const missing = new Set();
  for (const key of [...chain, sloAsset]) {
    const eff = effectiveMetric(db, graph, key, 'completeness', day, cache || new Map());
    if (eff.value == null) missing.add(key);
  }
  const origins = [];
  for (const key of missing) {
    const parents = (graph.parents.get(key) || []).map((p) => p.key);
    if (!parents.some((p) => missing.has(p))) origins.push(key);
  }
  return origins.sort((a, b) => chain.indexOf(a) - chain.indexOf(b));
}

/* ------------------------------------------------------------------ */
/* Side-effect-free day preview                                        */
/* ------------------------------------------------------------------ */

/**
 * Compute the state of an SLO for a single day without writing evaluations.
 * Used by impact analysis so a GET never mutates history.
 */
export function previewSloDay(db, slo, day, graph) {
  const g = graph || assetGraph(db);
  const rules = rulesForSlo(db, slo.id);
  if (!rules.length) return null;
  const rule = ruleForDay(rules, day);
  const cache = new Map();
  const windowDays = rule.window_days;
  const days = [];
  for (let d = addDays(day, -(windowDays - 1)); d <= day; d = addDays(d, 1)) {
    const dayRule = ruleForDay(rules, d);
    const c = computeDay(db, g, slo, dayRule, d, cache);
    days.push({ day: d, composite: c.composite, coverage: c.coverage });
  }
  const computed = computeDay(db, g, slo, rule, day, cache);
  const roll = rollingFor(days, windowDays, rule, g, db, slo, day);
  const suppression = suppressionFor(db, { sloId: slo.id, assetKey: slo.asset_key, rules: [rule], day });
  const minCoverage = Number(rule.thresholds.minCoverage ?? 0.6);
  let state;
  if (computed.coverage < minCoverage || roll.rolling == null) state = 'nodata';
  else if (roll.rolling < rule.target) state = 'breached';
  else if (roll.rolling < rule.target + rule.warn_margin) state = 'warning';
  else state = 'healthy';
  return {
    rule,
    rolling: roll.rolling,
    composite: computed.composite,
    coverage: computed.coverage,
    state,
    effective_state: suppression ? 'suppressed' : state,
    suppression,
    missing_metrics: computed.missing,
    upstream_missing: computed.upstreamMissing,
  };
}

/* ------------------------------------------------------------------ */
/* Alert lifecycle                                                     */
/* ------------------------------------------------------------------ */

export function alertKey(sloId, ruleVersionId, firstSeenDay) {
  return `${sloId}:v${ruleVersionId}:${firstSeenDay}`;
}

export function addAlertEvent(db, alertId, kind, actor, detail, at) {
  addEvent(db, alertId, kind, actor, detail, at);
}

function alertFor(db, key) {
  return db.prepare('SELECT * FROM alerts WHERE alert_key = ?').get(key);
}

function openAlert(db, { key, slo, rule, day, lastDay, severity, summary, evidence, actor, at }) {
  const info = db
    .prepare(
      `INSERT INTO alerts (alert_key, slo_id, rule_version_id, severity, state, escalation_level,
         opened_at, first_seen_day, last_seen_day, summary, evidence)
       VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, ?)`,
    )
    .run(key, slo.id, rule.id, severity, at || nowIso(), day, lastDay || day, summary, JSON.stringify(evidence));
  const id = Number(info.lastInsertRowid);
  addEvent(db, id, 'opened', actor || 'evaluator', { severity, day, summary }, at);
  return id;
}

/**
 * Reconcile alerts against stored evaluations for a single SLO.
 * Closed alerts are historical record: they are never updated, reopened, or
 * mutated by later data. A breach after closure creates a fresh alert.
 */
export function reconcileSlo(db, sloId, { actor = 'scheduler', at, autoEscalate = true } = {}) {
  const slo = db.prepare('SELECT * FROM slo_defs WHERE id = ?').get(sloId);
  if (!slo) throw new Error(`unknown slo ${sloId}`);
  const now = at || nowIso();
  const rules = rulesForSlo(db, sloId);

  const evalsByRule = new Map();
  const rows = db.prepare('SELECT * FROM evaluations WHERE slo_id = ? ORDER BY day').all(sloId);
  for (const r of rows) {
    if (!evalsByRule.has(r.rule_version_id)) evalsByRule.set(r.rule_version_id, []);
    evalsByRule.get(r.rule_version_id).push(r);
  }
  const today = isoDay(now);
  const actions = [];
  const openedThisPass = new Set();

  for (const [ruleVersionId, list] of evalsByRule) {
    const rule = rules.find((r) => r.id === ruleVersionId) || parseRule(
      db.prepare('SELECT * FROM slo_rule_versions WHERE id = ?').get(ruleVersionId),
    );
    if (!rule) continue;
    if (!list.length) continue;

    // Group consecutive breached (unsuppressed) or nodata days into episodes.
    const episodes = [];
    let current = null;
    const isFault = (e) => (e.state === 'breached' || e.state === 'nodata') && e.effective_state !== 'suppressed';
    for (const e of list) {
      if (isFault(e)) {
        if (current && dayDiff(current.lastDay, e.day) === 1) {
          current.days.push(e);
          current.lastDay = e.day;
        } else {
          current = { days: [e], firstDay: e.day, lastDay: e.day };
          episodes.push(current);
        }
      } else if (current && e.day < today) {
        current = null;
      }
    }

    for (const ep of episodes) {
      const first = ep.days[0];
      const last = ep.days[ep.days.length - 1];
      const key = alertKey(sloId, rule.id, first.day);
      const existing = alertFor(db, key);
      const evidence = {
        days: ep.days.map((d) => ({ day: d.day, state: d.state, rolling: d.rolling, coverage: JSON.parse(d.evidence).coverage })),
        worst: round(Math.min(...ep.days.map((d) => d.rolling ?? 1)), 4),
        window_days: rule.window_days,
        target: rule.target,
        rule_version: rule.version,
        dims: JSON.parse(last.evidence).dims,
        upstream_missing: JSON.parse(last.evidence).upstream_missing || [],
      };

      if (!existing) {
        // Only open if the episode is still relevant (its last observed day is
        // near the data horizon) - do not resurrect long-past history.
        const horizon = addDays(today, -1);
        if (last.day < horizon) continue;
        const severity = first.state === 'nodata' || (last.rolling != null && last.rolling < rule.target - 0.02)
          ? 'critical'
          : 'warning';
        const summary = first.state === 'nodata'
          ? `Coverage gap on ${slo.asset_key} — insufficient data for SLO window`
          : `${slo.name} below ${(rule.target * 100).toFixed(2)}% target (${(last.rolling * 100).toFixed(2)}%)`;
        const id = openAlert(db, {
          key,
          slo,
          rule,
          day: first.day,
          lastDay: last.day,
          severity,
          summary,
          evidence,
          actor,
          at: now,
        });
        openedThisPass.add(id);
        actions.push({ alert_id: id, action: 'opened', key, severity });
      } else if (['open', 'acknowledged', 'escalated'].includes(existing.state)) {
        if (existing.last_seen_day !== last.day) {
          db.prepare(
            `UPDATE alerts SET last_seen_day = ?, evidence = ?, severity = ? WHERE id = ? AND state != 'closed'`,
          ).run(
            last.day,
            JSON.stringify(evidence),
            last.state === 'nodata' || (last.rolling != null && last.rolling < rule.target - 0.02) ? 'critical' : existing.severity,
            existing.id,
          );
          addEvent(db, existing.id, 'extended', actor, { day: last.day, rolling: last.rolling }, now);
          actions.push({ alert_id: existing.id, action: 'extended', key });
        }
      } else if (existing.state === 'recovered' && last.day >= addDays(today, -1)) {
        // The same episode regressed after recovery (e.g. a revised metric or a
        // failed replay). Re-open the incident rather than silently dropping it.
        db.prepare(
          `UPDATE alerts SET state = 'open', recovered_at = NULL, last_seen_day = ?, severity = ?, evidence = ?
           WHERE id = ? AND state = 'recovered'`,
        ).run(
          last.day,
          first.state === 'nodata' || (last.rolling != null && last.rolling < rule.target - 0.02) ? 'critical' : existing.severity,
          JSON.stringify(evidence),
          existing.id,
        );
        addEvent(db, existing.id, 'reopened', actor, { day: last.day, rolling: last.rolling, reason: 'fault_recurred' }, now);
        actions.push({ alert_id: existing.id, action: 'reopened', key });
      }
    }

    // Recovery: rolling back at/above target for `recovery_evals` consecutive
    // evaluated days after the episode ends. Suppressed days do not count.
    const latest = list[list.length - 1];
    const activeForRule = db
      .prepare(
        `SELECT * FROM alerts WHERE slo_id = ? AND rule_version_id = ? AND state IN ('open','acknowledged','escalated')`,
      )
      .all(sloId, rule.id);
    if (latest && latest.effective_state === 'suppressed') {
      // A rule-level or asset-level exemption / maintenance window covering the
      // live breach silences pages; the alert is closed out as "suppressed" so
      // the lifecycle stays honest without rewriting data.
      for (const a of activeForRule) {
        db.prepare(
          `UPDATE alerts SET state = 'recovered', recovered_at = ? WHERE id = ? AND state != 'closed'`,
        ).run(now, a.id);
        addEvent(db, a.id, 'suppressed', actor, { reason: 'exemption_or_maintenance', day: latest.day }, now);
        actions.push({ alert_id: a.id, action: 'suppressed', key: a.alert_key });
      }
      continue;
    }
    const openAlerts = db
      .prepare(
        `SELECT * FROM alerts WHERE slo_id = ? AND rule_version_id = ? AND state IN ('open','acknowledged','escalated')`,
      )
      .all(sloId, rule.id);
    const tail = list.slice(-Math.max(1, rule.recovery_evals));
    const healthyTail =
      tail.length >= rule.recovery_evals &&
      tail.every((e) => e.rolling != null && e.rolling >= rule.target && e.effective_state !== 'suppressed');
    if (healthyTail) {
      for (const a of openAlerts) {
        // An alert opened in this same reconciliation pass is not owed an
        // immediate recovery — it must be observed healthy afterwards.
        if (openedThisPass.has(a.id)) continue;
        db.prepare(
          `UPDATE alerts SET state = 'recovered', recovered_at = ? WHERE id = ? AND state != 'closed'`,
        ).run(now, a.id);
        addEvent(db, a.id, 'recovered', actor, { rolling: latest.rolling, days: rule.recovery_evals }, now);
        actions.push({ alert_id: a.id, action: 'recovered', key: a.alert_key });
      }
    }

    // Auto-escalation for unacknowledged alerts past their escalation clock.
    if (autoEscalate) {
      const stale = db
        .prepare(
          `SELECT * FROM alerts WHERE slo_id = ? AND rule_version_id = ? AND state IN ('open','acknowledged')`,
        )
        .all(sloId, rule.id);
      for (const a of stale) {
        const ageHours = (new Date(now).getTime() - new Date(a.opened_at).getTime()) / 3600000;
        if (ageHours >= rule.escalation_hours && a.state === 'open') {
          db.prepare(
            `UPDATE alerts SET state = 'escalated', escalation_level = escalation_level + 1, escalated_at = ? WHERE id = ? AND state != 'closed'`,
          ).run(now, a.id);
          addEvent(db, a.id, 'escalated', 'scheduler', { reason: 'ack_sla_exceeded', age_hours: round(ageHours, 2) }, now);
          actions.push({ alert_id: a.id, action: 'escalated', key: a.alert_key });
        }
      }
    }
  }

  return actions;
}

export function reconcileAll(db, opts = {}) {
  const slos = db.prepare('SELECT id FROM slo_defs ORDER BY id').all();
  const out = [];
  for (const s of slos) out.push(...reconcileSlo(db, s.id, opts));
  return out;
}

/* ------------------------------------------------------------------ */
/* Alert transitions (human)                                           */
/* ------------------------------------------------------------------ */

const ACTIVE_STATES = ['open', 'acknowledged', 'escalated'];

export function ackAlert(db, id, { actor, note, at }) {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  if (!a) throw new Error('alert not found');
  if (!ACTIVE_STATES.includes(a.state)) throw new Error(`cannot acknowledge an alert in state ${a.state}`);
  db.prepare(`UPDATE alerts SET state = 'acknowledged', acked_by = ?, acked_at = ?, ack_note = ? WHERE id = ?`).run(
    actor,
    at || nowIso(),
    note || null,
    id,
  );
  addEvent(db, id, 'acknowledged', actor, { note: note || null }, at);
  audit(db, { actor, action: 'alert.ack', entityType: 'alert', entityId: id, detail: { note }, at });
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

export function escalateAlert(db, id, { actor, reason, at }) {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  if (!a) throw new Error('alert not found');
  if (!ACTIVE_STATES.includes(a.state)) throw new Error(`cannot escalate an alert in state ${a.state}`);
  db.prepare(
    `UPDATE alerts SET state = 'escalated', escalation_level = escalation_level + 1, escalated_at = ? WHERE id = ?`,
  ).run(at || nowIso(), id);
  addEvent(db, id, 'escalated', actor, { reason: reason || 'manual' }, at);
  audit(db, { actor, action: 'alert.escalate', entityType: 'alert', entityId: id, detail: { reason }, at });
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

export function recoverAlert(db, id, { actor, note, at }) {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  if (!a) throw new Error('alert not found');
  if (!ACTIVE_STATES.includes(a.state)) throw new Error(`cannot recover an alert in state ${a.state}`);
  db.prepare(`UPDATE alerts SET state = 'recovered', recovered_at = ? WHERE id = ?`).run(at || nowIso(), id);
  addEvent(db, id, 'recovered', actor, { reason: 'manual', note: note || null }, at);
  audit(db, { actor, action: 'alert.recover', entityType: 'alert', entityId: id, detail: { note }, at });
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

export function closeAlert(db, id, { actor, note, at }) {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  if (!a) throw new Error('alert not found');
  if (a.state !== 'recovered') {
    throw new Error('a human can only close a recovered alert — recover it first');
  }
  db.prepare(`UPDATE alerts SET state = 'closed', closed_at = ? WHERE id = ?`).run(at || nowIso(), id);
  addEvent(db, id, 'closed', actor, { note: note || null }, at);
  audit(db, { actor, action: 'alert.close', entityType: 'alert', entityId: id, detail: { note }, at });
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

export function mergeAlerts(db, { groupId, memberIds, actor, at }) {
  const group = db.prepare('SELECT * FROM alerts WHERE id = ?').get(groupId);
  if (!group) throw new Error('merge group not found');
  if (group.state === 'closed') throw new Error('cannot merge into a closed alert');
  if (group.state === 'merged') throw new Error('a merged alert cannot absorb further members');
  const members = [];
  for (const mid of memberIds) {
    if (Number(mid) === Number(groupId)) continue;
    const m = db.prepare('SELECT * FROM alerts WHERE id = ?').get(mid);
    if (!m) throw new Error(`alert ${mid} not found`);
    if (m.state === 'closed') throw new Error(`alert ${mid} is closed and immutable`);
    if (m.state === 'merged') throw new Error(`alert ${mid} is already merged`);
    if (!ACTIVE_STATES.includes(m.state) && m.state !== 'recovered') {
      throw new Error(`alert ${mid} cannot be merged from state ${m.state}`);
    }
    members.push(m);
  }
  if (!members.length) throw new Error('no merge members supplied — pick at least one other alert');
  if (group.state === 'recovered') throw new Error('a recovered alert cannot be the merge group — recover only merges active incidents');
  for (const m of members) {
    db.prepare(`UPDATE alerts SET state = 'merged', merged_into = ? WHERE id = ?`).run(groupId, m.id);
    addEvent(db, m.id, 'merged', actor, { group_id: groupId }, at);
    addEvent(db, groupId, 'merge_member', actor, { member_id: m.id, summary: m.summary }, at);
  }
  audit(db, { actor, action: 'alert.merge', entityType: 'alert', entityId: groupId, detail: { members: members.map((m) => m.id) }, at });
  return {
    group: db.prepare('SELECT * FROM alerts WHERE id = ?').get(groupId),
    members: members.map((m) => db.prepare('SELECT * FROM alerts WHERE id = ?').get(m.id)),
  };
}

/* ------------------------------------------------------------------ */
/* Alert view helper                                                   */
/* ------------------------------------------------------------------ */

export function alertView(db, row) {
  const events = db
    .prepare('SELECT * FROM alert_events WHERE alert_id = ? ORDER BY at, id')
    .all(row.id)
    .map((e) => ({ ...e, detail: j(e.detail) }));
  const members = row.state === 'merged'
    ? []
    : db
        .prepare('SELECT id, summary, state, first_seen_day FROM alerts WHERE merged_into = ?')
        .all(row.id);
  return {
    ...row,
    evidence: j(row.evidence, {}),
    events,
    merged_members: members,
    age_hours: round((Date.now() - new Date(row.opened_at).getTime()) / 3600000, 1),
  };
}
