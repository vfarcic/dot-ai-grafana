# PRD: Grafana App Plugin for AI-Powered Kubernetes Cluster Intelligence

**Issue**: [#1](https://github.com/vfarcic/dot-ai-grafana/issues/1)
**Priority**: High
**Status**: Draft

## Problem Statement

Teams using Grafana for Kubernetes observability must context-switch to separate tools when they want to:
- Ask natural language questions about their cluster resources (e.g., "show all failing pods in production")
- Get AI-powered analysis of cluster issues (e.g., "why is my-app crashing?")

This breaks workflow, adds friction, and creates a gap between observing a problem in Grafana and understanding it through AI-powered analysis.

## Solution Overview

A Grafana App Plugin that embeds two read-only dot-ai tools directly into Grafana:

1. **Query** — Natural language questions about Kubernetes cluster resources
2. **Remediate (Analysis Only)** — AI-powered issue analysis without execution capability

The plugin provides a simple text-based interface: tool selector, text input for the intent, and a text area displaying the agent's response. No rich visualizations (Mermaid, cards, tables) — just plain text responses.

## User Journey

1. User is viewing dashboards in Grafana and notices an anomaly
2. User navigates to the dot-ai plugin page (accessible from Grafana sidebar)
3. User selects "Query" or "Remediate" from the tool dropdown
4. User types their question/intent in natural language
5. User submits and sees the AI-generated text response
6. User can ask follow-up questions or switch tools

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

### UI Components

Minimal UI surface:
- **Tool selector dropdown** — Switch between Query and Remediate
- **Intent text input** — Natural language input field with context-aware placeholder
- **Response area** — Scrollable text display for the agent's response
- **Loading indicator** — While waiting for response
- **Error display** — Connection errors, auth failures

### What's Explicitly Out of Scope

- Rich visualizations (Mermaid diagrams, cards, code blocks with syntax highlighting)
- Action execution (remediation execution, operate, recommend)
- Multi-stage workflows or wizards
- Resource selection from dashboards
- Session management or conversation history

## Success Criteria

- Plugin installs cleanly into Grafana (9.x+/10.x/11.x)
- Users can submit natural language queries and receive text responses
- Users can submit issue descriptions and receive analysis text
- Configuration via Grafana plugin settings works (MCP URL + auth token)
- Response times are comparable to direct MCP server calls (< 500ms overhead from plugin)
- Plugin follows Grafana UI conventions and feels native

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Grafana plugin API changes across versions | Plugin breaks on upgrade | Target Grafana 10.x+ with stable APIs, test across versions |
| MCP server authentication complexity | Users can't configure plugin | Clear setup docs, connection test button in settings |
| Go backend proxy adds latency | Slow responses | Minimal proxy logic, streaming if Grafana supports it |
| Plugin review process (if publishing to marketplace) | Delayed availability | Start with unsigned/private distribution, publish later |

## Dependencies

- dot-ai MCP server running and accessible from Grafana instance
- MCP server exposes `/api/v1/tools/query` and `/api/v1/tools/remediate` endpoints
- Grafana 10.x or later (for stable app plugin APIs)
- `@grafana/create-plugin` toolchain for scaffolding

## Milestones

- [ ] **Plugin scaffolding and build pipeline** — Grafana app plugin project created with `@grafana/create-plugin`, builds successfully, loads in Grafana dev environment
- [ ] **Plugin configuration page** — Admin can configure MCP server URL and auth token via Grafana plugin settings, with connection test
- [ ] **Backend proxy (Go)** — Backend plugin component proxies requests to MCP server with configured auth, handles errors gracefully
- [ ] **Query tool UI** — Users can type natural language queries, submit, and see text responses from the MCP server
- [ ] **Remediate analysis UI** — Users can describe issues, submit, and see AI-powered analysis text (no execution)
- [ ] **Tool selector and shared layout** — Dropdown to switch between Query and Remediate, shared input/response layout, context-aware placeholders
- [ ] **Error handling and loading states** — Connection errors, auth failures, timeouts displayed clearly; loading spinner during requests
- [ ] **Documentation and installation guide** — README with setup instructions, configuration guide, and screenshots
- [ ] **Grafana version compatibility testing** — Verified working on Grafana 10.x and 11.x
