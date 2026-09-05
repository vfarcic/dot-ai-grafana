import pluginJson from '../src/plugin.json';

/** Plugin id under test (must match src/plugin.json). */
export const PLUGIN_ID = pluginJson.id;

/** Unique stub markers — must never appear in browser-visible plugin responses. */
export const UPSTREAM_SECRET_MARKER = 'UPSTREAM_SECRET_STACK_DO_NOT_LEAK';
export const UPSTREAM_INTERNAL_FIELD = 'raw_upstream_internal_do_not_leak';

/** Provisioned bearer (secureJsonData). Must never appear in settings/resources/bundle. */
export const PROVISIONED_API_KEY = 'bydesign-e2e-bearer-token-do-not-leak';

export type ToolName = 'query' | 'remediate' | 'test-connection' | 'health';

export function resourcePath(tool: ToolName): string {
  return `/api/plugins/${PLUGIN_ID}/resources/${tool}`;
}

export type ToolEnvelope = {
  ok?: boolean;
  status?: number;
  summary?: string;
  error?: string;
  [key: string]: unknown;
};

export function asEnvelope(body: unknown): ToolEnvelope {
  if (body && typeof body === 'object') {
    return body as ToolEnvelope;
  }
  return {};
}

/** True when body looks like the stable tool proxy envelope (not a raw upstream dump). */
export function isStableEnvelope(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const o = body as Record<string, unknown>;
  return 'ok' in o && 'status' in o && 'summary' in o && 'error' in o;
}

export function bodyContainsForbidden(body: unknown, ...needles: string[]): string[] {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return needles.filter((n) => n && text.includes(n));
}

/**
 * Host-reachable base URL of the dot-ai stub (docker-compose.yaml publishes
 * container port 8080 on host 18080). Overridable for non-default setups.
 */
export const STUB_BASE_URL = process.env.DOT_AI_STUB_URL || 'http://localhost:18080';

export type StubCounters = Record<string, number>;

export type StubHealth = {
  /** Per-tool POST counters (version/query/remediate/other). */
  hits: StubCounters;
  /** Per-request `DIALPROBE-<id>` counters, one key per probe the stub has seen. */
  probes: StubCounters;
};

/**
 * Upstream hit counters from the stub's GET /healthz — the measurement behind
 * #44's "403 with no upstream dial". A gate that dialled upstream and then
 * discarded the result would still bump these.
 *
 * Deny-path specs assert on `probes[token]` rather than `hits[tool]`: the suite
 * is `fullyParallel`, so allow-path tests move the per-tool totals concurrently,
 * while a probe token is unique to one request.
 */
export async function stubHealth(): Promise<StubHealth> {
  const resp = await fetch(`${STUB_BASE_URL}/healthz`);
  if (!resp.ok) {
    throw new Error(`dot-ai stub /healthz returned HTTP ${resp.status} at ${STUB_BASE_URL}`);
  }
  const body = (await resp.json()) as Partial<StubHealth>;
  if (!body || typeof body.hits !== 'object' || body.hits === null) {
    throw new Error(`dot-ai stub /healthz payload has no hits map: ${JSON.stringify(body)}`);
  }
  return { hits: body.hits, probes: body.probes ?? {} };
}

export type StubIntent = {
  /** Tool the plugin proxied to (`query` / `remediate`). */
  tool: string;
  /** The packed `{intent}` / `{issue}` text as it arrived upstream. */
  text: string;
  len: number;
  /** Top-level request-body keys, so a spec can assert the allowlist. */
  keys: string[];
};

/**
 * Request texts the stub actually received (GET /intents, newest last). This is the
 * measurement behind consent specs: what the on-page notice claims is POSTed has to
 * match what left the browser, not what the UI says about itself.
 */
export async function stubIntents(): Promise<StubIntent[]> {
  const resp = await fetch(`${STUB_BASE_URL}/intents`);
  if (!resp.ok) {
    throw new Error(`dot-ai stub /intents returned HTTP ${resp.status} at ${STUB_BASE_URL}`);
  }
  const body = (await resp.json()) as { intents?: StubIntent[] };
  if (!body || !Array.isArray(body.intents)) {
    throw new Error(`dot-ai stub /intents payload has no intents array: ${JSON.stringify(body)}`);
  }
  return body.intents;
}

/** Unique per-request dial probe token, planted in the request body. */
export function dialProbe(label: string): string {
  return `DIALPROBE-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
