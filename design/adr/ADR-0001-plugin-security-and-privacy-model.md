# ADR-0001: Plugin security and privacy model

- **Status:** Accepted (binding for PRDs #1, #2, #4)
- **Date:** 2026-09-03
- **Deciders:** Plugin companion maintainers (design); upstream engine items deferred to Viktor (see §Open questions)
- **Evidence base:** SecAudit security review of this branch (`ai/quality-review`), cited as `file:line` below. Concurrent code changes after the audit do not rewrite this model — they implement it.
- **Convention note:** This repository had no prior `design/` or ADR layout. This file establishes `design/adr/ADR-NNNN-…md` as the convention (Context → Decision → Consequences → Alternatives; decision tables where useful).

## Context

The Grafana app plugin is a **companion UI** to the dot-ai engine (PRD #1 DD11). It:

1. Packs live Grafana observability evidence (Loki, Prometheus, Tempo, Alertmanager) into natural-language `intent` / `issue` text.
2. Proxies that text through a Go backend (`pkg/plugin/`) to dot-ai with a bearer token.
3. Returns analysis only in v1 — no cluster apply from the plugin (PRD #1 DD3, DD9; PRD #2 owns GitOps-PR execute later).

So **cluster log content becomes prompt content**, and **prompt content reaches an LLM**. Grafana RBAC and Kubernetes / dot-ai RBAC are disconnected. One shared service token is the v1 identity model (PRD #1 DD4). Several controls already shipped without an overarching model; this ADR is that model so PRDs stop re-litigating security per pull request.

### As-audited controls (evidence)

| Control | Behaviour today | Cite |
|--------|-----------------|------|
| Token storage | Single shared token in Grafana `secureJsonData.apiKey`; backend-only decrypt | `pkg/plugin/app.go:55-56` |
| Upstream auth | `Authorization: Bearer <token>` on probe and tool proxy | `pkg/plugin/resources.go:386`, `resources.go:707` |
| SSRF / URL gate | `validateAPIURL` requires absolute `http`/`https` with host; rejects other schemes; plaintext `http` only for loopback, RFC1918, or in-cluster DNS | `pkg/plugin/resources.go:442-480` |
| Read-only remediate | `sanitizeRemediateBody` allowlists analysis fields; drops execute/apply/session tokens | `pkg/plugin/resources.go:542-566` |
| Draft-URL probe | Org Admin required to test a draft `apiUrl`; SEC-01 never reuses saved key against a different draft URL | `pkg/plugin/resources.go:329-345` |
| Response envelope | Proxy returns stable `{ok,status,summary,error}`; never reflects raw upstream body; maps 401/403 → 502 | `pkg/plugin/resources.go:742-761` |
| Body caps | Request 1 MiB; upstream response 8 MiB | `pkg/plugin/resources.go:671`, `727` |
| Ask log | Optional (`debugLog`, default off); JSONL on Grafana data path; size rotate 1 MiB → `.1`; preview strips top-level secret **keys** only (not secrets inside log lines); entry had no user/org fields at audit time | `pkg/plugin/app.go:33-54`; `resources.go:60-84`, `132-148`, `236-271` (SecAudit) |
| Evidence packing | Cluster-wide LogQL when no ns/pod; `textLinesFromFrames` whitespace-collapses only; packed under `Current:` with user text after as `Question:`/`Issue:` | `src/utils/grafanaStack.ts:45-46`, `282-306`; `progressiveContext.ts:97-122` |
| Evidence opt-out | `sendGrafanaEvidence=false` skips stack fetch; consent banner is informational only | `src/utils/askOrchestrator.ts:356-359`; `src/pages/DotAIPage.tsx:169-176` |
| UI / route role gate | Configuration page `role: Admin`; tool resource routes require Grafana **Editor+** before any engine proxy call (Decision §1; fail closed if no user) | `src/plugin.json:27-41`; role helpers in `pkg/plugin/resources.go` |
| Drilldowns | Explore links are UI-only; never POSTed | `src/utils/progressiveContext.ts:14-15` |

### Threat classes in scope

1. Prompt injection via evidence  
2. Privilege escalation across RBAC boundaries (Grafana vs Kubernetes / dot-ai)  
3. Data egress and residency  
4. Data at rest (ask logs)  
5. Attribution and audit  
6. Tenancy (multi-org Grafana)  
7. Secret echo (model returns secrets seen in evidence)  
8. Consent  

## Decision

### 1. Auth model

**v1 decision: shared service token** (honours PRD #1 DD4).

- Operators configure one dot-ai API token in plugin settings (`secureJsonData.apiKey`). The backend attaches it on engine proxy calls for the tool routes.
- The token **must** be a no-`apply` / analysis-capable credential (PRD #1 DD3 layer b). Documented role naming is an upstream question (PRD #1 Open Question 1; §Open questions).
- **Cross-RBAC gap (Grafana vs Kubernetes / dot-ai):** a shared service token means the engine hop is only as constrained as the Grafana role gate in front of it. Datasource ACLs bound the browser-side evidence hop only — not the engine hop. Without an Editor+ (or stricter) gate on the tool routes, lower Grafana roles could invoke engine reach they do not have via `kubectl` (SecAudit finding #1). This ADR requires the gate below; do not ship tool routes ungated.

**v1 mitigation (required, not optional):**

- **Role-gate** the tool resource routes so only Grafana **Editor** or **Admin** (org role) may invoke the engine proxy. Reuse the existing `isOrgAdmin` / `UserFromContext` pattern in `pkg/plugin/resources.go`. Deny with 403 before any upstream dial; fail closed when the request has no user. Viewers may still open the page if product wants read-of-UI, but must not trigger engine calls. Exact minimum role: **Editor** (operators who already edit dashboards); Admin-only is acceptable if an adopter is stricter — default ship gate is Editor+.
- Configuration and draft-URL test-connection remain Admin-only (already true for draft URL and config page).

**Trigger that forces per-user identity (Dex/OAuth):** any of:

- Multi-tenant / multi-org production use where a single no-apply token is still too wide; or  
- PRD #2 GitOps-PR execute shipping (PR create is a privileged write to SCM — must not share the analysis token and must attribute the actor); or  
- Compliance requirement for per-user audit on the engine side.

Until then, per-user OAuth/Dex forwarding remains **out of v1 scope** (PRD #1 DD4) but is the documented destination (idea I-003). When enabled, plugin forwards Grafana user identity in a form the engine accepts; static token remains the fallback for single-tenant labs.

**Accepted residual for v1:** after the Editor+ gate, every Editor still shares one K8s-side principal. That is explicit, not accidental.

### 2. Privacy model (what may be packed; redaction)

**What may be packed into an Ask (when `sendGrafanaEvidence` is true):**

- Aggregated / sampled observability facts the signed-in Grafana user can already query through configured datasources: recent log lines, metric samples, trace summaries, firing alerts.
- User-authored question/issue text and condensed Prior turns.
- Stable tool preamble (analysis-only instructions).

**What must not leave the browser unredacted:**

- Credential-shaped material in evidence lines (Bearer tokens, `apiKey=`, PEM blocks, `password=`, cloud provider access keys, `eyJ` JWT-shaped strings) — strip or mask before pack.
- Authorization headers and plugin settings secrets (already backend-only; never put in intent).
- Explore/Drilldown URLs are UI-only and must never be POSTed (already true).

**Where redaction belongs:**

| Layer | Role | v1 mandate |
|-------|------|------------|
| **Client (pack path)** | First cut: redact/mask secret-shaped substrings in evidence lines **before** `buildRequestText`; fence evidence so it cannot forge packet markers | **Required** — earlier for honest UI use; not sufficient alone |
| **Backend proxy** | Second cut on `intent`/`issue` body: same secret-shaped redaction; never log raw Authorization; keep envelope-only responses | **Required** — closes non-UI callers that skip the client pack path |
| **Engine** | Authoritative long-term redaction, retention, and model-provider policy | **Preferred upstream**; plugin must not assume it exists yet (§Open questions) |

**Why client + backend, not client-only:** client-only is earlier (less data on the wire from honest UI use) but weaker (any non-UI caller of the resource API skips it). Backend-only is later (data already left the browser). **Both** for secret-shaped patterns; engine remains the right place for org-wide policy and provider-side guarantees.

**Evidence is untrusted input** — see §5 Prompt injection. Redaction is not a substitute for injection hardening.

### 3. Data egress and residency

**Sovereignty positioning (PRD #1 DD9 / wedge 3):** this plugin targets **self-managed Grafana** talking to an operator-controlled dot-ai deployment. It does not require Grafana Cloud. The LLM is whatever the **dot-ai engine** is configured to use — the plugin does not select or host a model.

**v1 decisions:**

- Plugin egress is only to the configured `apiUrl` (dot-ai). No direct OpenAI/Anthropic/etc. calls from the plugin.
- `apiUrl` validation stays fail-closed on non-http(s) and hostless URLs (`validateAPIURL`). Plaintext `http` remains allowed **only** for loopback / RFC1918 / in-cluster DNS for lab and in-cluster installs; public hosts require `https`.  
  - Note: PRD #1 NFR text asked to block RFC1918 unless allowlisted; **shipping behaviour is the opposite default for cluster-local DX**. This ADR **accepts** the code’s https-except-cluster-local rule for v1 and does **not** require a second allowlist UI. Adopters who need stricter SSRF deny private targets at the network policy layer.
- **Residency / model choice is an engine and operator concern**, not a plugin toggle. Install docs must state: packed evidence (logs, metrics samples, alerts, user questions) is sent to the configured dot-ai server and may be forwarded to that server’s configured LLM provider. Sovereignty-minded adopters run dot-ai with an in-cluster or contractually bounded model.
- No silent secondary telemetry egress from the plugin.

### 4. Data at rest (ask logs)

**Facts:** optional JSONL ask log on the Grafana data PVC; default **off** (`debugLog`); size-based rotation only (1 MiB → `.1`); preview retains up to 4096 runes of packed body after stripping top-level secret keys — **secrets inside log lines still pass through** (SecAudit #4).

**v1 decisions:**

- Size-based rotation is **capacity management, not a retention policy**.
- **Retention policy when `debugLog` is on:** retain at most **7 days** or **2 rotated segments** (current + `.1`), whichever prunes first. Implement time-based purge on append or a cheap startup sweep. Document that previews can contain evidence and must be treated as sensitive.
- Ask-log access = filesystem access to the Grafana data path (same trust as Grafana itself). Do not expose ask logs through a plugin HTTP API in v1.
- Redact secret-shaped substrings in `askBodyPreview` the same way as the pack path (defense in depth).
- Attribution fields on each line — see §6.
- Default remains **off**. Enabling `debugLog` is an operator choice that expands the at-rest surface; the consent banner should mention logging when debug is on **[INFERENCE: UI copy follow-up]**.

### 5. Prompt injection (first-class)

**Decision: packed evidence is untrusted input.** Anything that can write a log line can write into the prompt. For a product that later proposes remediations (PRD #2 / #4), that is an attack path on the change proposal itself. SecAudit rated this **HIGH / unmitigated** aside from size caps and analysis-only execute strip.

**v1 mitigations (all required before treating remediate text as actionable input to PRD #2):**

1. **Delimiter / fencing.** Evidence blocks (`Current`, `Prior`, `Map`) are clearly delimited from instruction and from `Question:`/`Issue:`. Evidence lines are escaped or prefixed so a log line cannot introduce a raw `Question:`, `Issue:`, `Current:`, or tool-preamble line that the packer treats as structure (`progressiveContext.ts:110-122` is the structure to harden).
2. **Strip instruction-shaped content from evidence.** Before pack, drop or neutralize evidence lines that look like role/system instructions, “ignore previous”, or forged section headers.
3. **Stable preamble stays authoritative.** The analysis-only preamble (`progressiveContext.ts:35-40`) is plugin-owned instruction. Evidence must not override “analysis only / no mutate.”
4. **Evidence never authorises an action.** No apply from this plugin in v1 (DD3). PRD #2 execute = GitOps PR only after human review; PRD #4 safe-time / pre-flight must not treat model prose or evidence text as a substitute for RBAC, MOP/CRA, or merge approval. Model output is **advisory**.
5. **Blast-radius bounds already present stay:** intent cap (`MAX_INTENT_CHARS`), line caps, no drilldown POST, remediate body allowlist, no-apply token. These bound damage; they do not fix injection.

**Explicit non-goal for v1:** perfect prompt-injection immunity. Goal is **structured untrusted evidence + never-auto-execute**.

### 6. Attribution and audit

**v1: every engine Ask that is logged or proxied must be attributable to a Grafana user where the backend can see one.**

Minimum audit record for an Ask (ask log when enabled; and any future metrics):

| Field | Purpose |
|-------|---------|
| UTC timestamp | When |
| Grafana user login (or stable id) | Who |
| Grafana org id | Which tenant |
| Grafana org role | Authz context |
| Tool (`query` / `remediate`) | What API |
| Status / error class | Outcome |
| Redacted body preview | What was asked (sensitive) |
| Hop meta (optional) | Progressive-context diagnostics |

- Source: `backend.UserFromContext` (already used for the admin gate at `resources.go:568-574`). Nil user → record `unauthenticated` / deny the call if role-gate is enforced.
- Shared token remains on the wire to dot-ai in v1; engine-side logs still cannot split users until I-003. **Plugin-side attribution is mandatory** so local audit can answer “who asked.”
- Do not put the API token or `Authorization` header into logs (already stated in code comments).

### 7. Tenancy

**v1 decision: single-tenant assumption with honest documentation.**

- One plugin configuration (one `apiUrl` + one token) per Grafana plugin instance. No per-org token map in v1.
- Ask log path must not silently mix orgs without labels: every entry carries `orgId`; if multiple orgs share one Grafana process and one plugin config, that is **accepted only when operators understand they share one dot-ai principal**. Prefer documenting “one Grafana org ↔ one plugin config ↔ one dot-ai token” as the supported layout.
- **Deferred:** per-org `apiUrl`/token, org-scoped log files, and denying cross-org use. Forced earlier if a multi-org production deploy is claimed.

### 8. Consent

**v1 decision: informational consent is required when evidence is sent; recorded consent is deferred.**

- When `sendGrafanaEvidence` is true, show the banner (`DotAIPage.tsx:169-176`) stating that Grafana datasource facts go to the configured dot-ai server (and may reach that server’s LLM).
- Banner must remain visible (not a one-click dismiss that is forgotten) **or** be paired with a settings acknowledgement. v1 keeps the always-on info alert; no separate legal “I agree” store.
- `sendGrafanaEvidence=false` is the operator off-switch (skips fetch and hides banner).
- **Deferred:** durable per-user consent ledger, timestamp of acknowledgement, IdP-linked privacy notice version. Revisit if a regulated adopter requires it.

### 9. Secret echo

**v1 decision: mitigate in depth; accept residual model risk.**

- Redaction on pack + proxy (§2) reduces secrets reaching the model.
- UI may later offer a “response may contain sensitive data” notice when evidence was sent **[INFERENCE: copy]**.
- Plugin does not post-filter model prose for secrets in v1 (high false-positive cost; engine is the better layer). Operators treat remediate suggestions as untrusted text (PRD #1 NFR).
- Envelope-only proxy already prevents raw upstream dump (`resources.go:742-748`).

---

## Decision table (eight threat classes)

| Threat | Decision for v1 | Deferred to | Owner |
|--------|-----------------|-------------|--------|
| **1. Prompt injection via evidence** | Treat evidence as untrusted; fence/escape section markers; strip instruction-shaped evidence lines; analysis-only + human gate before any PRD #2 action; size caps remain | Stronger engine-side prompt firewall; PRD #2/\#4 refuse evidence-only authorisation | Plugin (pack + docs); engine for deep filter |
| **2. Privilege escalation (Grafana RBAC ≠ K8s RBAC)** | **Accepted only with Editor+ (or Admin) role-gate on `/query` and `/remediate`**; shared no-apply token; Viewer must not invoke engine | Per-user Dex/OAuth (I-003) when trigger hits; documented no-apply role name | Plugin (route gate); engine (token RBAC); operator (token mint) |
| **3. Data egress / residency** | Egress only to configured dot-ai; https-except-cluster-local; sovereignty = operator’s engine/LLM choice; no plugin-side model calls | Optional stricter SSRF allowlist UI; Cloud track (PRD #1 DD10 out of scope) | Plugin (URL gate + docs); engine/operator (LLM residency) |
| **4. Data at rest** | `debugLog` default off; when on: ≤7 days or 2 segments + secret-shaped redaction in preview; no HTTP API to logs | Encryption-at-rest beyond Grafana PVC norms; central SIEM ship | Plugin |
| **5. Attribution / audit** | Record login + org id + role on ask-log lines; role-gate implies authenticated user | Engine-side per-user identity (I-003 / Dex) | Plugin (log fields); engine (OAuth) |
| **6. Tenancy** | Supported layout = one org ↔ one config ↔ one token; label org on logs; shared token across orgs is discouraged | Per-org credentials and isolation | Plugin + operator |
| **7. Secret echo** | Client + backend secret-shaped redaction before egress; advisory UI; no v1 response scrubber | Engine output filtering / provider-side controls | Plugin (redact); engine (preferred long-term) |
| **8. Consent** | Informational banner whenever evidence send is on; off-switch via `sendGrafanaEvidence` | Durable consent ledger / notice versioning | Plugin (banner); legal/operator if regulated |

---

## Consequences

### Positive

- PRDs #1, #2, and #4 share one security vocabulary; PRs cite this ADR instead of rediscovering threat trade-offs.
- Cross-RBAC privilege gap (Grafana role vs shared engine token) is named and gated rather than silent.
- Prompt injection is a design input to PRD #2/\#4, not a post-incident surprise.
- Sovereignty story stays coherent: plugin is a thin client; residency lives with dot-ai + LLM choice (DD9, DD11).

### Negative / cost

- Editor+ gate is a product behaviour change vs broader authenticated access to Ask.
- Dual redaction (client + backend) is duplicate logic to maintain.
- Time-based log retention is new behaviour beyond size rotate.
- Shared token still cannot give engine-side per-user audit until OAuth work lands.

### Neutral bindings already taken

- Analysis-only v1 and GitOps-PR-only execute (PRD #1 DD3/DD9, PRD #2) remain load-bearing security controls, not just UX preferences.
- Companion-vs-core (DD11): new intelligence/RBAC verbs land in dot-ai first.

## Alternatives considered

| Alternative | Why not for v1 |
|-------------|----------------|
| **Per-user OAuth/Dex from day one** | Correct end-state for multi-tenant audit; blocked on engine HTTPS/Dex setup and plugin identity forwarding. PRD #1 DD4 already deferred it. Triggers listed above. |
| **Admin-only Asks** | Safer than Editor+; too narrow for the intended operator workflow (dashboard Editors diagnosing). Adopters may tighten locally. |
| **Leave tool routes ungated** | SecAudit HIGH; would leave the Grafana↔engine RBAC gap open. Rejected. |
| **Client-only redaction** | Skipped by non-UI callers of the resource API. Insufficient alone. |
| **Backend-only redaction** | Honest UI still ships secrets to the browser memory/network path longer than needed. Insufficient alone. |
| **Block all RFC1918 `apiUrl`** | Matches a strict reading of PRD #1 NFR; breaks default in-cluster Grafana→dot-ai HTTP. NetworkPolicy is the stricter tool. |
| **Always-on ask log** | Expands PVC sensitive data without operator intent. Keep opt-in. |
| **Recorded click-wrap consent** | No legal requirement identified for the default OSS audience; banner + off-switch enough until a regulated adopter asks. |
| **In-plugin response secret scrubber** | High false positives on K8s-ish strings; engine/provider better placed. |
| **In-plugin kubectl apply path** | Explicitly rejected (PRD #2); would collapse the injection and RBAC story. |

## Open questions for Viktor

These are **upstream engine / project** decisions. The plugin will not invent answers that bind the core. PRD #1 Open Question 1 is the parent of (1).

1. **Documented no-apply RBAC role** — Is there (or will there be) a named dot-ai role meaning “read + analyze, no `apply`” that install docs should cite? (PRD #1 OQ1; PRD [vfarcic/dot-ai#392](https://github.com/vfarcic/dot-ai/issues/392).)
2. **Engine-side redaction** — Should secret-shaped and prompt-injection filtering be **guaranteed in the engine** for all surfaces (Headlamp, Grafana, MCP, CLI), with companions as defense in depth only?
3. **Identity forwarding contract** — Preferred header/claim shape when a companion forwards end-user identity to dot-ai under Dex/OAuth (so I-003 and Headlamp stay aligned)?
4. **Model/residency disclosure** — Any standard engine API or status field companions should surface so the UI can say which provider/region will see the prompt, or is that config-doc-only?
5. **PRD #4 change-safety boundary** — Confirm engine vs plugin ownership for telemetry-aware risk (PRD #4 open architectural question); this ADR only requires that **evidence and model output never alone authorise mutation**.

## Public-surface check

This ADR was written for a **public** repository (and a public fork of upstream). It contains **no** real secrets, tokens, internal hostnames, or internal organisation names. Cites use in-repo paths and public GitHub issue links only. Plugin id `lesleymurfin-dotai-app` appears only as already-published plugin metadata. Describe **required controls**, not step-by-step reproduction of unpatched weaknesses — see `docs/security-disclosure.md`.

## References

- PRD #1 — Design Decisions DD3, DD4, DD8, DD9, DD11; NFR Security; Open Questions 1, 6  
- PRD #2 — GitOps-PR execute; no in-plugin apply; token split  
- PRD #4 — Evidence-grounded change safety; human gate; GitOps-only write path  
- SecAudit review (branch `ai/quality-review`) — threat verdicts and file:line evidence above  
- Idea I-003 — pass Grafana user identity for audit attribution (OPEN until OAuth trigger)
