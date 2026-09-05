import { test, expect } from './fixtures';
import {
  PROVISIONED_API_KEY,
  UPSTREAM_INTERNAL_FIELD,
  UPSTREAM_SECRET_MARKER,
  asEnvelope,
  bodyContainsForbidden,
  dialProbe,
  isStableEnvelope,
  resourcePath,
  STUB_BASE_URL,
  stubHealth,
} from './byDesignHelpers';
import { testIds } from '../src/components/testIds';

/**
 * Security by design — real HTTP path /api/plugins/<id>/resources/*.
 *
 * Every deny case plants a unique DIALPROBE token in the request body and
 * snapshots the stub's GET /healthz counters before and after, then asserts a
 * zero delta for that probe: the denial happened with **no upstream dial**
 * (#44 S1/S2/S5/S7), measured rather than inferred from response body markers.
 * The body-marker assertions are kept alongside.
 */

const viewerState = 'playwright/.auth/viewer.json';
const editorState = 'playwright/.auth/editor.json';
const adminState = 'playwright/.auth/admin.json';

/** Probe delta for one token, plus the per-tool totals for failure context. */
async function probeDelta(token: string): Promise<{ delta: number; detail: string }> {
  const after = await stubHealth();
  return {
    delta: after.probes[token] ?? 0,
    detail: `stub hits=${JSON.stringify(after.hits)} probes[${token}]=${after.probes[token] ?? 0}`,
  };
}

test.describe('Security by design — Viewer denied on tool routes', () => {
  test.use({ storageState: viewerState });

  for (const tool of ['query', 'remediate'] as const) {
    test(`Viewer POST /${tool} is refused with HTTP 403 and no upstream dial`, async ({ request }) => {
      const probe = dialProbe(`viewer-${tool}`);
      const before = await stubHealth();
      expect(before.probes[probe], 'probe token must be unused before the request').toBeUndefined();

      const body =
        tool === 'query'
          ? { intent: `list pods in default ${probe}` }
          : { issue: `crashloop on checkout ${probe}`, intent: `crashloop on checkout ${probe}` };

      const resp = await request.post(resourcePath(tool), { data: body });
      const text = await resp.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }

      // THE GATE ASSERTION — red without the role gate (PR #25), green with it.
      expect(
        resp.status(),
        `Viewer /${tool} must be HTTP 403 (role gate). body=${text}`
      ).toBe(403);

      // THE NO-DIAL ASSERTION — fails if the gate dialled upstream and discarded it.
      const { delta, detail } = await probeDelta(probe);
      expect(delta, `Viewer /${tool} denial must not dial upstream. ${detail}`).toBe(0);

      const forbidden = bodyContainsForbidden(
        json,
        UPSTREAM_SECRET_MARKER,
        UPSTREAM_INTERNAL_FIELD,
        PROVISIONED_API_KEY,
        'stub-query-ok',
        'stub-remediate-ok'
      );
      expect(forbidden, `upstream/provisioned secrets must not reach Viewer body`).toEqual([]);

      if (typeof json === 'object' && json !== null) {
        expect(isStableEnvelope(json)).toBeTruthy();
        const env = asEnvelope(json);
        expect(env.status).toBe(403);
        expect(env.ok).toBe(false);
      }
    });
  }
});

test.describe('Security by design — unauthenticated caller', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const tool of ['query', 'remediate'] as const) {
    test(`unauthenticated POST /${tool} is not treated as an authorized tool call`, async ({ request }) => {
      const probe = dialProbe(`anon-${tool}`);
      const before = await stubHealth();
      expect(before.probes[probe], 'probe token must be unused before the request').toBeUndefined();

      const body = tool === 'query' ? { intent: `whoami ${probe}` } : { issue: `whoami ${probe}` };
      const resp = await request.post(resourcePath(tool), { data: body });
      const text = await resp.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }

      // Grafana itself should reject anonymous resource calls when anonymous auth is off.
      // Accept 401/403; never 2xx with upstream content.
      expect(
        [401, 403].includes(resp.status()),
        `unauthenticated /${tool} status=${resp.status()} body=${text}`
      ).toBeTruthy();

      const { delta, detail } = await probeDelta(probe);
      expect(delta, `unauthenticated /${tool} must not dial upstream. ${detail}`).toBe(0);

      const forbidden = bodyContainsForbidden(
        json,
        UPSTREAM_SECRET_MARKER,
        UPSTREAM_INTERNAL_FIELD,
        PROVISIONED_API_KEY,
        'stub-query-ok',
        'stub-remediate-ok'
      );
      expect(forbidden).toEqual([]);
    });
  }
});

