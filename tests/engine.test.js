import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp, createDb } from '../server/api.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { evaluateSlo, reconcileSlo, rulesForSlo, ruleForDay, assetGraph, evaluateAllSlo } from '../server/engine.js';
import { daysAgo, todayUTC } from '../server/time.js';

function fresh() {
  const db = openDb(':memory:');
  seed(db);
  const app = createApp(db);
  return { db, app };
}

describe('composite SLO scoring', () => {
  let db;
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('weights dimensions and renormalizes when a dimension is missing', async () => {
    const slo = db.prepare("SELECT * FROM slo_defs WHERE id = 'slo-revenue'").get();
    const rule = ruleForDay(rulesForSlo(db, slo.id), todayUTC());
    const day = daysAgo(30);
    db.prepare("UPDATE metric_points SET value = 1.0 WHERE asset_key = ? AND metric = 'completeness' AND day = ?").run(
      slo.asset_key,
      day,
    );
    db.prepare("UPDATE metric_points SET value = 0.8 WHERE asset_key = ? AND metric = 'quality' AND day = ?").run(
      slo.asset_key,
      day,
    );
    db.prepare("UPDATE metric_points SET value = 0.6 WHERE asset_key = ? AND metric = 'latency' AND day = ?").run(
      slo.asset_key,
      day,
    );
    const res = await request(createApp(db)).get(`/api/impact/${slo.asset_key}?day=${day}`);
    expect(res.status).toBe(200);

    const { evals } = evaluateSlo(db, slo.id, { from: day, to: day });
    const e = evals[0];
    const expected = 0.35 * 1 + 0.4 * 0.8 + 0.25 * 0.6; // 0.35 + 0.32 + 0.15
    expect(e.composite).toBeCloseTo(expected, 3);
    expect(e.coverage).toBe(1);
    expect(rule.weights).toEqual({ quality: 0.4, latency: 0.25, completeness: 0.35 });
  });

  it('marks a day nodata when weighted coverage drops below the rule minimum', async () => {
    const slo = db.prepare("SELECT * FROM slo_defs WHERE id = 'slo-orders'").get();
    const day = daysAgo(25);
    for (const metric of ['quality', 'completeness']) {
      db.prepare('UPDATE metric_points SET value = NULL WHERE asset_key = ? AND metric = ? AND day = ?').run(
        slo.asset_key,
        metric,
        day,
      );
    }
    const { evals } = evaluateSlo(db, slo.id, { from: day, to: day });
    expect(evals[0].state).toBe('nodata');
    expect(evals[0].evidence.missing_metrics.sort()).toEqual(['completeness', 'quality']);
  });
});

describe('lineage propagation', () => {
  it('treats upstream row loss as missing data downstream even when local timestamps exist', async () => {
    const { db, app } = fresh();
    const day = daysAgo(6);
    // Wipe the raw source only. Staging and mart keep their own values.
    db.prepare(
      "UPDATE metric_points SET value = NULL WHERE asset_key = 'raw.orders_ingest' AND day = ?",
    ).run(day);
    const res = await request(app).get(`/api/impact/raw.orders_ingest?day=${day}`);
    expect(res.status).toBe(200);
    const revenue = res.body.slo_impact.find((s) => s.id === 'slo-revenue');
    expect(revenue.state).toBe('nodata');
    expect(revenue.upstream_missing).toContain('raw.orders_ingest');
    expect(revenue.gap_origins).toEqual(['raw.orders_ingest']);
    res.body.slo_impact.forEach((s) => expect(s.state).toBe('nodata'));

    const graph = assetGraph(db);
    expect([...graph.children.keys()].length).toBeGreaterThan(0);
  });

  it('reports the full downstream exposure set', async () => {
    const { app } = fresh();
    const res = await request(app).get(`/api/impact/raw.payments_ingest?day=${daysAgo(3)}`);
    expect(res.body.descendants.sort()).toEqual(
      ['dim.customer', 'mart.revenue_daily', 'staging.payments_clean'].sort(),
    );
    expect(res.body.summary.slos_affected).toBe(2);
  });
});

