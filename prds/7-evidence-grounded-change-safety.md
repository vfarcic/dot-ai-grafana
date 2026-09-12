# PRD: Evidence-grounded change safety and verification

**Issue**: [#7](https://github.com/vfarcic/dot-ai-grafana/issues/7)
**Priority**: High
**Status**: Draft — not started

## Problem Statement

A GitOps PR path alone does not tell the operator whether **now is a safe time** to change, what the **blast radius** looks like from live traffic and alerts (not only the dependency graph), or whether the target **metric recovered after merge**.

The engine's existing `operate` envelope already carries dry-run, risk assessment, policy checks, and post-execution validation. The gap is grounding those steps in **live observability signal** on the Grafana doorway — without turning this plugin into a second Kubernetes day-2 object manager (that stays on Headlamp).

## Solution Overview

Make Grafana the place where a GitOps change is:

1. **Pre-flighted** against live telemetry ("is now a safe time?")
2. Judged for **blast radius** using live traffic and alert evidence joined to impact analysis
3. **Verified after merge** ("did the metric recover?") bound to the change identity
4. Optionally **recorded** back into operational knowledge where the engine supports it

Execute trigger remains **PRD #5 propose → GitOps PR** only. No live apply from the plugin.

Attach to `operate`'s existing change-safety envelope (dry-run → approval → execute → validate; risk assessment; session ids) rather than inventing a parallel workflow.

**Open architectural choice (see Open Questions):** whether telemetry-aware risk and metric-recovery validation land primarily in the **engine** (`operate` consuming Grafana MCP-style integrations already available upstream) or in **this plugin**.

## Technical Scope

- Pre-flight safe-time from live telemetry and alerts packed in Current / stack context
- Blast radius from live traffic/alert evidence joined to engine impact analysis — not the dependency graph alone
- Post-merge metric recovery check bound to the change / PR identity
- UI: human decision gate that stays disarmed until safe-time + pre-flight have rendered (or an explicit waive with audit reason, if product later allows waiving)
- Optional knowledge write-back of verified outcomes when the engine exposes it
- Surface demarcation: Grafana = observability-first intelligence + GitOps-PR triggering; Headlamp = day-2 object lifecycle

### What's Explicitly Out of Scope

- GitOps PR create mechanism internals (PRD #5)
- Map / Explore / show-me / markdown presentation (tracked on issue #6 as deferred PRD #1 scope)
- Analysis-only first-release packing (PRD #1)
- Thread integrity / progress UX / shipping polish (tracked on issue #8 as PRD #1 carry-forward)
- Live `kubectl apply` from the plugin
- Full Build/Update object wizards in Grafana (Headlamp's home)
- Deploying topology-graph or packet-capture planes as this companion's job (engine/platform)

## Requirements

### Implementation

- [ ] Pre-flight panel: safe-time signal from live telemetry/alerts before PR control arms
- [ ] Blast-radius view joins live traffic/alert evidence to impact analysis fields the engine already returns
- [ ] Post-merge verification: metric recovery (or explicit non-recovery) bound to change/PR identity
- [ ] PR control remains disarmed until pre-flight has rendered (fail closed on missing signal unless explicit waive exists later)
- [ ] Wire through existing `operate` envelope fields where present; do not fork a second session model without cause
- [ ] Optional knowledge write-back path when engine capability exists; no-op when absent

### Documentation

- [ ] Document safe-time / blast-radius / verify operator journey
- [ ] Document dependency on PRD #5 PR path and analysis-only foundation
- [ ] Document engine-vs-plugin split once OQ1 is decided

### Validation

- [ ] Fixture: quiet stack shows honest clear/empty — never silent skip of pre-flight
- [ ] Fixture: degraded/firing stack warns before PR control arms
- [ ] Fixture or e2e: after merge, verify step reports recovery or non-recovery against a known metric
- [ ] Tests assert no live apply client path

### User Acceptance

- [ ] Operator can refuse or delay a PR because safe-time says no, with visible evidence
- [ ] Operator can see blast radius grounded in alerts/traffic, not only a static graph
- [ ] Operator can confirm post-merge whether the target signal recovered

### Launch Activities

- [ ] Enable only when PRD #5 path (or test double) is available for demos
- [ ] Rollout note: analysis-only remains default; safety loop is additive

### Success Metrics

- [ ] Demo path: safe-time → pre-flight → GitOps PR → verify, with no plugin cluster apply
- [ ] Zero silent skips of pre-flight in degraded fixture

## Success Criteria

- Operator gets an evidence-backed **safe-time** answer before a GitOps PR is opened from Grafana
- Blast radius cites live signal, not only dependency topology
- Post-merge verification answers whether the agreed metric recovered for that change
- Plugin still never applies live; execute remains GitOps PR only

## Dependencies

- **PRD #1** ([issue #1](https://github.com/vfarcic/dot-ai-grafana/issues/1)) — analysis/Current foundation
- **PRD #5** ([issue #5](https://github.com/vfarcic/dot-ai-grafana/issues/5)) — GitOps PR mechanism used as execute trigger
- Engine `operate` (or equivalent) change-safety envelope and impact fields
- Grafana stack telemetry available to the plugin (and/or engine via Grafana MCP-style integration)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Re-implementing operate inside the plugin | Attach to engine envelope; OQ1 decides engine vs plugin for telemetry join |
| Silent skip when telemetry missing | Honest empty/degraded states; fail closed on arming PR |
| Becoming a cluster object manager | Explicit non-goal; Headlamp keeps object lifecycle |
| Blocking all PRs on flaky signals | Clear evidence UI; optional future waive with audit (not required for first cut) |

## Milestones

- [ ] **M1 — Contract inventory** — which `operate` / impact / remediate fields exist today vs what the plugin must join from Current
- [ ] **M2 — Safe-time pre-flight UI** — render safe-time from live telemetry/alerts; PR control stays disarmed until shown
- [ ] **M3 — Blast-radius join** — live traffic/alert evidence joined to impact analysis
- [ ] **M4 — Post-merge verify** — metric recovery bound to change/PR identity
- [ ] **M5 — PRD #5 integration** — end-to-end: pre-flight → propose GitOps PR → verify (real path or test double)
- [ ] **M6 — Docs + engine/plugin decision recorded** — OQ1 resolved in Decision Log; operator docs updated

## Decision Log

| Decision | Date | Rationale | Impact | Code Impact | Owner |
|----------|------|-----------|--------|-------------|-------|
| Execute trigger is PRD #5 GitOps PR only | 2026-09-03 | Maintainer demarcation: Grafana observes + opens reviewable PRs; no live apply | No apply surface in this PRD | Depends on PRD #5 APIs | Maintainer + contributor |
| Attach to existing `operate` envelope | 2026-09-03 | Avoid a parallel session/workflow model | Requirements reference operate fields | Thin client join, not a new engine | Contributor |
| Headlamp keeps day-2 object lifecycle | 2026-09-03 | Do not duplicate cluster manager UX in Grafana | Object wizards out of scope here | No Build/Update wizard | Maintainer + contributor |

## Open Questions

- [ ] **OQ1 — Engine vs plugin:** Do telemetry-aware risk and metric-recovery validation land in the **engine** (`operate` consuming already-available Grafana MCP-style integrations) or in **this plugin**? Prefer engine if the envelope already owns dry-run/risk/validate.
- [ ] **OQ2 — Waive policy:** Is an explicit audited waive of safe-time allowed in the first cut, or always hard-gate?
- [ ] **OQ3 — Knowledge write-back:** Which knowledge write APIs are real today vs planned?
- [ ] **OQ4 — Prompt-injection / untrusted telemetry:** When Current packs logs/alerts/traces into engine requests on the change path, how should hostile or malformed signal be bounded so it cannot steer an unsafe PR proposal? Prefer engine-side guards; plugin fails closed on oversized/unparseable packs.
- [ ] **OQ5 — Data residency / egress:** Which parts of packed Current and operate session context leave the Grafana process boundary, and what must operators configure for air-gapped or residency-bound deployments?

## Status / Progress

- **Phase:** Draft (design only)
- **Overall:** 0% (0 of 6 milestones complete)
- **Implementation:** not started
- **Validation:** not started
- **Launch:** not started
- **Next:** M1 contract inventory; depends on PRD #5 for full-loop demos
