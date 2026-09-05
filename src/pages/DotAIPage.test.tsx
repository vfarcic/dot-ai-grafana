import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DotAIPage from './DotAIPage';
import { testIds } from '../components/testIds';
import { ASK_TIMEOUT_MESSAGE, callDotAITool } from '../utils/dotaiApi';
import { buildRequestText, stablePreamble } from '../utils/progressiveContext';
import { fetchStackContext } from '../utils/grafanaStack';

jest.mock('../utils/dotaiApi', () => ({
  ...jest.requireActual('../utils/dotaiApi'),
  callDotAITool: jest.fn(),
}));

jest.mock('../utils/grafanaStack', () => {
  const actual = jest.requireActual('../utils/grafanaStack');
  return {
    ...actual,
    fetchStackContext: jest.fn(),
  };
});

const mockCallDotAITool = callDotAITool as jest.MockedFunction<typeof callDotAITool>;
const mockFetchStackContext = fetchStackContext as jest.MockedFunction<typeof fetchStackContext>;

const emptyStack = {
  current:
    'Loki last 15m:\nno log lines\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
  mapHint: 'Loki, Prometheus, Tempo, Alertmanager',
  logLines: [] as string[],
  promLines: [] as string[],
  tempoLines: [] as string[],
  alertLines: [] as string[],
  currentEmpty: false,
};


async function selectTool(label: string) {
  const combobox = screen.getByRole('combobox');
  fireEvent.keyDown(combobox, { key: 'ArrowDown', code: 'ArrowDown' });
  const option = await screen.findByText(label);
  fireEvent.click(option);
}

function typeIntent(value: string) {
  fireEvent.change(screen.getByTestId(testIds.dotai.intent), { target: { value } });
}

function clickSubmit() {
  fireEvent.click(screen.getByTestId(testIds.dotai.submit));
}

