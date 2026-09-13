import {
  DataFrame,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceInstanceSettings,
  dateTime,
  TimeRange,
} from '@grafana/data';
import { getBackendSrv, getDataSourceSrv } from '@grafana/runtime';
import { isObservable, lastValueFrom, Observable } from 'rxjs';
import { buildDrilldownLinks, DrilldownLink } from './grafanaExplore';
import { HINT_STOPWORDS } from './progressiveContext';
// Grafana 13 deprecates many legacy /api HTTP routes. This module never calls
// GET /api/search (will not migrate), /api/datasources, or /api/dashboards.
// Stack reads go through getDataSourceSrv + ds.query (Explore path), except
// Alertmanager: Grafana's built-in AlertManagerDatasource.query() is an explicit
// stub that always returns { data: [] } (grafana/grafana
// public/app/plugins/datasource/alertmanager/DataSource.ts). Its own
// testDatasource()/_request() instead call getBackendSrv().fetch() against
// `instanceSettings.url + path` — for a proxy-access datasource that url is
// already Grafana's own `/api/datasources/proxy/uid/<uid>` prefix, so this is
// not a hand-rolled proxy URL, it is the exact mechanism Grafana's own
// Alertmanager datasource uses. We mirror it with getBackendSrv().get() against
// `${instanceSettings.url}/api/v2/alerts` to read real alerts.
// If we later add "open this dashboard", use Grafana 12+ Dashboard /apis only.


export const LOG_LINE_CAP = 30;
export const WINDOW_MS = 15 * 60 * 1000;
export const PROM_SERIES_CAP = 8;
export const TEMPO_TRACE_CAP = 5;
export const ALERT_CAP = 8;
/**
 * Cap on dashboard uids extracted from firing alerts. Matches buildDrilldownLinks'
 * own 5-link limit, so nothing extracted here ever goes unused downstream, and it
 * bounds the growth of the Current/Map text these uids feed before the packer ever
 * sees them — see dashboardUidsFromAlertFrames.
 */
export const DASHBOARD_UID_CAP = 5;

export type PodNamespaceTarget = {
  pod?: string;
  namespace?: string;
};

export type StackContextResult = {
  current: string;
  mapHint: string;
  logLines: string[];
  promLines: string[];
  tempoLines: string[];
  alertLines: string[];
  /** True when every stack block is an empty/missing note (no evidence lines). */
  currentEmpty: boolean;
  /** UI-only Explore/Drilldown/dashboard links. Never POSTed. */
  drilldowns: DrilldownLink[];
};

/** Cluster-wide LogQL when the question has no pod/ns — recent error-ish lines. */
export const CLUSTER_LOGQL =
  '{namespace=~".+"} |~ "(?i)error|exception|panic|oom|crash|backoff|fail"';

/** Cluster-wide PromQL — pods with restarts in the window. */
export const CLUSTER_PROMQL =
  'topk(8, sum by (pod, namespace) (increase(kube_pod_container_status_restarts_total[15m])))';

type DsQueryable = {
  name?: string;
  uid?: string;
  query: (req: DataQueryRequest) => unknown;
};

type LokiTarget = { refId: string; expr: string; queryType: string; maxLines: number };
type PromTarget = { refId: string; expr: string; instant?: boolean; format?: string };
type TempoTarget = { refId: string; queryType?: string; query?: string; limit?: number };

/** Resource-kind / filler words that must never become a pod or namespace. */
const NAME_DENY: Record<string, true> = {
  pods: true,
  issues: true,
  logs: true,
  failing: true,
  crashlooping: true,
  cluster: true,
  which: true,
  what: true,
  show: true,
  why: true,
  in: true,
};

/** True when s is RFC-1123 DNS label(s); rejects HINT_STOPWORDS and NAME_DENY. */
function isRfc1123Name(s: string): boolean {
  if (!s || s.length > 253) {
    return false;
  }
  const labels = s.toLowerCase().split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return false;
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      return false;
    }
    if (HINT_STOPWORDS[label] || NAME_DENY[label]) {
      return false;
    }
  }
  return true;
}