test.describe('Security by design — Editor allowed on tool routes', () => {
  test.use({ storageState: editorState });

  for (const tool of ['query', 'remediate'] as const) {
    test(`Editor POST /${tool} is accepted (authorization, not live cluster)`, async ({ request }) => {
      const body =
        tool === 'query'
          ? { intent: 'list nodes' }
          : { issue: 'pod pending', intent: 'pod pending' };

      const resp = await request.post(resourcePath(tool), { data: body });
      const text = await resp.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }

      expect(resp.status(), `Editor /${tool} should reach the tool proxy. body=${text}`).toBe(200);
      expect(isStableEnvelope(json)).toBeTruthy();
      const env = asEnvelope(json);
      expect(env.ok).toBe(true);
      expect(String(env.summary || '')).toContain(`stub-${tool}-ok`);

      const forbidden = bodyContainsForbidden(json, UPSTREAM_SECRET_MARKER, UPSTREAM_INTERNAL_FIELD, PROVISIONED_API_KEY);
      expect(forbidden).toEqual([]);
    });
  }
});

test.describe('Security by design — Admin allowed on tool routes', () => {
  test.use({ storageState: adminState });

  for (const tool of ['query', 'remediate'] as const) {
    test(`Admin POST /${tool} is accepted`, async ({ request }) => {
      const body =
        tool === 'query'
          ? { intent: 'list namespaces' }
          : { issue: 'node not ready', intent: 'node not ready' };

      const resp = await request.post(resourcePath(tool), { data: body });
      const text = await resp.text();
      const json = JSON.parse(text);

      expect(resp.status(), text).toBe(200);
      expect(isStableEnvelope(json)).toBeTruthy();
      expect(asEnvelope(json).ok).toBe(true);

      const forbidden = bodyContainsForbidden(json, UPSTREAM_SECRET_MARKER, UPSTREAM_INTERNAL_FIELD, PROVISIONED_API_KEY);
      expect(forbidden).toEqual([]);
    });
  }
});

test.describe('Security by design — Test-connection Admin gate', () => {
  /**
   * A draft apiUrl pointed at the stub with a unique DIALPROBE path segment:
   * test-connection forwards only the draft URL (body is `{}` upstream), so the
   * probe has to ride in the path. A denial that still dialled would show up as
   * `probes[token] === 1`.
   */
  const draftProbeUrl = (probe: string) => `http://dot-ai-stub.svc:8080/${probe}`;

  test('Admin can test-connection against saved settings', async ({ request }) => {
    const resp = await request.post(resourcePath('test-connection'), { data: {} });
    const text = await resp.text();
    const json = JSON.parse(text) as Record<string, unknown>;

    // Saved-settings probe is allowed and answers on the test-connection contract.
    expect(resp.status(), text).toBe(200);
    expect(json.status, text).toBe('ok');
    expect(json.connected, text).toBe(true);
    expect(json.upstreamStatus, text).toBe(200);
    expect(bodyContainsForbidden(text, PROVISIONED_API_KEY, UPSTREAM_SECRET_MARKER), text).toEqual([]);
  });

  for (const [role, state] of [
    ['Viewer', viewerState],
    ['Editor', editorState],
  ] as const) {
    test(`${role} cannot probe a draft apiUrl (Admin-only, no dial)`, async ({ browser }) => {
      const probe = dialProbe(`${role.toLowerCase()}-testconn`);
      const before = await stubHealth();
      expect(before.probes[probe], 'probe token must be unused before the request').toBeUndefined();

      const context = await browser.newContext({ storageState: state });
      const resp = await context.request.post(resourcePath('test-connection'), {
        data: { apiUrl: draftProbeUrl(probe), apiKey: 'draft-key' },
      });
      const text = await resp.text();
      expect(resp.status(), text).toBe(403);

      const { delta, detail } = await probeDelta(probe);
      expect(delta, `${role} test-connection denial must not dial upstream. ${detail}`).toBe(0);

      expect(text).not.toContain(UPSTREAM_SECRET_MARKER);
      expect(text).not.toContain(PROVISIONED_API_KEY);
      await context.close();
    });
  }
});

