# PRD: GitOps PR path for remediate execute

**Issue**: [#5](https://github.com/vfarcic/dot-ai-grafana/issues/5)
**Priority**: High
**Status**: Draft — design + start of M1
**Updated**: 2026-09-19

> **How this revision is organized:** This is **PRD #5 as written in draft PR #9**, with build-ready detail layered directly on top of it. Under every `##` heading you will find the **original section text first** (unchanged — same words, same bullets, same milestones), then one or more `### Expansion:` blocks. Expansions are **additive only**. Strip every Expansion block (and the reviewer appendices) and you get the original PRD back. We are not rewriting the PRD; we are building on it.
>
> Issue [#5](https://github.com/vfarcic/dot-ai-grafana/issues/5) **Owns** / **Does not own** is quoted verbatim in [Issue ownership (verbatim)](#issue-ownership-verbatim) and is not reinterpreted.

## Problem Statement

PRD #1 ships analysis-only remediate: operators get diagnosis text in Grafana but cannot turn a proposed fix into a change without leaving the product. In-cluster apply from the plugin is the wrong default — no review trail, bypasses GitOps, and collides with no-apply analysis tokens.

The review of the original PRD expansion (PR #2) called this out: keep v1 analysis-only, and track execute as a **separate** roadmap item for a GitOps-PR path.

### Expansion: Why a second credential exists at all

PRD #1's remediate path is **analysis-only forever** on `/api/plugins/<id>/resources/remediate`:

- The Go proxy allowlists `{issue}` (plus a mapped `{intent}` for compatibility) and **drops** `executeChoice`, `sessionId`, `apply`, `mode`, and confirmation tokens (`sanitizeRemediateBody`).
- The configured analysis secret (`secureJsonData.apiKey`) is a **no-apply** dot-ai token. It must never grow cluster-write or SCM-write scope.

A GitOps PR is a **different privilege**: it writes a branch and opens a pull request on an infrastructure repo. That credential must not be the analysis token, must not be sent to dot-ai, and must not be required for Query / Remediate to keep working.

## Solution Overview

After PRD #1 is live, Grafana keeps proposing remediation **analysis**. An explicit execute path creates a **pull request against the GitOps repo** (manifest/values diff). Cluster mutation happens only via the existing GitOps reconcile after human review and merge. The plugin never applies live to the cluster.

Credentials for PR creation are distinct from the forever no-apply analysis token. Analysis continues to work when PR credentials are absent or denied.

### Expansion: Issue ownership (verbatim)

Quoted from [vfarcic/dot-ai-grafana#5](https://github.com/vfarcic/dot-ai-grafana/issues/5). This PRD does not enlarge or shrink these bullets.

**Owns**

- After the analysis-only release ships: from an analysis result, propose → open/link a **pull request against the GitOps repo** (manifest/values diff).
- Credentials distinct from the no-apply analysis token; analysis path stays no-apply forever.
- RBAC/approval for who may trigger PR creation.
- e2e proving proposal → PR without direct cluster write from the plugin.
- Cluster mutation only via existing GitOps reconcile after human review/merge.

**Does not own**

- In-cluster apply / live mutate from the Grafana plugin.
- Evidence-grounded safe-time / blast-radius / post-merge verify (issue #7).
- Map / Explore / show-me (issue #6, deferred on PRD #1).
- Thread integrity / progress / shipping polish (issue #8, carry-forward on PRD #1).

### Expansion: Propose → PR → GitOps reconcile

ASCII sequence (M2+ UI, M3 SCM; M1 only stores the credentials the later hops will use):

```
Operator              Grafana plugin                 dot-ai              GitHub SCM           GitOps controller
   |                         |                         |                    |                       |
   |-- Remediate (analysis) ->|                         |                    |                       |
   |                         |-- POST /remediate ------>|                    |                       |
   |                         |   Authorization: Bearer  |                    |                       |
   |                         |     <apiKey>             |                    |                       |
   |                         |   body: {issue} only     |                    |                       |
   |                         |   (no execute / apply)   |                    |                       |
   |                         |<-- analysis + actions ---|                    |                       |
   |<-- analysis text --------|                         |                    |                       |
   |                         |                         |                    |                       |
   |  [M1: if gitops not ready, Propose stays disabled; analysis still works]
   |                         |                         |                    |                       |
   |-- Propose GitOps PR ---->|                         |                    |                       |
   |   (M2 UI, M3 create)     |                         |                    |                       |
   |                         |-- evaluateGitOpsPRConfig |                    |                       |
   |                         |   missing/denied → 409   |                    |                       |
   |                         |   mix-up (same secret)   |                    |                       |
   |                         |     → denied             |                    |                       |
   |                         |-- (M3) POST pulls ------>|------------------->|                       |
   |                         |   Authorization: Bearer  |                    |                       |
   |                         |     <gitopsPrToken>      |                    |                       |
   |                         |   NEVER apiKey here      |                    |                       |
   |                         |<-- PR number + html_url -|<-------------------|                       |
   |<-- PR link --------------|                         |                    |                       |
   |                         |                         |                    |                       |
   |  human review + merge on GitHub                    |                    |                       |
   |                         |                         |                    |-- reconcile --------->|
   |                         |                         |                    |                       |-- apply to cluster
```

**Hard rule:** the plugin process never talks to the Kubernetes apply/create/patch APIs. Cluster write is GitOps' job after merge.

```
  +------------------+     analysis token      +--------+
  | Query/Remediate  | ----------------------> | dot-ai |
  | (PRD #1 forever) |     no apply fields     +--------+
  +------------------+
           |
           |  (M2+) explicit Propose — only when gitops ready
           v
  +------------------+     PR-create token     +--------+     merge      +--------+
  | GitOps PR path   | ----------------------> | GitHub | -------------> | GitOps |
  | (this PRD)       |     owner/repo only     +--------+                +--------+
  +------------------+                                                      |
                                                                            v
                                                                      cluster apply
                                                                    (not this plugin)
```

## Technical Scope

- UI: from an analysis result, propose → open or link a GitOps PR (title, body, file diffs).
- Backend/integration: create the PR via SCM API (or hand off to controlled automation) using PR-create credentials separate from analysis.
- Document the **no-apply vs PR-create** token split; analysis path stays no-apply forever.
- RBAC / approval: who may trigger PR creation; optional second approver before open.
- End-to-end proof against a real or fixture GitOps repo: proposal → PR with no direct cluster write from the plugin.

### What's Explicitly Out of Scope

- In-cluster `kubectl apply` / live mutate from the Grafana plugin
- Any change to PRD #1 v1 analysis-only product surface
- Evidence-grounded safe-time / blast-radius / post-merge verify (PRD #7; depends on this PR mechanism)
- Map / Explore / show-me navigation (PRD #6)
- Thread integrity, multi-hop progress UX, shipping polish (PRD #8)
- `operate` / `recommend` multi-tool expansion beyond the GitOps PR trigger

### Expansion: Config and API shapes (M1 contract)

Grafana app settings. **`jsonData` is non-secret. Secrets live only in `secureJsonData`.** Existing analysis keys are unchanged.

```jsonc
// plugin.meta.jsonData  — persisted, visible to Admin config UI
{
  "apiUrl": "http://dot-ai:3456",          // existing — dot-ai REST base (no /api/v1 suffix)
  "debugLog": false,                       // existing
  "showContext": true,                     // existing
  "sendGrafanaEvidence": true,             // existing

  // --- GitOps SCM (new; all optional; empty = execute off) ---
  "gitopsProvider": "github",              // M1–M5: only "github" is accepted (OQ1 leaning)
  "gitopsOwner": "acme",                   // org or user
  "gitopsRepo": "gitops-prod",             // repository name (not owner/repo combined)
  "gitopsBaseBranch": "main",              // default "main" when omitted / blank
  "gitopsApiUrl": ""                       // reserved: GitHub Enterprise host; empty = api.github.com (M3)
}

// plugin.meta.secureJsonData  — write-only from the browser; backend decrypts
{
  "apiKey": "<dot-ai no-apply analysis token>",   // existing — NEVER used for SCM
  "gitopsPrToken": "<GitHub PAT / fine-grained token>"
  // gitopsPrToken scopes (M3, GitHub-first): Contents: read/write (branch + file commit)
  //   and Pull requests: read/write. No cluster, no dot-ai, no Grafana API.
}
```

**Frontend `AppPluginSettings` (additive):**

| Field | Store | Default | Secret? |
|-------|--------|---------|---------|
| `apiUrl` | `jsonData` | `""` | no |
| `apiKey` | `secureJsonData` | unset | **yes** |
| `gitopsProvider` | `jsonData` | `""` (treat as `"github"` only when other GitOps fields are set) | no |
| `gitopsOwner` | `jsonData` | `""` | no |
| `gitopsRepo` | `jsonData` | `""` | no |
| `gitopsBaseBranch` | `jsonData` | `"main"` when GitOps fields are saved non-empty; otherwise omitted | no |
| `gitopsApiUrl` | `jsonData` | `""` (public GitHub) | no |
| `gitopsPrToken` | `secureJsonData` | unset | **yes** |

There is **no** `gitopsExecuteEnabled` user switch in M1. Execute is a **computed** capability (see readiness below). A boolean that an Admin can flip without a repo or token would lie. The launch requirement “feature/config default keeps execute off until GitOps repo + credentials are set” is this computed gate.

**Backend settings struct (Go, additive on `App`):**

```go
type gitopsSettings struct {
    Provider   string // jsonData.gitopsProvider
    Owner      string // jsonData.gitopsOwner
    Repo       string // jsonData.gitopsRepo
    BaseBranch string // jsonData.gitopsBaseBranch; default "main"
    APIURL     string // jsonData.gitopsApiUrl; empty = https://api.github.com
    PRToken    string // DecryptedSecureJSONData["gitopsPrToken"]
}

// Never put PRToken on analysis HTTP clients. Never log it.
```

**Computed readiness (M1; used by M2/M3; no SCM call):**

```
evaluateGitOpsPRConfig(settings, analysisAPIKey) → { ready bool, reason string }

ready  iff  provider ∈ {"", "github"}
        AND owner != ""
        AND repo  != ""
        AND prToken != ""
        AND prToken != analysisAPIKey          // token mix-up → denied

reason (stable strings for tests / UI):
  "not_configured"   — owner, repo, and token all empty (default install)
  "missing_owner"
  "missing_repo"
  "missing_token"
  "unsupported_provider"  — anything other than github / empty-as-github
  "token_mixup"           — gitopsPrToken equals apiKey (denied)
  "ready"
```

Default install (PRD #1 operators who never touch GitOps fields): `not_configured` → execute **off**. Analysis unchanged.

**Resource routes**

| Method + path | Milestone | Behavior |
|---------------|-----------|----------|
| `POST /query`, `POST /remediate`, `POST /test-connection`, `GET /health` | PRD #1 | **Unchanged.** Use `apiKey` only. Ignore `gitopsPrToken`. |
| `GET /gitops-status` | **M1** | Returns `{ "ready": bool, "reason": "<code>", "provider", "owner", "repo", "baseBranch" }`. **Never** returns tokens or `apiKey`. |
| `POST /gitops-pr` (or equivalent) | **M3** | Create PR. Fail closed via `evaluateGitOpsPRConfig` before any SCM dial. **Not in M1.** |
| Any `/apply`, `/execute`, kubectl-shaped route | **never** | Must not exist. |

**M1 config UI (Admin page only):** a second `FieldSet` **“GitOps PR credentials”** under the existing **“dot-ai API Settings”** set.

- Fields: provider (read-only `GitHub` for M1), owner, repo, base branch, PR-create token (`SecretInput`, same write-only pattern as `apiKey`).
- Helper copy: analysis token stays no-apply; PR-create token is unused until M3; Query / Remediate do not need these fields.
- Save still requires `apiUrl` + analysis token (existing submit gate). GitOps fields are optional. Saving with only analysis settings must **not** write a dummy `gitopsPrToken`.
- Status line (from `GET /gitops-status` or a client-side mirror of the same rules): “GitOps PR execute is off until owner, repo, and PR-create token are set.”

### Expansion: Milestone slices (what lands when)

| Milestone | Lands | Does **not** land |
|-----------|-------|-------------------|
| **M1** | Config keys + Admin UI + backend parse + `evaluateGitOpsPRConfig` + `GET /gitops-status` + unit tests (missing / denied / mix-up / analysis-alone) | Propose button, SCM HTTP, PR create, RBAC-for-PR, e2e against GitHub |
| **M2** | Analysis-result **Propose GitOps PR** UI (title / body / diff preview); disabled + reason when `ready=false` | Live `POST /repos/.../pulls` |
| **M3** | GitHub-first PR create with `gitopsPrToken`; fixture or recorded SCM; fail closed on missing/denied | GitLab / generic git; live cluster apply |
| **M4** | Grafana role gate for Propose (default **Admin** for create; Editor may still analyze); optional second approver | Changing `/remediate` Editor gate |
| **M5** | e2e: propose → PR on fixture/real repo; assert plugin made **zero** cluster writes | Evidence / blast-radius (issue #7) |
| **M6** | README / install: token split, failure modes, GitOps repo fields | Rewriting PRD #1 analysis docs as execute |

## Requirements

### Implementation

- [ ] Analysis result UI exposes an explicit **propose GitOps PR** action (not implicit apply)
- [ ] Backend creates or links a PR against the configured GitOps repo with title, body, and file diffs
- [ ] PR-create credentials are configured separately from the no-apply analysis token
- [ ] Analysis path remains fully functional when PR-create credentials are missing or denied
- [ ] RBAC gate: only permitted Grafana roles can trigger PR creation
- [ ] Optional second-approver gate before the PR is opened (configurable)

### Documentation

- [ ] Document no-apply vs PR-create token split and failure modes
- [ ] Document RBAC / approval expectations for PR creation
- [ ] README / install notes describe GitOps repo configuration for the execute path

### Validation

- [ ] Unit tests cover credential-missing, credential-denied, and happy-path PR create
- [ ] e2e against a real or fixture GitOps repo: proposal → PR, no cluster write from plugin
- [ ] Verify analysis-only path still enforces no-apply when execute is disabled

### User Acceptance

- [ ] Operator can go from remediate analysis in Grafana to a reviewable GitOps PR without leaving the review trail
- [ ] Operator with analysis-only credentials never sees a working apply path

### Launch Activities

- [ ] Feature flag or config default keeps execute off until GitOps repo + credentials are set
- [ ] Rollout note for operators already on PRD #1 analysis-only

### Success Metrics

- [ ] At least one successful analysis → GitOps PR path demonstrated on a reference stack
- [ ] Zero plugin-originated live cluster applies in that demonstration

### Expansion: Acceptance fixtures (M1 vs later)

Stable names for tests. **M1 implements F1–F5 and the analysis half of F6.** F6 SCM + F7–F9 are M2+.

| ID | Setup | Expect |
|----|--------|--------|
| **F1** analysis-alone | Only `apiUrl` + `apiKey`. No GitOps fields. | Query + Remediate succeed. `GET /gitops-status` → `ready=false`, `reason=not_configured`. No Propose (M2). |
| **F2** missing token | Owner + repo set; `gitopsPrToken` unset. | `ready=false`, `reason=missing_token`. Analysis still works. |
| **F3** missing repo | Token set; owner set; repo empty. | `ready=false`, `reason=missing_repo`. Analysis still works. |
| **F4** denied / mix-up | `gitopsPrToken` **equals** `apiKey`. | `ready=false`, `reason=token_mixup`. Analysis still uses `apiKey` only. M3 must not dial SCM. |
| **F5** missing owner | Repo + token set; owner empty. | `ready=false`, `reason=missing_owner`. |
| **F6** ready config | Provider github + owner + repo + distinct `gitopsPrToken`. | M1: `ready=true`. M3: PR create uses **only** `gitopsPrToken`. Analysis outbound `Authorization` is still `apiKey`. |
| **F7** unsupported provider | `gitopsProvider: "gitlab"` (or other). | `ready=false`, `reason=unsupported_provider` until a later PRD opens that provider. |
| **F8** no live apply | Any config. | No route accepts `apply` / `executeChoice` / `sessionId`. `sanitizeRemediateBody` still strips them. Plugin never calls Kubernetes write APIs. |
| **F9** e2e propose→PR | Fixture GitHub repo (M5). | PR exists with title/body/diff. Audit of plugin egress: SCM + dot-ai only. **Zero** cluster mutate from the plugin process. |

### Expansion: Failure modes

| Mode | User-visible | Backend |
|------|----------------|---------|
| GitOps fields empty (default) | Config helper: execute off. No Propose (M2). | `not_configured`; no SCM dial |
| Owner/repo/token incomplete | Status reason; Propose disabled | `missing_*`; HTTP 409 on any future create |
| Token mix-up (`gitopsPrToken == apiKey`) | “PR-create token must not be the analysis token” | `token_mixup`; denied; no SCM dial |
| Unsupported provider | “GitHub only in this version” | `unsupported_provider` |
| SCM 401/403 (M3) | “PR-create credentials denied by GitHub” | Map to 502/409; **do not** fall back to `apiKey` |
| SCM outage (M3) | PR action errors; Query/Remediate unaffected | Analysis client unchanged |
| Viewer hits future `/gitops-pr` (M4) | Forbidden | Fail closed (M4 default: Admin for create) |
| Crafted `/remediate` with execute fields | Analysis only / 400 | Allowlist drop; never forwarded |

### Expansion: Threat notes

| Threat | Why it matters | Control (this PRD) |
|--------|----------------|--------------------|
| **Token mix-up** | One secret used for both analysis and GitHub write. A leaked no-apply token suddenly opens infra PRs, or a GitHub PAT is sent to dot-ai. | Distinct keys (`apiKey` vs `gitopsPrToken`). `token_mixup` deny if equal. Analysis HTTP client must not read `gitopsPrToken`. SCM client must not read `apiKey`. Unit tests F4/F6. |
| **Live-apply prevention** | Fastest way to violate GitOps and the no-apply analysis token. | No apply/execute route. Remediate allowlist stays. e2e F8/F9. Code review: reject any `client-go` write or `/apply` handler. |
| **Secret exfil via status/error** | `GET /gitops-status` or SCM errors echo the PAT. | Status DTO has no token fields. Redact `Authorization` / `gitopsPrToken` / `apiKey` the same way analysis redacts `apiKey` today. |
| **Confused deputy** | Token valid for many repos; plugin posts to an attacker-supplied owner/repo. | M3 binds create to **saved** `gitopsOwner`/`gitopsRepo` only. Request body cannot retarget the repo. |
| **Privilege confusion (RBAC)** | Any Editor who can Analyze can open prod GitOps PRs. | M4: create defaults to **Admin** (or explicit allow-list). Analysis Editor gate **unchanged**. OQ3 second approver is optional, default off. |
| **GitOps token over-scope** | Classic PAT with `repo` on every org. | Docs (M6): prefer fine-grained token limited to the one GitOps repo. Not enforceable in the plugin. |

## Success Criteria

- Operator can go from remediate analysis in Grafana to a **reviewable GitOps PR** without the plugin writing the cluster
- Analysis continues to work with no-apply credentials when execute/PR credentials are absent or denied
- Audit trail is the PR (and GitOps history), not an opaque plugin action

### Expansion: Additional success criteria

- Default (no GitOps fields) is indistinguishable from today’s analysis-only plugin for Query / Remediate.
- `GET /gitops-status` never includes secrets.
- M3 PR create cannot succeed when `evaluateGitOpsPRConfig` is not `ready`.
- Demonstration (M5) records **zero** plugin-originated cluster applies.

## Dependencies

- **PRD #1** ([issue #1](https://github.com/vfarcic/dot-ai-grafana/issues/1)) — analysis-only Query/Remediate UI + backend proxy
- dot-ai remediate analysis output sufficient to propose a manifest/values change
- Reachable GitOps repo and SCM API (or equivalent automation) for PR creation

### Expansion: Additional dependencies

- Grafana Admin config page (`AppConfig`) and `secureJsonData` write-only secret inputs (already shipped).
- GitHub REST `POST /repos/{owner}/{repo}/pulls` (and the contents/blob/ref calls needed to push a branch) — **M3**, not M1.
- GitOps reconciler **already running** on the cluster (Argo CD / Flux / equivalent). This plugin does not install or talk to it.
- Issue #7 (evidence-grounded change safety) **depends on** this PR mechanism; it must not block M1–M5.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| PR-create token confused with analysis token | Separate config keys; document forever no-apply on analysis; fail closed if miswired |
| Plugin accidentally gains live apply | No apply API surface; e2e asserts no cluster write; code review gate |
| SCM API outage blocks diagnosis | Analysis path independent; PR action fails with clear error only |
| Over-broad RBAC lets any editor open infra PRs | Default deny PR create; explicit role/approver config |

### Expansion: Additional risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Admin pastes the analysis token into the PR-create field | GitHub PAT == no-apply token; mix-up | `token_mixup` deny; UI copy; tests F4 |
| M1 “ready” is mistaken for “PRs already create” | False ship signal | Milestone table; Status stays design + start of M1 until M3 |
| GitHub-only leaning blocks GitLab shops | Later rewrite | Interface `evaluateGitOpsPRConfig` + provider switch; OQ1 marked GitHub-first, GitLab **undecided** |
| Diff grain too wide (fully rendered children) | Unreviewable PRs | OQ2 leaning: top-level claims/values (M2/M3) |

## Milestones

- [ ] **M1 — Token split and config** — no-apply analysis vs PR-create credentials documented and configurable; analysis works alone
- [ ] **M2 — Propose → PR UI** — from analysis result, operator can open/link a GitOps PR (title, body, diffs)
- [ ] **M3 — SCM integration** — backend creates PR via SCM API (or controlled automation) with distinct credentials
- [ ] **M4 — RBAC / approval gates** — who may trigger PR creation; optional second approver
- [ ] **M5 — e2e GitOps proof** — fixture or real repo: proposal → PR, no direct cluster mutate from plugin
- [ ] **M6 — Docs** — install/config notes for GitOps execute path and token split

### Expansion: M1 done-when (build-ready)

M1 is **started** by this design plus a **separate** implementation PR. It is **not** complete until that PR lands.

*Done when:*

1. Admin can save `gitopsOwner` / `gitopsRepo` / `gitopsBaseBranch` / `gitopsProvider` in `jsonData` and `gitopsPrToken` in `secureJsonData` without changing analysis save behavior.
2. Backend parses those keys; `GET /gitops-status` reports F1–F5 reasons; tokens never appear in the body.
3. Query / Remediate / Test-connection still use only `apiKey` when GitOps is absent **or** present.
4. Unit tests cover missing token, missing repo/owner, token mix-up (denied), unsupported provider, and analysis-alone.
5. No `POST /gitops-pr`, no SCM client, no live-apply route.

## Decision Log

| Decision | Date | Rationale | Impact | Code Impact | Owner |
|----------|------|-----------|--------|-------------|-------|
| Execute = GitOps PR only; no in-plugin cluster apply | 2026-09-01 | Keeps GitOps as source of truth and human review; matches maintainer direction on PR #2 | PRD #1 stays analysis-only; this PRD owns execute | No apply client paths in plugin | Maintainer + contributor |
| Analysis token never gains apply | 2026-09-01 | Prevents accidental mutate if execute misconfigured | Forever no-apply on analysis path | Separate credential config; tests | Contributor |

### Expansion: Decision Log additions (2026-09-19)

| Decision | Date | Rationale | Impact | Code Impact | Owner |
|----------|------|-----------|--------|-------------|-------|
| **OQ1 leaning — GitHub-first.** M1–M5 implement `gitopsProvider=github` only. GitLab / generic git remain **undecided** (not rejected; not scheduled). | 2026-09-19 | Smallest reviewable SCM; matches existing GitHub surfaces in the toolkit. Avoids a fake-generic client. | Unsupported provider → `unsupported_provider`. A later PRD/OQ1 close can add GitLab. | Provider enum + fail-closed default | Contributor; maintainer confirms |
| **OQ2 leaning — top-level claims/values.** PRs should diff Helm values / Kustomize overlays / the files operators already review — not fully expanded child manifests. **Still open** for the exact file-selection UX in M2. | 2026-09-19 | Expanded children are unreviewable and fight GitOps. | M2 preview + M3 commit set stay narrow. | Diff builder (M2/M3) | Contributor; maintainer confirms at M2 |
| **OQ3 leaning — second approver optional, default off.** M4 ships a configurable gate; default is **no** plugin-side second person. Grafana **Admin** (not Editor) may create PRs by default. | 2026-09-19 | GitHub CODEOWNERS / branch protection already cover many shops. Forcing a Grafana second click on day one blocks the happy path. | Stricter orgs opt in. Analysis Editor gate unchanged. | M4 settings (not M1) | Contributor; maintainer confirms at M4 |
| **Computed execute gate, no lying toggle.** Execute is off until owner + repo + distinct PR token are set. No `gitopsExecuteEnabled` switch in M1. | 2026-09-19 | Launch requirement: default off until repo + credentials exist. A boolean without those inputs is a false on. | Matches F1 default. | `evaluateGitOpsPRConfig` | Contributor |
| **Config keys frozen for M1.** `jsonData.gitopsProvider\|Owner\|Repo\|BaseBranch\|ApiUrl`; `secureJsonData.gitopsPrToken`. Analysis keys unchanged. | 2026-09-19 | Build-ready contract for the M1 PR. | Renames after M1 need a migration note. | AppConfig + `NewApp` | Contributor |
| **M1 does not create PRs.** Status/readiness only. SCM HTTP is M3. | 2026-09-19 | Token split is independently reviewable; no live GitHub from a config PR. | Draft #9 stays docs-only; M1 is a separate PR. | `GET /gitops-status` only | Contributor |

## Open Questions

- [ ] **OQ1 — SCM provider scope:** GitHub only for v1 of this path, or GitLab/other via generic git remote?
- [ ] **OQ2 — Diff grain:** PR diffs top-level claims/values the operator reasons about, or fully expanded child manifests?
- [ ] **OQ3 — Second approver:** Required by default, or optional config for stricter environments?

### Expansion: OQ leanings (not silent closes)

| OQ | Recommended leaning | Status | Close when |
|----|---------------------|--------|------------|
| **OQ1** | **GitHub-first** for M1–M5. Interface stays provider-shaped so GitLab can be added without renaming keys. | **Leaning — GitHub-first OK.** GitLab/generic **undecided**. Checkbox above stays open. | Maintainer ACK, or first GitLab issue. |
| **OQ2** | **Top-level claims/values** (Helm/Kustomize/overlay files), not fully expanded children. | **Leaning.** Exact picker is M2. Checkbox stays open. | M2 UI review. |
| **OQ3** | **Optional, default off.** PR create defaults to Grafana Admin. Branch protection is out-of-plugin. | **Leaning.** Checkbox stays open. | M4 implementation review. |

## Status / Progress

- **Phase:** Draft (design only)
- **Overall:** 0% (0 of 6 milestones complete)
- **Implementation:** not started
- **Validation:** not started
- **Launch:** not started
- **Next:** M1 token split and config after PRD #1 ships

### Expansion: Progress (evidence log — milestones above remain SSOT)

PRD #1 analysis-only Query/Remediate is on `vfarcic/main`. This file is still the design SSOT for execute.

| date | milestone | status | evidence |
|------|-----------|--------|----------|
| 2026-09-03 | PRD draft | [x] filed | Issue #5; draft PR #9; original short PRD |
| 2026-09-19 | Design depth | [x] this revision | Config shapes, sequence, fixtures F1–F9, threats, OQ leanings + Decision Log |
| 2026-09-19 | **M1** token split | [~] **started, not complete** | Design contract above. Implementation is a **separate** draft PR (docs-only stays on #9). Checkboxes in ## Milestones stay `[ ]` until that PR merges. |
| 2026-09-19 | M2–M6 | [ ] not started | Propose UI, SCM create, RBAC, e2e, install docs |

**Honest overall:** design + start of M1. **Not** complete. Do not treat `ready=true` in M1 as “GitOps execute shipped.”

---

# Reviewer appendices (not part of the original PRD)

## Related / prior art

- Issue ownership: [vfarcic/dot-ai-grafana#5](https://github.com/vfarcic/dot-ai-grafana/issues/5)
- Analysis-only v1: [PRD #1](1-grafana-ai-cluster-intelligence.md) / [issue #1](https://github.com/vfarcic/dot-ai-grafana/issues/1)
- Maintainer direction to split execute out of PRD #1: review of original PRD expansion (PR #2)
- Does-not-own neighbors: [issue #6](https://github.com/vfarcic/dot-ai-grafana/issues/6) Map, [issue #7](https://github.com/vfarcic/dot-ai-grafana/issues/7) evidence safety, [issue #8](https://github.com/vfarcic/dot-ai-grafana/issues/8) usability
- Server remediate execute / GitOps PR (engine, not this UI): dot-ai remediate tool docs — this companion does **not** reimplement the engine
- Headlamp already has execute; Grafana’s execute is **PR-only** (this PRD)

## Link conventions

| Ref form | Resolves to |
|---|---|
| `[#5](https://github.com/vfarcic/dot-ai-grafana/issues/5)` | This companion issue |
| `[#1](https://github.com/vfarcic/dot-ai-grafana/issues/1)` | PRD #1 analysis-only |
| Bare `#6` / `#7` / `#8` in the issue quote | Same repo issues — left verbatim |

## Mapping to the original draft

| Original draft | This revision |
|---|---|
| Problem / Solution / Scope / OOS | Unchanged + sequence + ownership quote |
| Requirements checkboxes | Unchanged; fixtures map onto them |
| Decision Log (2 rows) | Unchanged; additions in Expansion table |
| Open Questions OQ1–OQ3 | Checkboxes unchanged; leanings in Expansion |
| Status 0% / not started | Original list kept; Expansion records design + M1 start |

## Work Log

### 2026-09-19 — expand draft to build-ready depth

- **Issue**: Draft PR #9 was a short operable outline; M1 could not be built without config keys, readiness rules, and OQ leanings.
- **Action**: Additive Expansion blocks only. Issue Owns / Does not own copied verbatim. OQ1–OQ3 checkboxes left open with recommended leanings + Decision Log rows. Status/Progress: design + start of M1, not complete. **Docs-only** on this branch.
- **Prompt**: Lesley — expand PRD #5 then start M1 on a separate branch.
