# DevOps AI Toolkit Grafana Plugin

AI-powered Kubernetes cluster intelligence inside [Grafana](https://grafana.com) — powered by [DevOps AI Toolkit](https://devopstoolkit.ai).

Companion to the [Headlamp plugin](https://github.com/vfarcic/dot-ai-headlamp): Grafana is for diagnosis (query + analysis-only remediate). Headlamp is for operate / execute.

## What It Does

- **Query** — Ask questions about your cluster in plain English. Responses are text (`data.result.summary`).
- **Remediate (analysis only)** — Get AI-powered issue analysis. No execute, apply, or mutation UI.
- **Progressive context** — On Query, the page reads configured Loki, Prometheus, Tempo, and Alertmanager datasources (`getDataSourceSrv`, no hardcoded uids) and packs **Current** + **Map** into the same `{intent}` string. **History** is on screen only (last 5 turns) and is never POSTed. No `sessionId`. One Ask may issue up to 3 dot-ai POSTs (unscoped question or answer vs Current). Remediate is one hop and reuses Query Current. JSONL ask log: `/var/lib/grafana/dotai-ask.log` (no tokens; hop meta stripped before upstream).

## Requirements

- Grafana >= 11.0 (reference host **11.4**; `@grafana/*` libraries pinned to 11.4.0)
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
| Debug Log | Enable/disable JSONL ask log at `/var/lib/grafana/dotai-ask.log`. **Off by default.** JSONL may include packed Current (Loki/Prom lines). No Grafana tokens. Credentials inside *application* logs can appear. |
| Show context | Show Current, Map, and History on the page. **On by default.** Display-only; independent of Send Grafana evidence. |
| Send Grafana evidence | `jsonData.sendGrafanaEvidence`. **On by default** (missing/undefined = send). When off, Asks do not pack Grafana DS facts. Independent of Show context. |
| Test connection | `POST /api/v1/tools/version` through the plugin backend |

Do not point `apiUrl` at agentgateway or Context Forge — only the dot-ai tools REST base.

No datasource UID pickers: types discovered via `getDataSourceSrv().getList({ type })`. Per-type checkboxes / dashboard deep-links are future. Related alerts are already in Current from Alertmanager when send is on. Dashboard-to-open is not built (would be Grafana `/apis` dashboards later).

## Timeouts

Grafana plugin resource calls are limited by the plugin host. This plugin uses the Grafana SDK HTTP client with a **120s** ceiling for query/remediate (15s for version/health). That is shorter than Headlamp's 30-minute AI tool timeout because Grafana does not expose an equivalent long-poll proxy. v1 does **not** implement async `202` + job poll; if a call hits 120s, retry or narrow the question.

## How It Works

```
  Ask ── Remediate: pack Query Current + issue ── 1x POST /remediate
    │
    └── Query
          Read Loki/Prom/Tempo/AM  →  Current + Map  (History never POSTed)
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

**Progressive context vs Headlamp.** Headlamp Query is one POST of the box text; remediate/operate on a resource detail page pass that **Kubernetes object**. This plugin packs **Grafana datasource** facts (Loki, Prometheus, Tempo, Alertmanager) into the same `{intent}` / `{issue}` string. History is display-only. No `sessionId` chat protocol. Engine-side Prom/Grafana evidence would be [dot-ai#463](https://github.com/vfarcic/dot-ai/issues/463), not this UI.

## Ask log (troubleshooting)

**Debug Log** in plugin settings (`jsonData.debugLog`) enables it. **Off by default.** When on, every query/remediate hop appends one JSON line to `/var/lib/grafana/dotai-ask.log` (rotate at 1MiB → `.1`): `time`, `tool`, truncated `body`, `status`, `summary`, `hop`, `hops`, `first_hop`, `branch`, `current_empty`. Tokens never written. Hop meta stripped before dot-ai.

Grafana plugin debug (`GF_LOG_FILTERS=plugin.devopstoolkit-dotai-app:debug`) is separate and only set in create-plugin docker for `npm run server`.

## Related Projects

- [AI Engine](https://devopstoolkit.ai/docs/ai-engine) — MCP server this plugin connects to
- [Headlamp plugin](https://github.com/vfarcic/dot-ai-headlamp) — operate / execute companion
- [Web UI](https://devopstoolkit.ai/docs/ui) · [CLI](https://devopstoolkit.ai/docs/cli) · [Controller](https://devopstoolkit.ai/docs/controller)