test.describe('Security by design — upstream errors never dump raw body', () => {
  test.use({ storageState: adminState });

  /**
   * Upstream 5xx → stable envelope is asserted once, in
   * tests/reliability-by-design.spec.ts ("upstream 5xx degrades to stable
   * envelope"), whose assertions are a superset of the copy that used to live
   * here. Unit coverage: pkg/plugin/resources_test.go:751
   * (TestProxyTools/upstream_error_envelope).
   */
  test('upstream 403 is remapped to 502 envelope (not session-looking 403)', async ({ request }) => {
    const resp = await request.post(resourcePath('query'), {
      data: { intent: 'TRIGGER_UPSTREAM_403 please' },
    });
    const text = await resp.text();
    const json = JSON.parse(text);

    expect(isStableEnvelope(json)).toBeTruthy();
    // Plugin maps upstream 401/403 → 502 so the browser does not mistake it for Grafana session expiry.
    expect(resp.status(), text).toBe(502);
    const forbidden = bodyContainsForbidden(json, UPSTREAM_SECRET_MARKER, UPSTREAM_INTERNAL_FIELD, PROVISIONED_API_KEY);
    expect(forbidden, text).toEqual([]);
  });
});

test.describe('Security by design — remediate allowlist (no execute)', () => {
  test.use({ storageState: adminState });

  test('execute/apply keys in remediate body never reach upstream as executable fields', async ({ request }) => {
    const resp = await request.post(resourcePath('remediate'), {
      data: {
        issue: 'scale deployment',
        intent: 'scale deployment',
        execute: true,
        apply: true,
        mode: 'execute',
        confirm: 'yes',
      },
    });
    const text = await resp.text();
    const json = JSON.parse(text);

    expect(resp.status(), text).toBe(200);
    expect(isStableEnvelope(json)).toBeTruthy();
    const env = asEnvelope(json);
    expect(env.ok).toBe(true);
    // Stub plants STUB_SAW_EXECUTE_KEYS if any execute-ish key survives the allowlist.
    expect(String(env.summary || ''), text).not.toMatch(/STUB_SAW_EXECUTE_KEYS/);
    expect(String(env.summary || '')).toContain('stub-remediate-ok');
  });
});

