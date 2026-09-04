# Test loop — plan vs shipped

This file is a **gap matrix**, not a claim that Group A/B/C from the M0 validation plan were executed as that suite inside this plugin. The thin-client that shipped has its own automated suite (CI + Jest + Go + Playwright). Pre-build live curls and host probes live in capture design notes; they are not re-run by plugin CI.

## What / Where / State

| What | Where | State |
|------|--------|--------|
| Group A/B/C plan | M0 validation plan (capture `design/`) | **Pre-build.** Still lists OpenAPI client generation, async **202** + job poll, UI **char counter**, and **raw-response toggle** as assumptions/gates. Those items were **not** built in the thin-client pass. |
| Milestone verify cmds | `specs/grafana-prd1-m*.md` | **Factory-era** verify blocks (`npm run build` / `test:ci` / `go test`, greps for handlers). They track milestone slices, not a thin-client-only inventory and not live Group A curls. |
| What actually runs | CI + Jest / Go / Playwright | **Shipped automation** in this repo. Indexed below (counted from source). |

## Group A (A1–A8) — planned live REST checks

Source of last known results: capture `design/M0-results.md` (code preflight). **Do not treat this table as plugin CI.**

| # | One-liner | Last known |
|---|-----------|------------|
| A1 | Tools list includes `query`, `remediate`, `version` | **PASS** |
| A2 | OpenAPI document fetchable for client-gen | **PASS** (fetch only — **no generated OpenAPI client** in the plugin) |
| A3 | `version` returns cluster/k8s context shape | **PASS** |
| A4 | `query` returns non-empty `data.result.summary` | **FAIL** (LLM / model-route error; summary not observed) |
| A5 | Plain intent vs `[visualization]` shape differs | **FAIL** (same LLM block as A4; shapes not comparable) |
| A6 | `remediate` with no-apply token: no `executionChoices`, has `fallbackReason` | **FAIL** (LLM block before analysis envelope; safety not re-proven that run) |
| A7 | Bearer / `X-Dot-AI-Authorization` auth; missing token → 401 | **PASS** |
| A8 | Wall-clock latency for healthy query/remediate | **INFO** (fail-fast LLM only; successful multi-minute path not measured) |

## Group B (B1–B4) — plan vs shipped host behavior

| # | Plan intent | Shipped reality |
|---|-------------|-----------------|
| B1 | Plugin loads on Grafana **11.4** (and stays loadable) | **CI e2e** runs Playwright against enterprise images including **11.x** (and later majors in the workflow matrix). Pins/floor still target ≥11.0 / 11.4 line. |
| B2 | Token stays in **secureJsonData**; settings GET must not echo secret | **Shipped:** config save omits `secureJsonData` when key already stored; new token sent as `secureJsonData.apiKey`. Covered by Jest AppConfig tests. |
| B3 | Probe host resource-call deadline → choose blocking vs async **202** | **No 202 / job-poll path implemented.** Tool HTTP client uses a **120s** host ceiling; UI surfaces that limit. Blocking call only. |
| B4 | Test-connection: bad URL/token fail-fast; good → OK + context | **Shipped:** `/test-connection` + health probes via httptest; **admin gate** on divergent draft URL; SEC-01 draft URL must not reuse stored key. |

## Group C — plan vs shipped automation

| Plan (M0 validation plan) | Shipped |
|---------------------------|---------|
| Go `resources_test.go` with httptest: envelope, errors, auth mapping, SSRF-ish URL reject | **Present** — see Go case index (`func Test*`). |
| Frontend RTL: tool switch, disable empty/in-flight, error Alert, **raw-response toggle**, **1000-char counter** | **Partial.** Tool switch, submit lock, errors, loading exist. **No** char counter UI; **no** raw-response toggle (not in thin-client UI). |
| Playwright: config-save, Query/Remediate round-trip vs mock (and later live) on 11.4 + current | **Config + mocked** query/remediate routes in `tests/*.spec.ts`. **Not** live Group A curls. CI matrix supplies multi-version Grafana images. |

## Case index (counted from source)

Counts below are from reading the files in this tree (not guessed).