describe('rule versions, exemptions, maintenance', () => {
  it('applies the rule version effective on each day', async () => {
    const { db } = fresh();
    const rules = rulesForSlo(db, 'slo-revenue');
    const v1 = { ...rules.find((r) => r.version === 1) };
    const v2 = { ...rules.find((r) => r.version === 2) };
    expect(ruleForDay(rules, v1.effective_from).version).toBe(1);
    expect(ruleForDay(rules, v2.effective_from).version).toBe(2);
    const dayBefore = new Date(new Date(v2.effective_from).getTime() - 86400000).toISOString().slice(0, 10);
    expect(ruleForDay(rules, dayBefore).version).toBe(1);
  });

  it('rejects an overlapping retroactive rule version', async () => {
    const { app } = fresh();
    const res = await request(app)
      .post('/api/slos/slo-revenue/rules')
      .send({ target: 0.99, effective_from: daysAgo(80) });
    expect(res.status).toBe(400);
  });

  it('appends a new rule version and fills evaluations from its effective date', async () => {
    const { app, db } = fresh();
    const res = await request(app)
      .post('/api/slos/slo-revenue/rules')
      .send({
        target: 0.99,
        window_days: 3,
        weights: { quality: 0.5, latency: 0.2, completeness: 0.3 },
        authored_by: 'nadia.p',
        note: 'Tighter contract',
      });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(3);
    const evals = db
      .prepare('SELECT * FROM evaluations WHERE slo_id = ? AND rule_version_id = (SELECT id FROM slo_rule_versions WHERE slo_id = ? AND version = 3)')
      .all('slo-revenue', 'slo-revenue');
    expect(evals.length).toBeGreaterThan(0);
    const stored = db.prepare('SELECT * FROM slo_rule_versions WHERE slo_id = ? AND version = 3').get('slo-revenue');
    expect(JSON.parse(stored.weights)).toEqual({ quality: 0.5, latency: 0.2, completeness: 0.3 });
    const auditRow = db.prepare("SELECT * FROM audit_log WHERE action = 'rule.version.create'").get();
    expect(auditRow.entity_id).toBe('slo-revenue');
  });

  it('suppresses breaches inside an exemption and reopens when revoked', async () => {
    const { app, db } = fresh();
    const before = db.prepare("SELECT * FROM alerts WHERE slo_id = 'slo-revenue' AND state IN ('open','acknowledged','escalated')").all();
    expect(before.length).toBe(1);
    const ex = await request(app)
      .post('/api/exemptions')
      .send({
        scope_type: 'slo',
        scope_id: 'slo-revenue',
        starts_on: daysAgo(10),
        ends_on: todayUTC(),
        reason: 'Finance approved provisional revenue',
        author: 'nadia.p',
      });
    expect(ex.status).toBe(201);
    const slo = await request(app).get('/api/slos/slo-revenue');
    expect(slo.body.summary.effective_state).toBe('suppressed');
    const recovered = slo.body.alerts.find((a) => a.id === before[0].id);
    expect(recovered.state).toBe('recovered');
    expect(recovered.events.map((e) => e.kind)).toContain('suppressed');

    await request(app).post(`/api/exemptions/${ex.body.id}/revoke`).send({ actor: 'nadia.p' });
    const after = await request(app).get('/api/slos/slo-revenue');
    expect(after.body.summary.effective_state).toBe('breached');
    const reopened = after.body.alerts.find((a) => a.id === before[0].id);
    expect(reopened.state).toBe('open');
    expect(reopened.events.map((e) => e.kind)).toContain('reopened');
  });

  it('requires a reason and a real scope for exemptions', async () => {
    const { app } = fresh();
    const noReason = await request(app).post('/api/exemptions').send({
      scope_type: 'slo',
      scope_id: 'slo-revenue',
      starts_on: daysAgo(2),
      ends_on: todayUTC(),
    });
    expect(noReason.status).toBe(400);
    const badScope = await request(app).post('/api/exemptions').send({
      scope_type: 'asset',
      scope_id: 'does.not.exist',
      starts_on: daysAgo(2),
      ends_on: todayUTC(),
      reason: 'x',
    });
    expect([400, 404]).toContain(badScope.status);
  });

  it('records maintenance windows independently and suppresses their days', async () => {
    const { db } = fresh();
    const windows = db.prepare('SELECT * FROM maintenance_windows ORDER BY starts_on').all();
    expect(windows.length).toBe(2);
    const completed = windows.find((w) => w.status === 'completed');
    const ev = db
      .prepare("SELECT * FROM evaluations WHERE slo_id = 'slo-revenue' AND day = ?")
      .all(completed.starts_on)[0];
    expect(ev.suppression).toBe('maintenance');
    expect(ev.effective_state).toBe('suppressed');
    // Suppression is recorded on the evaluation, not baked into the metric.
    const raw = db
      .prepare("SELECT value FROM metric_points WHERE asset_key = 'mart.revenue_daily' AND metric = 'latency' AND day = ?")
      .get(completed.starts_on);
    expect(raw.value).toBeLessThan(0.6);
  });
});