test.describe('Security by design — untrusted markdown answer', () => {
  test.use({ storageState: adminState });

  /**
   * The dot-ai answer is attacker-influenceable: it is generated from a prompt packed with
   * Loki lines, alert annotations and Kubernetes object names, any of which someone with
   * write access to a monitored cluster can author. The payload is the stub's
   * INJECTION_ANSWER (tests/harness/dot_ai_stub.py), fetched from the stub by the route
   * handler below and handed to the page in the plugin's envelope shape.
   *
   * Why the route is intercepted rather than proxied: the subject here is the RENDERER, not
   * the Go proxy. The proxy's own behaviour is asserted by the sibling describes in this
   * file, which post to /resources/* for real. Intercepting also makes this spec runnable
   * against a Grafana that has the plugin frontend but no backend binary.
   *
   * Measured, not inferred: `probes[token]` proves the payload came out of the stub (the
   * route handler's dial — not the plugin's), and the request recorder is a browser-side
   * observation of every request Chromium ATTEMPTED, so a surviving `<img>`/`<iframe>`/
   * `<link rel=stylesheet>` is counted even though the beacon host never resolves.
   */
  test('injected answer renders inert — no embed, no handler, no beacon', async ({ gotoPage, page }) => {
    const beaconHost = 'beacon.evil.invalid';
    const probe = dialProbe('render-injection');
    const before = await stubHealth();
    expect(before.probes[probe], 'probe token must be unused before the request').toBeUndefined();

    const beaconed: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes(beaconHost)) {
        beaconed.push(`${req.resourceType()} ${req.url()}`);
      }
    });

    await page.route(new RegExp(`/api/plugins/[^/]+/resources/query`), async (route) => {
      const upstream = await fetch(`${STUB_BASE_URL}/api/v1/tools/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-render-probe' },
        body: JSON.stringify({ intent: `TRIGGER_INJECTION_MARKDOWN ${probe}` }),
      });
      const body = (await upstream.json()) as { data?: { result?: { summary?: string } } };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // The plugin's stable envelope — same keys the Go proxy returns.
        body: JSON.stringify({
          ok: true,
          status: 200,
          summary: body.data?.result?.summary ?? '',
          error: '',
        }),
      });
    });

    await gotoPage('/');
    await page.getByTestId(testIds.dotai.intent).fill('what is wrong with the api pod');
    await page.getByTestId(testIds.dotai.submit).click();

    const answer = page.getByTestId(testIds.dotai.answerMarkdown);
    await expect(answer).toBeVisible({ timeout: 30_000 });
    // Whole answer arrived — otherwise "no payload rendered" would pass vacuously.
    await expect(answer).toContainText('INJECTED_ANSWER_START');
    await expect(answer).toContainText('INJECTED_ANSWER_END');

    const { delta, detail } = await probeDelta(probe);
    expect(delta, `payload must have come from the stub. ${detail}`).toBeGreaterThan(0);

    const report = await answer.evaluate((root) => {
      const forbidden = Array.from(
        root.querySelectorAll('script,iframe,object,embed,img,video,audio,source,svg,style,link,form,input')
      ).map((el) => el.tagName.toLowerCase());
      const badAttrs: string[] = [];
      const badUrls: string[] = [];
      for (const el of Array.from(root.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'style' || name === 'src' || name === 'srcset') {
            badAttrs.push(`${el.tagName.toLowerCase()}[${name}]`);
          }
          if (/^\s*(?:javascript|data|vbscript):/i.test(attr.value)) {
            badUrls.push(`${el.tagName.toLowerCase()}[${name}]=${attr.value.slice(0, 40)}`);
          }
        }
      }
      const external = root.querySelector<HTMLAnchorElement>('a[href="https://runbooks.example/crashloop"]');
      return {
        forbidden,
        badAttrs,
        badUrls,
        pwned: (window as unknown as Record<string, unknown>).__pwned ?? null,
        headings: root.querySelectorAll('h2').length,
        listItems: root.querySelectorAll('li').length,
        externalRel: external?.getAttribute('rel') ?? null,
        externalTarget: external?.getAttribute('target') ?? null,
        // Resource timings catch a beacon that fired and then failed DNS.
        beaconResources: performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((name) => name.includes('beacon.evil.invalid')),
      };
    });

    // The measurement first: every request Chromium attempted to the attacker host.
    expect(beaconed, 'the browser must make no request to the attacker host').toEqual([]);
    expect(report.beaconResources, 'no resource timing for the attacker host').toEqual([]);
    expect(report.forbidden, 'no executable or remote-fetching element may survive').toEqual([]);
    expect(report.badAttrs, 'no event-handler/style/src attribute may survive').toEqual([]);
    expect(report.badUrls, 'no executable URL scheme may survive').toEqual([]);
    expect(report.pwned, 'nothing in the answer may execute').toBeNull();

    // The benign half of the same answer still renders, and its link is safe + external.
    expect(report.headings).toBeGreaterThan(0);
    expect(report.listItems).toBeGreaterThan(0);
    expect(report.externalRel).toBe('noopener noreferrer');
    expect(report.externalTarget).toBe('_blank');
  });
});