| Layer | Files | Count rule | Count |
|-------|-------|------------|------:|
| Go | `pkg/plugin/resources_test.go` | every `func Test*` | **13** |
| Jest | `src/**/*.test.ts*` | every `describe(` | **12** |
| Jest | `src/**/*.test.ts*` | every `test(` | **72** |
| Playwright | `tests/*.spec.ts` | every `test(` | **6** |
| **Total named entries** | | sum of the four rows | **103** |

### Go — `pkg/plugin/resources_test.go` (13 `func Test*`)

Subtests listed for navigation; the contract count is the 13 top-level funcs.

1. `TestCallResource` — `health_not_configured`, `query_unconfigured`
2. `TestMethodNotAllowed` — `query_GET`, `remediate_GET`, `health_POST`, `health_PUT`, `test-connection_GET`
3. `TestTestConnection` — `missing_settings`, `success_with_draft`, `connected_unknown_shape_does_not_claim_success` (`missing_connected_key`, `connected_not_a_bool`), `unauthorized`, `settings_from_instance`, `rejects_draft_url_without_key_does_not_use_stored_key`, `draft_url_non_admin_403_no_dial`, `draft_url_missing_user_403_no_dial`, `draft_url_admin_proceeds`, `saved_url_editor_no_admin_gate`, `same_url_as_saved_editor_no_admin_gate`
4. `TestProxyTools` — `query`, `remediate`, `upstream_error_envelope`, `upstream_401_maps_to_502_envelope`, `upstream_403_maps_to_502_envelope`
5. `TestProxyBodyLimits` — `body_over_1mib_rejected_413`, `empty_body_defaults_to_empty_object`
6. `TestRemediateAnalysisOnly` — `strips_execute_apply_mode`, `invalid_json_400`, `empty_issue_400_no_upstream`, `query_still_forwards_extra_fields`
7. `TestCheckHealth` — `unconfigured`, `configured_valid_credentials_probes_and_reports_ok`, `configured_invalid_credentials_reports_error_not_ok`
8. `TestValidateAPIURL` — `rejects_non_http_schemes_and_hostless` (nested raw cases), `accepts_http_example_invalid_at_parse_layer`, `accepts_https_and_trims_slash`
9. `TestRejectsUnsafeAPIURLBeforeDial` — for each of `file` / `javascript` / `missing_host`: `test_connection_*`, `health_*`, `query_*`, `remediate_*`
10. `TestAskLogFile`
11. `TestAppendAskLogRotatesAtMaxSize`
12. `TestAskBodyPreviewStripsSecrets`
13. `TestAskMetaFromBodyReadsBranch`

### Jest — `src/**/*.test.ts*` (12 `describe`, 72 `test`)

**`src/components/App/App.test.tsx`** — describe `Components/App` (1 test)

- renders the DotAI tools page as default route

**`src/components/AppConfig/AppConfig.test.tsx`** — describe `Components/AppConfig` (7 tests)

- renders API settings with auth token, URL, save and test connection
- disables test connection until url and token are present
- error status without message shows Connection test failed, not Connection successful
- ok status with empty message falls back to Connection successful
- ok status with connected false keeps not-connected wording
- submit saves apiUrl and omits secureJsonData when key is already stored
- submit sends a newly typed auth token as secureJsonData

**`src/pages/DotAIPage.test.tsx`** — describe `Pages/DotAIPage` (16 tests)

- renders intent field and submit button
- can switch tool selection to Remediate (analysis only)
- submit calls query with Stable+stack Current and History is not in POST body
- Query Current includes mocked Grafana stack log lines before callDotAITool
- follow-up packs Current into intent and still omits History from body
- success path renders response summary and Current rewrite
- ok with empty summary shows fallback text
- error path shows error message without History rewrite; stack Current may remain
- timeout error renders the 120s limit line under an Ask timed out title
- loading state shows spinner and disables double-submit
- Enter in intent box submits when text is present
- Shift+Enter in intent box does not submit
- Enter does not submit while loading
- remediate submit calls analysis-only tool without execute
- Analyze this switches to Remediate and fills box from Current
- Clear thread resets active tool Current and History only

**`src/utils/askOrchestrator.test.ts`** — 3 describes, 19 tests

