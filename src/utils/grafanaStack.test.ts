import { of } from 'rxjs';
import { getDataSourceSrv } from '@grafana/runtime';
import {
  buildLogQL,
  CLUSTER_LOGQL,
  fetchStackContext,
  dashboardUidsFromAlertFrames,
  dashboardHintFromUids,
  getDataSourceByType,
  linesFromLokiFrames,
  LOG_LINE_CAP,
  parsePodNamespace,
} from './grafanaStack';
import { buildRequestText, MAX_INTENT_CHARS, mergeMap } from './progressiveContext';

jest.mock('@grafana/runtime', () => ({
  getDataSourceSrv: jest.fn(),
}));

const mockGet = jest.fn();
const mockGetList = jest.fn();

function frameWithLineField(lines: string[]) {
  return {
    fields: [{ name: 'Line', type: 'string', values: lines }],
  };
}

function frameWithValue(labels: Record<string, string>, value: number) {
  return {
    name: labels.pod || 'series',
    fields: [{ name: 'Value', type: 'number', values: [value], labels }],
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockGetList.mockReset();
  (getDataSourceSrv as jest.Mock).mockReturnValue({
    get: mockGet,
    getList: mockGetList,
  });
  mockGetList.mockImplementation((opts?: { type?: string }) => {
    const all = [
      { uid: 'loki-1', name: 'Loki', type: 'loki' },
      { uid: 'prom-1', name: 'Prometheus', type: 'prometheus' },
      { uid: 'tempo-1', name: 'Tempo', type: 'tempo' },
      { uid: 'am-1', name: 'Alertmanager', type: 'alertmanager' },
    ];
    if (opts?.type) {
      return all.filter((s) => s.type === opts.type);
    }
    return all;
  });
});

describe('parsePodNamespace / buildLogQL', () => {
  test('parses pod and namespace', () => {
    expect(parsePodNamespace('logs for pod checkout-api in namespace prod')).toEqual({
      pod: 'checkout-api',
      namespace: 'prod',
    });
    expect(buildLogQL({ pod: 'checkout-api', namespace: 'prod' })).toBe(
      '{namespace="prod",pod=~"checkout-api.*"}'
    );
  });

  test('show logs for pod checkout-api in namespace prod still works', () => {
    expect(parsePodNamespace('show logs for pod checkout-api in namespace prod')).toEqual({
      pod: 'checkout-api',
      namespace: 'prod',
    });
  });

  test('does not invent pods from which/what questions', () => {
    expect(parsePodNamespace('which pods are not ready')).toEqual({});
    expect(parsePodNamespace('what pods exist')).toEqual({});
  });

  test('rejects stopword and non-RFC1123 captures', () => {
    expect(parsePodNamespace('pod are in namespace prod').pod).toBeUndefined();
    expect(parsePodNamespace('pod _bad in namespace prod').pod).toBeUndefined();
    expect(
      parsePodNamespace('show me the logs for the top issue we need to address in our environment')
    ).toEqual({});
  });

  test('English stopwords and in-fallback do not become pod names', () => {
    expect(parsePodNamespace('show failing pods in production')).toEqual({});
    expect(parsePodNamespace('top issues in the cluster')).toEqual({});
    expect(parsePodNamespace('which pods are crashlooping in staging')).toEqual({});
    expect(parsePodNamespace('why is checkout-api CrashLooping in prod?')).toEqual({
      pod: 'checkout-api',
    });
    expect(parsePodNamespace('show logs for pod checkout-api in namespace production')).toEqual({
      pod: 'checkout-api',
      namespace: 'production',
    });
  });

  test('generated LogQL never uses invented pod/ns labels', () => {
    expect(buildLogQL(parsePodNamespace('show failing pods in production'))).toBe(CLUSTER_LOGQL);
    expect(buildLogQL(parsePodNamespace('top issues in the cluster'))).toBe(CLUSTER_LOGQL);
    expect(buildLogQL(parsePodNamespace('which pods are crashlooping in staging'))).toBe(CLUSTER_LOGQL);

    const crashLogQL = buildLogQL(parsePodNamespace('why is checkout-api CrashLooping in prod?'));
    expect(crashLogQL).toBe('{pod=~"checkout-api.*"}');
    expect(crashLogQL).not.toMatch(/CrashLooping/i);
    expect(crashLogQL).not.toMatch(/namespace="prod"/);

    expect(buildLogQL(parsePodNamespace('show logs for pod checkout-api in namespace production'))).toBe(
      '{namespace="production",pod=~"checkout-api.*"}'
    );

    const invented = /pod=~"(in|issues|are|CrashLooping)\.\*"/;
    for (const q of [
      'show failing pods in production',
      'top issues in the cluster',
      'which pods are crashlooping in staging',
      'why is checkout-api CrashLooping in prod?',
      'show logs for pod checkout-api in namespace production',
    ]) {
      expect(buildLogQL(parsePodNamespace(q))).not.toMatch(invented);
      expect(buildLogQL(parsePodNamespace(q))).not.toMatch(/namespace="the"/);
    }
  });

});

