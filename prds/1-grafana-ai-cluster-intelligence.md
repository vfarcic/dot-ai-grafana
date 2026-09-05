# PRD: Grafana App Plugin for AI-Powered Kubernetes Cluster Intelligence

**Issue**: [#1](https://github.com/vfarcic/dot-ai-grafana/issues/1)
**Priority**: High
**Status**: Implemented (Phase 1 v1)
**Updated**: 2026-09-01
> **How this revision is organized:** This is **PRD #1 as written on `main`**, with build-ready detail layered directly on top of it. Under every `##` heading you will find the **original section text first** (unchanged — same words, same bullets, same milestones), then one or more `### Expansion:` blocks. Expansions are **additive only**. Strip every Expansion block (and the reviewer appendices) and you get the original PRD back byte-for-byte. We are not rewriting the PRD; we are building on it.

## Problem Statement

Teams using Grafana for Kubernetes observability must context-switch to separate tools when they want to:
- Ask natural language questions about their cluster resources (e.g., "show all failing pods in production")
- Get AI-powered analysis of cluster issues (e.g., "why is my-app crashing?")

This breaks workflow, adds friction, and creates a gap between observing a problem in Grafana and understanding it through AI-powered analysis.

### Expansion: Competitive landscape & differentiation

Grafana ships fast-moving, first-party AI, so this plugin must earn its place rather than duplicate it.

**What Grafana already does (2026):**
- **Grafana Assistant** — agentic LLM in the UI: NL over metrics/logs/traces, dashboard generation, and **Assistant Investigations (GA)** (points at an alert, explores signals, builds hypotheses, writes a report). **Availability caveat (verified):** self-managed requires **Grafana v13+** *and* a connected Grafana Cloud stack (pre-installed in Enterprise 13.1+); **not available on self-managed v11/v12**.
- **Sift** — automatic ML Kubernetes diagnostics (crashes, resource contention) over cluster signals.
- Viktor's own demo ([*"I Stopped Staring at Dashboards"*](https://www.youtube.com/watch?v=HI6KleJAZPY), 2026-05-25) walks through exactly this, and names the key limit: Grafana Assistant **"does only analysis … it cannot fix it — analysis without remediation is pointless."**

| Capability | Grafana Assistant / Sift | dot-ai plugin |
|---|---|---|
| NL query + AI analysis of **telemetry** in the UI | ✅ native, GA | ⚠️ overlaps — do not compete here |
| Reasons over **live K8s API state** (resources, capabilities, health) | ✗ telemetry-centric | ✅ **wedge 1** |
| **Remediation** — GitOps PR / kubectl fix, RBAC-gated | ✗ "cannot fix it" | ✅ **wedge 2** (strongest; PRD #1-out-of-scope today — see DD9) |
| Deploy / recommend manifests | ✗ | ✅ |
| **Sovereign** — in-cluster, your own LLM, no Grafana Cloud | ⚠️ Cloud-backed | ✅ **wedge 3** |

**Honest read.** The "redundant with Grafana Assistant" risk is **real only for Grafana Cloud users or self-managed v13+ shops willing to tether to Grafana Cloud**. For self-managed **v11/v12** (the reference deployment is Grafana **11.4**), air-gapped, or sovereignty-minded teams, Assistant is simply unavailable — so dot-ai in Grafana is the *only* way to get AI cluster intelligence in the UI, and the overlap largely evaporates. Even so, as *scoped* (analysis-only) this plugin captures wedges **1 (K8s-state)** and **3 (sovereign)** but omits **2 (remediation)** — dot-ai's biggest differentiator — and it overlaps `dot-ai-headlamp`, which already delivers the full dot-ai experience in a cluster UI. Net: **clearly worth building for self-managed / sovereign / pre-13 Grafana users** (which includes the reference deployment); for Grafana-Cloud/v13+ users the case rests on wedges 1/2. Positioning call: Design Decision 9 / Open Question 6.

_Sources: video `HI6KleJAZPY`; Grafana Assistant Investigations (GA) + Sift, and the self-managed **v13+ / Grafana-Cloud-required** constraint (Grafana docs, 2026); dot-ai remediate GitOps PR path (`docs/ai-engine/tools/remediate`)._

**OSS reality — Grafana gives you a socket, not a brain.** Grafana **OSS** ships no built-in
assistant; what it ships is *plumbing*: the **LLM app plugin** (a secure connector to
OpenAI/Azure OpenAI) and the **`mcp-grafana` MCP server** (grants an external AI access to your
Grafana instance). Both are building blocks whose explicit purpose is *bring your own intelligence*.
So on a self-managed OSS stack the real choice is not "dot-ai vs. Grafana Assistant" — Assistant
isn't available — it is "build an assistant yourself on the LLM plugin, or plug in an external
brain through the MCP server Grafana already provides." **dot-ai is that brain**, and the two were
built to snap together: Phase 3 evidence work (mcp-grafana + Kubeshark) consumes that socket
exactly as intended. Even a DIY assistant built on the OSS plumbing would still hit the same
ceiling as Cloud — *observe/explain within Grafana*, with **no live-K8s-state grounding, no
execute path, and no second (Headlamp) surface** — the three things dot-ai adds.

## Solution Overview

A Grafana App Plugin that embeds two read-only dot-ai tools directly into Grafana:

1. **Query** — Natural language questions about Kubernetes cluster resources
2. **Remediate (Analysis Only)** — AI-powered issue analysis without execution capability

The plugin provides a simple interface: tool selector, text input for the intent, and a response area that renders the model's own GFM markdown (headings, lists, tables, code blocks, links) as sanitized HTML. **Amendment (2026-09-05, Design Decision 12):** this retires the *rendering* half of the original text-only decision only — the plugin still never requests rich visualizations from dot-ai (no `[visualization]` prefix; see the tool→endpoint map below and Design Decision 1).

### Expansion: Tool → endpoint map

| Tool | Endpoint | Method | Request body | Notes |
|------|----------|--------|--------------|-------|
| Query | `/api/v1/tools/query` | POST | `{ "intent": "<text>" }` | Single-shot; `intent` 1–1000 chars. Send the **plain** intent — **do not** prefix `[visualization]` (that switches the tool into rich-visualization mode). |
| Remediate | `/api/v1/tools/remediate` | POST | `{ "issue": "<text>", "mode": "manual" }` | Analysis; execute round-trip (`sessionId`+`executeChoice`) not used. |
| System status | `/api/v1/tools/version` | POST | `{}` | Powers Test-connection **and** the always-visible cluster context: `data.result.system.kubernetes.{connected,context}`. |

Both tool calls are instances of dot-ai's universal `POST /api/v1/tools/{toolName}` endpoint; one dot-ai server serves MCP, CLI, and REST simultaneously — **no server configuration beyond a token is required.**

### Expansion: Response contract and presentation layer

dot-ai wraps every REST response in a standard envelope:

```jsonc
{
  "success": true,
  "data": { "result": { /* tool-specific */ }, "tool": "query", "executionTime": 1234 },
  "error": { "code": "…", "message": "…", "details": {} }, // only when success=false
  "meta": { "timestamp": "…", "requestId": "…", "version": "…" }
}
```

dot-ai's tools are built for an *LLM agent*, so `data.result` carries **structured JSON plus agent-oriented fields** (`agentInstructions`, `sessionId`), not a prose string. The plugin extracts the human-readable content per tool (confirmed against source and against how `dot-ai-headlamp` unwraps `data.result`):

| Tool | Render (as markdown) | Ignore in the UI |
|------|----------------|-----------------------------|
| `query` | **`data.result.summary`** (`QueryOutput.summary`, `src/tools/query.ts` L54) | `agentInstructions`, `sessionId`, `visualizationUrl`, `iterations`, `toolsUsed` |
| `remediate` | `message`, `analysis.rootCause`, `analysis.confidence`, `analysis.factors[]`, `remediation.summary`, `remediation.actions[]` (`command`/`rationale`/`risk`), `guidance` | `executionChoices`, `nextAction`, `sessionId`, `visualizationUrl`, `agentInstructions` |
| `version` | `system.kubernetes.context` (shown as the active-cluster label) | everything else |

A **"Show raw response" toggle** always exposes the full `data.result` payload — a safety net if a field mapping drifts across dot-ai versions.

### Expansion: Auth header

dot-ai's auth middleware (`src/interfaces/oauth/middleware.ts` L38–39) reads **`X-Dot-AI-Authorization` first, then `Authorization` as fallback** — so a direct caller may use either. Our Go backend calls dot-ai directly and sends `Authorization: Bearer <token>`. `dot-ai-headlamp` uses the custom `X-Dot-AI-Authorization` header because it proxies through the K8s API server, which consumes `Authorization`; we send the custom header **only** when the deployment is configured to route through such a proxy (not both unconditionally).

### Expansion: Prior art — dot-ai-headlamp

Viktor's existing dot-ai UI plugin already answers our hardest questions with production choices we adopt:
- **Transport**: reaches dot-ai via Headlamp's **K8s API proxy** (`ApiProxy.request`). Grafana has no equivalent proxy → our Go-backend + `apiUrl` + token is the correct Grafana-native equivalent.
- **Timeout**: `AI_TOOL_TIMEOUT = 30 min` for all AI tools; `DEFAULT_TIMEOUT = 30 s` otherwise — AI calls are long (see [Timeout & long-call strategy](#timeout--long-call-strategy)).
- **Auth**: `X-Dot-AI-Authorization: Bearer <token>` (see above).
- **Presentation**: unwraps `data.result` (`src/api/client.ts` L89).
- **Read-only vs not**: Headlamp is *not* read-only (`executeRemediation`, `operate`, `recommend`). Our Grafana v1 is a deliberate read-only narrowing.
- **Resource context**: Headlamp invokes remediate **from a resource detail page** — the resource-scoped context we approximate via [dashboard→intent deep-linking](#scope).

### Expansion: Prior art — GitHub project-setup

dot-ai already has a **first-class GitHub surface** — not a future idea for this PRD:

**[Project Setup](https://devopstoolkit.ai/docs/ai-engine/tools/project-setup)** (`project-setup` tool) audits a repository and generates governance / GitHub automation files (LICENSE, CODE_OF_CONDUCT, CONTRIBUTING, issue/PR templates, OpenSSF Scorecard workflow, Renovate, labeler, stale bot, …). Interactive scope selection + template-based generation; does **not** require Kubernetes or an LLM for generation. Related: PR templates feed the **`prd-done`** prompt workflow for intelligent PR creation ([prompts](https://devopstoolkit.ai/docs/ai-engine/tools/prompts#available-prompts)).

| Surface | Host | Job | Status vs this PRD |
|---|---|---|---|
| **GitHub — project-setup** | GitHub repo (files + Actions) | Bootstrap / audit **repo governance & automation** | **Shipped** (server tool) — recognize, do not reimplement |
| **Headlamp — `dot-ai-headlamp`** | Kubernetes UI | Resource-centric **operate** (incl. execute) | **Shipped** — Phase 2 is dual-surface *wiring*, not rebuild |
| **Grafana — this plugin** | Observability UI | Dashboard-centric **diagnose / watch** (analysis-only) | **This contribution (Phase 1)** |
| **Remediate → GitOps PR** | Git (via remediate execute) | Cluster fix as a **reviewable PR** (RBAC-gated) | Server capability; **not** the same as project-setup; optional Grafana surface in Phase 2 M12 |

**Do not conflate:** `project-setup` = *repository* standards and GitHub workflow files. Remediate's GitOps-PR path = *cluster* change proposed as a PR. Both touch GitHub; different jobs, different tools. This Grafana plugin is a third **UI** doorway (observability), complementary to Headlamp (cluster UI) and project-setup (GitHub/repo), all on the same toolkit.

### Expansion: Companion-project model

This repo / PRD is a **companion UI**, not a second product brain — the same split Viktor uses for
[`dot-ai-headlamp`](https://github.com/vfarcic/dot-ai-headlamp) (`prds/1-headlamp-plugin.md` →
"Companion Projects: **dot-ai** — MCP server providing the REST API this plugin consumes").

| Question | Lives in | Example |
|---|---|---|
| **New capability / contract / intelligence** | **`vfarcic/dot-ai`** (core PRD first) | New tool or MCP, remediate loop change, RBAC verb, OpenAPI field, KB ingest rules |
| **How it appears in a host UI** | **Companion repo PRD** (this one, or headlamp) | Page, settings, host auth glue, presentation, timeouts for *that* host |
| **Privileged / platform install** | **Deploy docs + (where live infra) MOP** — not a UI PRD | Kubeshark tap, longhorn, NetworkPolicy |

**Rule (fail-closed):** if the work changes *what the AI can do or what the server promises*, open or extend a **dot-ai** PRD and only then teach the companion UIs to call it. Companions may request a **tiny, host-agnostic** server hook when the host cannot work otherwise (Headlamp's precedent: `X-Dot-AI-Authorization` support on the server). They must **not** reimplement tools, invent parallel evidence pipelines, or own K8s browsing that the host already has.

**Companion projects (ecosystem map)**

| Project | Role |
|---|---|
| **[dot-ai](https://github.com/vfarcic/dot-ai)** | AI engine — tools, REST/MCP, RBAC, remediate, knowledge, project-setup, … |
| **[dot-ai-headlamp](https://github.com/vfarcic/dot-ai-headlamp)** | Companion UI — Headlamp (shipped; full tools incl. execute) |
| **[dot-ai-ui](https://github.com/vfarcic/dot-ai-ui)** | Companion UI — standalone web (alternative frontend) |
| **dot-ai-grafana** (this) | Companion UI — Grafana (proposed; analysis-only v1) |
| **CLI / MCP clients** | Other consumers of the same engine |

```
  NEW CAPABILITY / CONTRACT          ──►  vfarcic/dot-ai  (core PRD)
           │
           │ REST / MCP only
           ▼
  ┌────────┴────────┬──────────────┬─────────────┐
  Headlamp          Grafana        Web UI / CLI  …   (companion PRDs = host glue only)
```

<a id="prior-core-mcp-auth"></a>

#### Prior core contribution — outbound MCP auth (vfarcic/dot-ai#414 → vfarcic/dot-ai#416 → vfarcic/dot-ai#417)

We already shipped the **engine-side plug** for authenticated external MCPs on `vfarcic/dot-ai`:

| Step | Artifact | Role |
|---|---|---|
| PRD | [vfarcic/dot-ai#414](https://github.com/vfarcic/dot-ai/issues/414) | Capability: outbound MCP client auth |
| Design | [vfarcic/dot-ai#416](https://github.com/vfarcic/dot-ai/pull/416) | Design-doc PR |
| Implement | **[vfarcic/dot-ai#417](https://github.com/vfarcic/dot-ai/pull/417)** (merged 2026-04-01) | Static Bearer, custom headers, OAuth client_credentials, Helm `existingSecret` |

That is **not** Kubeshark/PCAP and **not** this Grafana UI — it is what makes Phase 3–style evidence MCPs *attachable* (secured `mcp-grafana`, a future Kubeshark MCP, etc.) without inventing auth plumbing again. This companion PRD reuses the same PRD-first discipline; any later packet/evidence capability should open a **new core PRD** on `dot-ai` (after maintainer signal or a thin spike), not grow a client inside this plugin.

### Expansion: Server impact

**This plugin requires no change to the dot-ai server, and no dot-ai user who doesn't install it sees any change.** It is a pure REST client of endpoints that already exist (PRD [vfarcic/dot-ai#354](https://github.com/vfarcic/dot-ai/issues/354)): no new endpoints, schemas, or config-model changes. Only runtime prerequisites: the REST gateway is reachable from Grafana (on by default) and an auth token exists. The recommended read-only token (no `apply`) uses dot-ai's existing RBAC (PRD [vfarcic/dot-ai#392](https://github.com/vfarcic/dot-ai/issues/392)) — a scoped credential, not a server change.

### Expansion: Design Decisions

1. **Query presentation field — RESOLVED.** query's human-readable answer is `data.result.summary` (`src/tools/query.ts` L54); send the plain intent (not `[visualization]`, which switches modes — `query.ts` L210). Keep a "Show raw response" toggle. M0 only confirms envelope unwrapping across the deployed dot-ai version.
2. **Timeout & long-call strategy.** Query is short (seconds) → a blocking POST is fine. Remediate is a multi-iteration loop up to ~30 min (`dot-ai-headlamp` `AI_TOOL_TIMEOUT`); Grafana's own guidance treats minutes-long blocking resource calls as unstable. **Leaning: async `202 + jobId` + `/status/{jobId}` poll as the *default* for remediate** — minimal, in-memory, single-instance jobs with a TTL; the UI Cancel abandons the poll; poll on a fixed interval with terminal-state handling. Blocking-with-a-tuned-[Timeout chain](#timeout--long-call-strategy) is the fallback only where the operator fully controls every hop. **M0 measures the real Grafana resource-call deadline and picks**; this is [Open Question 5](#open-questions). SSE (`/api/v1/events/remediations`, PRD [vfarcic/dot-ai#425](https://github.com/vfarcic/dot-ai/issues/425)) is the post-v1 streaming upgrade.
3. **Read-only enforcement (two layers).** **(a)** client never sends `executeChoice`/`sessionId`; the backend **fails closed** with a request-field allowlist so a crafted request can't reach an execution path; **(b)** the dot-ai token's RBAC lacks the `apply` verb (PRD [vfarcic/dot-ai#392](https://github.com/vfarcic/dot-ai/issues/392)), so remediate returns analysis + `fallbackReason` and offers no `executionChoices` **server-side** (`remediate.ts` L1606/L1625). **Both.** (b) is authoritative and requires dot-ai RBAC enabled — verified in M0.
4. **Identity model.** **Leaning:** single shared service token for v1 (dot-ai RBAC applies at token level; audit logs cannot attribute to individual Grafana users — accepted v1 risk). Per-user OAuth/Dex forwarding is a future enhancement (out of scope).
5. **Plugin identity & home.** Grafana id form `org-name-type`; proposed `devopstoolkit-dotai-app` — **needs maintainer input** on org slug and repo location.
6. **Grafana version floor & reference deployment (11.4).** The reference deployment is **Grafana 11.4 self-managed** (the adopter's production; current Grafana is 13.1). The real compatibility lever is the **`@grafana/{data,ui,runtime}` library versions**, not just `grafanaDependency`: `@grafana/create-plugin` now scaffolds against ~13.x libs, which can break at runtime on 11.4. **Leaning:** pin `@grafana/*` to the latest line whose minimum supported Grafana ≤ 11.4, set `grafanaDependency: >=11.0`, and make CI **build+smoke on 11.4 (must-pass) and a current release (13.x)**. Supporting 10.x/9.x is untested burden for versions neither the adopter nor "current" runs — offer only if the maintainer wants a broad range. (Deviation from PRD #1's `9.x+`; see Scope.)
7. **Distribution.** **Leaning:** unsigned/private first — which **requires** operator allow-listing (`allow_loading_unsigned_plugins` in `grafana.ini` / `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=<id>`); document it in the install guide. Grafana catalog (signing + review) later.
8. **Auth header.** Send `Authorization: Bearer`; `X-Dot-AI-Authorization` only for proxy-consuming deployments (see [Auth header](#auth-header)).
9. **Strategic positioning vs Grafana Assistant (read-only scope).** Grafana Assistant + Sift now cover NL analysis of telemetry natively, so this plugin must lead with dot-ai's wedge — **K8s API state, remediation, sovereignty** (see [Competitive landscape](#competitive-landscape--differentiation)). **Leaning:** v1 honors PRD #1's read-only scope and differentiates on **K8s-state + sovereign self-hosting** (not a telemetry-chat clone); **remediation** (GitOps PR) is the strongest differentiator but is out of PRD #1 scope — flagged as the highest-value expansion and the central go/no-go ([Open Question 6](#open-questions)). If neither wedge is compelling for the target users, the honest call is **not** to ship a standalone plugin and instead expose dot-ai via a Grafana Assistant Skill / the Grafana MCP.
10. **Deployment target: self-managed Grafana only for this contribution.** **Leaning:** design, CI, and install docs target **self-managed Grafana** (reference **11.4**; matrix includes a current 13.x). **Grafana Cloud is explicitly not planned** for this PRD's delivery track — see [Deployment targets](#deployment-targets-self-managed-vs-grafana-cloud). Cloud may still matter to other adopters (including the maintainer); it is left as an optional follow-on for whoever finds value, not a Phase 1/2/3 commitment here.
11. **Companion vs core ownership.** **Leaning:** this PRD follows the Headlamp companion pattern — UI/host only; capabilities land in **dot-ai** first. Applies especially to **Kubeshark / evidence** (Phase 3): see [Where Kubeshark connectivity lives](#where-kubeshark-connectivity-lives).
12. **Markdown rendering vs. text-only — RESOLVED, amends Decision 1.** The original text-only decision banned both *requesting* and *rendering* rich visualizations. Only the rendering half is retired: the response area now renders the model's own GFM markdown (headings, lists, tables, code blocks, links) as sanitized HTML instead of a plain-text area. The request half is unchanged — the plugin still never prefixes `[visualization]` to the intent (Decision 1); dot-ai is never asked to switch into rich-visualization mode. See Work Log 2026-09-05.

### Expansion: As-built v1 (this contribution)

What shipped in the plugin PR. Original outline + earlier expansions stay above; this block is the as-built contract.

| Topic | As-built |
|---|---|
| Plugin id | `devopstoolkit-dotai-app` (unsigned allow-list uses this id) |
| Author / module | DevOps Toolkit · `github.com/vfarcic/dot-ai-grafana` |
| Tools | Query (`intent`) + Remediate analysis-only (`issue` / mapped `intent`). No execute / operate / recommend UI |
| Client | Thin Grafana SDK `httpclient` for query, remediate, version only. **No** generated OpenAPI client (full schema includes mutation tools) |
| Timeouts | Probe/version **15s**; query/remediate **120s** blocking. **No** async `202` + job poll |
| UI | Tool select, intent box, Ask/Analyze, **Cancel** while in flight, spinner, error `Alert` with **Retry** (intent preserved). Titles: timeout / 401 / 403 / 404 / unreachable / cancelled. Analysis-only banner on Remediate. Current/Map/History gated by Show context (display-only). Packing gated by **Send Grafana evidence** (default on). Consent info Alert on Ask when send is on. |
| Ask log | **Debug Log** (`jsonData.debugLog`, off by default): JSONL ask log. Failed tool calls also go to Grafana plugin **error log** (`log.DefaultLogger.Error`, no tokens/body). |
| vs Headlamp / core | Headlamp Query = box → one POST. Resource-detail passes the **K8s object** into remediate/operate. `sessionId` is the **execute** round-trip, not Grafana DS packing. No Loki/Prom/Tempo/AM in `dot-ai-headlamp`. Closest core plan: [vfarcic/dot-ai#463](https://github.com/vfarcic/dot-ai/issues/463) (Low, draft — evaluate external monitoring MCP). This packing is Grafana-host glue |
| Config | Admin: **MCP Server URL**, **Auth Token**, **Debug Log** (off by default), **Show context** (on by default; display-only), **Send Grafana evidence** (`jsonData.sendGrafanaEvidence`, default on; independent of Show context). HTTPS required except loopback / RFC1918 / in-cluster `*.svc` / `*.cluster.local`. Test connection = `POST /api/v1/tools/version` |
| Auth | `Authorization: Bearer` (not `X-Dot-AI-Authorization`) |
| Grafana | `grafanaDependency: ">=11.0.0"`; `@grafana/*` **11.4.0**; CI Playwright on Grafana 11.0–13 + nightly |
| Deferred | **M7 Map/Explore/show-me** → [PRD #3](https://github.com/LesleyMurfin/dot-ai-grafana/issues/23) / [PR #22](https://github.com/LesleyMurfin/dot-ai-grafana/pull/22) (0.2.x, not this PR). **GitOps execute** → [PRD #2](https://github.com/LesleyMurfin/dot-ai-grafana/issues/13) / [PR #18](https://github.com/LesleyMurfin/dot-ai-grafana/pull/18). Also: async 202; generated OpenAPI client; Grafana.com signing |

```
  Ask
   |
   +-- Remediate ── pack existing Query Current + issue
   |                 1x POST /remediate (analysis) ── done
   |
   +-- Query
         |
         v
      Read Grafana DS: Loki, Prometheus, Tempo, Alertmanager
      (no hardcoded uids; types via getDataSourceSrv().getList({type}); skip when sendGrafanaEvidence is false)
         |
         v
      Current + Map     History stays on screen — never POSTed
         |
         v
      classifyFirstHop(question)
         |                              |
         | alerts/logs/metrics/traces   | list/show namespaces|pods|...
         | "top issues" / default       | (inventory language)
         v                              v
      first_hop=grafana            first_hop=dot-ai
         |                              |
         +--------------+---------------+
                        v
      hop 1  POST /query
             intent = Stable + Current + Map + question
                        |
         +--------------+--------------+
         | unscoped (no pod/ns/app)?   | answer denies facts in Current?
         v                             v
      hop 2 across                  hop 2 conflict
         |                             |
         |          hop 2 still hedges on Current?
         |                             v
         +---------------------- hop 3 hedge
                        |
                        v
      cap 3; stop. Rewrite Current from the answer (for next Ask /
      Analyze this). Each hop = one ask-log line.

  Go backend (every hop):
    strip hop/branch/first_hop before upstream
    append JSONL ask log if Debug Log on (off by default; no Grafana tokens)
    Authorization: Bearer  -->  dot-ai

  dot-ai (unchanged):
    query toolLoop (kubectl / capabilities / optional MCP, <=30)
    intent max 1000 chars; sessionId = visualization cache, not chat
    remediate sessionId = execute round-trip — this plugin never sends it

  Headlamp (not this PR): K8s resource object + execute / operate
```

Headlamp remains the operate/execute companion. Grafana v1 is diagnosis: **Grafana stack facts packed into the same intent**, then Grafana-first vs inventory-first hops, so Asks see the dashboards the operator is looking at.

**Send Grafana evidence** (`jsonData.sendGrafanaEvidence`, default on; missing/undefined = send) is independent of **Show context**. When send is off, Asks do not pack Grafana DS facts (`fetchStackContext` / `loadStack` not called). No datasource UID pickers: types discovered via `getDataSourceSrv().getList({ type })`. Per-type checkboxes are future. Related alerts are already in **Current** from Alertmanager when send is on. Dashboard-to-open / Explore / show-me / markdown Answer are **not** this PR — [PRD #3](https://github.com/LesleyMurfin/dot-ai-grafana/issues/23). Grafana `/apis` dashboard inventory is later than PRD #3.

**Grafana APIs this plugin uses (existing host APIs — no custom Loki/Prom HTTP client):**

```
  Browser (signed-in Grafana user)
           │
           │  1. Grafana runtime (existing)
           │     getDataSourceSrv()
           │       .getList({ type: loki|prometheus|tempo|alertmanager })
           │       .get(uid)
           │       ds.query(DataQueryRequest)   ← same path as Explore
           ▼
  Current + Map packed into {intent}     History never POSTed
           │
           │  2. Grafana plugin resource API (existing)
           │     getBackendSrv().fetch
           │       POST /api/plugins/devopstoolkit-dotai-app/resources/{query|remediate}
           ▼
  Grafana server → our Go backend (plugin SDK httpadapter)
           │
           │  3. Not Grafana — outbound to dot-ai
           │     Authorization: Bearer
           ▼
  POST /api/v1/tools/query | /remediate | /version
```

Settings (Admin): Grafana plugin `jsonData` / `secureJsonData` (URL, token, Debug Log, Show context, Send Grafana evidence).
Not used: Grafana Assistant, LLM app plugin, `mcp-grafana` (engine-side: vfarcic/dot-ai#463).

**Grafana 12+ `/apis` HTTP structure** ([docs](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/apis/), [migration](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/apis-migration/)): Grafana 12 adds Kubernetes-style `/apis/<group>/<version>/namespaces/<ns>/<resource>`. Grafana 13 **deprecates** legacy `/api` HTTP APIs (they stay up but stop receiving updates). **This plugin does not call those Grafana resource HTTP APIs.** Stack reads go through `getDataSourceSrv` / `ds.query` (Explore path). Asks go through the **plugin resource** contract `POST /api/plugins/<id>/resources/*` and settings `POST /api/plugins/<id>/settings` — Grafana plugin SDK, not dashboard HTTP. CI Playwright already runs Grafana **11.0–13 + nightly**. We do not use removed Grafana 12 UI-extension APIs (`getPluginExtensions`, etc.). Tool dropdown stays `@grafana/ui` `Select` because `Combobox` landed in 11.5 and our libs are pinned **11.4.0** for the 11.4 floor; migrate to Combobox when the floor rises.

**Future-proof (do not regress):**

- Never `GET /api/search` — Folder/Dashboard Search **will not be migrated**.
- Never Grafana Data source HTTP (`/api/datasources`) — deprecated; we already use `getDataSourceSrv`.
- Never Alerting Provisioning HTTP for “related alerts” — we already query Alertmanager via `ds.query`.
- If we add “which dashboard to open”: Grafana 12+ **Dashboard `/apis`** only (`dashboard.grafana.app`), not `/api/dashboards` or `/api/search`.
- Plugin `/api/plugins/<id>/resources/*` and `/settings` stay until Grafana publishes a plugin-SDK replacement; they are not the dashboard `/api` deprecation.


### Expansion: By Design (as-built honesty)

| Pillar | Verdict | What we did | Gap |
|---|---|---|---|
| **Reliability** | Partial | Fail-fast config + Test connection; hop cap 3; Cancel; Retry; stack DS throw isolated; 120s classified timeout | No async 202 — long remediate can still hit 120s |
| **Security** | Partial | Token in `secureJsonData` (backend only); remediate allowlist (no execute); 401/403 → 502 no secret leak; no generated OpenAPI client; Debug Log off by default; public `http` rejected | `http` only for loopback, RFC1918, or in-cluster DNS (`*.svc` / `*.cluster.local`); shared Bearer (any user who can open the plugin); Current/logs go to the LLM when send is on |
| **Privacy** | Partial | History never POSTed; error log has no body/token; Debug Log opt-in; **Send Grafana evidence** opt-out | Show context is still display-only (does not stop packing) |
| **Consent** | Partial | Admin configures; user clicks Ask; Debug Log opt-in; analysis-only banner; info Alert on Ask when send is on (Asks send Grafana DS facts to the configured dot-ai server); banner hidden when send is off | Grafana users share one token; no per-user consent / OAuth |

## User Journey

1. User is viewing dashboards in Grafana and notices an anomaly
2. User navigates to the dot-ai plugin page (accessible from Grafana sidebar)
3. User selects "Query" or "Remediate" from the tool dropdown
4. User types their question/intent in natural language
5. User submits and sees the AI-generated text response
6. User can ask follow-up questions or switch tools

### Expansion: UX states & firefighting controls

1. Operator sees an anomaly on a dashboard; opens the dot-ai page (sidebar) — or follows a **panel data-link** that pre-fills the intent (see Scope).
2. Selects Query or Remediate; the active **cluster/context is always displayed** (from `version → system.kubernetes.context`) so the answer's scope is unambiguous.
3. Types intent (live 1000-char counter); submits.
4. **In-flight**: spinner + **elapsed-time counter** + staged copy ("Investigating cluster state… up to a few minutes"); a **Cancel** button aborts (AbortController / abandons the async poll) and re-enables the form.
5. **Success**: plain-text answer; **Copy** on the whole response and per recommended `command`; a "Show raw response" toggle.
6. **Error**: specific `Alert` (unreachable / 401 / 403 / 404 / timeout / tool error) with a one-click **Retry** that preserves the intent.
7. Ask a follow-up (single-shot — the prior answer stays visible while composing the next).

## Technical Scope

### Architecture

- **Grafana App Plugin** with a custom page (React + TypeScript)
- **Backend plugin component** (Go) to proxy requests to the dot-ai MCP server with authentication
- Leverages Grafana's built-in auth and RBAC — no separate authentication needed

### MCP Server Integration

The plugin calls two dot-ai MCP server REST endpoints:

| Tool | Endpoint | Method | Purpose |
|------|----------|--------|---------|
| Query | `/api/v1/tools/query` | POST | Natural language cluster queries |
| Remediate | `/api/v1/tools/remediate` | POST | Issue analysis (read-only) |

### Plugin Configuration

Grafana admin configures via plugin settings:
- **MCP Server URL** — dot-ai MCP server endpoint
- **Auth Token** — Authentication token for the MCP server

### Expansion: Plugin configuration (as-built)

Grafana admin configures via plugin settings:
- **MCP Server URL** — `jsonData.apiUrl` (absolute http(s) base, no `/api/v1` suffix). HTTPS required except loopback / RFC1918 / in-cluster `*.svc` / `*.cluster.local`. Public `http` is rejected.
- **Auth Token** — `secureJsonData.apiKey` (Bearer; stored encrypted)
- **Debug Log** — `jsonData.debugLog` enable/disable the JSONL ask log (`/var/lib/grafana/dotai-ask.log`). **Off by default.** Tokens never written; hop meta stripped before upstream.
- **Show context** — `jsonData.showContext` show Current, Map, and History on the page. **On by default.** Display-only; independent of Send Grafana evidence.
- **Send Grafana evidence** — `jsonData.sendGrafanaEvidence`. **On by default** (missing/undefined = send). When off, do not pack Grafana DS facts into Asks. Independent of Show context.

### UI Components

Minimal UI surface:
- **Tool selector dropdown** — Switch between Query and Remediate
- **Intent text input** — Natural language input field with context-aware placeholder
- **Response area** — Scrollable text display for the agent's response
- **Loading indicator** — While waiting for response
- **Error display** — Connection errors, auth failures

### What's Explicitly Out of Scope

- Rich visualizations *requested from dot-ai* (Mermaid diagrams, cards, charts) — the plugin never prefixes `[visualization]` to the intent (Decision 1). It does render the model's own GFM markdown, including code blocks with syntax highlighting, as sanitized HTML (Decision 12, amends this line for rendering only).
- Action execution (remediation execution, operate, recommend)
- Multi-stage workflows or wizards
- Resource selection from dashboards
- Session management or conversation history

### Expansion: Architecture — implementation detail

**dot-ai — existing, consumed as-is**: `src/interfaces/routes/index.ts` (`POST /api/v1/tools/:toolName`, PRD [vfarcic/dot-ai#354](https://github.com/vfarcic/dot-ai/issues/354)); `schema/openapi.json` + `GET /api/v1/openapi` (client generation source); `src/tools/query.ts` (input `{intent}`; answer `summary`); `src/tools/remediate.ts` (`mode:"manual"` analysis; `apply` RBAC gate L1582–1633); `src/interfaces/oauth/middleware.ts` (auth header precedence); `docs/ai-engine/api/rest-api.md` (envelope, bearer auth, status codes; `version` → `system.kubernetes.context`).

**Grafana plugin — new (mirrors `examples/app-with-backend`, built on `grafana-plugin-sdk-go`)**: `src/plugin.json` (`type:app`, `backend:true`; `includes` a page with `addToNav:true`+`defaultNav:true` + a `role:Admin` Configuration entry; `grafanaDependency` floor); `src/module.tsx` (`setRootPage(DotAiPage).addConfigPage(...)`); `src/components/AppConfig/AppConfig.tsx` (`jsonData.apiUrl` + `secureJsonData.apiKey`; Test-connection); `src/pages/DotAiPage.tsx` (`<PluginPage>`; `getBackendSrv().post('/api/plugins/<id>/resources/<tool>')`); `pkg/plugin/app.go` (`httpadapter.New(mux)`; `httpclient.New(...)` for outbound calls; `CheckHealth` → dot-ai `POST /api/v1/tools/version`, invoked by the frontend via `GET /api/plugins/<id>/health`; token via `httpadapter.PluginConfigFromContext(ctx).AppInstanceSettings.DecryptedSecureJSONData["apiKey"]`); `pkg/plugin/resources.go` (`registerRoutes`: `handleQuery`, `handleRemediate`, `handleHealth`, `handleStatus`); generated OpenAPI client package (from `schema/openapi.json`).

```
  Grafana browser (React)                  Grafana server                         dot-ai server (existing)
  +---------------------------+            +--------------------------------+     +---------------------------+
  | Config page               |  save      | Plugin Go backend              |     | REST gateway              |
  |  apiUrl · token · Test    | ---------> |  grafana-plugin-sdk-go         |     |  POST /api/v1/tools/:tool |
  |  connection               |  settings  |  /query /remediate /health     |     |            |              |
  +---------------------------+            |  /status/{jobId}               |     |            v              |
  |                           |            |  httpclient + OpenAPI client   |     | tool RBAC (apply verb)    |
  | dot-ai page               |  getBackendSrv POST                         |     |            |              |
  |  tool · intent · response | ---------> |  fail-fast · redaction         | HTTPS|            v              |
  |  cluster-context          |            |               |                | Bearer| query · remediate loop  |
  |  cancel / retry / copy    |            |               +--------------->| ----> | · version               |
  +---------------------------+            +--------------------------------+     +------------|--------------+
                                                                                              |
                                                                                              v
                                                                                   Kubernetes + AI provider
```

### Expansion: Timeout & long-call strategy

A `getBackendSrv().post(...resources...)` call crosses: browser fetch → Grafana HTTP server → gRPC to the plugin process → plugin `httpclient` → dot-ai. A plugin-set timeout governs only the **last** hop, and Grafana's resource-call gRPC/HTTP deadlines (plus any ingress `proxy_read_timeout`) cap the rest — a plugin timeout alone cannot override them. Because remediate can run minutes, the **default is the async `202`+`/status/{jobId}` poll** (Design Decision 2): the backend runs the dot-ai call in a job (in-memory, single-instance, TTL-bounded), returns `202 + jobId` immediately, and the frontend polls. A **blocking** path (with a fully-tuned chain: browser fetch, ingress, `grafana.ini`, `httpclient`) is offered only where the operator controls every hop and accepts the ceiling. M0 measures the real deadline and confirms which is default.

### Expansion: Deployment targets (self-managed vs Grafana Cloud)

(self-managed vs Grafana Cloud)

| Host | This contribution | Notes |
|---|---|---|
| **Self-managed Grafana** (OSS/Enterprise on k8s/VM; reference **11.4**) | **In scope** — primary design, CI matrix, install guide | Operator controls plugin install (incl. unsigned allow-list), backend process, and network path to dot-ai (in-cluster or HTTPS). |
| **Grafana Cloud** | **Out of scope / not planned here** | Called out so others can evaluate value; **not** a delivery commitment for this PRD. |

**Why call Cloud out at all.** Some adopters (and the maintainer) may care about Cloud-hosted Grafana. The plugin *conceptually* only needs: (1) ability to run an app+backend plugin on that Grafana, (2) a **Cloud-reachable HTTPS** `apiUrl` for the customer's dot-ai (private in-cluster URLs won't work from Cloud without an edge), and (3) catalog/signing or whatever install path Cloud allows. None of that is free: Cloud install policies for private/backend plugins, egress, SSRF defaults (this design fail-closes on non-HTTPS and many private ranges unless allowlisted), and product overlap with **Grafana Assistant** (native on Cloud) all need a deliberate owner.

**Intent for this contribution.** We design and ship for **self-managed**. We do **not** plan Cloud packaging, Cloud CI, or Cloud install docs. If the maintainer or another contributor later finds Cloud worth it, treat it as a **separate follow-on** (likely after catalog signing + a documented public/edge HTTPS path to dot-ai) — not a blocker for Phase 1.

### Expansion: Non-Functional Requirements

- **Latency / long calls**: async default (above); calls may run minutes. Cancelable; progress surfaced.
- **Fail-fast on misconfiguration** (K8s-native): an unreachable/invalid `apiUrl`, missing token, or non-2xx `version` health check surfaces a **clear error** (Test-connection + explicit error states) — never a silently-degraded "looks fine but returns nothing." Matches dot-ai's own fail-fast posture.
- **Security**:
  - Token only in `secureJsonData`; backend-only read; never logged; `Authorization` redacted and **upstream dot-ai error bodies sanitized** before surfacing to the browser. Custom auth header sent only when configured — never both unconditionally.
  - **Egress/SSRF**: `apiUrl` **must** be `https://` (reject `http://`) and the backend **must** block link-local/metadata (`169.254.169.254`), loopback, and RFC1918 targets unless an operator explicitly allowlists them (fail-closed). Admin-only config lowers but doesn't remove the risk in multi-tenant Grafana.
  - **Read-only**: enforced server-side via a no-`apply` RBAC token *and* a backend fail-closed request-field allowlist (Design Decision 3).
  - **Prompt/command injection**: free-text `intent`/`issue` reaches an LLM with read-only cluster tools; the token's read scope bounds the blast radius, and remediate's suggested `command`s are advisory/untrusted (a human runs them). Least-privilege token; rotation; per-Grafana-org isolation.
  - **Identity**: single shared token → no per-user attribution in dot-ai audit logs (accepted v1 risk).
- **Observability**: backend logs request id, tool, status, duration (no secrets).
- **Compatibility**: pin `@grafana/*` libs (to support 11.4) + `grafanaDependency: >=11.0`; CI build+smoke on **11.4 (reference deployment, must-pass) and a current release (13.x)**.
- **Accessibility**: labelled controls; announced response; keyboard submit.

## Success Criteria

- Plugin installs cleanly into Grafana (`>=11.0`; 11.4 reference)
- Users can submit natural language queries and receive text responses
- Users can submit issue descriptions and receive analysis text
- Configuration via Grafana plugin settings works (MCP URL + auth token)
- Response times are comparable to direct MCP server calls (< 500ms overhead from plugin)
- Plugin follows Grafana UI conventions and feels native

### Expansion: Additional success criteria

- Active cluster/context always visible (from `version → system.kubernetes.context`)
- Remediate `command`s copyable; no execution path presented
- Long remediate completes via async poll (or tuned blocking) or is cancelable
- Live e2e against real Grafana (**11.4** reference + current 13.x) and live dot-ai; no-`apply` token blocks execution
- Misconfiguration fails fast; specific errors with Retry
- *(NFR)* plugin proxy < 500 ms overhead vs direct call (excluding model think time)

**Note on version floor:** original success criteria listed 9.x+/10.x/11.x; **as-built is `>=11.0`** with **11.4** must-pass. 9.x/10.x not claimed.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Grafana plugin API changes across versions | Plugin breaks on upgrade | Target Grafana `>=11.0` with stable APIs; CI 11.0–13 + nightly |
| MCP server authentication complexity | Users can't configure plugin | Clear setup docs, connection test button in settings |
| Go backend proxy adds latency | Slow responses | Minimal proxy logic, streaming if Grafana supports it |
| Plugin review process (if publishing to marketplace) | Delayed availability | Start with unsigned/private distribution, publish later |

### Expansion: Additional risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `@grafana/*` lib drift vs 11.4 host | Runtime break on reference deploy | Pin libs for 11.4; CI matrix 11.4 + 13.x |
| Long remediate vs Grafana resource-call deadlines | Spurious timeouts | Async `202`+poll default; M0 measures deadline |
| Scope creep (Kubeshark client in this repo) | Wrong ownership | Companion model; core `dot-ai` PRD for evidence tools |

## Dependencies

- dot-ai MCP server running and accessible from Grafana instance
- MCP server exposes `/api/v1/tools/query` and `/api/v1/tools/remediate` endpoints
- Grafana `>=11.0` (reference **11.4**; CI 11.0–13 + nightly)
- `@grafana/create-plugin` toolchain for scaffolding

### Expansion: Additional dependencies

- `POST /api/v1/tools/version` and `GET /api/v1/openapi` (health / client generation)
- Auth token with read + analyze, **no** `apply` for analysis-only ([vfarcic/dot-ai#392](https://github.com/vfarcic/dot-ai/issues/392))
- `grafana-plugin-sdk-go` (`httpadapter`, `httpclient`)
- Design template: [`vfarcic/dot-ai-headlamp`](https://github.com/vfarcic/dot-ai-headlamp)
- Outbound MCP auth already in core ([vfarcic/dot-ai#417](https://github.com/vfarcic/dot-ai/pull/417)) for future evidence MCPs

**Note:** this revision proposes floor **≥ 11.0** (reference 11.4) vs original "10.x or later" — open question for maintainer.

## Milestones

- [x] **Plugin scaffolding and build pipeline** — Grafana app plugin project created with `@grafana/create-plugin`, builds successfully, loads in Grafana dev environment
- [x] **Plugin configuration page** — Admin can configure MCP server URL and auth token via Grafana plugin settings, with connection test
- [x] **Backend proxy (Go)** — Backend plugin component proxies requests to MCP server with configured auth, handles errors gracefully
- [x] **Query tool UI** — Users can type natural language queries, submit, and see text responses from the MCP server
- [x] **Remediate analysis UI** — Users can describe issues, submit, and see AI-powered analysis text (no execution)
- [x] **Tool selector and shared layout** — Dropdown to switch between Query and Remediate, shared input/response layout, context-aware placeholders
- [x] **Error handling and loading states** — Connection errors, auth failures, timeouts displayed clearly; loading spinner during requests; Cancel + Retry in v1
- [x] **Documentation and installation guide** — README with setup instructions, configuration guide, and screenshots
- [x] **Grafana version compatibility testing** — CI Playwright on Grafana **11.0–13 + nightly** (floor `>=11.0.0`, 11.4 libs). Not 9.x/10.x.

As-built: M0–M6/M8–M9 cover v1; M7 not in v1. Floor is `grafanaDependency: ">=11.0.0"` (11.4 libs), not 10.x. See [As-built v1](#expansion-as-built-v1-this-contribution).

### Expansion: Phase 1 detail (M0–M9 mapping to the checklist above)

A thin, SDK-native, **analysis-only** Grafana App plugin. Captures wedges **1 (live K8s-state)**
and **3 (sovereign / self-hosted)** — the two that matter on self-managed **v11/v12** where
Grafana Assistant is unavailable. Built in five independently-reviewable stages:

**Stage 1a — Foundation**
- [x] **M0 — Validation spike.** Envelope `summary` + analysis-only remediate + Bearer auth confirmed. Grafana host deadline measured at **120s** → v1 stays **blocking**, no async `202`. Cluster-context chip not on the page (Test connection still calls `version`).
- [x] **M1 — Scaffolding and build.** `@grafana/create-plugin` app+backend; `@grafana/*` **11.4.0**. **No** generated OpenAPI client (as-built: thin SDK `httpclient` for three paths).

**Stage 1b — Connectivity**
- [x] **M2 — Configuration page.** apiUrl + token (`secureJsonData`); Test-connection via `version`. Draft URL gated to org Admin.
- [x] **M3 — Backend proxy (Go).** `/query`, `/remediate`, `/health`, `/test-connection`; SDK `httpclient`; remediate field allowlist; token never logged. **No** `/status/{jobId}` (no 202).

**Stage 1c — Intelligence surfaces**
- [x] **M4 — Query UI.** Plain-text `summary`. Grafana DS **Current/Map** packed into `{intent}`; History display-only. No cluster-context chip, raw-response toggle, or char counter in v1.
- [x] **M5 — Remediate analysis UI.** Analysis text; **no execution surfaced** (allowlist drops execute/apply tokens). Single hop; reuses Query Current.

**Stage 1d — Firefighting UX & dashboard integration**
- [x] **M6 — Shared layout.** Tool selector, placeholders, spinner, error `Alert`, Clear thread, Analyze this. Cancel + Retry shipped in v1; no elapsed timer.
- [ ] **M7 — Dashboard deep-link.** **Not in v1.** Owned by [PRD #3](https://github.com/LesleyMurfin/dot-ai-grafana/issues/23) / [PR #22](https://github.com/LesleyMurfin/dot-ai-grafana/pull/22) (plugin 0.2.x). Do not land on vfarcic#3.

**Stage 1e — Ship**
- [x] **M8 — Docs & install guide.** Product README: setup, config, unsigned allow-list, 120s timeout. No screenshot set / `changelog.d`.
- [x] **M9 — Compatibility.** CI: unit/lint + Playwright on Grafana 11.0–13 + nightly (provisioned dummy token). Live operator stack is adopter-side.

> **Phase 1 exit:** a self-managed 11.4 operator gets AI **cluster-state** answers + remediation
> **analysis** inside **Grafana** — sovereign, read-only, verified against a live stack.

### Expansion: Forward roadmap — Phase 2 Headlamp (proposed, not this contribution)

**Grafana diagnoses; Headlamp operates; GitHub already has project-setup.** Viktor already ships
[`dot-ai-headlamp`](https://github.com/vfarcic/dot-ai-headlamp) against the **same** dot-ai server
(full tools: remediate execute, operate, recommend — Headlamp is *not* read-only), and
**[project-setup](https://devopstoolkit.ai/docs/ai-engine/tools/project-setup)** as the GitHub/repo
governance doorway. Phase 2 is **not** "rebuild Headlamp" (or project-setup); it is **integrating
the Headlamp surface** next to the Phase 1 Grafana plugin so cluster operators have two deliberate
UI doorways — and we keep GitHub project-setup in the map so nobody "discovers" a third surface
and invents a parallel one.

- [ ] **M10 — Shared-server dual-surface wiring.** Document and verify one dot-ai deployment serves both: Grafana plugin (Phase 1, analysis-only token) **and** `dot-ai-headlamp` (resource-scoped, can use `apply` where intended). Install/runbook: Headlamp plugin enablement, auth header/`ApiProxy` path, same REST base. *Done when an operator can open the same cluster in both UIs against one dot-ai without config drift.*
- [ ] **M11 — Role split codified.** Grafana = **diagnose / watch** (dashboards → intent deep-link → analysis); Headlamp = **resource-centric operate** (invoke from a resource detail page; execute/operate where RBAC allows). Cross-links or runbook steps for "saw it in Grafana → act in Headlamp" (and the reverse). *Done when the split is written in both plugins' docs and a walkthrough works end-to-end.*
- [ ] **M12 — Optional Grafana GitOps-PR surface (wedge 2, low risk).** If [Open Question 6](#open-questions) wants action *without* leaving Grafana: surface remediate's **PR path** only (reviewable Git PR; human still merges) — still **no** direct-apply in Grafana unless a later opt-in. Direct `{sessionId, executeChoice}` remains Headlamp's home by default (it already has it). *Done when either (a) Grafana can open a PR link from analysis, or (b) the decision is explicit: execute stays Headlamp-only.*

> **Phase 2 exit:** one brain, two doorways — Grafana for firefighting from dashboards, Headlamp
> for resource-scoped operate — without duplicating intelligence or inventing a second server.

### Expansion: Forward roadmap — Phase 3 Evidence/Kubeshark (proposed; core vfarcic/dot-ai first)

Phase 1–2 reason over **live K8s state**. Deeper evidence (metrics/logs/flows, then packet/payload)
is **engine capability**, not a Grafana feature. Under the
[companion-project model](#companion-project-model-same-as-headlamp), **do not implement
Kubeshark connectivity inside this plugin repo.**

#### Where Kubeshark connectivity lives

| Layer | Owns | Does **not** own |
|---|---|---|
| **Core `vfarcic/dot-ai` PRD** (open first) | Kubeshark as an MCP/tool (or evidence source): discover, auth, **redaction**, capability gate (`mcp:use` or equivalent), when remediate may call it, OpenAPI/tool schema, fail-closed without Kubeshark installed | Grafana/Headlamp page chrome |
| **Platform install** (adopter-specific) | Installing the privileged Kubeshark tap, NetworkPolicy, storage, on-demand vs always-on, operator approval | Tool contract or UI |
| **Companion UIs** (this Grafana PRD, Headlamp) | Optionally show analysis text that **already cites** packet evidence once the server returns it; no special Kubeshark client | Direct Kubeshark API, PCAP storage, decrypt keys, privilege |

**Order of work (fail-closed):**

1. **dot-ai PRD** — "Kubeshark evidence source / MCP for remediate" (contract + security model).
2. **Implement + document** on the server (and optional `mcpServers` registration pattern, same family as context-forge / other MCPs).
3. **Platform MOP** — install Kubeshark where an operator wants the tier (privileged; not default-on for everyone).
4. **Companion UIs** — only if presentation needs a tweak (almost always: none; remediate `summary` / factors already carry the narrative). Grafana does **not** grow a "Kubeshark panel" that bypasses the engine.

Same rule for cheaper senses: registering **`mcp-grafana`** (Prom/Loki/Hubble) is **server/config**, not a Grafana-plugin feature. The plugin already talks to **dot-ai**; it does not scrape Prometheus itself. Authenticated MCP attach is already unblocked by **[vfarcic/dot-ai#417](https://github.com/vfarcic/dot-ai/pull/417)** ([prior contribution](#prior-core-mcp-auth)).

#### Proposed milestones (ownership tagged)

- [ ] **M13 — Core: cheaper senses (`mcp-grafana`).** *dot-ai PRD + config* — register `mcp-grafana` so remediate can cite metrics/logs/flows. *Done when server-side remediate cites evidence not available from K8s state alone.* **Not this companion repo.**
- [ ] **M14 — Core: Kubeshark MCP (tier-3, on-demand).** *dot-ai PRD + implement* — payload / decrypted-TLS / PCAP tool; capability-gated, redaction-enforced, never first resort. *Done when the engine can pull gated packet evidence.* **Not this companion repo.** Platform MOP installs the tap separately.
- [ ] **M15 — Core (optional): predictive hardware signals.** Exporters → Prom → engine; diagnosis-only. *Done when trends yield human-action analysis with no autonomous hardware path.* **Not this companion repo.**
- [ ] **M16 — Companion (only if needed): surface polish.** If server responses grow new structured fields worth showing in Grafana (e.g. "evidence tier used"), add minimal presentation here — still no Kubeshark client. *Done when Phase 1 plugin renders the new fields without new privileges.* **This companion, after M13–M14 land.**

> **Phase 3 exit:** the **engine** can ground diagnosis in Prom/Loki/Hubble and, when needed,
> Kubeshark — under a core PRD and gated install. Grafana/Headlamp remain doorways; they do not
> own connectivity.

---

---

# Reviewer appendices (not part of the original PRD)

### Expansion: Related PRDs (not this contribution)

Do **not** mix these into vfarcic/dot-ai-grafana#3. Unsigned alpha **0.1.0** is this file only.

```
  PRD #1  this file / vfarcic#3 / fork #21     v1 0.1.0   analysis-only pack
  PRD #2  issue #13 / fork #18                  post-v1    GitOps PR execute
  PRD #3  issue #23 / fork #22                  0.2.x      Map / Explore / show-me
```

| PRD | GitHub | Owns | Does not own |
|---|---|---|---|
| **#1** (this file) | [vfarcic#3](https://github.com/vfarcic/dot-ai-grafana/pull/3) · [fork #21](https://github.com/LesleyMurfin/dot-ai-grafana/pull/21) | Query + analysis-only remediate, Current packing, 0.1.0 | Map `/d/uid`, Explore, show-me skip POST, markdown Answer, GitOps execute |
| **#2** | [issue #13](https://github.com/LesleyMurfin/dot-ai-grafana/issues/13) · [PR #18](https://github.com/LesleyMurfin/dot-ai-grafana/pull/18) | GitOps PR execute | M7 Map, v1 packing |
| **#3** | [issue #23](https://github.com/LesleyMurfin/dot-ai-grafana/issues/23) · [PR #22](https://github.com/LesleyMurfin/dot-ai-grafana/pull/22) | Map `/d/<uid>`, Explore/Drilldown, show-me skip POST, markdown Answer | GitOps execute, v1 0.1.0 |

Fork [PR #16](https://github.com/LesleyMurfin/dot-ai-grafana/pull/16) (`feat/upstream-plugin` → `main`) is **not** a product split. Do not merge it as v1+M7.

## Related / prior art (for this revision)

[#1](https://github.com/vfarcic/dot-ai-grafana/issues/1) (this PRD). Core: [vfarcic/dot-ai#354](https://github.com/vfarcic/dot-ai/issues/354), [vfarcic/dot-ai#392](https://github.com/vfarcic/dot-ai/issues/392), [vfarcic/dot-ai#143](https://github.com/vfarcic/dot-ai/issues/143), [vfarcic/dot-ai#358](https://github.com/vfarcic/dot-ai/issues/358), [vfarcic/dot-ai#425](https://github.com/vfarcic/dot-ai/issues/425), [vfarcic/dot-ai#317](https://github.com/vfarcic/dot-ai/issues/317). Headlamp: [vfarcic/dot-ai-headlamp](https://github.com/vfarcic/dot-ai-headlamp). MCP auth: [vfarcic/dot-ai#414](https://github.com/vfarcic/dot-ai/issues/414) → [vfarcic/dot-ai#416](https://github.com/vfarcic/dot-ai/pull/416) → [vfarcic/dot-ai#417](https://github.com/vfarcic/dot-ai/pull/417).

## Link conventions

Cross-repo references use full GitHub links (or `owner/repo#N`) so they resolve to the **correct** repository when this file is viewed in `vfarcic/dot-ai-grafana` (bare `#N` would otherwise mean *this* repo only):

| Ref form | Resolves to |
|---|---|
| `[#1](https://github.com/vfarcic/dot-ai-grafana/issues/1)` | This companion repo (Grafana PRD issue) |
| `[vfarcic/dot-ai#354](https://github.com/vfarcic/dot-ai/issues/354)` | Core engine issue/PRD |
| `[vfarcic/dot-ai#417](https://github.com/vfarcic/dot-ai/pull/417)` | Core engine PR |

Product **wedges 1–3** are *not* GitHub issues (written without a bare `#N` so they do not auto-link).

## Mapping to the original draft

This revision **extends the original PRD in place** (same path: `prds/1-grafana-ai-cluster-intelligence.md`).
The original draft text is kept **verbatim** under each section; `### Expansion:` blocks and the reviewer appendices are additive.
Git history retains the prior short form. **Phase 1 of this document = the original PRD's deliverable.**
Phases 2–3 are **proposed roadmap only** and are **not** part of original scope.

### Original section → this revision

| Original draft | This revision | Notes |
|---|---|---|
| **Problem Statement** | [Problem Statement](#problem-statement) + [Competitive landscape](#competitive-landscape--differentiation) | Same gap (context-switch for NL / analysis); framing expanded with Grafana Assistant / Sift so the plugin's wedge is honest |
| **Solution Overview** | [Solution Overview](#solution-overview) | Same: Query + Remediate analysis-only; plain-text presentation |
| **User Journey** | [User Journey](#user-journey) | Same path; adds cancel / retry / cluster-context / deep-link detail |
| **Architecture** | [Architecture](#architecture) + [Companion-project model](#companion-project-model-same-as-headlamp) | Same app+Go proxy; contracts pinned to source; companion vs core ownership explicit |
| **MCP Server Integration** (query + remediate endpoints) | [Tool → endpoint map](#tool--endpoint-map) and [MCP Server Integration](#mcp-server-integration) | Same two tools; fields/`summary`/auth headers validated against `vfarcic/dot-ai` |
| **Plugin Configuration** (URL + token) | [Plugin Configuration](#plugin-configuration) | Same; `apiUrl` + `secureJsonData` token; Test-connection via `version` |
| **UI Components** | [UI Components](#ui-components) | Same minimal surface; firefighting controls spelled out |
| **What's Explicitly Out of Scope** | [What's Explicitly Out of Scope](#whats-explicitly-out-of-scope) | Same exclusions; plus Cloud-as-host and new engine capabilities |
| **Success Criteria** | [Success Criteria](#success-criteria) + [Additional success criteria](#additional-success-criteria) | Original list kept verbatim; extras additive |
| **Risks & Mitigations** | [Risks & Mitigations](#risks--mitigations) + [Additional risks](#additional-risks) | Original table kept verbatim; extra risks additive |
| **Dependencies** | [Dependencies](#dependencies) + [Additional dependencies](#additional-dependencies) | Original list kept verbatim; extras additive |
| **Milestones** (scaffold → ship) | [Milestones](#milestones) + Phase 1 detail M0–M9 | Original 9 checklist items kept verbatim; M0–M9 is the expansion mapping |
| *(not in original)* | Mapping / Validation / Open Questions / Link conventions | Reviewer appendices — do not replace original outline |

### Original milestones → Phase 1

| Original milestone | Phase 1 |
|---|---|
| Plugin scaffolding and build pipeline | **M1** (+ **M0** validation spike before build) |
| Plugin configuration page (+ connection test) | **M2** |
| Backend proxy (Go) | **M3** |
| Query tool UI | **M4** |
| Remediate analysis UI | **M5** |
| Tool selector and shared layout | **M6** |
| Error handling and loading states | **M6** (cancel / retry / elapsed / alerts) |
| Documentation and installation guide | **M8** |
| Grafana version compatibility testing | **M9** (11.4 must-pass + current 13.x; **floor raised** — see deltas) |
| *(new in this revision)* | **M7** dashboard→intent deep-link — **Not in v1**; [PRD #3](https://github.com/LesleyMurfin/dot-ai-grafana/issues/23) |

### Deliberate deltas from the original draft (please confirm or redirect)

| Topic | Original draft | This revision | Why |
|---|---|---|---|
| **Grafana version floor** | 9.x+ / 10.x / 11.x | **`grafanaDependency: >=11.0`**, reference **11.4** must-pass | Reference deployment is 11.4; untested 9/10 burden — [Open Question 3](#open-questions) |
| **Auth wording** | "Leverages Grafana auth/RBAC — no separate auth" | Grafana settings store **dot-ai** URL + token; Grafana RBAC gates who can configure | More accurate to the Go-proxy + bearer design |
| **Problem framing** | Context-switch only | + competitive landscape vs Assistant/Sift | Avoid shipping a redundant telemetry chatbot |
| **Phases 2–3** | Absent | Headlamp dual-surface; Kubeshark/evidence on **core** first | Roadmap only; [companion model](#companion-project-model-same-as-headlamp) |

## Validation — assumptions checked against source

✅ verified · ⚠️ caveat · ✅→ resolved this revision.

| # | Assumption | Status | Evidence |
|---|------------|--------|----------|
| 1 | REST gateway (not only MCP) | ✅ | `docs/ai-engine/api/rest-api.md`; `schema/openapi.json` + `GET /api/v1/openapi` |
| 2 | `/tools/query` + `/tools/remediate` exist | ✅ | `src/interfaces/routes/index.ts` (`POST /api/v1/tools/:toolName`, PRD [vfarcic/dot-ai#354](https://github.com/vfarcic/dot-ai/issues/354)) |
| 3 | Auth: both headers accepted | ✅ | `src/interfaces/oauth/middleware.ts` L38–39 (`X-Dot-AI-Authorization` first, `Authorization` fallback) |
| 4 | query single-shot, input `{intent}` | ✅ | `src/tools/query.ts` L25–35 |
| 5 | **query answer field** | ✅→ | `data.result.summary` (`QueryOutput.summary`, `src/tools/query.ts` L54); plain intent, `[visualization]` switches modes (L210) |
| 6 | remediate `{issue,mode}` → single analysis | ✅ | `src/tools/remediate.ts` L1420–1633 |
| 7 | "analysis only" server-enforced | ✅ | `apply` RBAC gate, `remediate.ts` L1606/L1625 |
| 8 | responses structured JSON, need presentation | ✅ | `QueryOutput`/`RemediateOutput`; `dot-ai-headlamp` `client.ts` L89 unwraps `data.result` |
| 9 | long calls (tens of s → min) | ✅ | multi-iteration loop; `dot-ai-headlamp` `AI_TOOL_TIMEOUT = 30 min` (`client.ts` L9) |
| 10 | cluster context available | ✅→ | `POST /api/v1/tools/version` → `data.result.system.kubernetes.{connected,context}` (`rest-api.md`) |
| 11 | Grafana app+backend proxy feasible | ⚠️ | `examples/app-with-backend`; resource-call deadlines → async-default / Timeout chain |
| 12 | config = URL + secret token | ✅ | `AppConfig.tsx` (`jsonData.apiUrl` + `secureJsonData.apiKey`, write-only) |
| 13 | Grafana SDK exists for all of this | ✅ | `grafana-plugin-sdk-go` (`backend`, `httpadapter`, `httpclient`, `instancemgmt`); `@grafana/{data,ui,runtime}`; `@grafana/create-plugin`; `@grafana/plugin-e2e` |
| 14 | prior art exists | ✅ | `dot-ai-headlamp` — same thin-client pattern |
| 15 | GitHub surface already exists (project-setup) | ✅ | [project-setup docs](https://devopstoolkit.ai/docs/ai-engine/tools/project-setup) — repo audit/governance generation; distinct from remediate GitOps PR |
| 16 | Outbound MCP auth already landed (enables evidence MCPs) | ✅ | Core **[vfarcic/dot-ai#414](https://github.com/vfarcic/dot-ai/issues/414)** → design **[vfarcic/dot-ai#416](https://github.com/vfarcic/dot-ai/pull/416) → implement [vfarcic/dot-ai#417](https://github.com/vfarcic/dot-ai/pull/417) (merged) — static Bearer / headers / OAuth client_credentials for outbound MCP clients |

## Open Questions

1. **Recommended token scope** — a documented dot-ai RBAC role for "read + analyze, no `apply`" to cite in setup?
2. **Plugin identity & home** (Design Decision 5) — org slug / id; this repo or a sibling.
3. **Grafana floor** (Design Decision 6) — confirm `>=11.0` with **11.4 as the must-pass reference deployment** + the `@grafana/*` pins; accept dropping 10.x/9.x?
4. **Distribution** (Design Decision 7) — private/unsigned first vs. catalog.
5. **Timeout strategy** (Design Decision 2 / M0) — confirm async `202`+poll as the remediate default, or is blocking-with-tuned-chain acceptable on the target Grafana?
6. **Positioning vs Grafana Assistant** (Design Decision 9 / [Competitive landscape](#competitive-landscape--differentiation)) — given Grafana Assistant + Sift, is an **analysis-only** Grafana plugin worth building, or should v1 differentiate by including **remediation** (GitOps PR) and lean on K8s-state + sovereignty? This is the central go/no-go, above the implementation questions.
7. **Grafana Cloud (optional, not planned here)** (Design Decision 10 / [Deployment targets](#deployment-targets-self-managed-vs-grafana-cloud)) — does the maintainer or community want a **later** Cloud track (catalog signing, Cloud-reachable dot-ai HTTPS, install path)? This contribution will not take it on; answer only if someone is volunteering to own that follow-on.
8. **Kubeshark / evidence ownership** (Design Decision 11 / [Where Kubeshark connectivity lives](#where-kubeshark-connectivity-lives)) — confirm: **core `dot-ai` PRD + platform MOP** for connectivity; this companion only presents server output (optional M16). Reject putting a Kubeshark client in the Grafana plugin.

### Expansion: As-built answers (v1)

| # | Answer |
|---|---|
| 1 | Still open for maintainer docs. v1 uses a Bearer token; recommend no `apply`. |
| 2 | **Resolved:** id `devopstoolkit-dotai-app`; home this repo. |
| 3 | **Resolved:** `>=11.0`, reference **11.4**, pins 11.4.0. 9.x/10.x not claimed. |
| 4 | **Resolved for v1:** unsigned/private first. Catalog later. |
| 5 | **Resolved for v1:** blocking 120s (15s probes). Async 202 deferred. |
| 6 | **Resolved for v1:** analysis-only Grafana; execute stays Headlamp. GitOps-PR execute is a later PRD if wanted. |
| 7 | Unchanged — not this contribution. |
| 8 | Unchanged — core engine first; no Kubeshark client in this plugin. |

## Work Log

### 2026-09-01 — as-built v1

- **Issue**: Plugin implementation shipped; PRD #1 still read as Draft and still listed async 202 / generated OpenAPI client as Phase 1 defaults.
- **Action**: Status → Implemented (Phase 1 v1). Added as-built table; marked M0–M6/M8–M9 done with honest gaps; M7 open. Recorded answers for open questions 2–6.
- **Prompt**: update PRD #1 on the upstream plugin PR.

### 2026-09-02 — progressive context + ask log

- **Issue**: Packing restored on this PR for the maintainer to try. Headlamp/core have no Grafana DS Current (resource-scoped `sessionId` / execute only; [vfarcic/dot-ai#463](https://github.com/vfarcic/dot-ai/issues/463) is evaluate-external-MCP, Low). Ask log has **no enable/disable**.
- **Action**: As-built Ask-log + vs-Headlamp rows; README progressive-context + ask-log notes.
- **Prompt**: keep the updated PRD on PR #3 (not a new PR).

### 2026-09-02 — related PRDs named (split)

- **Issue**: M7 extras and GitOps execute had fork PRs but PRD #1 did not point at them, so the split was invisible on vfarcic#3.
- **Action**: Deferred / M7 / as-built rows now name [PRD #2](https://github.com/LesleyMurfin/dot-ai-grafana/issues/13) and [PRD #3](https://github.com/LesleyMurfin/dot-ai-grafana/issues/23). Related-PRDs table. No Map/Explore/show-me content added here.

### 2026-09-05 — retire text-only decision for rendering only

- **Issue**: PRD line 57, the "What's Explicitly Out of Scope" list, the tool→endpoint response table, and CLAUDE.md's Key Design Decisions still banned rich visualizations outright (Mermaid, cards, tables, syntax-highlighted code) at the presentation layer, but a companion PR renders the model's own GFM markdown (tables, headings, code, links). Raised as blocking finding B4 on review of PR #13: Decision 12 there recorded "navigation extras returning" but not that the text-only decision itself was being retired.
- **Action**: Amended PRD line 57, the out-of-scope bullet, and the response-table header; added Design Decision 12 recording that only the *rendering* half of the original text-only decision (Decision 1) is retired — sanitized markdown rendering is now in scope. The *request* half is unchanged: the plugin still never prefixes `[visualization]` to the intent. Mirrored the correction in CLAUDE.md's Key Design Decisions.
- **Prompt**: land as its own documentation-only PR, based directly on `main`, independent of the navigation PRs.
