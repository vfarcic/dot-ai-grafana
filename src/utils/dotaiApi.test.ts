import { of, throwError } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { ASK_TIMEOUT_MESSAGE, callDotAITool } from './dotaiApi';

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: jest.fn(),
}));

const mockFetch = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  (getBackendSrv as jest.Mock).mockReturnValue({ fetch: mockFetch });
});

describe('callDotAITool', () => {
  test('query POSTs { intent }; remediate POSTs { issue, intent }', async () => {
    mockFetch.mockReturnValue(
      of({
        status: 200,
        data: { ok: true, status: 200, summary: 'fine', error: '' },
      })
    );

    await callDotAITool('query', 'list pods');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/api/plugins/devopstoolkit-dotai-app/resources/query',
        data: { intent: 'list pods' },
      })
    );

    mockFetch.mockClear();
    mockFetch.mockReturnValue(
      of({
        status: 200,
        data: { ok: true, status: 200, summary: 'guidance', error: '' },
      })
    );

    await callDotAITool('remediate', 'CrashLoopBackOff on api');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/api/plugins/devopstoolkit-dotai-app/resources/remediate',
        data: { issue: 'CrashLoopBackOff on api', intent: 'CrashLoopBackOff on api' },
      })
    );
    const remediateData = mockFetch.mock.calls[0][0].data as Record<string, unknown>;
    expect(remediateData).toHaveProperty('issue', 'CrashLoopBackOff on api');
    expect(remediateData).not.toHaveProperty('execute');
    expect(remediateData).not.toHaveProperty('apply');
  });

  test('forwards every ask-log meta field, branch included', async () => {
    mockFetch.mockReturnValue(
      of({ status: 200, data: { ok: true, status: 200, summary: 'ok', error: '' } })
    );

    await callDotAITool('query', 'top issues', {
      hop: 3,
      hops: 3,
      current_empty: false,
      first_hop: 'grafana',
      branch: 'hedge',
    });

    // branch was silently dropped here once: askOrchestrator set it, this whitelist
    // did not forward it, and the ask-log logged branch=undefined on every real Ask.
    expect(mockFetch.mock.calls[0][0].data).toEqual({
      intent: 'top issues',
      hop: 3,
      hops: 3,
      current_empty: false,
      first_hop: 'grafana',
      branch: 'hedge',
    });
  });

  test('drops an unknown branch value instead of forwarding it', async () => {
    mockFetch.mockReturnValue(
      of({ status: 200, data: { ok: true, status: 200, summary: 'ok', error: '' } })
    );

    await callDotAITool('query', 'top issues', {
      branch: 'bogus' as unknown as 'hedge',
    });

    expect(mockFetch.mock.calls[0][0].data).not.toHaveProperty('branch');
  });

  test('maps 200 contract success body to ToolCallResult', async () => {
    mockFetch.mockReturnValue(
      of({
        status: 200,
        data: { ok: true, status: 200, summary: 'cluster healthy', error: '' },
      })
    );

    const result = await callDotAITool('query', 'health');
    expect(result).toEqual({
      ok: true,
      status: 200,
      summary: 'cluster healthy',
      raw: { ok: true, status: 200, summary: 'cluster healthy', error: '' },
      errorMessage: undefined,
    });
  });

  test('maps contract error body (ok false) without envelope probing', async () => {
    mockFetch.mockReturnValue(
      of({
        status: 200,
        data: { ok: false, status: 400, summary: '', error: 'issue is required' },
      })
    );

    const result = await callDotAITool('remediate', '');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.errorMessage).toBe('issue is required');
    expect(result.summary).toBe('');
  });

  test('fetch reject/throw becomes ToolCallResult error (finding 5)', async () => {
    mockFetch.mockReturnValue(throwError(() => new Error('network down')));

    const result = await callDotAITool('query', 'anything');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.summary).toBe('');
    expect(result.errorMessage).toBe('network down');
  });

  test('fetch reject with status/data surfaces message', async () => {
    mockFetch.mockReturnValue(
      throwError(() => ({
        status: 502,
        message: 'Bad Gateway',
        data: { detail: 'upstream' },
      }))
    );

    const result = await callDotAITool('query', 'x');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.errorMessage).toBe('Bad Gateway');
    expect(result.raw).toEqual({ detail: 'upstream' });
  });

  test('client abort maps to Ask cancelled', async () => {
    const abort = new Error('The user aborted a request.');
    abort.name = 'AbortError';
    mockFetch.mockReturnValue(throwError(() => abort));

    const result = await callDotAITool('query', 'long question');
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe('Ask cancelled.');
  });

  test('proxy 502 deadline envelope maps to the 120s plugin-limit message', async () => {
    mockFetch.mockReturnValue(
      of({
        status: 200,
        data: {
          ok: false,
          status: 502,
          summary: '',
          error: 'dot-ai unreachable (502): timeout',
        },
      })
    );

    const result = await callDotAITool('query', 'wide question');
    expect(result.status).toBe(502);
    expect(result.errorMessage).toBe(ASK_TIMEOUT_MESSAGE);
  });

  test('upstream 504 maps to the 120s plugin-limit message', async () => {
    mockFetch.mockReturnValue(throwError(() => ({ status: 504, message: 'Gateway Timeout' })));

    const result = await callDotAITool('remediate', 'slow issue');
    expect(result.errorMessage).toBe(ASK_TIMEOUT_MESSAGE);
  });

  test('a plain 502 keeps its own text (not a timeout)', async () => {
    mockFetch.mockReturnValue(
      of({
        status: 200,
        data: { ok: false, status: 502, summary: '', error: 'dot-ai unreachable (502): connection refused' },
      })
    );

    const result = await callDotAITool('query', 'x');
    expect(result.errorMessage).toBe('dot-ai unreachable (502): connection refused');
  });
});
