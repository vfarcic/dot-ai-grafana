# DevOps AI Toolkit Grafana Plugin

AI-powered Kubernetes cluster intelligence inside [Grafana](https://grafana.com) — powered by [DevOps AI Toolkit](https://devopstoolkit.ai).

Companion to the [Headlamp plugin](https://github.com/vfarcic/dot-ai-headlamp): Grafana is for diagnosis (query + analysis-only remediate). Headlamp is for operate / execute.

## What It Does

- **Query** — Ask questions about your cluster in plain English. Responses are text (`data.result.summary`).
- **Remediate (analysis only)** — Get AI-powered issue analysis. No execute, apply, or mutation UI.
- **Progressive context** — On Query, the page reads configured Loki, Prometheus, Tempo, and Alertmanager datasources (`getDataSourceSrv`, no hardcoded uids) and packs **Current** + **Map** into the same `{intent}` string. A condensed **Prior:** block (up to `MAX_PRIOR_CHARS` = 240 characters, built from the 2 most recent turns) is also included in the intent inside the unchanged 1000-char budget. Full History remains on screen (last 5 turns). No `sessionId`. One Ask may issue up to 3 dot-ai POSTs (unscoped question or answer vs Current). Remediate is one hop and reuses Query Current. JSONL ask log: `/var/lib/grafana/dotai-ask.log` (no tokens; hop meta stripped before upstream). What Prior actually contains, and what the evidence toggle does and does not cover, is in [Data egress](#data-egress).

## Requirements

- Grafana >= 11.0 (reference host **11.4**; `@grafana/*` libraries pinned to 11.4.0)
- Grafana org **Editor** or **Admin** to use Query / Remediate; **Admin** for Configuration and Test connection (see [Configuration](#configuration))
- [DevOps AI Toolkit](https://devopstoolkit.ai) MCP server reachable from the Grafana plugin backend
- Unsigned load until the plugin is signed:

```bash
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=devopstoolkit-dotai-app
```

## Installation

This plugin installs into **a Grafana you already run**. It is deliberately not
part of the [dot-ai-stack](https://github.com/vfarcic/dot-ai-stack) umbrella
chart: that chart deploys the dot-ai MCP server, controller and UI, and does not
deploy Grafana, so there is nothing there for a Grafana plugin to install into.
Point this plugin at your dot-ai MCP server via [Configuration](#configuration).

### From a release

Download the `devopstoolkit-dotai-app-<version>.zip` from the
[latest release](https://github.com/vfarcic/dot-ai-grafana/releases), verify it
against the published `.sha256`, and unzip it into Grafana's plugin directory.

Releases are **unsigned**, so Grafana must be told to load it:

```bash
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=devopstoolkit-dotai-app
```

### From source

```bash
npm install
npm run build
mage -v build:linux
```

Copy `dist/` into Grafana's plugin directory as `devopstoolkit-dotai-app`, then restart Grafana.

Local Grafana (create-plugin docker):

```bash
npm run server
```

#### What `npm run server` starts (and overrides)

The e2e harness changed this environment in three ways. All three apply to plain
local development too, not just CI:

1. **A second container.** `docker-compose.yaml` adds `dot-ai-stub`
   (`python:3.12-alpine`, pinned by digest) running
   `tests/harness/dot_ai_stub.py`. Grafana `depends_on` it, so it starts on every
   `npm run server`. It publishes container port `8080` on host port **18080**
   (`http://localhost:18080/healthz` returns per-tool upstream hit counters, which
   the deny-path e2e specs read to prove a 403 happened with no upstream dial).
2. **`apiUrl` points at that stub.** `provisioning/plugins/apps.yaml` provisions
   `apiUrl: http://dot-ai-stub.svc:8080`. Grafana re-applies app provisioning on
   **every start**, so it overwrites whatever you set in the plugin config UI. Local
   dev therefore talks to a fake that answers `stub-query-ok: …`, which looks
   enough like a working connection to be mistaken for one. (The previous value,
   `127.0.0.1:3456`, resolved to the Grafana container's own loopback and could
   never reach a host-side dot-ai either.)
3. **Anonymous auth is off by default.** `docker-compose.yaml` sets
   `GF_AUTH_ANONYMOUS_ENABLED: ${ANONYMOUS_AUTH_ENABLED:-false}` as a runtime env
   var, overriding the image default baked from the create-plugin base build arg
   (`true`). You now get a **login page** instead of an automatic Admin session;
   log in with `admin` / `admin` (`GF_AUTH_BASIC_ENABLED: 'true'` is set alongside).
   Set `ANONYMOUS_AUTH_ENABLED=true` to get the old auto-Admin behaviour back.

To point local dev at a **real** dot-ai instead of the stub, override the
provisioned value at runtime rather than editing the tracked file — the app
provisioning file is committed, so an edit there is easy to `git commit` by
accident (and it carries the e2e bearer placeholder):

```bash
# One-off: run Grafana without the provisioning mount, then configure the plugin in the UI.
GF_PATHS_PROVISIONING=/etc/grafana/provisioning-empty npm run server

# Or keep a local, untracked copy of the provisioning file and point Compose at it:
cp provisioning/plugins/apps.yaml /tmp/apps.local.yaml   # edit apiUrl/apiKey there
# then mount /tmp/apps.local.yaml over provisioning/plugins/apps.yaml in a
# docker-compose.override.yaml (untracked) for your machine only.
```

Note that `provisioning/plugins/apps.yaml`'s hostname is load-bearing for the
test suite — see the comment in that file before changing it.

## Releasing

Tag the version and the [release workflow](.github/workflows/release.yml) does
the rest — it syncs `package.json` from the tag (so `plugin.json` reports the
right version), assembles `changelog.d/` fragments into `CHANGELOG.md` with
towncrier, and attaches the plugin zip plus its SHA256 to the GitHub release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Every user-visible change should land with a fragment in `changelog.d/`, named
`<issue>.<type>.md` where type is one of `feature`, `bugfix`, `breaking`,
`doc`, `misc`. CI renders them on every PR, so a malformed fragment fails there
rather than at release time.

### Branch protection and the release token

`main` carries a ruleset ("main: require PR and green CI") that requires a pull
request and a passing `Build, lint and unit tests` check, and blocks force
pushes and deletion. Repository admins can bypass it.

The release job commits the assembled changelog and version bump back to
`main`, which the ruleset would otherwise reject: `GITHUB_TOKEN` has write
access but is not an admin, and GitHub Actions cannot be granted a ruleset
bypass on a personal-account repository. So the job uses a `RELEASE_TOKEN`
secret when present — a fine-grained PAT from a repository admin with
`contents: write` on this repo.

Without `RELEASE_TOKEN` the release still succeeds: the GitHub Release and its
artifacts publish normally, and only the commit-back is skipped, with a warning
naming the `towncrier` command to re-apply the changelog through a PR.

## Configuration

As Grafana Admin: **Administration → Plugins → dot-ai → Configuration**.

| Setting | Description |
|---|---|
| MCP Server URL | Absolute `http(s)` base for the dot-ai tools REST API. HTTPS required except loopback / RFC1918 / in-cluster `*.svc` / `*.cluster.local` (example: `http://dot-ai.dot-ai.svc:3456`). Public `http` is rejected. |
| Auth Token | Bearer token stored in Grafana encrypted settings (`Authorization: Bearer`) |
| Debug Log | Enable/disable JSONL ask log at `/var/lib/grafana/dotai-ask.log`. **Off by default.** JSONL may include packed Current (Loki/Prom lines). Each line records the Grafana user `login` and org `role`; never the user's email or display name. No Grafana tokens. Credentials inside *application* logs can appear. |
| Show context | Show Current, Map, and History panels on the page. **On by default.** Toggles on-page display only; independent of Send Grafana evidence. Does not control intent packing (Current/Map/Prior). |
| Send Grafana evidence | `jsonData.sendGrafanaEvidence`. **On by default** (missing/undefined = send). When off, no datasource is read, so Asks pack no fresh Grafana DS facts — the question, the session **Current** summary, **Map**, and the condensed **Prior:** block are still sent. The toggle does not cover Prior (see [Data egress](#data-egress)). Independent of Show context. |
| Test connection | `POST /api/v1/tools/version` through the plugin backend |

**Who can use Query / Remediate.** Grafana org **Editor** or **Admin**. Viewer and org role
`None` receive `HTTP 403` with `error: "Editor role required"`, refused in the plugin backend
before any call to the dot-ai server. Configuration and Test connection remain **Admin**-only.
A Grafana *server* admin whose org role is Viewer is also denied: the plugin SDK's
`backend.User` exposes only `Login`, `Name`, `Email`, `Role` — no `IsGrafanaAdmin`. The gate
trusts Grafana's org-role assignment, so anonymous auth with `org_role = Editor`, or an Editor
service-account token, passes it.

Do not point `apiUrl` at agentgateway or Context Forge — only the dot-ai tools REST base.

No datasource UID pickers: types discovered via `getDataSourceSrv().getList({ type })`. Per-type checkboxes / dashboard deep-links are future. Related alerts are already in Current from Alertmanager when send is on. Dashboard-to-open is not built (would be Grafana `/apis` dashboards later).

## Data egress

Every Ask POSTs one `{intent}` (Query) or `{issue}` (Remediate) string to the configured
dot-ai server. That string is the whole egress surface. It carries:

| Block | Content | Bound |
|---|---|---|
| Stable preamble | Fixed instruction text, including "quote the concrete Loki/Prometheus/Tempo/Alertmanager lines" | fixed |
| `Current:` | Grafana datasource facts read for **this** Ask when evidence is on; otherwise the session's rewritten Current, which holds `Asked:` (your previous question, ≤180 chars) and `What's true now:` (dot-ai's previous answer, ≤500 chars) | `MAX_CURRENT_CHARS` = 700 |
| `Prior:` | The 2 most recent turns, condensed: **your question text, which can also carry follow-up instructions this page added automatically** (≤90 chars per turn), and **prose from dot-ai's answers**. Because the preamble tells the model to quote log, metric and alert lines, answers routinely contain verbatim log text — so anything credential-shaped in an application log can travel here | `MAX_PRIOR_CHARS` = 240 |
| `Map:` | Resource-name and namespace chips accumulated across **every** turn of the session, harvested from both questions and answers | `MAX_MAP_CHARS` = 400 |
| `Question:` / `Issue:` | The box text, verbatim | reserved first |

Total intent: `MAX_INTENT_CHARS` = 1000. **Counted in UTF-16 code units, not bytes** — a
1000-unit intent of mostly non-BMP text measures ~1808 UTF-8 bytes on the wire, so the cap
bounds neither bytes nor tokens. Truncation is surrogate-safe: a cut tail never emits a lone
surrogate.

Full **History** (last 5 turns, verbatim) stays in the browser and is never POSTed as such;
the condensed `Prior:` block is what leaves.

**Which toggle covers what.**

- **Send Grafana evidence** off (`skipStack`) stops the datasource *read*. It does **not** stop
  `Prior:`, `Map:`, or the rewritten `Current:` — so prior-turn question and answer text still
  leaves the browser with the toggle off.
- **Show context** controls on-page display only. It never changes what is packed.

**Shedding order, measured.** When the packed string exceeds 1000, blocks are shed in this
order: plugin-written follow-up instruction lines (down to a Current floor of
`MIN_CURRENT_CHARS` = 240) → `Map:` → `Prior:` shrunk to its latest turn (≤160) → the Tempo
section → Loki, then Prometheus, then Alertmanager body lines → `Prior:` entirely → a cap of
the `Current:` block → and only if the preamble plus the question alone overflow, a deliberate
cap of the question. The question is reserved before evidence is packed and the packed string
is never blind-capped, so growing datasource output cannot delete what you asked.

**Prior outranks fresh evidence, but never wastes it.** Because `Prior:` is dropped only after
log, metric and alert lines have been peeled, keeping a follow-up resolvable costs live
evidence. Measured on a stack Current at real caps (30 Loki lines, 8 Prometheus series, no
alerts) with a three-turn history: the Prior-carrying pack retained **0** Loki lines where the
identical no-history pack retained 3. On a busy shape (alerts firing at `ALERT_CAP`) Prior
still survives and the pack keeps 5 of 8 alert lines and no Loki or Prometheus lines. When
`Prior:` is dropped, the evidence reduction restarts from the untouched `Current`, so a pack
that ends up without `Prior:` carries exactly the evidence it would have carried with no
history at all — evidence is never spent on a block that does not ship.

## Timeouts

Grafana plugin resource calls are limited by the plugin host. This plugin uses the Grafana SDK HTTP client with a **120s** ceiling for query/remediate (15s for version/health). That is shorter than Headlamp's 30-minute AI tool timeout because Grafana does not expose an equivalent long-poll proxy. v1 does **not** implement async `202` + job poll; if a call hits 120s, retry or narrow the question.

## How It Works

```
  Ask ── Remediate: pack Query Current + issue ── 1x POST /remediate
    │
    └── Query
          Read Loki/Prom/Tempo/AM  →  Current + Map + condensed Prior (≤240 chars in 1000-char budget)
          classifyFirstHop:
            alerts/logs/metrics/traces/"top issues"/default → grafana
            list/show namespaces|pods|…                   → dot-ai
          hop 1: POST /query  intent=Stable+Current+Map+question
          hop 2: unscoped → across   OR   answer denies Current → conflict
          hop 3: still hedges → hedge     (cap 3)
          Go strips hop meta, writes ask log, Bearer to dot-ai
          dot-ai query toolLoop (kubectl/MCP) returns summary
```

Browser → Grafana plugin resource API → Go backend (`grafana-plugin-sdk-go` `httpclient`) → dot-ai `:3456` tools REST (`/api/v1/tools/query`, `/api/v1/tools/remediate`, `/api/v1/tools/version`).

Remediate bodies are allowlisted to analysis-only fields (`issue` / `intent`). Auth for this Grafana path is `Authorization: Bearer` (not `X-Dot-AI-Authorization`, which is the Headlamp Kubernetes API proxy header).

The published OpenAPI document for dot-ai includes execute/operate/recommend. This plugin does **not** generate a client from that full schema — that would pull mutation tools into an analysis-only Grafana app. Outbound HTTP uses the Grafana plugin SDK `httpclient` for the three read paths above.

**Progressive context vs Headlamp.** Headlamp Query is one POST of the box text; remediate/operate on a resource detail page pass that **Kubernetes object**. This plugin packs **Grafana datasource** facts (Loki, Prometheus, Tempo, Alertmanager) into `{intent}` when a Query Ask reads them, replacing Current rather than sending both; `{issue}` (Remediate) reuses whatever Current already holds and never triggers a fresh datasource read. Either string also carries a condensed **Prior:** block from the 2 most recent turns (≤ `MAX_PRIOR_CHARS` = 240 chars inside the 1000-char intent budget; shed only after Tempo, log, metric and alert lines have been peeled — see [Data egress](#data-egress)). Full History stays on screen. No `sessionId` chat protocol. Engine-side Prom/Grafana evidence would be [dot-ai#463](https://github.com/vfarcic/dot-ai/issues/463), not this UI.

## Ask log (troubleshooting)

**Debug Log** in plugin settings (`jsonData.debugLog`) enables it. **Off by default.** When on, every query/remediate hop appends one JSON line to `/var/lib/grafana/dotai-ask.log` (rotate at 1MiB → `.1`): `time`, `tool`, truncated `body`, `status`, `summary`, `hop`, `hops`, `first_hop`, `branch`, `current_empty`, `login`, `role`. The Grafana user `login` and org `role` are recorded on every line (`unauthenticated` when a line is written with no user on the context); the user's email address and display name are never written. Tokens never written. Hop meta stripped before dot-ai.

Grafana plugin debug (`GF_LOG_FILTERS=plugin.devopstoolkit-dotai-app:debug`) is separate and only set in create-plugin docker for `npm run server`.

## Related Projects

- [AI Engine](https://devopstoolkit.ai/docs/ai-engine) — MCP server this plugin connects to
- [Headlamp plugin](https://github.com/vfarcic/dot-ai-headlamp) — operate / execute companion
- [Web UI](https://devopstoolkit.ai/docs/ui) · [CLI](https://devopstoolkit.ai/docs/cli) · [Controller](https://devopstoolkit.ai/docs/controller)
