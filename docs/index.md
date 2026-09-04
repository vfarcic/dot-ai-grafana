---
sidebar_position: 1
---

# DevOps AI Toolkit Grafana Plugin

**AI-powered Kubernetes cluster intelligence inside Grafana — query and analysis-only remediate with natural language.**

---

## What is the Grafana Plugin?

The [DevOps AI Toolkit](https://devopstoolkit.ai) Grafana Plugin is a page you open in [Grafana](https://grafana.com) when something is red. You ask *why is checkout failing?* in the tab you are already in; the plugin gathers the Loki, Prometheus, and Tempo evidence around that question, sends it with your question to the [dot-ai engine](https://devopstoolkit.ai/docs/ai-engine), which inspects live cluster state, and hands back an answer. It is a human surface: the operator on call types into it and reads the answer. The engine does the reasoning; the plugin exposes no MCP server and no tool API for an AI client to drive.

So you stop context-switching between Grafana, a terminal, and a chat window, and stop hand-copying log lines and pod names into a prompt. Ask short questions — your wording and the packed evidence share one 1000-character intent, so a long question leaves less room for the evidence traveling with it. The questions worth asking here are the ones a Grafana-only assistant cannot answer, because it cannot see the cluster, and a cluster-only agent cannot answer, because it cannot see your dashboards:

- **Restarts with no obvious cause** — *"why is checkout restarting?"* → the top pods by restart count in the last 15m travel with the question while the engine inspects the workload behind them.
- **The logs point at one node** — *"why these errors on node-3?"* → the Loki error lines on screen go with the question; the engine looks at the node and pods behind them.
- **The trace points downstream** — *"why is checkout slow?"* → Tempo trace evidence carried into cluster inspection.
- **The dashboards cannot show it** — *"what is wrong in payments?"* → events, limits, and scheduling the engine reaches with its own cluster tools.

**Analyze this** hands the evidence on screen to Remediate, which returns root-cause analysis and remediation options; applying them is yours. Once you decide what to change, that is the [Headlamp plugin](https://devopstoolkit.ai/docs/headlamp), which owns operate / execute. This plugin analyses and never executes.

Grafana's own AI surfaces reason about **Grafana**: [Grafana Assistant](https://grafana.com/docs/grafana-cloud/machine-learning/assistant/) for dashboard creation, analytics, and guided troubleshooting; the [LLM app](https://grafana.com/docs/grafana-cloud/machine-learning/llm/) proxying authenticated LLM requests for other Grafana components; the [Grafana MCP server](https://grafana.com/docs/grafana/latest/developer-resources/mcp/) giving an external AI client tools over your Grafana instance. This plugin reasons about the **Kubernetes cluster those dashboards describe**, and runs in whatever Grafana you already operate, while Assistant depends on a Grafana Cloud Assistant backend.

Whoever is signed in to Grafana uses it under their existing **org role**; there is no separate plugin login (see [Configure](#configure)). It appears in Grafana's left navigation as **dot-ai** (`/a/devopstoolkit-dotai-app/`), with one nested Admin-only **Configuration** entry and no other pages.

## Features

### Query

Ask natural language questions about your cluster. The engine's answer renders as plain text.

On Query, the page reads configured Loki, Prometheus, and Tempo datasources via Grafana's datasource service (no hardcoded UIDs) and packs **Current** + **Map** into the same `{intent}` string. **History** stays on screen only — the last 5 turns in full — and is never sent to the engine. The packed intent is capped at 1000 characters, and your question is reserved *before* the evidence is packed: under pressure the packer drops plugin-written follow-up lines, drops Map, drops the Tempo block, peels Loki, then Prometheus, then Alertmanager lines, and finally caps the Current block itself — never the packed tail that carries the question. On a busy cluster the Loki block can shrink to `…`, so a full log excerpt is not guaranteed. Keep questions short anyway: a long question crowds out evidence, and if the preamble plus the question alone overflow the budget the question is capped as the last resort. One Ask may issue up to 3 dot-ai POSTs.

**Map** is a short token list of what the Ask resolved: first the datasource each type resolved to — or `(missing)` when none is configured — then the namespaces and pods that came up in the evidence and the conversation. It reads like `Loki loki, Prometheus prometheus, Tempo (missing), Alertmanager (missing), ns/payments, pod/checkout-7d9f`, with `checkout@payments` for a bare "name in namespace" mention. Twelve tokens and 400 characters at most, earliest kept first, so on a stack with all four datasources configured the datasource tokens hold four of the twelve slots. It is shown on the page as plain text and travels inside the intent as follow-up referents, so "why is *that* one restarting?" resolves. It is not built from a Grafana search API.

**Question routing.** Observability wording (`logs`, `metrics`, `traces`, `alerts`, `top issues`, `crash`, `failing`, `restarts`) — and anything the plugin does not recognise as inventory wording, which is the default — reads the Grafana stack first, then asks the engine with that evidence attached. Inventory wording (`list namespaces`, `show pods`) goes straight to the engine. Either way, every Ask makes at least one engine call.

While an Ask is in flight, **Cancel** aborts it. Failures show an error Alert with distinct titles (timed out, authentication failed, permission denied, not found, unreachable, cancelled); **Retry** re-runs the same intent text.

[Query tool documentation](https://devopstoolkit.ai/docs/ai-engine/tools/query)

### Remediate (analysis only)

Get AI-powered issue analysis. Remediate is one hop and reuses Query Current. Request bodies are allowlisted to analysis-only fields (`issue` / `intent`), and an **Analysis only** info banner states that Remediate never executes changes. Cancel, Retry, and the same error titles apply as on Query.

[Remediate tool documentation](https://devopstoolkit.ai/docs/ai-engine/tools/remediate)

## Quick Start

### Prerequisites

- [Grafana](https://grafana.com) >= 11.0
- A reachable [dot-ai MCP server](https://devopstoolkit.ai/docs/ai-engine/setup/deployment) (tools REST, typically port 3456)

### Install

Download the release zip from this project's [GitHub releases](https://github.com/vfarcic/dot-ai-grafana/releases) or build it from source — it is **not** on grafana.com and **not** in Grafana's plugin catalog, so Grafana must also be told to load it unsigned. It installs into **a Grafana you already run**, and is deliberately not part of the [dot-ai-stack](https://github.com/vfarcic/dot-ai-stack) umbrella chart: that chart deploys the dot-ai MCP server, controller, and UI, and no Grafana.

Allow the unsigned plugin:

```bash
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=devopstoolkit-dotai-app
```

**From a release** (once the first release is cut — no tags exist yet, so build from source until then)

1. Take `devopstoolkit-dotai-app-<version>.zip` from the [latest release](https://github.com/vfarcic/dot-ai-grafana/releases).
2. Verify it against the published `.sha256`.
3. Unzip it into Grafana's plugin directory.
4. Set the env var above and restart Grafana.

**From source**

```bash
npm install
npm run build
mage -v build:linux
```

Copy `dist/` into Grafana's plugin directory as `devopstoolkit-dotai-app`, set the unsigned-load env var above, then restart Grafana.

### Configure

As Grafana **Admin**: open **Configuration** under **dot-ai** in the left nav, or reach it at **Administration → Plugins → dot-ai → Configuration**.

| Setting | Default | Description |
|---------|---------|-------------|
| MCP Server URL | _(empty)_ | Absolute `http(s)` base for the dot-ai tools REST API, and nothing else. HTTPS required except loopback / RFC1918 / in-cluster `*.svc` / `*.cluster.local` (example: `http://dot-ai.dot-ai.svc:3456`). Public `http` is rejected. |
| Auth Token | _(empty)_ | Plugin backend credential to the dot-ai engine, stored in Grafana encrypted settings and sent as `Authorization: Bearer`. Use an analysis-only token with no apply rights. |
| Debug Log | Off | JSONL ask log at `/var/lib/grafana/dotai-ask.log`. May include packed Current (Loki/Prom lines). Each line records the Grafana user `login` and org `role`; never their email or display name. No Grafana tokens. |
| Show context | On | Show Current, Map, and History on the page. Display only; intent packing still runs when this is off. |
| Send Grafana evidence | On | When on, Asks pack Grafana datasource facts and the page shows a consent info Alert naming them (Loki, Prometheus, Tempo, Alertmanager). Missing/undefined = send. Independent of Show context. |
| Test connection | — | Admin-only. Probes `POST /api/v1/tools/version` through the plugin backend |

Alertmanager is named in that consent Alert because an Ask also queries a configured Alertmanager datasource cluster-wide. It is resolved like the others, through Grafana's datasource service rather than a hardcoded UID, which does not surface Grafana's own built-in Alertmanager — so in practice Current reports it as missing unless a standalone Alertmanager datasource is configured ([issue #47](https://github.com/vfarcic/dot-ai-grafana/issues/47)). That is why the evidence described above is Loki, Prometheus, and Tempo.

**Authentication and authorization.** The plugin uses the signed-in Grafana user and their **org role**, with no separate plugin login, user directory, or per-user credential. **Editor or above** runs Query and Remediate; **Admin** opens Configuration and runs **Test connection**. The **Auth Token** row above is the plugin backend's own credential to the [dot-ai MCP server](https://devopstoolkit.ai/docs/ai-engine) tools REST API — not a user identity.

## How It Works

An Ask resolves in at most three engine hops. The browser never talks to the engine directly: the plugin's Go backend is the only component that does.

```text
  Ask ── Remediate: pack Query Current + issue ── 1x POST /remediate
    │
    └── Query
          Read Loki/Prom/Tempo  →  Current + Map hints
          classifyFirstHop:
            alerts/logs/metrics/traces/"top issues"/default → grafana
            list/show namespaces|pods|…                     → dot-ai
          hop 1: POST /query  intent=Stable+Current+Map+question  (≤1000 chars,
                 question reserved first; evidence sheds, never the question)
          hop 2: unscoped → across   OR   answer denies Current → conflict
          hop 3: still hedges → hedge     (cap 3)
          Go strips hop meta, writes ask log, Bearer to dot-ai
          dot-ai query toolLoop (kubectl/MCP) returns summary
          Answer renders as plain text
```

Each POST above travels that same path:

```text
Browser
  └── Grafana plugin resource API
        └── Go backend (Grafana plugin SDK HTTP client)
              └── dot-ai :3456 tools REST
                    (/api/v1/tools/query, /remediate, /version)
```

Outbound engine auth on this path is `Authorization: Bearer` (not `X-Dot-AI-Authorization`, which is the Headlamp Kubernetes API proxy header). Query and remediate calls use a **120s** ceiling; version/health probes use **15s**. There is no async `202` + job poll; if a call hits 120s, retry or narrow the question.

## Compatibility

| Grafana | Support |
|---------|---------|
| >= 11.0 | Minimum supported |
| 11.4 | Reference host (`@grafana/*` libraries pinned here) |
| Later majors | CI e2e exercises the current and recent Grafana majors on every PR, resolved by `grafana/plugin-actions/e2e-version` |

## Releasing

Release process, changelog assembly, and fragment naming live in the repository [README Releasing section](https://github.com/vfarcic/dot-ai-grafana/blob/main/README.md#releasing). User-visible changes land as `changelog.d/<issue>.<type>.md` fragments (`feature`, `bugfix`, `breaking`, `doc`, `misc`); this page does not duplicate that process.

## Support

- **GitHub Issues**: [Bug reports and feature requests](https://github.com/vfarcic/dot-ai-grafana/issues)

## Related Projects

- **[AI Engine](https://devopstoolkit.ai/docs/ai-engine)** — DevOps AI Toolkit MCP server this plugin connects to
- **[Headlamp plugin](https://devopstoolkit.ai/docs/headlamp)** — operate / execute companion
- **[Web UI](https://devopstoolkit.ai/docs/ui)** — Standalone web UI (alternative frontend)
- **[CLI](https://devopstoolkit.ai/docs/cli)** — CLI for terminal-based interaction
- **[Controller](https://devopstoolkit.ai/docs/controller)** — Kubernetes controller for autonomous operations

---

**DevOps AI Toolkit Grafana Plugin** — AI-powered Kubernetes diagnosis inside Grafana.
