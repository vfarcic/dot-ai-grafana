import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';
import {
  PLUGIN_ID,
  type StubIntent,
  asEnvelope,
  isStableEnvelope,
  resourcePath,
  stubIntents,
} from './byDesignHelpers';

/**
 * Consent by design — no execute/operate surface from this plugin; remediate is
 * analysis-only; the on-page notice discloses what an Ask actually POSTs.
 *
 * The disclosure cases assert the notice against the stub's recorded request
 * bodies (GET /intents), so the copy cannot drift away from the egress it
 * describes — including with "Send Grafana evidence" off, which suppresses the
 * datasource read but not the condensed Prior block.
 *
 * Deferred (see issue #44):
 * - debugLog opt-in default-off (main always writes ask log; gate branch adds the flag)
 */

const adminState = 'playwright/.auth/admin.json';

test.describe('Consent by design — no execute/operate surface', () => {
  test.use({ storageState: adminState });

  test('tools page has no Execute or Operate control', async ({ gotoPage, page }) => {
    await gotoPage('/');
    await expect(page.getByTestId(testIds.dotai.container)).toBeVisible();

    await expect(page.getByRole('button', { name: /execute/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /operate/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /execute/i })).toHaveCount(0);

    // Submit is Ask (query) — never Execute.
    const submit = page.getByTestId(testIds.dotai.submit);
    await expect(submit).toBeVisible();
    await expect(submit).toHaveText(/Ask/i);
  });

  test('Remediate option is labelled analysis-only and shows disclosure', async ({
    gotoPage,
    page,
    selectors,
  }) => {
    const appPage = await gotoPage('/');

    await page.getByTestId(testIds.dotai.tool).click();
    const optionSelector = selectors.components.Select.option;
    const remediateOpt = appPage.getByGrafanaSelector(optionSelector).filter({ hasText: /Remediate/ });
    await expect(remediateOpt).toBeVisible();
    await expect(remediateOpt).toContainText(/analysis/i);
    await remediateOpt.click();

    // Option description and Alert body both match; assert via first match in app root.
    const root = page.getByTestId(testIds.dotai.container);
    await expect(root.getByText(/never executes changes/i).first()).toBeVisible();
    await expect(root.getByText(/Headlamp/i).first()).toBeVisible();

    const submit = page.getByTestId(testIds.dotai.submit);
    await expect(submit).toHaveText(/Analyze/i);
  });

  test('POST remediate with execute flags still returns analysis-only envelope', async ({ request }) => {
    const resp = await request.post(resourcePath('remediate'), {
      data: {
        issue: 'consent check',
        execute: true,
        apply: true,
      },
    });
    const text = await resp.text();
    const json = JSON.parse(text);
    expect(isStableEnvelope(json)).toBeTruthy();
    expect(resp.status(), text).toBe(200);
    const env = asEnvelope(json);
    expect(env.ok).toBe(true);
    expect(String(env.summary || '')).not.toMatch(/STUB_SAW_EXECUTE/i);
  });
});

/**
 * The notice at `testIds.dotai.consent` is the operator's only egress notice in the
 * product — README and prds/ are not shipped to the browser. Both cases below read
 * the rendered notice, then compare it with what the stub actually received.
 */