describe('linesFromLokiFrames', () => {
  test('caps extracted lines', () => {
    const many = Array.from({ length: 40 }, (_, i) => `log-line-${i}`);
    expect(linesFromLokiFrames([frameWithLineField(many) as never])).toHaveLength(LOG_LINE_CAP);
  });
});

describe('fetchStackContext', () => {
  test('Current includes mocked Loki log lines via ds.query', async () => {
    const lokiLines = ['OOMKilled container', 'Back-off restarting failed container'];
    mockGet.mockImplementation(async (ref: string) => {
      if (ref === 'loki-1' || ref === 'Loki') {
        return {
          query: () => of({ data: [frameWithLineField(lokiLines)] }),
        };
      }
      if (ref === 'prom-1' || ref === 'Prometheus') {
        return {
          query: () =>
            of({
              data: [frameWithValue({ pod: 'checkout-api', namespace: 'prod' }, 12)],
            }),
        };
      }
      if (ref === 'tempo-1' || ref === 'Tempo') {
        return {
          query: () =>
            of({
              data: [{ fields: [{ name: 'traceID', type: 'string', values: ['abc123'] }] }],
            }),
        };
      }
      if (ref === 'am-1' || ref === 'Alertmanager') {
        return {
          query: () =>
            of({
              data: [{ fields: [{ name: 'alertname', type: 'string', values: ['KubePodCrashLooping'] }] }],
            }),
        };
      }
      return { query: () => of({ data: [] }) };
    });

    const result = await fetchStackContext('why is pod checkout-api crashing in namespace prod?');

    expect(mockGetList).toHaveBeenCalled();
    expect(result.logLines).toEqual(lokiLines);
    expect(result.current).toContain('Loki last 15m');
    expect(result.current).toContain('OOMKilled container');
    expect(result.current).toContain('Prometheus last 15m');
    expect(result.current).toContain('restarts=12');
    expect(result.current).toContain('Tempo last 15m');
    expect(result.current).toContain('trace abc123');
    expect(result.current).toContain('Alertmanager');
    expect(result.current).toContain('KubePodCrashLooping');
    expect(result.mapHint).toMatch(/Loki/);
    expect(result.mapHint).toMatch(/Prometheus/);
    expect(result.mapHint).toMatch(/Tempo/);
    expect(result.mapHint).toMatch(/Alertmanager/);
    expect(JSON.stringify(mockGet.mock.calls)).not.toMatch(/P8E80F9AEF21F6940/);
    expect(JSON.stringify(mockGet.mock.calls)).not.toMatch(/datasources\/proxy/);
  });

  test('one-line note when Loki datasource missing', async () => {
    mockGetList.mockImplementation((opts?: { type?: string }) => {
      if (opts?.type === 'loki') {
        return [];
      }
      if (opts?.type === 'prometheus') {
        return [{ uid: 'prom-1', name: 'Prometheus', type: 'prometheus' }];
      }
      return [];
    });
    mockGet.mockImplementation(async (ref: string) => {
      if (ref === 'prom-1') {
        return { query: () => of({ data: [] }) };
      }
      throw new Error('not found');
    });

    const result = await fetchStackContext('pod api in namespace default');
    expect(result.current).toMatch(/Loki datasource missing/);
  });

  test('no pod/ns still calls Loki and Prom with cluster-wide expr', async () => {
    const lokiQuery = jest.fn((_req: { targets: Array<{ expr: string }> }) =>
      of({ data: [frameWithLineField(['error something'])] })
    );
    const promQuery = jest.fn(() =>
      of({
        data: [frameWithValue({ pod: 'x', namespace: 'y' }, 2)],
      })
    );
    mockGet.mockImplementation(async (ref: string) => {
      if (ref === 'loki-1' || ref === 'Loki') {
        return { query: lokiQuery };
      }
      if (ref === 'prom-1' || ref === 'Prometheus') {
        return { query: promQuery };
      }
      return { query: () => of({ data: [] }) };
    });

    const result = await fetchStackContext('how healthy is the cluster?');
    expect(lokiQuery).toHaveBeenCalled();
    expect(promQuery).toHaveBeenCalled();
    expect(result.current).toContain('Loki last 15m');
    expect(result.current).toContain('error something');
    expect(result.currentEmpty).toBe(false);
    const lokiReq = lokiQuery.mock.calls[0][0];
    expect(lokiReq.targets[0].expr).toMatch(/namespace=~/);
  });

  // Dashboards are alert-derived, so the block has three cases and only two are worth
  // budget. Current (700) and Map (400) are fixed, so every char spent here is a char of
  // real evidence the packer sheds. Measured with the 30x77-char dump below and no firing
  // alerts: Current 2523 chars packing to 957 and keeping 8 Loki lines, against 2588
  // chars packing to 943 and keeping 7 when the "(none linked on firing alerts)"
  // placeholder is emitted anyway. The placeholder cost the operator log line 07.
  const lokiDump = Array.from(
    { length: 30 },
    (_, i) => `k8s error line ${String(i).padStart(2, '0')} ${'x'.repeat(60)}`
  );

  function mockStack(alertFields: Array<Record<string, unknown>>) {
    mockGet.mockImplementation(async (ref: string) => {
      if (ref === 'loki-1' || ref === 'Loki') {
        return { query: () => of({ data: [frameWithLineField(lokiDump)] }) };
      }
      if (ref === 'prom-1' || ref === 'Prometheus') {
        return {
          query: () => of({ data: [frameWithValue({ pod: 'checkout-api', namespace: 'prod' }, 12)] }),
        };
      }
      if (ref === 'am-1' || ref === 'Alertmanager') {
        return { query: () => of({ data: alertFields.length > 0 ? [{ fields: alertFields }] : [] }) };
      }
      return { query: () => of({ data: [] }) };
    });
  }

  test('no firing alerts: no Dashboards block, and one more Loki line survives packing', async () => {
    mockStack([]);

    const question = 'top issues in the cluster';
    const result = await fetchStackContext(question);

    expect(result.alertLines).toEqual([]);
    expect(result.current).not.toContain('Dashboards');
    expect(result.mapHint).not.toContain('dashboards');
    expect(result.mapHint).not.toMatch(/,\s*$/);

    const packed = buildRequestText({
      tool: 'query',
      current: result.current,
      map: mergeMap(result.mapHint, question),
      box: question,
    });
    expect(packed.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    // The contract is how much evidence reaches the model at a full Current, not whether
    // a particular header is absent: Loki lines are peeled from the end, so line 07 is
    // the marginal one and the 65 chars the placeholder used to spend are what it cost.
    expect((packed.match(/k8s error line/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(packed).toContain(lokiDump[7]);
    expect(packed).toContain('Question:');
    expect(packed).toContain(question);
  });

  test('alerts firing with no dashboard link: the explicit negative is still emitted', async () => {
    mockStack([{ name: 'alertname', type: 'string', values: ['KubePodCrashLooping'] }]);

    const result = await fetchStackContext('top issues in the cluster');

    expect(result.current).toContain('KubePodCrashLooping');
    // The model can see the alert, so it must be told there is no dashboard to cite
    // rather than left to infer one.
    expect(result.current).toContain('Dashboards (from firing alerts):');
    expect(result.current).toContain('(none linked on firing alerts)');
    expect(result.mapHint).toContain('dashboards: none linked on firing alerts');
  });

  test('alerts firing with dashboard links: the links are named in Current and Map', async () => {
    mockStack([
      {
        name: 'alertname',
        type: 'string',
        values: ['KubePodCrashLooping'],
        labels: { __dashboardUid__: 'abc12def' },
      },
    ]);

    const result = await fetchStackContext('top issues in the cluster');

    expect(result.current).toContain('Dashboards (from firing alerts):');
    expect(result.current).toContain('/d/abc12def');
    expect(result.current).not.toContain('none linked');
    expect(result.mapHint).toContain('dashboards: /d/abc12def');
  });
});

describe('getDataSourceByType selection', () => {
  test('prefers the default datasource over the first listed', async () => {
    mockGetList.mockImplementation(() => [
      { uid: 'loki-a', name: 'Extra Loki', type: 'loki' },
      { uid: 'loki-b', name: 'Team Loki', type: 'loki', isDefault: true },
    ]);
    mockGet.mockImplementation(async () => ({ query: () => of({ data: [] }) }));

    const picked = await getDataSourceByType('loki');
    expect(picked?.settings?.uid).toBe('loki-b');
    expect(mockGet).toHaveBeenCalledWith('loki-b');
  });

  test('falls back to the type-named datasource when none is default', async () => {
    mockGetList.mockImplementation(() => [
      { uid: 'loki-a', name: 'Extra Loki', type: 'loki' },
      { uid: 'loki-b', name: 'Loki', type: 'loki' },
    ]);
    mockGet.mockImplementation(async () => ({ query: () => of({ data: [] }) }));

    const picked = await getDataSourceByType('loki');
    expect(picked?.settings?.uid).toBe('loki-b');
  });

  test('falls back to the first configured when neither default nor named match', async () => {
    mockGetList.mockImplementation(() => [
      { uid: 'loki-a', name: 'Extra Loki', type: 'loki' },
      { uid: 'loki-b', name: 'Other Loki', type: 'loki' },
    ]);
    mockGet.mockImplementation(async () => ({ query: () => of({ data: [] }) }));

    const picked = await getDataSourceByType('loki');
    expect(picked?.settings?.uid).toBe('loki-a');
  });

  test('ignores datasources of another type', async () => {
    mockGetList.mockImplementation(() => [
      { uid: 'prom-1', name: 'Prometheus', type: 'prometheus', isDefault: true },
      { uid: 'loki-a', name: 'Extra Loki', type: 'loki' },
    ]);
    mockGet.mockImplementation(async () => ({ query: () => of({ data: [] }) }));

    const picked = await getDataSourceByType('loki');
    expect(picked?.settings?.uid).toBe('loki-a');
  });
});

describe('dashboardUidsFromAlertFrames', () => {
  test('reads dashboardUid field and labels; ignores junk', () => {
    const uids = dashboardUidsFromAlertFrames([
      {
        fields: [
          { name: 'alertname', type: 'string', values: ['KubePodCrashLooping'] },
          { name: 'dashboardUid', type: 'string', values: ['abc12def'] },
        ],
      } as never,
      {
        fields: [
          {
            name: 'alertname',
            type: 'string',
            values: ['Other'],
            labels: { __dashboardUid__: 'panel-uid-1' },
          },
        ],
      } as never,
      {
        fields: [{ name: 'dashboardUid', type: 'string', values: ['no'] }],
      } as never,
    ]);
    expect(uids).toEqual(['abc12def', 'panel-uid-1']);
    expect(dashboardHintFromUids([])).toBe('');
    expect(dashboardHintFromUids(uids)).toContain('/d/abc12def');
  });
});

