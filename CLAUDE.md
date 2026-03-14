# Claude Code Instructions

## Project Overview

This is a Grafana App Plugin that provides AI-powered Kubernetes cluster intelligence. It embeds two read-only tools from the dot-ai MCP server into Grafana:

1. **Query** — Natural language questions about cluster resources
2. **Remediate (Analysis only)** — AI-powered issue analysis without execution

## Tech Stack

- **Framework**: Grafana App Plugin (React, TypeScript)
- **Build**: @grafana/create-plugin toolchain
- **Backend**: Proxies requests to dot-ai MCP server REST endpoints

## MCP Integration

This plugin communicates with the dot-ai MCP server via HTTP REST endpoints:
- `/api/v1/tools/query` POST — Natural language cluster queries
- `/api/v1/tools/remediate` POST — Issue analysis (read-only, no execution)

## Key Design Decisions

- **Text-only responses** — No Mermaid diagrams, cards, or rich visualizations. Displays plain text agent responses.
- **Read-only** — No action execution. Remediate shows analysis only, without the option to proceed to remediation.
- **Grafana-native** — Leverages Grafana's auth, RBAC, and UI conventions.