test.describe('Consent by design — the notice matches what is POSTed', () => {
  test.use({ storageState: adminState });
  // Both cases mutate the app's own jsonData, so they must not interleave.
  test.describe.configure({ mode: 'serial' });

  /** Only the field these cases flip; the rest of jsonData is preserved verbatim. */
  type PluginMeta = { jsonData?: { sendGrafanaEvidence?: boolean } & Record<string, unknown> };

  const token = (label: string) => `consentprobe-${label}-${Math.random().toString(36).slice(2, 8)}`;

  async function setEvidence(request: APIRequestContext, sendGrafanaEvidence: boolean): Promise<void> {
    const settingsUrl = `/api/plugins/${PLUGIN_ID}/settings`;
    const current = await request.get(settingsUrl);
    const currentText = await current.text();
    expect(current.ok(), currentText).toBeTruthy();
    const meta: PluginMeta = JSON.parse(currentText);
    const resp = await request.post(settingsUrl, {
      data: {
        enabled: true,
        pinned: false,
        jsonData: { ...(meta.jsonData ?? {}), sendGrafanaEvidence },
      },
    });
    const respText = await resp.text();
    expect(resp.ok(), respText).toBeTruthy();
  }

  /**
   * Ask twice so the second POST is the one that can carry Prior. Completion is read
   * from the intent box emptying — the page clears it on success, which also re-disables
   * the submit button, so `toBeEnabled` never resolves after a successful Ask.
   */
  async function askTwice(page: Page, first: string, second: string): Promise<void> {
    for (const text of [first, second]) {
      await page.getByTestId(testIds.dotai.intent).fill(text);
      await page.getByTestId(testIds.dotai.submit).click();
      await expect(page.getByTestId(testIds.dotai.response)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId(testIds.dotai.intent)).toHaveValue('', { timeout: 20_000 });
    }
  }

  function followUp(intents: StubIntent[], marker: string): StubIntent {
    const match = intents.filter((entry) => entry.text.includes(marker));
    expect(
      match.length,
      `no recorded intent carried ${marker}; recorded ${intents.length} intents`
    ).toBeGreaterThan(0);
    return match[match.length - 1];
  }

  test('evidence on: the notice names the blocks the follow-up Ask actually sends', async ({
    request,
    gotoPage,
    page,
  }) => {
    await setEvidence(request, true);
    await gotoPage('/');

    const notice = page.getByTestId(testIds.dotai.consent);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Grafana datasource facts read now');
    await expect(notice).toContainText('condensed Prior block of up to 240 characters');
    await expect(notice).toContainText('Full History stays in this browser');

    const first = token('on-first');
    await askTwice(page, `status of pod ${first} in namespace prod`, 'why is it restarting in namespace prod?');

    const intents = await stubIntents();
    // The follow-up POST is the one whose Prior block quotes the first question.
    const packed = followUp(intents, first);
    expect(packed.text, packed.text).toContain('Prior:');
    expect(packed.len).toBeLessThanOrEqual(1000);
    // The notice claims a datasource read happens; the packed body must show one.
    expect(packed.text, packed.text).toContain('Current:');
    // …and History itself is never a block on the wire.
    expect(packed.text).not.toMatch(/^History:/m);
  });

  test('evidence off: the notice still discloses Prior, and Prior still leaves', async ({
    request,
    gotoPage,
    page,
  }) => {
    await setEvidence(request, false);
    await gotoPage('/');

    // The operator who opted out is the one most likely to be surprised, so the
    // notice must still be present and must say the toggle does not cover Prior.
    const notice = page.getByTestId(testIds.dotai.consent);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Send Grafana evidence is off, so Asks read no datasource');
    await expect(notice).toContainText('condensed Prior block of up to 240 characters');
    await expect(notice).toContainText('The toggle does not cover Prior, Current or Map');

    const first = token('off-first');
    await askTwice(page, `status of pod ${first} in namespace prod`, 'why is it restarting in namespace prod?');

    const packed = followUp(await stubIntents(), first);
    // Disclosure and egress agree: no fresh datasource block …
    expect(packed.text, packed.text).not.toContain('Loki last 15m');
    // … but prior-turn question text is on the wire regardless of the toggle.
    expect(packed.text, packed.text).toContain('Prior:');
    expect(packed.len).toBeLessThanOrEqual(1000);
  });

  // Its own step, not a `finally`: a timed-out test has already disposed its request
  // context, and a restore that cannot run leaves the app off for every later spec.
  test('the evidence toggle is left back at its default', async ({ request }) => {
    await setEvidence(request, true);
    const resp = await request.get(`/api/plugins/${PLUGIN_ID}/settings`);
    const text = await resp.text();
    expect(resp.ok(), text).toBeTruthy();
    const meta: PluginMeta = JSON.parse(text);
    expect(meta.jsonData?.sendGrafanaEvidence).toBe(true);
  });
});
