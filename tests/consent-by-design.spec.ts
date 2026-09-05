import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';
import {
  asEnvelope,
  isStableEnvelope,
  PLUGIN_ID,
  resourcePath,
} from './byDesignHelpers';

/**
 * Consent by design — no execute/operate surface from this plugin; remediate is
 * analysis-only; UI discloses that fact.
 *
 * Deferred (see issue #44):
 * - debugLog opt-in default-off (main always writes ask log; gate branch adds the flag)
 * - Show-context row matching POSTed progressive context (needs #14/#43 UI)
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

  /**
   * Consent runs both ways: with "Send Grafana evidence" off the plugin must not
   * read a datasource — and must not then claim it did. A show-me navigation Ask
   * has nothing to point at in that configuration, so it reports the disabled
   * setting instead of an empty success with Map links that were never built.
   *
   * Zero-dial is measured at the plugin resource route (page.route counter): with
   * evidence off the 0-hop path must not consult dot-ai either, so the operator
   * gets a truthful failure rather than a fabricated navigation answer.
   */
  test('evidence off: a show-me Ask reports the disabled setting, not an empty success', async ({
    gotoPage,
    page,
  }) => {
    const settingsUrl = `/api/plugins/${PLUGIN_ID}/settings`;
    const before = await page.request.get(settingsUrl);
    expect(before.ok(), await before.text()).toBeTruthy();
    const meta = await before.json();
    const jsonData = (meta.jsonData ?? {}) as Record<string, unknown>;
    const pluginState = { enabled: meta.enabled !== false, pinned: Boolean(meta.pinned) };

    let toolCalls = 0;
    await page.route(new RegExp(resourcePath('query')), async (route) => {
      toolCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, status: 200, summary: 'must not be reached', error: '' }),
      });
    });

    await page.request.post(settingsUrl, {
      data: { ...pluginState, jsonData: { ...jsonData, sendGrafanaEvidence: false } },
    });

    try {
      await gotoPage('/');
      // Toggle took effect: the evidence-consent disclosure is gone.
      await expect(page.getByTestId(testIds.dotai.container)).toBeVisible();
      await expect(page.getByTestId(testIds.dotai.consent)).toHaveCount(0);

      await page.getByTestId(testIds.dotai.intent).fill('show me the logs');
      const submit = page.getByTestId(testIds.dotai.submit);
      await expect(submit).toBeEnabled();
      await submit.click();

      const error = page.getByTestId(testIds.dotai.error);
      await expect(error).toBeVisible({ timeout: 10_000 });
      await expect(error).toContainText(/Send Grafana evidence/i);

      // No success surface: no answer, no Map links, no Current.
      await expect(page.getByTestId(testIds.dotai.response)).toHaveCount(0);
      await expect(page.getByTestId(testIds.dotai.drilldown)).toHaveCount(0);
      await expect(page.getByTestId(testIds.dotai.current)).toHaveCount(0);
      expect(toolCalls).toBe(0);
    } finally {
      // Restore the provisioned setting for every other spec in the run.
      await page.request.post(settingsUrl, { data: { ...pluginState, jsonData } });
    }
  });
});
