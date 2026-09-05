# Security Policy

*Proposed for `vfarcic/dot-ai-grafana`. This repository currently has no disclosure channel; that
gap is itself a finding. The maintainer owns the final wording and must enable the reporting
mechanism below — a contributor cannot.*

## Supported versions

| Version | Supported |
|---------|-----------|
| `main` | Yes — fixes land here first |
| Latest tagged release | Yes |
| Older tags / pre-release builds | No — upgrade to the latest release |

The plugin tracks Grafana `>=11.0` (11.4 is the must-pass reference). Reports against unsupported
Grafana versions are still read, but a fix may be "upgrade Grafana".

## Reporting a vulnerability

Please report privately, **not** as a public issue or pull-request comment.

Use **GitHub Private Vulnerability Reporting** on this repository:
`Security` tab → `Report a vulnerability`.

> Maintainer action required: private reporting must be switched on in
> `Settings → Advanced Security → Private vulnerability reporting`. Until it is enabled, the
> `Report a vulnerability` button does not appear and there is no private channel at all.

Useful report contents: affected version/commit, Grafana version, the datasources involved,
the rendered or returned output that demonstrates the problem, and what an attacker gains.
Please avoid live third-party hosts in proof-of-concept payloads; use a reserved domain such as
`example.invalid`.

No response-time commitment is offered here — this project is maintained on a best-effort basis.
If you need one, ask the maintainer directly rather than assuming one from this file.

## In scope

- The Grafana app plugin in this repository: frontend (`src/`) and Go backend (`pkg/`).
- The **rendering path** — anything that turns a model answer, an evidence pack, or telemetry into
  DOM in an operator's browser.
- The **prompt-packing path** — how datasource reads and cluster state are assembled into the
  `intent` / `issue` text sent to dot-ai.
- Plugin configuration and secret handling (`jsonData` / `secureJsonData`, token exposure, logging).
- Backend egress behaviour (`apiUrl` validation, SSRF protections, error-body passthrough).

### Content-derived issues are explicitly in scope

Reports about **untrusted telemetry** are welcome and wanted — indirect prompt injection
(OWASP LLM01) and anything downstream of it: a log line, alert label, trace attribute, or
Kubernetes object annotation that causes the plugin to render a remote embed, fetch an
attacker-chosen URL, or present a misleading or destructive recommendation.

The governing invariant is **telemetry is data, never instruction**. Any concrete way to break it
is a valid report, including the no-attacker case (HTML or markdown that legitimately appears in a
stack trace). This is not a theoretical concern for observability products: the same vector was
demonstrated against Grafana's own AI assistant in 2026 (GrafanaGhost, patched) — injection
carried in log content, exfiltration via markdown image rendering.

Background, impact classes `I1`–`I11`, and the control set live in
[`prds/1-grafana-ai-cluster-intelligence.md` → *Expansion: Untrusted telemetry trust boundary*](prds/1-grafana-ai-cluster-intelligence.md#untrusted-telemetry-trust-boundary).

## Out of scope for this repository

- The **dot-ai engine** — tool behaviour, RBAC/`apply` gating, knowledge-base ingest, model
  prompting inside the server: report to [`vfarcic/dot-ai`](https://github.com/vfarcic/dot-ai).
- **Grafana core, its datasources, or Grafana Cloud**: report through Grafana Labs' own security
  process ([grafana.com/security](https://grafana.com/security/)).
- Operator deployment choices — an over-scoped dot-ai token, a permissive `grafana.ini` CSP, an
  unauthenticated Grafana. These are documentation bugs here at most; file a normal issue.
- Findings that require Grafana Admin rights to trigger and grant nothing beyond what Admin
  already has.

## Disclosure

Please give the maintainer a chance to ship a fix before publishing details. Credit is given in the
release notes unless you ask otherwise.