describe('Pages/DotAIPage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockFetchStackContext.mockResolvedValue({ ...emptyStack });
  });


  test('renders intent field and submit button', () => {
    render(<DotAIPage />);

    expect(screen.getByTestId(testIds.dotai.container)).toBeInTheDocument();
    expect(screen.getByTestId(testIds.dotai.intent)).toBeInTheDocument();
    expect(screen.getByTestId(testIds.dotai.submit)).toBeInTheDocument();
    expect(screen.getByTestId(testIds.dotai.submit)).toBeDisabled();
    expect(screen.getByRole('button', { name: /ask/i })).toBeInTheDocument();
    expect(screen.getByTestId(testIds.dotai.clearThread)).toBeInTheDocument();
  });

  test('can switch tool selection to Remediate (analysis only)', async () => {
    render(<DotAIPage />);

    await selectTool('Remediate (analysis only)');

    expect(screen.getByText(/analysis only — this plugin never executes changes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /analyze$/i })).toBeInTheDocument();
  });

  test('submit calls query with Stable+stack Current and no Prior on first turn', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: '3 pods failing',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('  show failing pods  ');
    clickSubmit();

    // Unscoped observability Ask: hop1 packs Grafana, hop2 searches all clusters.
    await waitFor(() => {
      expect(mockCallDotAITool.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    expect(mockFetchStackContext).toHaveBeenCalledWith('show failing pods');
    const expectedHop1 = buildRequestText({
      tool: 'query',
      current: emptyStack.current,
      map: emptyStack.mapHint,
      box: 'show failing pods',
    });
    expect(mockCallDotAITool).toHaveBeenCalledWith(
      'query',
      expectedHop1,
      expect.objectContaining({ first_hop: 'grafana', hop: 1 }),
      expect.any(AbortSignal)
    );
    const packed = mockCallDotAITool.mock.calls[0][1];
    expect(packed).toContain(stablePreamble('query'));
    expect(packed).toContain('show failing pods');
    expect(packed).toContain('Loki last 15m');
    expect(packed).not.toMatch(/\bHistory\b/i);
    expect(packed).not.toMatch(/^Prior:/m);
    expect(JSON.stringify(mockCallDotAITool.mock.calls[0])).not.toMatch(/\bHistory\b/i);
    const hop2 = mockCallDotAITool.mock.calls[1][1];
    expect(hop2).toContain('Loki last 15m');
    expect(hop2).toMatch(/across ALL clusters/i);
    expect(mockCallDotAITool.mock.calls[1][2]).toEqual(
      expect.objectContaining({ hop: 2, hops: 3, first_hop: 'grafana' })
    );
  });

  test('Query Current includes mocked Grafana stack log lines before callDotAITool', async () => {
    mockFetchStackContext.mockResolvedValue({
      current:
        'Loki last 15m (pod/checkout-api ns/prod):\nOOMKilled container\nBack-off restarting\n\nPrometheus last 15m:\ncheckout-api ns/prod restarts=12\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
      mapHint:
        'Loki Loki, Prometheus Prometheus, Tempo Tempo, Alertmanager Alertmanager, ns/prod, pod/checkout-api',
      logLines: ['OOMKilled container', 'Back-off restarting'],
      promLines: ['checkout-api ns/prod restarts=12'],
      tempoLines: [],
      alertLines: [],
      currentEmpty: false,
    });
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'pod is OOM',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('why is pod checkout-api crashing in namespace prod?');
    clickSubmit();

    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(1);
    });

    expect(mockFetchStackContext).toHaveBeenCalledWith(
      'why is pod checkout-api crashing in namespace prod?'
    );
    const packed = mockCallDotAITool.mock.calls[0][1];
    expect(packed).toContain('Current:');
    expect(packed).toContain('OOMKilled container');
    expect(packed).toContain('Loki last 15m');
    expect(packed).not.toMatch(/\bHistory\b/i);
    expect(packed).not.toMatch(/sessionId/i);
  });


  test('follow-up packs Current and condensed Prior into intent', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'pod checkout-api CrashLooping in namespace prod — restarts due to OOM',
      raw: {},
    });

    render(<DotAIPage />);
    // Named pod/ns keeps hop count at 1 per Ask when there is no Current/answer conflict.
    typeIntent('status of pod checkout-api in namespace prod');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.history)).toBeInTheDocument();
    expect(screen.getByTestId(testIds.dotai.current)).toBeInTheDocument();

    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(1);
    });

    const currentText = screen.getByTestId(testIds.dotai.current).textContent || '';
    typeIntent('why is pod checkout-api restarting in namespace prod?');
    clickSubmit();

    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(2);
    });

    const secondPacked = mockCallDotAITool.mock.calls[1][1];
    expect(secondPacked).toContain('Current:');
    // Each Query turn packs fresh Grafana stack Current plus condensed Prior from recent turns.
    expect(secondPacked).toContain('Loki last 15m');
    expect(secondPacked).toContain('why is pod checkout-api restarting in namespace prod?');
    expect(secondPacked).toMatch(/^Prior:/m);
    expect(secondPacked).toContain('status of pod checkout-api');
    expect(secondPacked).not.toMatch(/\bHistory\b/i);
    // Full History remains on screen; only condensed Prior leaves the browser.
    expect(screen.getByTestId(testIds.dotai.history)).toBeInTheDocument();
    expect(currentText.length).toBeGreaterThan(0);
    expect(mockFetchStackContext).toHaveBeenCalledTimes(2);
  });

  test('success path renders response summary and Current rewrite', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'cluster looks healthy',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('how is the cluster?');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.response)).toHaveTextContent('cluster looks healthy');
    expect(screen.getByTestId(testIds.dotai.current)).toHaveTextContent(/What's true now/i);
    expect(screen.getByTestId(testIds.dotai.history)).toHaveTextContent('You');
    expect(screen.getByTestId(testIds.dotai.history)).toHaveTextContent('cluster looks healthy');
    expect(screen.queryByTestId(testIds.dotai.error)).not.toBeInTheDocument();
  });

  test('ok with empty summary shows fallback text', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: '',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('anything');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.response)).toHaveTextContent(
      'dot-ai returned no summary'
    );
    expect(screen.queryByTestId(testIds.dotai.error)).not.toBeInTheDocument();
  });

  test('error path shows error message without History rewrite; stack Current may remain', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: false,
      status: 500,
      summary: '',
      raw: {},
      errorMessage: 'llm unavailable',
    });

    render(<DotAIPage />);
    typeIntent('why are pods crashing?');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.error)).toHaveTextContent('llm unavailable');
    expect(screen.getByTestId(testIds.dotai.retry)).toBeInTheDocument();
    expect(screen.getByTestId(testIds.dotai.current)).toHaveTextContent(/Loki last 15m/i);
    expect(screen.queryByTestId(testIds.dotai.history)).not.toBeInTheDocument();
  });

  test('timeout error renders the 120s limit line under an Ask timed out title', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: false,
      status: 502,
      summary: '',
      raw: {},
      errorMessage: ASK_TIMEOUT_MESSAGE,
    });

    render(<DotAIPage />);
    typeIntent('summarize every namespace');
    clickSubmit();

    const alert = await screen.findByTestId(testIds.dotai.error);
    expect(alert).toHaveTextContent('Ask stopped at the 120s limit per hop (up to 3 hops); retry or narrow the question.');
    expect(alert).toHaveTextContent('Ask timed out');
  });

  test('HTTP 401 copy uses Authentication failed title and Retry', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: false,
      status: 502,
      summary: '',
      raw: {},
      errorMessage: 'HTTP 401: UNAUTHORIZED',
    });
    render(<DotAIPage />);
    typeIntent('list pods');
    clickSubmit();
    const alert = await screen.findByTestId(testIds.dotai.error);
    expect(alert).toHaveTextContent('Authentication failed');
    expect(screen.getByTestId(testIds.dotai.retry)).toBeInTheDocument();
  });

  test('Cancel aborts an in-flight Ask', async () => {
    mockCallDotAITool.mockImplementation((_tool, _text, _meta, signal?: AbortSignal) => {
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<{
        ok: boolean;
        status: number;
        summary: string;
        raw: unknown;
        errorMessage?: string;
      }>((_resolve, r) => {
        reject = r;
      });
      const fail = () => {
        const err = new Error('Ask cancelled.');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal?.aborted) {
        fail();
      } else {
        signal?.addEventListener('abort', fail);
      }
      return promise;
    });
    render(<DotAIPage />);
    typeIntent('show failing pods');
    clickSubmit();
    fireEvent.click(await screen.findByTestId(testIds.dotai.cancel));
    expect(await screen.findByTestId(testIds.dotai.error)).toHaveTextContent('Ask cancelled');
  });

  test('loading state shows spinner and disables double-submit', async () => {
    let resolve!: (value: {
      ok: boolean;
      status: number;
      summary: string;
      raw: unknown;
    }) => void;
    const promise = new Promise<{
      ok: boolean;
      status: number;
      summary: string;
      raw: unknown;
    }>((r) => {
      resolve = r;
    });

    mockCallDotAITool.mockReturnValue(promise);

    render(<DotAIPage />);
    typeIntent('show nodes');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.loading)).toBeInTheDocument();
    expect(screen.getByTestId(testIds.dotai.submit)).toBeDisabled();
    expect(screen.getByTestId(testIds.dotai.intent)).toBeDisabled();
    // Grafana Select maps disabled→isDisabled; react-select drops combobox role when disabled.
    const toolInput = document.getElementById('dotai-tool') as HTMLInputElement | null;
    expect(toolInput).not.toBeNull();
    expect(toolInput).toBeDisabled();

    // Attempt a second submit while loading — guarded by disabled button + onSubmit loading check
    clickSubmit();
    expect(mockCallDotAITool).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ok: true, status: 200, summary: 'ok', raw: {} });
    });

    await waitFor(() => {
      expect(screen.queryByTestId(testIds.dotai.loading)).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId(testIds.dotai.response)).toHaveTextContent('ok');
    // Re-enabled after load completes
    const toolInputAfter = document.getElementById('dotai-tool') as HTMLInputElement | null;
    expect(toolInputAfter).not.toBeNull();
    expect(toolInputAfter).not.toBeDisabled();
  });

  test('Enter in intent box submits when text is present', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'nodes listed',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('list nodes');

    fireEvent.keyDown(screen.getByTestId(testIds.dotai.intent), {
      key: 'Enter',
      code: 'Enter',
      shiftKey: false,
    });

    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(1);
    });
    expect(mockCallDotAITool.mock.calls[0][0]).toBe('query');
    expect(mockCallDotAITool.mock.calls[0][1]).toContain('list nodes');
  });

  test('Shift+Enter in intent box does not submit', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'should not run',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('partial line');

    fireEvent.keyDown(screen.getByTestId(testIds.dotai.intent), {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
    });

    // Allow any microtasks; submit must not fire
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCallDotAITool).not.toHaveBeenCalled();
  });

  test('Enter does not submit while loading', async () => {
    let resolve!: (value: {
      ok: boolean;
      status: number;
      summary: string;
      raw: unknown;
    }) => void;
    const promise = new Promise<{
      ok: boolean;
      status: number;
      summary: string;
      raw: unknown;
    }>((r) => {
      resolve = r;
    });
    mockCallDotAITool.mockReturnValue(promise);

    render(<DotAIPage />);
    typeIntent('first ask');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.loading)).toBeInTheDocument();

    // Even if keyDown fires, loading guard must block a second call
    fireEvent.keyDown(screen.getByTestId(testIds.dotai.intent), {
      key: 'Enter',
      code: 'Enter',
      shiftKey: false,
    });
    expect(mockCallDotAITool).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ok: true, status: 200, summary: 'done', raw: {} });
    });
    await waitFor(() => {
      expect(screen.queryByTestId(testIds.dotai.loading)).not.toBeInTheDocument();
    });
  });


  test('remediate submit calls analysis-only tool without execute', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'restart deployment suggested',
      raw: {},
    });

    render(<DotAIPage />);
    await selectTool('Remediate (analysis only)');
    typeIntent('checkout-api CrashLooping');
    clickSubmit();

    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(1);
    });

    const expected = buildRequestText({
      tool: 'remediate',
      current: '',
      map: '',
      box: 'checkout-api CrashLooping',
    });
    expect(mockCallDotAITool).toHaveBeenCalledWith(
      'remediate',
      expected,
      expect.objectContaining({ first_hop: 'dot-ai', hops: 1 }),
      expect.any(AbortSignal)
    );
    const [toolArg, issueText] = mockCallDotAITool.mock.calls[0];
    expect(toolArg).toBe('remediate');
    expect(issueText).toContain('checkout-api CrashLooping');
    expect(issueText).toContain(stablePreamble('remediate'));
    expect(issueText).not.toMatch(/execute/i);
    expect(JSON.stringify(mockCallDotAITool.mock.calls[0])).not.toMatch(/execute/i);

    expect(await screen.findByTestId(testIds.dotai.response)).toHaveTextContent(
      'restart deployment suggested'
    );
  });

  test('Analyze this switches to Remediate and fills box from Current', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'pod checkout-api failing in namespace prod',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('inspect checkout-api');
    clickSubmit();

    const analyzeBtn = await screen.findByTestId(testIds.dotai.analyzeThis);
    const currentBefore = (screen.getByTestId(testIds.dotai.current).textContent || '').replace(
      /^Current/,
      ''
    );
    expect(currentBefore.length).toBeGreaterThan(0);

    // Query history is on screen
    expect(screen.getByTestId(testIds.dotai.history)).toHaveTextContent('inspect checkout-api');

    fireEvent.click(analyzeBtn);

    // Switched to remediate
    expect(screen.getByText(/analysis only — this plugin never executes changes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^analyze$/i })).toBeInTheDocument();

    // Box filled from Current
    const box = screen.getByTestId(testIds.dotai.intent) as HTMLTextAreaElement;
    expect(box.value).toContain("What's true now");
    expect(box.value.length).toBeGreaterThan(0);

    // Switch back to Query — History still present (not wiped)
    await selectTool('Query');
    expect(screen.getByTestId(testIds.dotai.history)).toHaveTextContent('inspect checkout-api');
  });

  test('Clear thread resets active tool Current and History only', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'nodes ok',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('list nodes');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.history)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(testIds.dotai.clearThread));

    expect(screen.queryByTestId(testIds.dotai.history)).not.toBeInTheDocument();
    expect(screen.queryByTestId(testIds.dotai.current)).not.toBeInTheDocument();
    expect(screen.queryByTestId(testIds.dotai.response)).not.toBeInTheDocument();
  });

  test('showContext on (default) displays Current after a packed Ask', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'cluster looks healthy',
      raw: {},
    });

    render(<DotAIPage />);
    typeIntent('show failing pods');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.response)).toHaveTextContent('cluster looks healthy');
    expect(screen.getByTestId(testIds.dotai.current)).toBeInTheDocument();
    expect(screen.getByTestId(testIds.dotai.history)).toBeInTheDocument();
    expect(mockCallDotAITool.mock.calls[0][1]).toContain('Loki last 15m');
  });

  test('showContext off hides Current/Map/History but still packs intent', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary: 'cluster looks healthy',
      raw: {},
    });

    render(<DotAIPage showContext={false} />);
    typeIntent('show failing pods');
    clickSubmit();

    expect(await screen.findByTestId(testIds.dotai.response)).toHaveTextContent('cluster looks healthy');
    expect(screen.queryByTestId(testIds.dotai.current)).not.toBeInTheDocument();
    expect(screen.queryByTestId(testIds.dotai.map)).not.toBeInTheDocument();
    expect(screen.queryByTestId(testIds.dotai.history)).not.toBeInTheDocument();
    expect(mockCallDotAITool).toHaveBeenCalled();
    expect(mockCallDotAITool.mock.calls[0][1]).toContain('Loki last 15m');
    expect(mockCallDotAITool.mock.calls[0][1]).toContain('show failing pods');
  });

  test('evidence off: the notice still discloses Prior, and Prior is still POSTed', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary:
        'pod checkout-api in namespace prod logs FATAL password authentication failed for user "billing"',
      raw: {},
    });

    render(<DotAIPage sendGrafanaEvidence={false} />);

    // The operator who opted out of evidence still gets a notice, because prior-turn
    // question and answer text still leaves the browser. The toggle does not cover it.
    const notice = screen.getByTestId(testIds.dotai.consent);
    expect(notice).toHaveTextContent(/Send Grafana evidence is off, so Asks read no datasource/);
    expect(notice).toHaveTextContent(
      /condensed Prior block of up to 240 characters built from your earlier questions and dot-ai’s earlier answers/
    );
    expect(notice).toHaveTextContent(
      /the question side can also carry follow-up instructions this page adds automatically/
    );
    expect(notice).toHaveTextContent(/quote log, metric and alert lines verbatim/);
    expect(notice).toHaveTextContent(/The toggle does not cover Prior, Current or Map/);
    expect(notice).toHaveTextContent(/Full History stays in this browser/);

    typeIntent('status of pod checkout-api in namespace prod');
    clickSubmit();
    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(1);
    });

    typeIntent('why is pod checkout-api restarting in namespace prod?');
    clickSubmit();
    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(2);
    });

    // Measured egress, not inferred: with the toggle off no datasource is read …
    expect(mockFetchStackContext).not.toHaveBeenCalled();
    const packed = mockCallDotAITool.mock.calls[1][1];
    expect(packed).not.toContain('Loki last 15m');
    // … but the prior question, and quoted log text from the prior answer, do leave.
    expect(packed).toMatch(/^Prior:/m);
    expect(packed).toContain('status of pod checkout-api');
    expect(packed).toContain('password authentication failed');
  });

  test('evidence on: the notice names every block the follow-up Ask actually POSTs', async () => {
    mockCallDotAITool.mockResolvedValue({
      ok: true,
      status: 200,
      summary:
        'pod checkout-api in namespace prod logs FATAL password authentication failed for user "billing"',
      raw: {},
    });

    render(<DotAIPage />);
    const notice = screen.getByTestId(testIds.dotai.consent);
    expect(notice).toHaveTextContent(
      /Query Asks that need live data replace Current with Grafana datasource facts read at that moment \(Loki, Prometheus, Tempo, Alertmanager\)/
    );
    expect(notice).toHaveTextContent(/Remediate Asks read no datasource/);
    expect(notice).toHaveTextContent(/the session Current summary and Map of resource names/);
    expect(notice).toHaveTextContent(
      /condensed Prior block of up to 240 characters built from your earlier questions and dot-ai’s earlier answers/
    );
    expect(notice).toHaveTextContent(
      /the question side can also carry follow-up instructions this page adds automatically/
    );
    expect(notice).toHaveTextContent(
      /Answers quote log, metric and alert lines verbatim, so anything credential-shaped in them is sent too/
    );
    expect(notice).toHaveTextContent(/Full History stays in this browser/);

    typeIntent('status of pod checkout-api in namespace prod');
    clickSubmit();
    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(1);
    });

    typeIntent('why is pod checkout-api restarting in namespace prod?');
    clickSubmit();
    await waitFor(() => {
      expect(mockCallDotAITool).toHaveBeenCalledTimes(2);
    });

    const packed = mockCallDotAITool.mock.calls[1][1];
    // Every block the notice names is in the POST body, and nothing it omits is.
    expect(packed).toContain('Loki last 15m');
    expect(packed).toMatch(/^Current:/m);
    expect(packed).toMatch(/^Prior:/m);
    expect(packed).toContain('status of pod checkout-api');
    expect(packed).toContain('password authentication failed');
    expect(packed).not.toMatch(/^History:/m);
  });
});
