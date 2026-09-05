# PRD: GitOps PR path for remediate execute

**Issue**: [#5](https://github.com/vfarcic/dot-ai-grafana/issues/5)
**Priority**: High
**Status**: Draft — not started

## Problem Statement

PRD #1 ships analysis-only remediate: operators get diagnosis text in Grafana but cannot turn a proposed fix into a change without leaving the product. In-cluster apply from the plugin is the wrong default — no review trail, bypasses GitOps, and collides with no-apply analysis tokens.

The review of the original PRD expansion (PR #2) called this out: keep v1 analysis-only, and track execute as a **separate** roadmap item for a GitOps-PR path.

## Solution Overview

After PRD #1 is live, Grafana keeps proposing remediation **analysis**. An explicit execute path creates a **pull request against the GitOps repo** (manifest/values diff). Cluster mutation happens only via the existing GitOps reconcile after human review and merge. The plugin never applies live to the cluster.

Credentials for PR creation are distinct from the forever no-apply analysis token. Analysis continues to work when PR credentials are absent or denied.

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

## Success Criteria

- Operator can go from remediate analysis in Grafana to a **reviewable GitOps PR** without the plugin writing the cluster
- Analysis continues to work with no-apply credentials when execute/PR credentials are absent or denied
- Audit trail is the PR (and GitOps history), not an opaque plugin action

## Dependencies

- **PRD #1** ([issue #1](https://github.com/vfarcic/dot-ai-grafana/issues/1)) — analysis-only Query/Remediate UI + backend proxy
- dot-ai remediate analysis output sufficient to propose a manifest/values change
- Reachable GitOps repo and SCM API (or equivalent automation) for PR creation

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| PR-create token confused with analysis token | Separate config keys; document forever no-apply on analysis; fail closed if miswired |
| Plugin accidentally gains live apply | No apply API surface; e2e asserts no cluster write; code review gate |
| SCM API outage blocks diagnosis | Analysis path independent; PR action fails with clear error only |
| Over-broad RBAC lets any editor open infra PRs | Default deny PR create; explicit role/approver config |

## Milestones

- [ ] **M1 — Token split and config** — no-apply analysis vs PR-create credentials documented and configurable; analysis works alone
- [ ] **M2 — Propose → PR UI** — from analysis result, operator can open/link a GitOps PR (title, body, diffs)
- [ ] **M3 — SCM integration** — backend creates PR via SCM API (or controlled automation) with distinct credentials
- [ ] **M4 — RBAC / approval gates** — who may trigger PR creation; optional second approver
- [ ] **M5 — e2e GitOps proof** — fixture or real repo: proposal → PR, no direct cluster mutate from plugin
- [ ] **M6 — Docs** — install/config notes for GitOps execute path and token split

## Decision Log

| Decision | Date | Rationale | Impact | Code Impact | Owner |
|----------|------|-----------|--------|-------------|-------|
| Execute = GitOps PR only; no in-plugin cluster apply | 2026-09-01 | Keeps GitOps as source of truth and human review; matches maintainer direction on PR #2 | PRD #1 stays analysis-only; this PRD owns execute | No apply client paths in plugin | Maintainer + contributor |
| Analysis token never gains apply | 2026-09-01 | Prevents accidental mutate if execute misconfigured | Forever no-apply on analysis path | Separate credential config; tests | Contributor |

## Open Questions

- [ ] **OQ1 — SCM provider scope:** GitHub only for v1 of this path, or GitLab/other via generic git remote?
- [ ] **OQ2 — Diff grain:** PR diffs top-level claims/values the operator reasons about, or fully expanded child manifests?
- [ ] **OQ3 — Second approver:** Required by default, or optional config for stricter environments?

## Status / Progress

- **Phase:** Draft (design only)
- **Overall:** 0% (0 of 6 milestones complete)
- **Implementation:** not started
- **Validation:** not started
- **Launch:** not started
- **Next:** M1 token split and config after PRD #1 ships
