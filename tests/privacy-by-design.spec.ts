import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import {
  PLUGIN_ID,
  PROVISIONED_API_KEY,
  UPSTREAM_INTERNAL_FIELD,
  UPSTREAM_SECRET_MARKER,
  asEnvelope,
  bodyContainsForbidden,
  isStableEnvelope,
  resourcePath,
} from './byDesignHelpers';

/**
 * Privacy by design — bearer never leaves secure storage; resource responses stay
 * on the stable envelope; bundle does not embed the provisioned token.
 *
 * Shipped on main (these are no longer deferred — #14 / #25 / #43 / #58):
 * - P4 / C1 ask-log default-off: `jsonData.debugLog` gates `appendAskLog`
 *   (`pkg/plugin/resources.go`). Unit: `TestAskLogDisabledByDefault`. No e2e
 *   log-read path exists; this file only pins that the provisioned instance
 *   does not enable the flag.
 * - P5 login+role, never email: unit `TestAskLogUserAttribution`.
 * - P6 body preview strips secrets: unit `TestAskBodyPreviewStripsSecrets`.
 * - P7 Prior block ≤240 inside the 1000-char budget: unit
 *   `src/utils/progressiveContext.test.ts`; e2e pin is the follow-up Ask in
 *   `tests/consent-by-design.spec.ts` (stubIntents path, not a second suite).
 * - #58 transport-error 502 must not leak upstream scheme/host/port: unit
 *   `TestTransportErrorDoesNotLeakUpstreamURL`; e2e pin sits next to R2 in
 *   `tests/reliability-by-design.spec.ts`.
 */

const adminState = 'playwright/.auth/admin.json';

function collectFiles(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectFiles(full, out);
    } else if (st.isFile() && st.size < 5_000_000) {
      out.push(full);
    }
  }
  return out;
}

test.describe('Privacy by design — bearer token isolation', () => {
  test.use({ storageState: adminState });

  test('plugin settings response does not include the provisioned apiKey', async ({ request }) => {
    const resp = await request.get(`/api/plugins/${PLUGIN_ID}/settings`);
    const text = await resp.text();
    expect(resp.ok(), text).toBeTruthy();

    const forbidden = bodyContainsForbidden(text, PROVISIONED_API_KEY, 'Bearer ');
    expect(forbidden, text).toEqual([]);

    // secureJsonFields may flag apiKey as set, but the value must not appear.
    expect(text).not.toContain(PROVISIONED_API_KEY);

    // P4 / C1: provisioned default is off. The write-path (no file when the
    // flag is absent) stays with TestAskLogDisabledByDefault — there is no
    // browser-visible ask-log read surface to e2e without expanding product.
    const settings = JSON.parse(text) as { jsonData?: { debugLog?: boolean } };
    expect(settings.jsonData?.debugLog ?? false).toBe(false);
  });

  test('tool resource responses never echo the bearer token', async ({ request }) => {
    const resp = await request.post(resourcePath('query'), {
      data: { intent: 'privacy check' },
    });
    const text = await resp.text();
    const json = JSON.parse(text);

    expect(isStableEnvelope(json)).toBeTruthy();
    const forbidden = bodyContainsForbidden(
      text,
      PROVISIONED_API_KEY,
      'Bearer ',
      UPSTREAM_SECRET_MARKER,
      UPSTREAM_INTERNAL_FIELD
    );
    expect(forbidden, text).toEqual([]);
    expect(asEnvelope(json).ok).toBe(true);
  });

  test('built frontend bundle does not embed the provisioned apiKey', async () => {
    // CI builds into dist/ before e2e; local runs may use the same tree.
    const roots = ['dist', `dist/${PLUGIN_ID}`];
    const files: string[] = [];
    for (const root of roots) {
      collectFiles(root, files);
    }

    // If dist is missing (dev without build), skip rather than false-green.
    test.skip(files.length === 0, 'dist/ not present — bundle scan requires a frontend build');

    const hits: string[] = [];
    for (const file of files) {
      if (!/\.(js|css|html|map|json)$/i.test(file)) {
        continue;
      }
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (content.includes(PROVISIONED_API_KEY)) {
        hits.push(file);
      }
    }
    expect(hits, `apiKey leaked into bundle files: ${hits.join(', ')}`).toEqual([]);
  });
});

test.describe('Privacy by design — envelope only', () => {
  test.use({ storageState: adminState });

  test('successful query response is only the stable envelope keys', async ({ request }) => {
    const resp = await request.post(resourcePath('query'), {
      data: { intent: 'envelope shape' },
    });
    const json = JSON.parse(await resp.text()) as Record<string, unknown>;
    expect(isStableEnvelope(json)).toBeTruthy();

    const keys = Object.keys(json).sort();
    // Allow only the documented contract keys.
    for (const k of keys) {
      expect(['ok', 'status', 'summary', 'error']).toContain(k);
    }
  });
});