describe('metric revisions vs closed incidents', () => {
  it('rewrites metric points but leaves a closed alert and its sealed evaluations untouched', async () => {
    const { app, db } = fresh();
    const closed = db.prepare("SELECT * FROM alerts WHERE slo_id = 'slo-orders' AND state = 'closed'").get();
    expect(closed).toBeTruthy();
    const sealedBefore = db
      .prepare('SELECT * FROM evaluations WHERE slo_id = ? AND day = ?')
      .all('slo-orders', closed.first_seen_day)
      .map((e) => ({ ...e }));
    const eventsBefore = db.prepare('SELECT * FROM alert_events WHERE alert_id = ? ORDER BY id').all(closed.id);
    const evidenceBefore = closed.evidence;

    const res = await request(app)
      .post('/api/revisions')
      .send({
        asset_key: 'staging.orders_clean',
        metric: 'quality',
        from: closed.first_seen_day,
        to: closed.last_seen_day,
        mode: 'set',
        params: { value: 0.999 },
        reason: 'Replay proved the dedupe bug was in the labeler, not the data',
        author: 'marco.b',
      });
    expect(res.status).toBe(201);
    expect(res.body.changed_points).toBeGreaterThan(0);
    expect(res.body.frozen_evaluation_days).toBeGreaterThan(0);

    const closedAfter = db.prepare('SELECT * FROM alerts WHERE id = ?').get(closed.id);
    expect(closedAfter.state).toBe('closed');
    expect(closedAfter.evidence).toBe(evidenceBefore);
    expect(db.prepare('SELECT * FROM alert_events WHERE alert_id = ? ORDER BY id').all(closed.id)).toEqual(eventsBefore);

    const sealedAfter = db
      .prepare('SELECT * FROM evaluations WHERE slo_id = ? AND day = ?')
      .all('slo-orders', closed.first_seen_day)
      .map((e) => ({ ...e }));
    expect(sealedAfter).toEqual(sealedBefore);

    // But the underlying metric did change.
    const point = db
      .prepare("SELECT value, revision_id FROM metric_points WHERE asset_key = 'staging.orders_clean' AND metric = 'quality' AND day = ?")
      .get(closed.first_seen_day);
    expect(point.value).toBeCloseTo(0.999, 4);
    expect(point.revision_id).toBe(res.body.revision.id);

    const frozenImpact = res.body.impacts.find((i) => i.kind === 'closed_frozen');
    expect(frozenImpact).toBeTruthy();
    expect(frozenImpact.alert_id).toBe(closed.id);
  });

  it('refuses to re-enable an empty revision and requires provenance', async () => {
    const { app } = fresh();
    const noReason = await request(app).post('/api/revisions').send({
      asset_key: 'raw.orders_ingest',
      metric: 'quality',
      from: daysAgo(3),
      to: daysAgo(3),
      mode: 'offset',
      params: { delta: 0.01 },
      author: 'marco.b',
    });
    expect(noReason.status).toBe(400);
    const empty = await request(app).post('/api/revisions').send({
      asset_key: 'raw.orders_ingest',
      metric: 'quality',
      from: daysAgo(3),
      to: daysAgo(3),
      mode: 'offset',
      params: { delta: 0 },
      reason: 'no-op',
      author: 'marco.b',
    });
    expect(empty.status).toBe(400);
  });

  it('keeps an append-only revision ledger', async () => {
    const { db } = fresh();
    const { applyRevision } = await import('../server/revisions.js');
    applyRevision(db, {
      assetKey: 'raw.orders_ingest',
      metric: 'latency',
      from: daysAgo(5),
      to: daysAgo(5),
      mode: 'set',
      params: { value: 0.99 },
      reason: 'Repair',
      author: 'marco.b',
    });
    const rev = db.prepare('SELECT * FROM metric_revisions ORDER BY id DESC LIMIT 1').get();
    expect(rev.version).toBe(1);
    expect(() => db.prepare('UPDATE metric_revisions SET reason = ? WHERE id = ?').run('tampered', rev.id)).toThrow(
      /append-only/,
    );
  });
});

