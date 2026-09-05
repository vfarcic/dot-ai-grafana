import { config } from '@grafana/runtime';

export type DrilldownLink = {
  id: string;
  label: string;
  href: string;
};

function appBase(): string {
  return String((config as { appSubUrl?: string } | undefined)?.appSubUrl || '').replace(/\/$/, '');
}

function orgId(): number {
  const boot = (config as { bootData?: { user?: { orgId?: number } } } | undefined)?.bootData;
  return boot?.user?.orgId ?? 1;
}

function hasApp(pluginId: string): boolean {
  const apps = (config as { apps?: Record<string, unknown> } | undefined)?.apps;
  return Boolean(apps && apps[pluginId]);
}

/** Grafana 11+ Explore panes URL. Not dashboard /api HTTP. */
export function exploreUrl(args: {
  uid: string;
  type: string;
  query: Record<string, unknown>;
}): string {
  const panes = {
    dotai: {
      datasource: args.uid,
      queries: [
        {
          refId: 'A',
          datasource: { type: args.type, uid: args.uid },
          ...args.query,
        },
      ],
      range: { from: 'now-15m', to: 'now' },
    },
  };
  const params = new URLSearchParams({
    schemaVersion: '1',
    panes: JSON.stringify(panes),
    orgId: String(orgId()),
  });
  return `${appBase()}/explore?${params.toString()}`;
}

export function dashboardUrl(uid: string): string {
  return `${appBase()}/d/${encodeURIComponent(uid)}`;
}

export function drilldownAppUrl(pluginId: string): string | undefined {
  if (!hasApp(pluginId)) {
    return undefined;
  }
  return `${appBase()}/a/${pluginId}`;
}

/**
 * True when the Ask is only a pure navigation phrase:
 * `(show me|open|display) the? (logs|alerts|traces|metrics|dashboards)`.
 * Diagnosis tokens force POST (show-me does not skip). False positives on the
 * 0-hop skip are dangerous — when ambiguous, return false so the engine runs.
 */
export function isShowMeOnly(question: string): boolean {
  // Lowercase; collapse whitespace; strip only surrounding .?! (keep interior).
  const q = question
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.?!]+|[.?!]+$/g, '')
    .trim();
  if (!q) {
    return false;
  }
  // Diagnosis wins. Contract six: why|error|crash|failing|analyze|remediate.
  // Keep extras (how, improve, root cause, because, issue(s), unhealthy): they
  // bias toward POST, the safe direction when the 0-hop skip would otherwise fire.
  if (
    /\b(why|error|crash|failing|analyze|remediate|how|improve|root cause|because|issue|issues|unhealthy)\b/.test(
      q
    )
  ) {
    return false;
  }

  // Strict complete-phrase match of the written production — no "for <resource>" tail.
  return /^(show me|open|display)( the)? (logs|alerts|traces|metrics|dashboards)$/.test(q);
}


export function buildDrilldownLinks(args: {
  lokiUid?: string;
  promUid?: string;
  tempoUid?: string;
  logql: string;
  promql: string;
  tempoSearch: string;
  traceIds: string[];
  dashboardUids: string[];
}): DrilldownLink[] {
  const links: DrilldownLink[] = [];

  if (args.lokiUid) {
    links.push({
      id: 'explore-logs',
      label: 'Explore logs',
      href: exploreUrl({
        uid: args.lokiUid,
        type: 'loki',
        query: { expr: args.logql, queryType: 'range' },
      }),
    });
    const logsApp = drilldownAppUrl('grafana-lokiexplore-app');
    if (logsApp) {
      links.push({ id: 'drilldown-logs', label: 'Logs Drilldown', href: logsApp });
    }
  }

  if (args.promUid) {
    links.push({
      id: 'explore-metrics',
      label: 'Explore metrics',
      href: exploreUrl({
        uid: args.promUid,
        type: 'prometheus',
        query: { expr: args.promql, instant: true },
      }),
    });
    const metricsApp = drilldownAppUrl('grafana-metricsdrilldown-app');
    if (metricsApp) {
      links.push({ id: 'drilldown-metrics', label: 'Metrics Drilldown', href: metricsApp });
    }
  }

  if (args.tempoUid) {
    links.push({
      id: 'explore-traces',
      label: 'Explore traces',
      href: exploreUrl({
        uid: args.tempoUid,
        type: 'tempo',
        query: { queryType: 'traceqlSearch', query: args.tempoSearch, limit: 5 },
      }),
    });
    const tracesApp = drilldownAppUrl('grafana-exploretraces-app');
    if (tracesApp) {
      links.push({ id: 'drilldown-traces', label: 'Traces Drilldown', href: tracesApp });
    }
    for (const id of args.traceIds.slice(0, 5)) {
      links.push({
        id: `trace-${id}`,
        label: `Trace ${id.slice(0, 8)}`,
        href: exploreUrl({
          uid: args.tempoUid,
          type: 'tempo',
          query: { queryType: 'traceql', query: id },
        }),
      });
    }
  }

  for (const uid of args.dashboardUids.slice(0, 5)) {
    links.push({
      id: `dash-${uid}`,
      label: `Dashboard ${uid}`,
      href: dashboardUrl(uid),
    });
  }

  return links;
}