- describe `classifyFirstHop`: observability language → grafana; inventory language → dot-ai; default → grafana
- describe `isUnscopedQuestion / answerConflictsWithCurrent`: top issues is unscoped; named pod is not; denial vs Loki evidence is a conflict; live ask-log hop-1 denials are conflicts (regression: TEST window 20:42:55Z, hops=1); currentEvidenceSources reports only blocks with real lines; soft "not accessible" over real evidence is a hedge, a committed answer is not; quoted upstream "HTTP 404 Not Found" is not a denial of Current
- describe `runAskOrchestrator`: top issues triggers stack queries and a second across-clusters hop; Current vs answer conflict forces hop 2 and keeps Grafana evidence packed; conflict hop 2 prompt names the Current datasources and target, and forbids denial; hop 2 that still hedges on the conflict forces a third hop; hop 2 that answers from Current does not spend a third hop; unscoped hop 2 that only quotes a 404 does not force a third hop; empty stack refine does not exceed hop cap; hop loop hard-stops at MAX_ASK_HOPS; dot-ai-first inventory skips stack when healthy list; remediate is single analysis hop

**`src/utils/dotaiApi.test.ts`** — describe `callDotAITool` (11 tests)

- query POSTs { intent }; remediate POSTs { issue, intent }
- forwards every ask-log meta field, branch included
- drops an unknown branch value instead of forwarding it
- maps 200 contract success body to ToolCallResult
- maps contract error body (ok false) without envelope probing
- fetch reject/throw becomes ToolCallResult error (finding 5)
- fetch reject with status/data surfaces message
- client abort maps to the 120s plugin-limit message
- proxy 502 deadline envelope maps to the 120s plugin-limit message
- upstream 504 maps to the 120s plugin-limit message
- a plain 502 keeps its own text (not a timeout)

**`src/utils/grafanaStack.test.ts`** — 4 describes, 9 tests

- describe `parsePodNamespace / buildLogQL`: parses pod and namespace
- describe `linesFromLokiFrames`: caps extracted lines
- describe `fetchStackContext`: Current includes mocked Loki log lines via ds.query; one-line note when Loki datasource missing; no pod/ns still calls Loki and Prom with cluster-wide expr
- describe `getDataSourceByType selection`: prefers the default datasource over the first listed; falls back to the type-named datasource when none is default; falls back to the first configured when neither default nor named match; ignores datasources of another type

**`src/utils/progressiveContext.test.ts`** — describe `progressiveContext` (9 tests)

- stable preamble distinguishes query vs remediate analysis-only
- buildRequestText sends Stable+Current+Map+box and omits History
- buildRequestText first turn is Stable + Question only
- buildRequestText remediate uses Issue label
- rewriteCurrent replaces with capped block including resources and next
- appendHistory caps display turns at MAX_HISTORY_TURNS
- mergeMap keeps short names only
- extractResourceHints ignores filler words around "in"
- extractResourceHints still keeps real "name in namespace" pairs

### Playwright — `tests/*.spec.ts` (6 `test`)

**`tests/appConfig.spec.ts`** — describe `dot-ai app configuration`

- Test connection is visible; does not clobber a live MCP URL

**`tests/appNavigation.spec.ts`** — describe `dot-ai app navigation`

- should render tools page with submit control
- tools page exposes Query and Remediate options
- Query submit shows loading then mocked response
- Remediate submit shows loading then mocked analysis response
- Query submit surfaces error testid when backend fails

## Commands that actually run

```bash
go test ./pkg/plugin/...
npm run test:ci
npm run e2e
```

CI is build/lint/unit and multi-version Playwright (enterprise image matrix including 11.x through current majors). Fork-only `public-surface-check.sh` was dropped from this repo (squash-merge for trailer hygiene instead).

### Envelope note (automation contract)

Backend tool/proxy responses use a **flat** resource envelope (`ok`, `status`, `summary`, `error`), not nested `data.result.*`. Playwright route mocks must match that envelope.

## Explicit non-claims

- Group A/B/C were **planned** in the M0 validation plan (capture `design/`); they were **not** rebuilt as that live suite inside this plugin session.
- OpenAPI **generated client**, async **202**, **char counter**, and **raw toggle** remain plan items — **not** implemented here.
- Milestone specs’ verify cmds are slice checklists from the factory era; green milestone greps ≠ Group A PASS.
