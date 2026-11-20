# Meridian — composite SLO data-observability console

Quality, latency, and completeness are blended into configurable SLOs per dataset. Lineage decides when a missing
upstream row becomes *no data* downstream instead of a silent pass. Rule versions, exemptions, and maintenance windows
are three independent registries. Alerts move through a real lifecycle (merge → escalate → recover → human close), and a
metric revision can never rewrite a closed incident.

## Run it

```bash
npm install
npm run dev        # API on :5175, Vite UI on :5173  →  http://localhost:5173
```

The first start seeds a deterministic 90-day workspace into `data/meridian.sqlite` (delete the file, or use
**Reset workspace** on the Verification page, to reseed). For a single-process demo:

```bash
npm run build && npm start    # serves the built UI and the API from :5175
```

```bash
npm test           # 31 tests: engine/API + route rendering
```

Environment: `PORT` (default 5175), `MERIDIAN_DB` (default `data/meridian.sqlite`).

## Where each requirement lives

| Requirement | Where to look |
| --- | --- |
| Composite configurable SLO (quality / latency / completeness) | `server/engine.js` → `computeDay`, `rollingFor`, `evaluateSlo`; weights normalized; coverage below `minCoverage` ⇒ `nodata`, never a zero |
| Rule versions recorded independently | `slo_rule_versions` (append-only trigger), **Governance** and each SLO's *Rule versions* tab |
| Exemption windows recorded independently | `exemptions` table, SLO *Exemptions & maintenance* tab, Governance. Suppression marks the *evaluation*, never the stored metric |
| Maintenance periods recorded independently | `maintenance_windows` table — separate registry and audit rows |
| Alert merge / escalate / recover / human ack-close | `server/engine.js` → `reconcileSlo`, `mergeAlerts`, `ackAlert`, `escalateAlert`, `recoverAlert`, `closeAlert`; close requires `recovered` |
| Metric revisions cannot change closed incidents | `server/revisions.js` → `frozenDays`, `applyRevision` (restores sealed evaluation rows, logs `closed_frozen` / `evaluations_sealed`); DB triggers block writes to closed alerts |
| SLO trend, evidence, dependency impact, alert lifecycle | Overview, SLO detail (trend + per-dimension evidence + metric inputs), Lineage & impact, Alert drawer timeline |
| Verify upstream missing rows and backfill | **Verification** lab: drop rows at a raw/staging source → dependent contracts go no-data with the true `gap_origin` → backfill → open alerts recover, sealed incidents stay sealed |

## Data model notes

* `metric_points` holds raw measurements; `evaluations` holds one computed row per SLO-day-rule, with the dimension
  evidence that produced it.
* Lineage propagation: a stale *local* timestamp cannot mask a source outage — `effectiveMetric()` walks ancestors, and
  completeness/latency inherit `upstream-missing` when a parent produced nothing that day.
* Append-only enforcement is in SQLite, not just in app code: `BEFORE UPDATE/DELETE ... RAISE(ABORT)` triggers cover
  closed alerts, rule versions, the revision ledger, alert events, and the audit log.
* A seeded revision (#1) deliberately overlaps the closed orders incident so the immutability guarantee is visible in the
  Ledger: the metric points change, the incident and its sealed days do not.

## Seeded workspace

3 SLOs across 6 lineage assets, 2 closed incidents (upstream gap on the revenue mart; staging quality dip on orders), one
open revenue incident, an active asset-scoped exemption, a completed maintenance window, a scheduled customer-dimension
cutover, and the revision above. Dates are relative to "today", so the demo stays current.