/** Workload names in free text almost always contain a hyphen (checkout-api). */
function looksLikeWorkloadName(s: string): boolean {
  return s.includes('-') && isRfc1123Name(s);
}

/** Best-effort pod + namespace from free-text question. Names stored lowercase. */
export function parsePodNamespace(question: string): PodNamespaceTarget {
  const text = question.trim();
  const out: PodNamespaceTarget = {};

  // Singular "pod" only — "which pods are not ready" must not capture filler words.
  const podLabeled =
    /\bpod[/:=\s]+([a-z0-9][a-z0-9.-]{0,252})\b/i.exec(text) ||
    /\b(?:for|of)\s+pod\s+([a-z0-9][a-z0-9.-]{0,252})\b/i.exec(text);
  if (podLabeled && isRfc1123Name(podLabeled[1])) {
    out.pod = podLabeled[1].toLowerCase();
  }

  const nsLabeled =
    /\b(?:namespace|ns)[/:=\s]+([a-z0-9][a-z0-9-]{0,62})\b/i.exec(text) ||
    /\bin\s+(?:namespace|ns)\s+([a-z0-9][a-z0-9-]{0,62})\b/i.exec(text);
  if (nsLabeled && isRfc1123Name(nsLabeled[1])) {
    out.namespace = nsLabeled[1].toLowerCase();
  }

  // "X in Y" only when X looks like a workload (hyphenated). Rejects
  // "pods in production" and "crashlooping in staging".
  if (!out.namespace) {
    const inNs = /\b([a-z0-9][a-z0-9.-]{1,60})\s+in\s+([a-z0-9][a-z0-9-]{0,62})\b/i.exec(text);
    if (inNs && looksLikeWorkloadName(inNs[1]) && isRfc1123Name(inNs[2])) {
      if (!out.pod) {
        out.pod = inNs[1].toLowerCase();
      }
      out.namespace = inNs[2].toLowerCase();
    }
  }

  if (!out.pod) {
    const hyphenated = /\b([a-z0-9][a-z0-9.-]*-[a-z0-9.-]*[a-z0-9])\b/gi;
    let m: RegExpExecArray | null;
    while ((m = hyphenated.exec(text)) !== null) {
      if (isRfc1123Name(m[1])) {
        out.pod = m[1].toLowerCase();
        break;
      }
    }
  }

  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Always returns LogQL — targeted labels or cluster-wide error stream. Never skip Loki. */
export function buildLogQL(target: PodNamespaceTarget): string {
  const labels: string[] = [];
  if (target.namespace) {
    labels.push(`namespace="${target.namespace}"`);
  }
  if (target.pod) {
    labels.push(`pod=~"${escapeRegex(target.pod)}.*"`);
  }
  if (labels.length === 0) {
    return CLUSTER_LOGQL;
  }
  return `{${labels.join(',')}}`;
}

/** Always returns PromQL — targeted restarts or cluster-wide top restarts. Never skip Prom. */
export function buildPromQL(target: PodNamespaceTarget): string {
  const labels: string[] = [];
  if (target.namespace) {
    labels.push(`namespace="${target.namespace}"`);
  }
  if (target.pod) {
    labels.push(`pod=~"${escapeRegex(target.pod)}.*"`);
  }
  if (labels.length === 0) {
    return CLUSTER_PROMQL;
  }
  return `sum by (pod, namespace) (kube_pod_container_status_restarts_total{${labels.join(',')}})`;
}

/** Fail-closed: true when Current has no evidence lines (only empty/missing notes). */
export function isStackCurrentEmpty(
  result: Pick<StackContextResult, 'logLines' | 'promLines' | 'tempoLines' | 'alertLines'>
): boolean {
  return (
    result.logLines.length === 0 &&
    result.promLines.length === 0 &&
    result.tempoLines.length === 0 &&
    result.alertLines.length === 0
  );
}

function timeRangeLast15m(): TimeRange {
  const to = dateTime();
  const from = dateTime(to.valueOf() - WINDOW_MS);
  return { from, to, raw: { from: 'now-15m', to: 'now' } };
}

function baseRequest<T extends { refId: string }>(targets: T[], requestId: string): DataQueryRequest<T> {
  return {
    requestId,
    targets,
    range: timeRangeLast15m(),
    interval: '15s',
    intervalMs: 15_000,
    maxDataPoints: 100,
    scopedVars: {},
    timezone: 'browser',
    app: 'dot-ai',
    startTime: Date.now(),
  } as DataQueryRequest<T>;
}

/**
 * Pick one datasource among the configured ones of a type.
 * Order: (1) the Grafana default of that type, (2) the one named after the type
 * (case-insensitive: Loki/Prometheus/Tempo/Alertmanager), (3) first configured.
 * No hardcoded uids.
 */
export function pickDataSource(
  list: DataSourceInstanceSettings[],
  type: 'loki' | 'prometheus' | 'tempo' | 'alertmanager'
): DataSourceInstanceSettings | undefined {
  const ofType = list.filter((s) => s && s.type === type);
  if (ofType.length === 0) {
    return undefined;
  }
  const byDefault = ofType.find((s) => s.isDefault === true);
  if (byDefault) {
    return byDefault;
  }
  const byName = ofType.find((s) => (s.name || '').trim().toLowerCase() === type);
  if (byName) {
    return byName;
  }
  return ofType[0];
}

/**
 * Configured datasource of a Grafana type, default-first.
 * getDataSourceSrv().getList({ type, all: true }) then get(ref) — no hardcoded uids, no picker UI.
 * `all: true` is required: getList() otherwise hides any datasource whose plugin.json declares none
 * of metrics/annotations/tracing/logs/alerting, which is exactly Grafana's built-in Alertmanager.
 */
export async function getDataSourceByType(
  type: 'loki' | 'prometheus' | 'tempo' | 'alertmanager'
): Promise<{ settings?: DataSourceInstanceSettings; ds?: DsQueryable } | undefined> {
  const srv = getDataSourceSrv();
  let list: DataSourceInstanceSettings[] = [];
  try {
    // getList() excludes datasources whose plugin.json declares none of
    // metrics/annotations/tracing/logs/alerting — that is exactly Grafana's built-in
    // Alertmanager datasource (grafana/grafana public/app/plugins/datasource/alertmanager/plugin.json
    // only sets "metrics": false). Pass all: true so a real, configured Alertmanager datasource is
    // still returned; pickDataSource()'s default/name/first ordering below is unaffected because it
    // already narrows to `type` first.
    const raw = srv.getList({ type, all: true });
    list = Array.isArray(raw) ? raw : [];
  } catch {
    const raw = typeof srv.getList === 'function' ? srv.getList() : [];
    list = Array.isArray(raw) ? (raw as DataSourceInstanceSettings[]) : [];
  }
  const settings = pickDataSource(list, type);
  if (!settings) {
    return undefined;
  }
  const ref = settings.uid || settings.name;
  if (!ref) {
    return { settings };
  }
  try {
    // Official pattern (lokiexplore / metricsdrilldown / llm-app / scenes): get(ref) then ds.query
    const ds = await srv.get(ref);
    if (!ds || typeof ds.query !== 'function') {
      return { settings };
    }
    return { settings, ds: ds as DsQueryable };
  } catch {
    return { settings };
  }
}

async function runDsQuery(ds: DsQueryable, request: DataQueryRequest): Promise<DataQueryResponse | undefined> {
  const result = ds.query(request);
  if (result && typeof (result as Promise<DataQueryResponse>).then === 'function') {
    return result as Promise<DataQueryResponse>;
  }
  if (isObservable(result)) {
    return lastValueFrom(result as Observable<DataQueryResponse>);
  }
  return undefined;
}

function framesOf(response: DataQueryResponse | undefined): DataFrame[] {
  if (!response || !Array.isArray(response.data)) {
    return [];
  }
  return response.data as DataFrame[];
}

function fieldLength(values: unknown): number {
  if (!values) {
    return 0;
  }
  if (Array.isArray(values)) {
    return values.length;
  }
  const v = values as { length?: number };
  return typeof v.length === 'number' ? v.length : 0;
}

function fieldGet(values: unknown, index: number): unknown {
  if (Array.isArray(values)) {
    return values[index];
  }
  const v = values as { get?: (i: number) => unknown };
  return typeof v.get === 'function' ? v.get(index) : undefined;
}

/** Flatten string-ish DataFrame fields into plain lines (shared for Loki/AM). */
export function textLinesFromFrames(frames: DataFrame[], cap: number): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const fields = frame.fields ?? [];
    const preferred =
      fields.find((f) => f.name === 'Line' || f.name === 'body' || f.name === 'line' || f.name === 'alertname') ??
      fields.find((f) => f.type === 'string');
    if (!preferred) {
      continue;
    }
    const len = fieldLength(preferred.values);
    for (let i = 0; i < len && lines.length < cap; i++) {
      const line = String(fieldGet(preferred.values, i) ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!line || seen.has(line)) {
        continue;
      }
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.slice(0, cap);
}
const DASHBOARD_UID_KEYS = ['dashboardUID', 'dashboardUid', '__dashboardUid__', 'dashboard_uid'];

function addDashboardUid(raw: unknown, seen: Record<string, true>, uids: string[]) {
  if (uids.length >= DASHBOARD_UID_CAP) {
    return;
  }
  const s = String(raw ?? '').trim();
  if (!s || seen[s] || !/^[A-Za-z0-9_-]{5,40}$/.test(s)) {
    return;
  }
  seen[s] = true;
  uids.push(s);
}

/**
 * v1: dashboard UIDs Grafana already attached to firing alerts. Never GET /api/search.
 * Capped at DASHBOARD_UID_CAP: a cluster with many firing alerts can carry a distinct
 * dashboardUID label per alert, and both dashboardHintFromUids (mapHint) and
 * formatCurrent render every uid this returns with no cap of their own — an unbounded
 * list here grows the Current block past its packer budget and starves the packer
 * into shedding real Loki/Prometheus/Alertmanager evidence lines instead.
 */
export function dashboardUidsFromAlertFrames(frames: DataFrame[]): string[] {
  const uids: string[] = [];
  const seen: Record<string, true> = {};
  for (const frame of frames) {
    if (uids.length >= DASHBOARD_UID_CAP) {
      break;
    }
    for (const field of frame.fields ?? []) {
      if (uids.length >= DASHBOARD_UID_CAP) {
        break;
      }
      if (DASHBOARD_UID_KEYS.includes(field.name)) {
        const len = fieldLength(field.values);
        for (let i = 0; i < len && uids.length < DASHBOARD_UID_CAP; i++) {
          addDashboardUid(fieldGet(field.values, i), seen, uids);
        }
      }
      const labels = (field as { labels?: Record<string, string> }).labels ?? {};
      for (const key of DASHBOARD_UID_KEYS) {
        if (labels[key]) {
          addDashboardUid(labels[key], seen, uids);
        }
      }
    }
  }
  return uids;
}

/**
 * Map hint for the dashboards Grafana attached to firing alerts. Three cases, because
 * both the Current (700) and Map (400) budgets are fixed and every char spent here is
 * a char of real evidence the packer sheds:
 *
 * - links exist                 → name them; the model can cite them.
 * - alerts firing, no links     → say so; the explicit negative is the cheap defence
 *                                 against inventing a dashboard link for an alert.
 * - no alerts at all            → '' — there is nothing a dashboard could be linked to,
 *                                 so the sentence would cost budget to say nothing.
 */
export function dashboardHintFromUids(uids: string[], alertsFiring = false): string {
  if (uids.length > 0) {
    return 'dashboards: ' + uids.map((u) => '/d/' + u).join(' ');
  }
  return alertsFiring ? 'dashboards: none linked on firing alerts' : '';
}

/**
 * dashboardUidsFromAlertFrames only understands DataFrame shapes — this is the boundary
 * adapter from the real JSON alert payload into that shape, so its field/label scanning,
 * the UID regex validation, and DASHBOARD_UID_CAP stay untouched and still apply.
 */
export function frameFromAlertmanagerAlert(alert: AlertmanagerAlert): DataFrame {
  const fields: DataFrame['fields'] = [];
  for (const key of DASHBOARD_UID_KEYS) {
    const val = alert.annotations?.[key] || alert.labels?.[key];
    if (val) {
      fields.push({ name: key, type: 'string' as never, values: [val], config: {} });
    }
  }
  return {
    fields,
    length: fields.length > 0 ? 1 : 0,
  };
}


export function linesFromLokiFrames(frames: DataFrame[]): string[] {
  return textLinesFromFrames(frames, LOG_LINE_CAP);
}

export function factsFromPromFrames(frames: DataFrame[]): string[] {
  const facts: string[] = [];
  for (const frame of frames) {
    if (facts.length >= PROM_SERIES_CAP) {
      break;
    }
    const fields = frame.fields ?? [];
    const valueField =
      fields.find((f) => f.name === 'Value' || f.name === 'value') ?? fields.find((f) => f.type === 'number');
    if (!valueField) {
      continue;
    }
    const len = fieldLength(valueField.values);
    const labels =
      (valueField as { labels?: Record<string, string> }).labels ??
      (frame as DataFrame & { labels?: Record<string, string> }).labels ??
      {};
    // Prefer label columns from table format (instant queries).
    const podField = fields.find((f) => f.name === 'pod');
    const nsField = fields.find((f) => f.name === 'namespace');
    for (let i = len - 1; i >= 0 && facts.length < PROM_SERIES_CAP; i--) {
      const raw = fieldGet(valueField.values, i);
      if (raw === null || raw === undefined || Number.isNaN(Number(raw))) {
        continue;
      }
      const podFromCol = podField ? String(fieldGet(podField.values, i) ?? '').trim() : '';
      const nsFromCol = nsField ? String(fieldGet(nsField.values, i) ?? '').trim() : '';
      const pod = podFromCol || labels.pod || frame.name || 'series';
      const ns = nsFromCol || labels.namespace;
      const fact = ns ? `${pod} ns/${ns} restarts=${Number(raw)}` : `${pod} restarts=${Number(raw)}`;
      facts.push(fact);
      // Table rows: keep walking for multi-series frames
      if (!podField && !nsField && Object.keys(labels).length > 0) {
        break;
      }
    }
  }
  return facts;
}

export function tracesFromTempoFrames(frames: DataFrame[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const fields = frame.fields ?? [];
    const idField = fields.find((f) => /trace/i.test(f.name || '')) ?? fields.find((f) => f.type === 'string');
    if (!idField) {
      continue;
    }
    const len = fieldLength(idField.values);
    for (let i = 0; i < len && out.length < TEMPO_TRACE_CAP; i++) {
      const id = String(fieldGet(idField.values, i) ?? '').trim();
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(`trace ${id}`);
    }
  }
  return out;
}

/** Minimal shape of a Prometheus Alertmanager /api/v2/alerts entry we read. */
type AlertmanagerAlert = {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  status?: { state?: string };
};

/** One evidence line per alert: name, severity, state, start time, and summary/description. */
function formatAlertLine(alert: AlertmanagerAlert): string {
  const labels = alert.labels ?? {};
  const annotations = alert.annotations ?? {};
  const summary = annotations.summary || annotations.description || '';
  const base = `${labels.alertname || 'alert'} severity=${labels.severity || 'unknown'} state=${
    alert.status?.state || 'unknown'
  } since=${alert.startsAt || 'unknown'}`;
  return summary ? `${base} summary=${summary}` : base;
}

/** Flatten a raw Alertmanager /api/v2/alerts response into capped evidence lines. */
export function linesFromAlertmanagerAlerts(alerts: unknown, cap: number): string[] {
  if (!Array.isArray(alerts)) {
    return [];
  }
  return (alerts as AlertmanagerAlert[]).slice(0, cap).map(formatAlertLine);
}

/**
 * Alertmanager v2 API label matchers (`label=value`, `label=~regex`) for the
 * /api/v2/alerts `filter` query param — same namespace/pod scoping the old
 * (never-functional, because ds.query() is a stub) LogQL/PromQL-style expr
 * attempted, but applied server-side by Alertmanager itself rather than
 * guessed at from whatever labels happen to be present client-side.
 */
function alertFilterQuery(target: PodNamespaceTarget): string {
  const matchers: string[] = [];
  if (target.namespace) {
    matchers.push(`namespace="${target.namespace}"`);
  }
  if (target.pod) {
    matchers.push(`pod=~"${escapeRegex(target.pod)}.*"`);
  }
  return matchers.map((m) => `filter=${encodeURIComponent(m)}`).join('&');
}

/**
 * Mimir and Cortex serve the Alertmanager v2 API under an `/alertmanager` prefix;
 * a plain Prometheus Alertmanager serves it at the root. Grafana records which one
 * the operator selected in `jsonData.implementation` and its own
 * AlertManagerDatasource.testDatasource() branches on exactly that.
 *
 * Grafana's branch is `implementation === 'prometheus' ? root : '/alertmanager'`, so Grafana
 * treats an *unset* implementation as Mimir — ConfigEditor.tsx defaults the dropdown to Mimir
 * and writes it back on first edit. We deliberately treat unset as the root path instead:
 * provisioning is the main way `implementation` stays unset, and a provisioned Alertmanager
 * datasource in this plugin's target environment is almost always the Prometheus-operator's
 * plain Alertmanager, which serves /api/v2 at the root. A wrong guess is not silent — the read
 * 404s and Current reports `Alertmanager alerts unavailable (...)` rather than "no alerts".
 */
function alertmanagerApiPrefix(settings: DataSourceInstanceSettings): string {
  const implementation = (settings.jsonData as { implementation?: string } | undefined)?.implementation;
  return implementation === 'mimir' || implementation === 'cortex' ? '/alertmanager' : '';
}

/**
 * Real alerts, not ds.query() (a permanent stub — see header comment). Mirrors
 * grafana/grafana AlertManagerDatasource._request(): GET against the datasource's
 * own configured URL, which Grafana resolves to its proxy route for proxy-access
 * datasources. Throws on a missing URL or a failed request so the caller can report
 * the failure distinctly from a genuine empty result.
 */
async function fetchAlertmanagerAlerts(
  settings: DataSourceInstanceSettings,
  target: PodNamespaceTarget
): Promise<unknown> {
  if (!settings.url) {
    throw new Error('Alertmanager datasource has no URL configured');
  }
  const query = alertFilterQuery(target);
  const base = `${settings.url.replace(/\/+$/, '')}${alertmanagerApiPrefix(settings)}`;
  return getBackendSrv().get(`${base}/api/v2/alerts${query ? `?${query}` : ''}`);
}

function scopeSuffix(target: PodNamespaceTarget): string {
  const where = [
    target.pod ? `pod/${target.pod}` : undefined,
    target.namespace ? `ns/${target.namespace}` : undefined,
  ]
    .filter((x): x is string => Boolean(x))
    .join(' ');
  return where ? ` (${where})` : '';
}

function dsMapToken(kind: string, settings?: DataSourceInstanceSettings): string {
  if (!settings) {
    return `${kind} (missing)`;
  }
  const id = settings.uid || settings.name || '';
  return id ? `${kind} ${settings.name || id}` : kind;
}

function formatCurrent(args: {
  target: PodNamespaceTarget;
  logLines: string[];
  promLines: string[];
  tempoLines: string[];
  alertLines: string[];
  dashboardUids: string[];
  lokiNote?: string;
  promNote?: string;
  tempoNote?: string;
  alertNote?: string;
}): string {
  const scope = scopeSuffix(args.target);
  const parts: string[] = [];

  parts.push(`Loki last 15m${scope}:`);
  parts.push(args.logLines.length > 0 ? args.logLines.join('\n') : args.lokiNote ?? 'no log lines');
  parts.push('');
  parts.push(`Prometheus last 15m${scope}:`);
  parts.push(args.promLines.length > 0 ? args.promLines.join('\n') : args.promNote ?? 'no metric samples');
  parts.push('');
  parts.push(`Tempo last 15m${scope}:`);
  parts.push(args.tempoLines.length > 0 ? args.tempoLines.join('\n') : args.tempoNote ?? 'no traces');
  parts.push('');
  parts.push(`Alertmanager${scope}:`);
  parts.push(args.alertLines.length > 0 ? args.alertLines.join('\n') : args.alertNote ?? 'no alerts');
  // Dashboards are alert-derived, not a queried datasource, so unlike the four blocks
  // above they have no "checked, found nothing" state of their own. Emitted in two of
  // three cases: the links when Grafana attached any, and an explicit negative when
  // alerts are firing but carry none — that negative is the cheap defence against the
  // model inventing a link for an alert it can see. On a cluster with no firing alerts
  // the block is omitted: there it cost 65 chars of the fixed 700-char MAX_CURRENT_CHARS
  // budget to announce nothing, and the packer paid for it by shedding the last Loki
  // line that still fitted. dashboardUids is already capped at DASHBOARD_UID_CAP by
  // dashboardUidsFromAlertFrames, so this block's own growth is bounded too.
  const dashboardHint =
    args.dashboardUids.length > 0
      ? args.dashboardUids.map((u) => '/d/' + u).join('\n')
      : args.alertLines.length > 0
        ? '(none linked on firing alerts)'
        : '';
  if (dashboardHint) {
    parts.push('');
    parts.push('Dashboards (from firing alerts):');
    parts.push(dashboardHint);
  }

  return parts.join('\n');
}

/**
 * Grafana stack → Current/Map for Query (connect-only).
 * Pattern: getDataSourceSrv().getList({ type }) → get(ref) → ds.query(DataQueryRequest),
 * except Alertmanager, whose query() is a stub (see header comment): its alerts come
 * from getBackendSrv().get() against its own configured datasource URL instead.
 * Packs DataFrame text into Current. No hardcoded uids, no invented proxy URLs, no picker UI.
 * Always queries Loki + Prometheus (cluster-wide when no pod/ns). Alertmanager cluster-wide too.
 */
export async function fetchStackContext(question: string): Promise<StackContextResult> {
  const target = parsePodNamespace(question);
  const logql = buildLogQL(target);
  const promql = buildPromQL(target);
  const scoped = Boolean(target.pod || target.namespace);

  let logLines: string[] = [];
  let promLines: string[] = [];
  let tempoLines: string[] = [];
  let alertLines: string[] = [];
  let lokiNote: string | undefined;
  let promNote: string | undefined;
  let tempoNote: string | undefined;
  let alertNote: string | undefined;

  const [loki, prom, tempo, am] = await Promise.all([
    getDataSourceByType('loki'),
    getDataSourceByType('prometheus'),
    getDataSourceByType('tempo'),
    getDataSourceByType('alertmanager'),
  ]);

  const mapParts = [
    dsMapToken('Loki', loki?.settings),
    dsMapToken('Prometheus', prom?.settings),
    dsMapToken('Tempo', tempo?.settings),
    dsMapToken('Alertmanager', am?.settings),
  ];
  if (target.namespace) {
    mapParts.push(`ns/${target.namespace}`);
  }
  if (target.pod) {
    mapParts.push(`pod/${target.pod}`);
  }

  const queryOne = async (
    ds: { ds?: { query: (req: DataQueryRequest) => unknown } } | undefined,
    missing: string,
    failPrefix: string,
    run: () => Promise<{ lines: string[]; emptyNote: string }>
  ): Promise<{ lines: string[]; note?: string }> => {
    if (!ds?.ds) {
      return { lines: [], note: missing };
    }
    try {
      const { lines, emptyNote } = await run();
      if (lines.length === 0) {
        return { lines, note: emptyNote };
      }
      return { lines };
    } catch (e) {
      return { lines: [], note: `${failPrefix} (${e instanceof Error ? e.message : 'query failed'})` };
    }
  };

  const queryAlertmanager = async (): Promise<{ lines: string[]; note?: string; frames: DataFrame[] }> => {
    if (!am?.settings) {
      return { lines: [], note: 'Alertmanager datasource missing', frames: [] };
    }
    try {
      const raw = await fetchAlertmanagerAlerts(am.settings, target);
      const lines = linesFromAlertmanagerAlerts(raw, ALERT_CAP);
      const alerts = Array.isArray(raw) ? (raw as AlertmanagerAlert[]) : [];
      const frames = alerts.map(frameFromAlertmanagerAlert);
      if (lines.length === 0) {
        return {
          lines,
          frames,
          // /api/v2/alerts is a current-state snapshot, not a time window like the
          // Loki/Prometheus/Tempo notes, so this must not claim "in the last 15m".
          note: scoped ? 'no alerts firing for this pod/namespace' : 'no alerts firing',
        };
      }
      return { lines, frames };
    } catch (e) {
      return {
        lines: [],
        frames: [],
        note: `Alertmanager alerts unavailable (${e instanceof Error ? e.message : 'request failed'})`,
      };
    }
  };

  const [lokiRes, promRes, tempoRes, amRes] = await Promise.all([
    queryOne(loki, 'Loki datasource missing', 'no log lines', async () => {
      const resp = await runDsQuery(
        loki!.ds!,
        baseRequest<LokiTarget>(
          [{ refId: 'A', expr: logql, queryType: 'range', maxLines: LOG_LINE_CAP }],
          'dotai-loki'
        ) as DataQueryRequest
      );
      const lines = linesFromLokiFrames(framesOf(resp));
      return {
        lines,
        emptyNote: scoped
          ? 'no log lines for this pod/namespace in the last 15m'
          : 'no log lines cluster-wide for error-like events in the last 15m',
      };
    }),
    queryOne(prom, 'Prometheus datasource missing', 'no metric samples', async () => {
      const resp = await runDsQuery(
        prom!.ds!,
        baseRequest<PromTarget>(
          [{ refId: 'B', expr: promql, instant: true, format: 'table' }],
          'dotai-prometheus'
        ) as DataQueryRequest
      );
      const lines = factsFromPromFrames(framesOf(resp));
      return {
        lines,
        emptyNote: scoped
          ? 'no metric samples for this pod/namespace in the last 15m'
          : 'no metric samples cluster-wide for restarts in the last 15m',
      };
    }),
    queryOne(tempo, 'Tempo datasource missing', 'no traces', async () => {
      const search = target.pod || target.namespace || question.slice(0, 80);
      const resp = await runDsQuery(
        tempo!.ds!,
        baseRequest<TempoTarget>(
          [{ refId: 'C', queryType: 'traceqlSearch', query: search, limit: TEMPO_TRACE_CAP }],
          'dotai-tempo'
        ) as DataQueryRequest
      );
      const lines = tracesFromTempoFrames(framesOf(resp));
      return { lines, emptyNote: 'no traces for this target in the last 15m' };
    }),
    queryAlertmanager(),
  ]);

  logLines = lokiRes.lines;
  lokiNote = lokiRes.note;
  promLines = promRes.lines;
  promNote = promRes.note;
  tempoLines = tempoRes.lines;
  tempoNote = tempoRes.note;
  alertLines = amRes.lines;
  alertNote = amRes.note;
  const dashboardUids = dashboardUidsFromAlertFrames(amRes.frames);

  const mapHint = [...mapParts, dashboardHintFromUids(dashboardUids, alertLines.length > 0)]
    .filter(Boolean)
    .join(', ');

  const tempoSearch = target.pod || target.namespace || question.slice(0, 80);
  const drilldowns = buildDrilldownLinks({
    lokiUid: loki?.settings?.uid,
    promUid: prom?.settings?.uid,
    tempoUid: tempo?.settings?.uid,
    logql,
    promql,
    tempoSearch,
    traceIds: tempoLines.map((line) => line.replace(/^trace\s+/i, '').trim()).filter(Boolean),
    dashboardUids,
  });

  const currentEmpty = isStackCurrentEmpty({ logLines, promLines, tempoLines, alertLines });

  return {
    logLines,
    promLines,
    tempoLines,
    alertLines,
    currentEmpty,
    drilldowns,
    current: formatCurrent({
      target,
      logLines,
      promLines,
      tempoLines,
      alertLines,
      dashboardUids,
      lokiNote,
      promNote,
      tempoNote,
      alertNote,
    }),
    mapHint,
  };
}