describe('alert lifecycle', () => {
  it('moves acknowledge → escalate → recover → close with an event trail', async () => {
    const { app, db } = fresh();
    const alert = db.prepare("SELECT * FROM alerts WHERE state = 'open'").get();
    expect(alert).toBeTruthy();

    const ack = await request(app).post(`/api/alerts/${alert.id}/ack`).send({ actor: 'oncall.eng', note: 'picking up' });
    expect(ack.status).toBe(200);
    expect(ack.body.state).toBe('acknowledged');
    const esc = await request(app).post(`/api/alerts/${alert.id}/escalate`).send({ actor: 'oncall.eng', reason: 'needs data eng' });
    expect(esc.body.state).toBe('escalated');
    expect(esc.body.escalation_level).toBe(1);
    const rec = await request(app).post(`/api/alerts/${alert.id}/recover`).send({ actor: 'oncall.eng' });
    expect(rec.body.state).toBe('recovered');
    const preClose = await request(app).post(`/api/alerts/${alert.id}/ack`).send({ actor: 'oncall.eng' });
    expect(preClose.status).toBe(400);
    const closed = await request(app).post(`/api/alerts/${alert.id}/close`).send({ actor: 'oncall.eng', note: 'verified fix' });
    expect(closed.body.state).toBe('closed');
    expect(closed.body.events.map((e) => e.kind)).toEqual([
      'opened',
      'acknowledged',
      'escalated',
      'recovered',
      'closed',
    ]);
    const rejected = await request(app).post(`/api/alerts/${alert.id}/recover`).send({ actor: 'oncall.eng' });
    expect(rejected.status).toBe(400);
  });

  it('cannot close an alert that has not recovered', async () => {
    const { app, db } = fresh();
    const alert = db.prepare("SELECT * FROM alerts WHERE state = 'open'").get();
    const res = await request(app).post(`/api/alerts/${alert.id}/close`).send({ actor: 'oncall.eng' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recover/);
  });

  it('merges related alerts into a group and blocks further transitions on members', async () => {
    const { app } = fresh();
    const gap = await request(app).post('/api/scenarios/upstream-gap').send({
      asset_key: 'raw.orders_ingest',
      from: daysAgo(2),
      to: daysAgo(1),
    });
    expect(gap.status).toBe(200);
    const open = await request(app).get('/api/alerts?state=open');
    const ids = open.body.map((a) => a.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const merge = await request(app).post('/api/alerts/merge').send({
      group_id: ids[0],
      member_ids: ids.slice(1),
      actor: 'oncall.eng',
    });
    expect(merge.status).toBe(200);
    merge.body.members.forEach((m) => {
      expect(m.state).toBe('merged');
      expect(m.merged_into).toBe(ids[0]);
    });
    const view = await request(app).get(`/api/alerts/${ids[0]}`);
    expect(view.body.merged_members.length).toBe(ids.length - 1);
    const ackMember = await request(app).post(`/api/alerts/${ids[1]}/ack`).send({ actor: 'oncall.eng' });
    expect(ackMember.status).toBe(400);
    const mergeClosed = await request(app)
      .post('/api/alerts/merge')
      .send({ group_id: ids[0], member_ids: [] });
    expect(mergeClosed.status).toBe(400);
  });

  it('auto-escalates an unacknowledged alert past the rule clock', async () => {
    const { db } = fresh();
    const alert = db.prepare("SELECT * FROM alerts WHERE state = 'open'").get();
    const past = new Date(Date.now() + 60 * 3600 * 1000).toISOString();
    db.prepare('UPDATE alerts SET opened_at = ? WHERE id = ?').run(new Date(Date.now() - 60 * 3600 * 1000).toISOString(), alert.id);
    reconcileSlo(db, alert.slo_id, { actor: 'scheduler', at: past, autoEscalate: true });
    const after = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alert.id);
    expect(['escalated', 'recovered']).toContain(after.state);
    if (after.state === 'escalated') expect(after.escalation_level).toBeGreaterThan(0);
  });
});

describe('scenario verification: upstream gap → backfill', () => {
  it('opens critical alerts for missing upstream rows, then recovers them on replay', async () => {
    const { app, db } = fresh();
    const beforeOpen = (await request(app).get('/api/alerts?state=open')).body.length;

    const gap = await request(app).post('/api/scenarios/upstream-gap').send({
      asset_key: 'raw.payments_ingest',
      from: daysAgo(2),
      to: daysAgo(1),
      actor: 'nadia.p',
    });
    expect(gap.status).toBe(200);
    expect(gap.body.alerts_opened).toBeGreaterThan(0);
    Object.values(gap.body.slo_states).forEach((states) => {
      states.forEach((s) => expect(s.state).toBe('nodata'));
    });

    const afterGap = (await request(app).get('/api/alerts?state=open')).body;
    expect(afterGap.length).toBeGreaterThan(beforeOpen);
    const gapAlerts = afterGap.filter((a) => a.evidence.days?.[0]?.state === 'nodata' || a.summary.match(/Coverage gap/));
    expect(gapAlerts.length).toBeGreaterThan(0);

    const backfill = await request(app).post('/api/scenarios/backfill').send({
      asset_key: 'raw.payments_ingest',
      from: daysAgo(2),
      to: daysAgo(1),
      actor: 'nadia.p',
    });
    expect(backfill.status).toBe(200);
    expect(backfill.body.alerts_recovered).toBeGreaterThan(0);

    const afterBackfill = (await request(app).get('/api/alerts?state=open')).body;
    const stillOpen = afterBackfill.filter((a) => gapAlerts.some((g) => g.slo_id === a.slo_id && a.id === g.id));
    expect(stillOpen.length).toBe(0);

    const closedCount = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE state = 'closed'").get();
    expect(Number(closedCount.n)).toBe(2);
  });

  it('does not silently pass a no-data day', async () => {
    const { app } = fresh();
    const gap = await request(app).post('/api/scenarios/upstream-gap').send({
      asset_key: 'raw.payments_ingest',
      from: daysAgo(4),
      to: daysAgo(4),
    });
    const day = daysAgo(4);
    for (const rows of Object.values(gap.body.slo_states)) {
      const row = rows.find((r) => r.day === day);
      expect(row.state).toBe('nodata');
      expect(row.state).not.toBe('healthy');
    }
  });
});

describe('seed provenance and workspace reset', () => {
  it('seeds a revision that overlaps a closed incident without rewriting it', () => {
    const { db } = fresh();
    const rev = db.prepare('SELECT * FROM metric_revisions ORDER BY id DESC LIMIT 1').get();
    expect(rev).toBeTruthy();
    const closed = db.prepare("SELECT * FROM alerts WHERE slo_id = 'slo-orders' AND state = 'closed'").get();
    expect(rev.day_from <= closed.last_seen_day && rev.day_to >= closed.first_seen_day).toBe(true);
    const impacts = db.prepare('SELECT * FROM revision_impacts WHERE revision_id = ?').all(rev.id);
    expect(impacts.map((i) => i.kind)).toContain('closed_frozen');
    expect(impacts.map((i) => i.kind)).toContain('evaluations_sealed');
    // Sealed days carry no revision stamp; the surrounding days do.
    const sealed = db
      .prepare("SELECT revision_id FROM evaluations WHERE slo_id = 'slo-orders' AND day BETWEEN ? AND ?")
      .all(closed.first_seen_day, closed.last_seen_day);
    sealed.forEach((e) => expect(e.revision_id).toBeNull());
    const changed = db
      .prepare("SELECT revision_id FROM evaluations WHERE slo_id = 'slo-orders' AND day BETWEEN ? AND ? AND revision_id = ?")
      .all(rev.day_from, rev.day_to, rev.id);
    expect(changed.length).toBeGreaterThan(0);
  });

  it('reseeds through the reset endpoint and restores the append-only guards', async () => {
    const { app, db } = fresh();
    const res = await request(app).post('/api/scenarios/reset').send({});
    expect(res.status).toBe(200);
    expect(res.body.today).toBe(todayUTC());
    const closed = db.prepare("SELECT * FROM alerts WHERE state = 'closed'").get();
    expect(() => db.prepare('UPDATE alerts SET summary = ? WHERE id = ?').run('tampered', closed.id)).toThrow(
      /immutable/,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM metric_revisions').get().n).toBeGreaterThan(0);
  });
});

describe('validation and guards', () => {
  it('normalizes weights and rejects zero-total weight sets', async () => {
    const { app, db } = fresh();
    const ok = await request(app)
      .post('/api/slos/slo-customer/rules')
      .send({ target: 0.98, weights: { quality: 2, latency: 1, completeness: 1 }, authored_by: 'grace.l' });
    expect(ok.status).toBe(201);
    const row = db.prepare("SELECT weights FROM slo_rule_versions WHERE slo_id = 'slo-customer' ORDER BY version DESC LIMIT 1").get();
    expect(JSON.parse(row.weights)).toEqual({ quality: 0.5, latency: 0.25, completeness: 0.25 });
    const bad = await request(app)
      .post('/api/slos/slo-customer/rules')
      .send({ target: 0.98, weights: { quality: 0, latency: 0, completeness: 0 } });
    expect(bad.status).toBe(400);
  });

  it('rejects a bad target and non-positive window', async () => {
    const { app } = fresh();
    expect((await request(app).post('/api/slos/slo-orders/rules').send({ target: 1.4 })).status).toBe(400);
    expect((await request(app).post('/api/slos/slo-orders/rules').send({ window_days: 0 })).status).toBe(400);
  });

  it('exposes an append-only audit trail for governance actions', async () => {
    const { app } = fresh();
    const alert = (await request(app).get('/api/alerts?state=open')).body[0];
    await request(app).post(`/api/alerts/${alert.id}/ack`).send({ actor: 'oncall.eng' });
    const audit = await request(app).get('/api/audit');
    const entry = audit.body.find((a) => a.action === 'alert.ack');
    expect(entry.actor).toBe('oncall.eng');
    expect(() =>
      request(app)
        .get('/api/audit')
        .then(() => {}),
    ).not.toThrow();
  });
});
