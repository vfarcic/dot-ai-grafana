# PRD: Evidence-grounded change safety and verification

**Issue**: [#7](https://github.com/vfarcic/dot-ai-grafana/issues/7)
**Priority**: High
**Status**: Draft — design expanded 2026-09-19; implementation **not started** and **blocked** on [PRD #5](https://github.com/vfarcic/dot-ai-grafana/issues/5) M2+
**Draft PR**: [#11](https://github.com/vfarcic/dot-ai-grafana/pull/11)
**Renamed from**: fork PRD #4 / LesleyMurfin#31 (superseded; same workstream)

## Problem Statement

A GitOps PR path alone does not tell the operator whether **now is a safe time** to change, what the **blast radius** looks like from live traffic and alerts (not only the dependency graph), or whether the target **metric recovered after merge**.

The engine's existing `operate` envelope already carries dry-run, risk assessment, policy checks, and post-execution validation. The gap is grounding those steps in **live observability signal** on the Grafana doorway — without turning this plugin into a second Kubernetes day-2 object manager (that stays on Headlamp).

Today the Grafana plugin can pack Loki / Prometheus / Tempo / Alertmanager into a Query `intent`, and can run analysis-only `remediate`. It cannot:

- Judge safe-time from live signal before a change is proposed
- Join that live signal to engine impact analysis
- Arm a GitOps PR control only after those views have honestly rendered
- Bind a post-merge verify step to the PR identity and an agreed metric

## Solution Overview

Make Grafana the place where a GitOps change is:

1. **Pre-flighted** against live telemetry ("is now a safe time?")
2. Judged for **blast radius** using live traffic and alert evidence joined to impact analysis
3. **Gated** — the PR control stays disarmed until (1) and (2) have rendered, fail-closed
4. **Verified after merge** ("did the metric recover?") bound to the change identity
5. Optionally **recorded** back into operational knowledge where the engine supports it

Execute trigger remains **PRD #5 propose → GitOps PR** only. No live apply from the plugin.

Attach to `operate`'s existing change-safety envelope (dry-run → approval → execute → validate; risk assessment; session ids) rather than inventing a parallel workflow.

**Architectural lean (OQ1, Decision Log 2026-09-19):** telemetry-aware risk and metric-recovery validation land in the **engine** (`operate` already owns dry-run / risk / policy / post-execute validate; Grafana / Prometheus MCP attach is already an engine integration). This plugin stays a **thin join + fail-closed disarm gate**: pack labeled Current, render engine fields, refuse to arm the PR control when signal is missing or hostile. Structured envelope gaps become engine asks — not a second risk engine in Grafana.

**Evidence-integrity teammate:** [vfarcic/dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799) (owned by teammate **Dot-AI Evidence**) is the engine issue for provenance labels through prompt composition and tool gating. This PRD **cross-links** it and does **not** steal that issue. See [Untrusted telemetry / OQ4](#untrusted-telemetry--prompt-injection-oq4).

## Build start — hard blockers

| Gate | Required before | Status on 2026-09-19 |
|------|-----------------|----------------------|
| This document (M1 contract inventory) | Plugin design review | **Recorded below** (docs only) |
| [PRD #5](https://github.com/vfarcic/dot-ai-grafana/issues/5) **M2+** (Propose → PR UI exists, even behind a test double) | Any plugin code for the PR gate, blast-radius-on-change-path, or post-merge verify loop | **Not started** (draft PR [#9](https://github.com/vfarcic/dot-ai-grafana/pull/9), 0 of 6 milestones) |
| Engine envelope fields for telemetry-aware risk / verify (if OQ1 lean holds and today's fields are insufficient) | Full-loop M5 demo | **Gap** — see [Appendix A](#appendix-a--contract-inventory-m1) |
| [dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799) (evidence integrity) | Treating packed telemetry as a trusted input to arming or to an engine tool call that can propose a PR | **Open, other owner** |

**This expand does not start product implementation.** Full-loop build (M2–M5) waits for PRD #5 M2+. The only milestone this document may complete is **M1 — contract inventory**.

## Operator journey and wireframes

Four surfaces, one thread. Copy stays Grafana-native (PluginPage, Alert, disarmed button). No live apply affordance on any screen.

```
  [Ask / Remediate analysis]
            │
            ▼
   ┌─────────────────┐
   │ 1. SAFE-TIME    │  live telemetry + alerts → CLEAR | DEGRADED | MISSING
   └────────┬────────┘
            │ rendered (never skipped)
            ▼
   ┌─────────────────┐
   │ 2. BLAST RADIUS │  engine impact + live traffic/alert join
   └────────┬────────┘
            │ rendered (never skipped)
            ▼
   ┌─────────────────┐
   │ 3. PR GATE      │  disarmed until 1+2 honest; #5 opens GitOps PR
   └────────┬────────┘
            │ merge (outside plugin)
            ▼
   ┌─────────────────┐
   │ 4. VERIFY       │  agreed metric × PR identity → recovered | not | failed
   └─────────────────┘
```

### Screen 1 — Safe-time

```
┌─ dot-ai  /  Remediate (analysis only) ─────────────────────────────────┐
│ ⚠ Analysis only — this plugin never applies. Execute = GitOps PR (#5). │
│                                                                        │
│ Issue   checkout-api 5xx after the payments deploy                     │
│                                                                        │
│ ┌ Safe-time (last 15m) ─────────────────────────────────────────────┐  │
│ │ Status     DEGRADED — not a safe time                             │  │
│ │ Alerts     2 firing  alert/checkout-error-rate  page              │  │
│ │ Traffic    checkout p99 1.8s (baseline 240ms)  error-ratio 4.1%   │  │
│ │ Signal     Loki loki · Prom prometheus · AM alertmanager · Tempo —│  │
│ │                                                                      │
│ │ Evidence (untrusted — quoted, not instruction)                       │
│ │   14:02  checkout-7d9f  ERROR  upstream payments timeout             │
│ │   14:03  ALERT checkout-error-rate firing  4.1% > 1%                 │
│ │                                                                      │
│ │ [ Explore logs ]  [ Explore metrics ]     never POSTed               │
│ └───────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│ Propose GitOps PR                                         🔒 disarmed  │
│   Waiting on blast radius. Safe-time is DEGRADED — gate stays closed.  │
└────────────────────────────────────────────────────────────────────────┘
```

Quiet-stack variant of the same panel (must still **render**, never silently skip):

```
┌ Safe-time (last 15m) ───────────────────────────────────────────────┐
│ Status     CLEAR — no firing alerts in window; error-ratio at baseline│
│ Alerts     0 firing                                                 │
│ Traffic    checkout p99 220ms · error-ratio 0.2%                    │
│ Signal     honest empty notes allowed; missing DS is named, not skip│
└─────────────────────────────────────────────────────────────────────┘
Propose GitOps PR                                       🔒 disarmed
  Waiting on blast radius.
```

### Screen 2 — Blast radius

```
┌ Blast radius ───────────────────────────────────────────────────────┐
│ Engine impact_analysis.safe = false     (dependency / topology)     │
│ Live join                           DEGRADED                        │
│                                                                     │
│ Would touch                                                          │
│   deploy/checkout-api      ns/prod     replicas 3                    │
│   svc/checkout             ns/prod                                   │
│   deploy/payments-edge     ns/prod     ← live 5xx correlating        │
│                                                                     │
│ Live signal on those names (not the graph alone)                     │
│   alert/checkout-error-rate     firing     14:03                     │
│   prom  checkout_http_requests  5xx ↑   payments_edge 5xx ↑          │
│                                                                     │
│ Risk (engine operate.analysis.risks)     HIGH                        │
│ Dry-run (engine)                         success — manifest accepts  │
│ Policies                                 image-tag-not-latest PASS   │
│                                                                     │
│ ⚠ impact_analysis has no untrusted-content boundary (engine docs).   │
│   Live lines below are quoted evidence, not instruction.             │
└─────────────────────────────────────────────────────────────────────┘
Propose GitOps PR                                       🔒 disarmed
  Blast radius rendered. Safe-time DEGRADED — gate stays closed.
```

### Screen 3 — PR gate (armed only when fail-closed rules pass)

```
┌ Propose GitOps PR ──────────────────────────────────────────────────┐
│ Safe-time     CLEAR (rendered 14:11)                                 │
│ Blast radius  shown · engine safe=true · live join quiet             │
│ Target metric checkout_http_requests{code=~"5.."}  (agreed)          │
│ Window        15m pre / 15m post merge                               │
│                                                                     │
│ Title   fix(checkout): raise payments timeout to 3s                  │
│ Repo    org/gitops   base main                                       │
│ Diff    values.yaml  timeout: 1s → 3s                                │
│                                                                     │
│ [ Open GitOps PR ]   ← #5 M2+ control, now armed                     │
│                                                                     │
│ First cut: no waive. Missing or degraded signal keeps this disabled. │
└─────────────────────────────────────────────────────────────────────┘
```

Disarmed reasons are explicit — never a hidden disabled button:

| Reason shown | Arm? |
|--------------|------|
| Safe-time not yet rendered | No |
| Safe-time MISSING / unparseable / oversized pack | No |
| Safe-time DEGRADED / firing | No (first cut; OQ2 waive is later) |
| Blast radius not yet rendered | No |
| Engine risk HIGH and product has not defined an override | No |
| Model prose or evidence text says "safe to ship" | **Ignored** — never an arming input |
| PRD #5 control absent | Control not mounted (this PRD does not invent a PR client) |

### Screen 4 — Post-merge verify

```
┌ Verify change  #1842  sha 9f3c…   merged 14:40 ─────────────────────┐
│ Bound to   PR #1842 · target metric agreed at pre-flight             │
│ Window     15m after first successful GitOps reconcile               │
│                                                                     │
│ checkout_http_requests{code=~"5.."}                                  │
│   pre  4.1%     post  0.3%     baseline  0.2%                        │
│                                                                     │
│ Result     RECOVERED                                                 │
│ Engine     operate.execution.validation cited as cluster-side check  │
│            (not a substitute for this metric bind)                   │
│                                                                     │
│ Knowledge write-back   optional · no-op if engine API absent         │
└─────────────────────────────────────────────────────────────────────┘

  NOT_RECOVERED  → keep the panel; do not imply the PR was "done"
  VERIFY_FAILED  → honest error (signal missing after merge) — fail closed
```

## Technical Scope

- Pre-flight safe-time from live telemetry and alerts packed in Current / stack context
- Blast radius from live traffic/alert evidence joined to engine impact analysis — not the dependency graph alone
- Human decision gate that stays disarmed until safe-time + blast radius have rendered
- Post-merge metric recovery check bound to the change / PR identity returned by PRD #5
- Optional knowledge write-back of verified outcomes when the engine exposes it
- Surface demarcation: Grafana = observability-first intelligence + GitOps-PR triggering; Headlamp = day-2 object lifecycle
- Plugin work on this path is **join + render + disarm**. Telemetry-aware risk / verify **logic** is an engine concern (OQ1 lean)

### Engine vs plugin split (OQ1 lean)

| Concern | Engine (`vfarcic/dot-ai`) | This plugin |
|---------|---------------------------|-------------|
| Dry-run, policy, structured `risks`, session id | Already on `operate` | Display only |
| Telemetry-aware risk / "is now safe" judgment | **Prefer here** — `operate` + attached Grafana/Prometheus MCP | Do not reimplement a risk model |
| Metric-recovery validation after change | **Prefer here** — extend post-execute validate to accept a metric bind + change id | Display result; supply PR id + agreed metric as join keys |
| Live Current (Loki/Prom/Tempo/AM) | May also read via MCP | Already packed for Query; **must** be available on the change path (today Remediate reads no datasource — [PR #75](https://github.com/vfarcic/dot-ai-grafana/pull/75)) |
| `evidence` vs `intent`/`issue` split | Field exists (PRD #811 M4) | Today stuffing Current into `issue`/`intent`; change path must quote telemetry as `evidence` |
| Provenance label + tool gating | **[dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799)** (Dot-AI Evidence) | Emit capture-time labels only when #799 defines the wire format; until then fail closed on the gate |
| Arm / disarm the #5 PR control | No | **This PRD** — fail closed |
| GitOps PR create | Remediate execute already opens GitHub PRs for Argo/Flux apps | **PRD #5** doorway + token split — not this PRD |
| Live `kubectl apply` | Headlamp / engine execute | Never |

### What's Explicitly Out of Scope

- GitOps PR create mechanism internals (PRD #5)
- Map / Explore / show-me / markdown presentation (tracked on issue #6 as deferred PRD #1 scope)
- Analysis-only first-release packing (PRD #1)
- Thread integrity / progress UX / shipping polish (tracked on issue #8 as PRD #1 carry-forward)
- Live `kubectl apply` from the plugin
- Full Build/Update object wizards in Grafana (Headlamp's home)
- Deploying topology-graph or packet-capture planes as this companion's job (engine/platform)
- **Evidence integrity / provenance labeling through prompt composition and tool gating** — [vfarcic/dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799), teammate Dot-AI Evidence. Cross-link only.
- Per-operator credential propagation for Grafana/Loki/Prometheus tokens (also #799 item 3)
- A parallel session/workflow model beside `operate`
- Implementing the full safety loop in this repository before PRD #5 M2+ exists

## Fail-closed arming rules

The PR control is a **weaponized** affordance (it asks another system to open an infra PR). Missing signal is not "unknown, proceed"; it is **disarm**.

### State machine

```
                 ┌────────────┐
                 │  UNLOADED  │
                 └─────┬──────┘
                       │ operator opens change path
                       ▼
                 ┌────────────┐
            ┌────┤ LOAD_SAFE  │
            │    └─────┬──────┘
            │          │
     missing /         │ rendered
     unparseable       ▼
     oversized    ┌────────────┐     firing / degraded
            ├────►│ SAFE_SHOWN ├──────────────────────────┐
            │     └─────┬──────┘                          │
            │           │ CLEAR                           │
            │           ▼                                 │
            │     ┌────────────┐                          │
            ├────►│ LOAD_BLAST │                          │
            │     └─────┬──────┘                          │
            │           │ rendered                        │
            │           ▼                                 │
            │     ┌────────────┐     engine HIGH risk     │
            ├────►│ BLAST_SHOWN├──────────────────────────┤
            │     └─────┬──────┘                          │
            │           │ join ok + safe-time CLEAR       │
            │           ▼                                 │
            │     ┌────────────┐                          │
            │     │   ARMED    │  #5 control enabled      │
            │     └─────┬──────┘                          │
            │           │ PR opened                       │
            │           ▼                                 │
            │     ┌────────────┐     signal gone          │
            │     │ WAIT_MERGE ├──────────────────────────┤
            │     └─────┬──────┘                          │
            │           │ merged + window elapsed         │
            │           ▼                                 │
            │     ┌────────────┐                          │
            │     │  VERIFY    │──► RECOVERED | NOT_RECOVERED
            │     └─────┬──────┘
            │           │ verify pack missing
            │           ▼
            └──────────► DISARMED / VERIFY_FAILED
                         (explicit reason; never silent skip)
```

### Rules (first cut)

1. **Render or refuse.** Safe-time and blast radius always occupy UI. A quiet stack shows CLEAR/empty. A missing datasource is named. There is no "skip pre-flight when nothing is configured."
2. **Missing signal disarms.** `currentEmpty`, pack overflow, JSON/parse failure, or timeout on the stack read → DISARMED. Same if the engine returns no usable `risks` / impact payload when we asked for one.
3. **Degraded disarms.** Any firing alert in the agreed window, or live traffic on the touched names outside the agreed baseline band → DISARMED. First cut has **no waive** (OQ2).
4. **Untrusted text never arms.** Log lines, alert annotations, trace attributes, model `message` / `guidance` / `agentInstructions` are not boolean inputs to the gate. Only plugin-owned structured state (CLEAR + rendered + engine risk not HIGH) arms.
5. **Oversized / hostile packs fail closed.** If Current cannot be packed inside the existing intent budget **and** the `evidence` cap (20 000 chars on the engine field; plugin should cap tighter — see OQ4), do not send a truncated-into-trusted-channel leftover; disarm and show "pack exceeded bound."
6. **No apply client.** Tests keep asserting the plugin has no operate/execute/apply path. Arming a #5 PR control is not apply.
7. **Post-merge same posture.** If the agreed metric cannot be read after merge, result is VERIFY_FAILED, not an implied RECOVERED.

### Arming inputs (allowed vs forbidden)

| Allowed as gate input | Forbidden as gate input |
|-----------------------|-------------------------|
| Plugin-computed `currentEmpty` / DS presence | Any substring of a log or alert |
| Count of firing alerts the plugin listed | Model sentence "safe to ship" |
| Engine `analysis.risks.level` as an enum | `agentInstructions`, `guidance`, `nextAction` |
| Engine `impact_analysis.safe` as a boolean **display**, joined with live signal — not sufficient alone | `impact_analysis.summary` prose |
| PRD #5 "control mounted + operator is allowed to open a PR" | Presence of `gitSource` or a guessed repo URL in analysis text |

## Untrusted telemetry / prompt-injection (OQ4)

This is the change-path instance of the trust boundary already written for Query in [PRD #1](1-grafana-ai-cluster-intelligence.md#untrusted-telemetry-trust-boundary) and [ADR-0001](../design/adr/ADR-0001-plugin-security-and-privacy-model.md) §5. On this path the model output can steer a **PR proposal**, so the bound is tighter.

### What is already true (cited)

| Fact | Cite | Implication for this PRD |
|------|------|--------------------------|
| `remediate` / `operate` accept optional `evidence` and compose it inside `<untrusted_evidence>` | `vfarcic/dot-ai` `src/tools/operate.ts`, `src/tools/remediate.ts`; [Untrusted Content](https://github.com/vfarcic/dot-ai/blob/main/docs/ai-engine/operations/untrusted-content.md) | Change-path telemetry **must** travel in `evidence`, not in `issue`/`intent` |
| Tool results in those loops are wrapped in `<untrusted_tool_output>` | same | Do not treat engine investigation text as instruction |
| `query`, `impact_analysis`, `recommend` are **not** covered by that boundary | same, "Which loops have the boundary" | Blast-radius join must not assume impact prose is framed |
| `evidence` maxLength 20 000 is **not** enforced on `operate` over REST | same, "Caller-visible behavior" | Plugin must cap before POST |
| Plugin `sanitizeRemediateBody` allowlists only `issue` + `intent` | `pkg/plugin/resources.go` | Today's proxy **drops** `evidence`, `sessionId`, `executeChoice` — correct for analysis-only; the change path needs a deliberate, still-no-execute allowlist that can forward `evidence` and never `executeChoice` |
| Remediate Asks **read no datasource** | [PR #75](https://github.com/vfarcic/dot-ai-grafana/pull/75); `docs/index.md`; `DotAIPage.tsx` consent copy | Safe-time cannot reuse today's Remediate path as-is |
| Explore / Drilldown URLs are UI-only and never POSTed | ADR-0001; `grafanaStack.ts` | Keep that invariant on these screens |
| Packed evidence is attacker-writable (OWASP LLM01) | PRD #1 I1–I11; GrafanaGhost / LogJack / CVE-2025-41117 cited there | Arming must ignore that text |

### Plugin bounds this PRD will require (when build is unblocked)

- Split at capture time: operator Issue → `issue`/`intent`; Loki/Prom/Tempo/AM/Current → `evidence`.
- If the plugin cannot tell them apart, **do not guess** (engine integrator rule). Disarm and keep telemetry on screen only.
- Cap `evidence` on the caller (suggested 8 KiB packed text or the existing Current pack budget, whichever is smaller) so REST `operate` cannot blow the provider context.
- Strip or refuse packs that contain forged section headers (`Issue:`, `Question:`, `Current:`, `<untrusted_evidence>`) — already a PRD #1 / ADR-0001 direction.
- Secret-shaped redaction stays client + backend (ADR-0001 §2). Redaction is not an injection control.
- Fail closed on oversized / unparseable packs (rule 5).
- Never send `executeChoice` / `sessionId` from this plugin (PRD #1 layer a stays).

### What this PRD does **not** own (Dot-AI Evidence / #799)

[vfarcic/dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799) — *Evidence integrity/provenance labeling, carried through prompt composition and consulted at tool gating.*

That issue owns, and this PRD must not reopen as a Grafana-only design:

1. Integrity / provenance labels that survive prompt composition and reach tool gating
2. Making the host-emitted label **actionable** inside the engine (a host label with nowhere to land is inert — #799's words)
3. Per-operator credential propagation for non-Kubernetes backends (Grafana/Loki/Prometheus tokens), distinct from kubectl impersonation (#401)
4. Related `version` body / provider-identity exposure (see #799)

The optional `evidence` **string field** already landed in the engine (PRD #811 M4). #799 is the **label + gating** half, not a request to invent `evidence` again. When #799 publishes a wire format, this plugin emits it; until then the gate fails closed and we only quote, never arm from, telemetry.

## Requirements

### Implementation

- [ ] Pre-flight panel: safe-time signal from live telemetry/alerts before PR control arms
- [ ] Blast-radius view joins live traffic/alert evidence to impact analysis fields the engine already returns
- [ ] Post-merge verification: metric recovery (or explicit non-recovery) bound to change/PR identity from PRD #5
- [ ] PR control remains disarmed until pre-flight **and** blast radius have rendered (fail closed on missing signal; no waive in first cut)
- [ ] Wire through existing `operate` envelope fields where present; do not fork a second session model without cause
- [ ] Change-path telemetry sent as `evidence`, never merged into trusted `issue`/`intent`
- [ ] Remediate/operate proxy on this path still drops `executeChoice` / apply tokens
- [ ] Optional knowledge write-back path when engine capability exists; no-op when absent
- [ ] **Blocked:** no implementation PR until PRD #5 M2+ exists (test double acceptable for the control mount)

### Documentation

- [x] Document safe-time / blast-radius / PR-gate / verify operator journey (this revision)
- [x] Document dependency on PRD #5 PR path and analysis-only foundation
- [x] Document engine-vs-plugin split lean (OQ1) in Decision Log; maintainer confirm still open
- [x] Document OQ4 bounds and the #799 cross-link
- [x] M1 contract inventory appendix

### Validation (when build is unblocked)

- [ ] Fixture: quiet stack shows honest CLEAR/empty — never silent skip of pre-flight
- [ ] Fixture: degraded/firing stack warns and **keeps PR control disarmed**
- [ ] Fixture: missing datasource / unparseable / oversized pack → DISARMED with named reason
- [ ] Fixture: model/evidence text claiming "safe" does not arm
- [ ] Fixture or e2e: after merge, verify step reports recovery or non-recovery against a known metric bound to a PR id
- [ ] Tests assert no live apply client path; `executeChoice` never forwarded

### User Acceptance

- [ ] Operator can refuse or delay a PR because safe-time says no, with visible evidence
- [ ] Operator can see blast radius grounded in alerts/traffic, not only a static graph
- [ ] Operator cannot click through a missing-signal pre-flight
- [ ] Operator can confirm post-merge whether the target signal recovered for **that** PR

### Launch Activities

- [ ] Enable only when PRD #5 path (or test double) is available for demos
- [ ] Rollout note: analysis-only remains default; safety loop is additive
- [ ] Consent copy updated: change-path Current is quoted as untrusted `evidence`

### Success Metrics

- [ ] Demo path: safe-time → blast radius → GitOps PR → verify, with no plugin cluster apply
- [ ] Zero silent skips of pre-flight in degraded or empty fixtures
- [ ] Zero arming events whose only justification is model prose or a log line

## Success Criteria

- Operator gets an evidence-backed **safe-time** answer before a GitOps PR is opened from Grafana
- Blast radius cites live signal, not only dependency topology
- PR control is physically unable to open until fail-closed rules pass
- Post-merge verification answers whether the agreed metric recovered for that change
- Plugin still never applies live; execute remains GitOps PR only
- Telemetry-aware risk/verify logic is not reimplemented in the plugin if the engine envelope can own it

## Dependencies

- **PRD #1** ([issue #1](https://github.com/vfarcic/dot-ai-grafana/issues/1)) — analysis/Current foundation, untrusted-telemetry write-up, no-execute allowlist
- **PRD #5** ([issue #5](https://github.com/vfarcic/dot-ai-grafana/issues/5)) — GitOps PR mechanism used as execute trigger. **M2+ is a hard gate for this PRD's implementation.**
- Engine `operate` (or equivalent) change-safety envelope and impact fields — [Appendix A](#appendix-a--contract-inventory-m1)
- Grafana stack telemetry available to the plugin (and/or engine via Grafana MCP-style integration)
- **[dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799)** — evidence integrity (other owner). This PRD consumes the eventual wire format; it does not specify engine prompt composition.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Re-implementing operate inside the plugin | Attach to engine envelope; OQ1 lean is engine for telemetry-aware risk/verify; plugin is join + gate |
| Silent skip when telemetry missing | Honest empty/degraded states; fail closed on arming PR |
| Becoming a cluster object manager | Explicit non-goal; Headlamp keeps object lifecycle |
| Blocking all PRs on flaky signals | Clear evidence UI; optional future waive with audit (OQ2, not first cut) |
| Hostile telemetry steers a PR proposal | Quote as `evidence`; ignore as arming input; #799 owns engine-side labels/gating |
| Starting build before a PR control exists | Hard block on PRD #5 M2+ |
| Stealing #799 | Cross-link only; no Grafana-only provenance protocol |
| Treating `impact_analysis.safe` as live-safe | Always join live alerts/traffic; impact loop has no untrusted-content boundary |
| Forwarding `evidence` without dropping execute tokens | Dedicated allowlist: `issue`/`intent`/`evidence` only; still no `sessionId`/`executeChoice` |

## Milestones

- [x] **M1 — Contract inventory** — which `operate` / impact / remediate fields exist today vs what the plugin must join from Current. **Recorded in Appendix A** (this expand). Not a code milestone.
- [ ] **M2 — Safe-time pre-flight UI** — render safe-time from live telemetry/alerts; PR control stays disarmed until shown. **Blocked on PRD #5 M2+.**
- [ ] **M3 — Blast-radius join** — live traffic/alert evidence joined to impact analysis. **Blocked on PRD #5 M2+.**
- [ ] **M4 — Post-merge verify** — metric recovery bound to change/PR identity. **Blocked on PRD #5 M2+** (needs a PR identity to bind).
- [ ] **M5 — PRD #5 integration** — end-to-end: pre-flight → propose GitOps PR → verify (real path or test double)
- [ ] **M6 — Docs + engine/plugin decision recorded** — OQ1 maintainer-confirmed in Decision Log; operator docs updated

## Decision Log

| Decision | Date | Rationale | Impact | Code Impact | Owner |
|----------|------|-----------|--------|-------------|-------|
| Execute trigger is PRD #5 GitOps PR only | 2026-09-03 | Maintainer demarcation: Grafana observes + opens reviewable PRs; no live apply | No apply surface in this PRD | Depends on PRD #5 APIs | Maintainer + contributor |
| Attach to existing `operate` envelope | 2026-09-03 | Avoid a parallel session/workflow model | Requirements reference operate fields | Thin client join, not a new engine | Contributor |
| Headlamp keeps day-2 object lifecycle | 2026-09-03 | Do not duplicate cluster manager UX in Grafana | Object wizards out of scope here | No Build/Update wizard | Maintainer + contributor |
| **OQ1 lean: engine owns telemetry-aware risk and metric-recovery validation; plugin stays thin join + fail-closed disarm gate** | 2026-09-19 | `operate` already owns dry-run, `risks`, policies, `validationIntent`, and post-execute validate (via an internal remediate hop). Grafana/Prometheus MCP attach is already an engine integration. A second risk engine in the plugin would fork the session model this PRD forbids. | New structured fields (safe-time enum, metric-bind, PR-bound verify) are **engine asks** if today's envelope cannot carry them. Plugin work is pack/display/arm. | Docs only on #11. No plugin implementation until #5 M2+. | Contributor lean; **maintainer confirm still open** |
| First-cut arming is hard-gate (no audited waive) | 2026-09-19 | Fail closed is cheaper to loosen than to retrofit | OQ2 remains the waive question; first cut answers "no" | Gate implementation when unblocked | Contributor lean |
| Do not steal [dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799) | 2026-09-19 | Provenance labels + tool gating + per-operator DS credentials are engine behavior; teammate Dot-AI Evidence owns that issue | This PRD only consumes a future wire format and keeps the host gate fail-closed until then | None | Contributor |
| No full-loop build until PRD #5 M2+ | 2026-09-19 | Nothing to arm, and no PR identity to bind verify to | This expand is docs + inventory only | None on this branch | Contributor |

## Open Questions

- [ ] **OQ1 — Engine vs plugin:** Do telemetry-aware risk and metric-recovery validation land in the **engine** (`operate` consuming already-available Grafana MCP-style integrations) or in **this plugin**? **Lean: engine**, because the envelope already owns dry-run / risk / validate. Plugin = join + disarm gate. Waiting on maintainer confirm.
- [ ] **OQ2 — Waive policy:** Is an explicit audited waive of safe-time allowed in the first cut, or always hard-gate? **Lean: hard-gate** (recorded above). Revisit after a demo shows false DISARMED rate.
- [ ] **OQ3 — Knowledge write-back:** Which knowledge write APIs are real today vs planned? `manageKnowledge` ingest exists (see Appendix A); there is **no** typed "verified change outcome" API. First cut: no-op unless a later engine PRD adds one.
- [ ] **OQ4 — Prompt-injection / untrusted telemetry:** When Current packs logs/alerts/traces into engine requests on the change path, how should hostile or malformed signal be bounded so it cannot steer an unsafe PR proposal? **Lean (this PRD):** plugin quotes as `evidence`, caps, fails closed on bad packs, never arms from text. **Engine-side labels and tool gating:** [dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799) (Dot-AI Evidence) — do not specify that protocol here.
- [ ] **OQ5 — Data residency / egress:** Which parts of packed Current and operate session context leave the Grafana process boundary, and what must operators configure for air-gapped or residency-bound deployments? **v1 fact (ADR-0001 §3):** plugin egress is only `apiUrl`; the engine may forward to its configured model. Change-path `evidence` is the same residency class as today's Query Current. No extra plugin egress. Air-gapped adopters run in-cluster dot-ai + in-cluster model; this PRD adds no Cloud dependency.

## Appendix A — Contract inventory (M1)

Read of `vfarcic/dot-ai` `main` on 2026-09-19 via GitHub API (operate / remediate / impact-analysis / operate-execution / manage-knowledge / push-to-git + engine docs). Plugin cites are this repo at the same tip this branch is on (`589cc08` + this docs commit). Rows marked **inferred** were not read from source.

### A.1 `operate` — exists today

**Input** (`src/tools/operate.ts` `OperateInput` / `OPERATE_TOOL_INPUT_SCHEMA`)

| Field | Type / bound | Role | Plugin today |
|-------|--------------|------|--------------|
| `intent` | string, 1–2000 (MCP; REST may not enforce) | Authoritative operator instruction | Not called. Change path must keep Issue here only. |
| `evidence` | string, max 20 000 (MCP; **REST not enforced**) | Quoted untrusted material | Not forwarded. `sanitizeRemediateBody` drops unknown keys. |
| `sessionId` | string | Continue a session | Must **not** send (execute round-trip) |
| `executeChoice` | number, 1=execute | Execute approved plan | Must **not** send |
| `refinedIntent` | string, 1–2000 | Clarification | Out of v1 gate |
| `interaction_id` | string | Eval harness | Do not populate |

**Session / analysis** (`OperateSessionData`, `OperateOutput.analysis`)

| Field | Shape | Enough for this PRD? |
|-------|-------|----------------------|
| `status` | analyzing → analysis_complete → executing → executed_* / failed | Session lifecycle, not safe-time |
| `proposedChanges` | `{create,update,delete}[]` of `{kind,name,namespace?,manifest?,changes?,rationale}` | Touch-list for blast-radius **names**; no live signal |
| `commands` | string[] | Display / verify bind only; never run here |
| `dryRunValidation` | `{status: success\|failed, details}` | Keep; not a telemetry check |
| `patternsApplied` / `capabilitiesUsed` / `policiesChecked` | string[] | Display |
| `risks` | `{level: low\|medium\|high, description}` | **Use as enum** for the gate; `description` is prose (untrusted as arming input) |
| `validationIntent` | string | Model-authored check request. Engine now treats it as **evidence** on the validation hop (`operate-execution.ts`, PRD #811 M4) — not a metric bind |
| `execution.results` | `{command,success,output?,error?,timestamp}` | Post-**execute**, not post-**merge** |
| `execution.validation` | string | Cluster-side narrative after execute. **Gap:** not bound to PR id or a PromQL |
| `visualizationUrl` / `agentInstructions` / `message` | string | Ignore for arming; message is display |

**Exists in envelope:** dry-run, categorical risk, policy names, session id, post-execute validation string.

**Does not exist:** safe-time enum, live-traffic join, alert-firing count, agreed target metric, PR identity, post-merge window, provenance labels.

### A.2 `remediate` — exists today

**Input** (`src/tools/remediate.ts` `RemediateInput`)

| Field | Role | Plugin today |
|-------|------|--------------|
| `issue` | Authoritative instruction | Allowlisted (`sanitizeRemediateBody`); Query Current is **not** attached on Remediate ([PR #75](https://github.com/vfarcic/dot-ai-grafana/pull/75)) |
| `evidence` | Quoted untrusted | **Dropped** by allowlist |
| `mode` | `manual` \| `automatic` | Not forwarded (good — automatic would execute server-side if token allowed) |
| `confidenceThreshold` / `maxRiskLevel` | Automatic-mode brakes | Not forwarded |
| `executeChoice` / `sessionId` / `executedCommands` | Execute path | Dropped / never sent |

**Output** (display vs ignore — aligns with [PRD #1 response contract](1-grafana-ai-cluster-intelligence.md#expansion-response-contract-and-presentation-layer))

| Display | Ignore for this PRD's gate |
|---------|----------------------------|
| `analysis.rootCause`, `confidence`, `factors[]` | `executionChoices`, `nextAction`, `sessionId`, `visualizationUrl`, `agentInstructions` |
| `remediation.summary`, `actions[]` (`command` / `rationale` / `risk` / `kubectlAction`) | `executed` |
| `remediation.risk` | — |
| `remediation.actions[].gitSource` `{repoURL,repoPath,branch,files[]}` | Useful as **display** of where a #5 PR would land; not an arming input |
| `validationIntent` | Same caveat as operate |
| `investigation.dataGathered[]` | Untrusted cluster text |

Engine remediate **already creates GitHub PRs** on execute when the workload is Argo CD / Flux managed (`docs/ai-engine/tools/remediate.md`). That is the server capability PRD #5 fronts. This PRD binds verify to the PR that #5 (or that execute path) returns — it does not create the PR.

### A.3 `impact_analysis` — exists today, topology-shaped

| Field | Shape | Gap |
|-------|-------|-----|
| `input` | string, max 5000 (kubectl / YAML / prose) | No structured touch-list in; we would stuff names as text |
| `safe` | boolean | Dependency/safety judgment, **not** live traffic. Fail-closed: `safe=true` + firing alerts still DISARMS |
| `summary` | string | Prose; **this loop has no untrusted-content boundary** |
| `sessionId` / `agentInstructions` | — | Ignore for arming |

No structured `touchedResources[]`, no alert join, no PromQL. Blast radius in this PRD is **engine impact + plugin/engine live join**, not `safe` alone.

### A.4 Knowledge write-back — exists, untyped for this use

`manageKnowledge` (`src/tools/manage-knowledge.ts`): `ingest` \| `search` \| `deleteByUri` with `content`, `uri`, `metadata`.

**Inferred:** we *could* ingest a markdown note of "PR #1842 recovered checkout 5xx." There is no schema for change identity, metric, or verify result. OQ3 first cut = **no-op**.

`pushToGit` (`src/tools/push-to-git.ts`) is the **recommend / solutionId** PR path (`sol-…`, `pullRequest: true`). Different job from remediate GitOps PR and from PRD #5. Do not reuse as this PRD's execute trigger.

### A.5 Engine MCP attach (telemetry-aware path already exists server-side)

`docs/ai-engine/setup/deployment.md` **MCP Server Integration**: dot-ai is an MCP **client**; Prometheus / Jaeger / Grafana / others attach per-tool via `mcpServers[].attachTo` (`remediate`, `operate`, `query`).

This is the main reason OQ1 leans engine: the engine can already pull Prom metrics during `operate` analysis if an operator deploys and attaches those servers. What it cannot yet return is a **stable, typed** safe-time / metric-recovery object for a host UI to gate on.

### A.6 Plugin surface today (this repo)

| Surface | Today | Gap for this PRD |
|---------|-------|------------------|
| Tools proxied | `query`, `remediate`, `version` | No `operate`, no `impact_analysis` |
| Remediate body | `issue` + optional `intent` only | Need `evidence` on change path; still forbid execute keys |
| Query Current | Loki 30 lines / Prom 8 series / Tempo 5 / AM 8 alerts / 15m window; `currentEmpty` fail-closed helper | Not used on Remediate; not typed as safe-time |
| Consent | Query-only evidence toggle | Change path needs its own honest copy |
| Role gate | Editor+ on tool routes | Keep; #5 will add a stricter PR-create gate |
| Apply / operate UI | Consent-by-design tests assert zero Operate button | Keep forever |

### A.7 Proposed join keys (not in any API today — **inferred / asked**)

If OQ1 lean holds, the **engine** should eventually emit something a host can switch on. This table is the ask, not an invented plugin schema to ship before the engine PRD:

| Key | Purpose | Suggested owner |
|-----|---------|-----------------|
| `safeTime.status` | `clear` \| `degraded` \| `missing` | Engine (MCP + cluster), echoed by plugin if engine absent |
| `safeTime.window` | e.g. 15m | Shared with Current `WINDOW_MS` |
| `blast.touched[]` | kind/name/namespace | Engine `proposedChanges` + impact |
| `blast.live[]` | firing alerts / error-ratio on those names | Engine MCP **or** plugin join |
| `risk.level` | already `operate.analysis.risks.level` | Engine (exists) |
| `verify.metric` | PromQL or Grafana UID+expr agreed at pre-flight | Operator + plugin store; engine validate hop consumes |
| `verify.changeId` | PR URL / number / head SHA from #5 | Plugin join |
| `verify.result` | `recovered` \| `not_recovered` \| `failed` | Engine prefer |
| `evidenceIntegrity` | provenance labels | **#799 only** |

Until those exist, the plugin may **render** Current + `risks.level` + `impact_analysis.safe` and still **disarm** — it must not invent a local risk model that claims to be `operate`.

### A.8 Inventory verdict

| Need | Today | Action |
|------|-------|--------|
| Dry-run / policy / categorical risk / session | `operate` | Display |
| Topology blast radius | `impact_analysis.safe` + `proposedChanges` | Display + live join |
| Live safe-time | Plugin Current (Query only) + optional engine MCP | Plugin render; engine judgment preferred |
| Post-execute cluster validate | `execution.validation` string | Not sufficient for post-merge metric |
| Post-merge metric × PR id | **Missing** | Engine ask + plugin bind |
| Evidence string channel | Exists; plugin drops it | Forward on change path when building |
| Evidence **labels** + tool gating | **Missing** | #799 (do not steal) |
| GitOps PR from Grafana | Engine execute can; plugin cannot | PRD #5 |
| Fail-closed host gate | Partial (`currentEmpty`, no-execute allowlist) | This PRD, after #5 M2+ |

## Status / Progress

- **Phase:** Draft (design expanded; still not an implementation PR)
- **Overall:** 17% (1 of 6 milestones — M1 docs inventory only)
- **Implementation:** not started — **blocked on PRD #5 M2+**
- **Validation:** not started
- **Launch:** not started
- **Next:** maintainer confirm on OQ1 lean; wait for PRD #5 M2 (or a test-double PR control) before any plugin code; consume #799 wire format when Dot-AI Evidence publishes it

## Work Log

### 2026-09-03 — landable draft

- Added this PRD as design-only tracking for issue #7 (draft PR #11).

### 2026-09-19 — build-ready expand (docs only)

- Inventoried `operate` / `remediate` / `impact_analysis` / knowledge / MCP attach against `vfarcic/dot-ai` source; marked inferred rows.
- Added ASCII journey: safe-time → blast radius → PR gate → post-merge verify.
- Wrote fail-closed arming state machine and OQ4 plugin bounds.
- Recorded OQ1 lean (engine for telemetry-aware risk/verify; plugin = join + gate).
- Cross-linked [dot-ai#799](https://github.com/vfarcic/dot-ai/issues/799); explicitly out of scope.
- Hard-blocked M2–M5 on PRD #5 M2+. No product code in this PR.
