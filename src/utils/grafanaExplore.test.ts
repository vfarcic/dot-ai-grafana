import { config } from '@grafana/runtime';
import {
  buildDrilldownLinks,
  dashboardUrl,
  exploreUrl,
  isShowMeOnly,
} from './grafanaExplore';

jest.mock('@grafana/runtime', () => ({
  config: {
    appSubUrl: '',
    apps: { 'grafana-lokiexplore-app': { id: 'grafana-lokiexplore-app' } },
    bootData: { user: { orgId: 1 } },
  },
}));

describe('isShowMeOnly', () => {
  // One test per PRD #3 matching-contract clause (names fail the clause).

  test('clause: lowercase + strip surrounding .?! — SHOW ME LOGS.', () => {
    expect(isShowMeOnly('SHOW ME LOGS.')).toBe(true);
  });

  test('clause: complete phrase only — show me dashboards', () => {
    expect(isShowMeOnly('show me dashboards')).toBe(true);
  });

  test('clause: complete phrase verbs — open the traces / display the metrics', () => {
    expect(isShowMeOnly('open the traces')).toBe(true);
    expect(isShowMeOnly('display the metrics')).toBe(true);
  });

  test('clause: no for-resource tail — show me the logs for pod api-7f', () => {
    // Contract production has no `for <resource>`; must POST (not 0-hop skip).
    expect(isShowMeOnly('show me the logs for pod api-7f')).toBe(false);
  });

  test('clause: diagnosis wins — show me the logs — why is checkout-api crashing?', () => {
    // Interior em-dash/punctuation must survive; why/crash force POST.
    expect(isShowMeOnly('show me the logs — why is checkout-api crashing?')).toBe(false);
  });

  test('clause: diagnosis token analyze', () => {
    expect(isShowMeOnly('analyze the logs')).toBe(false);
  });

  test('clause: no partial-word hits', () => {
    expect(isShowMeOnly('showcase logs')).toBe(false);
    expect(isShowMeOnly('show me the logging')).toBe(false);
    expect(isShowMeOnly('showmen logs')).toBe(false);
  });

  test('pure navigation phrases still match', () => {
    expect(isShowMeOnly('show me the logs')).toBe(true);
    expect(isShowMeOnly('open traces')).toBe(true);
    expect(isShowMeOnly('display alerts')).toBe(true);
  });

  // Former widened-form cases (`for …`) previously expected true; contract rejects them.
  test('widened for-tail no longer skips (was depending on optional for-clause)', () => {
    expect(isShowMeOnly('show me the alerts for checkout')).toBe(false);
    expect(isShowMeOnly('show me metrics for ns/prod')).toBe(false);
    expect(isShowMeOnly('show logs for pod api')).toBe(false);
    expect(isShowMeOnly('list namespaces')).toBe(false);
  });

  test('diagnosis extras still force POST', () => {
    expect(isShowMeOnly('why are there errors for pod api')).toBe(false);
    expect(isShowMeOnly('how do we improve alerts')).toBe(false);
    expect(isShowMeOnly('show failing pods')).toBe(false);
    expect(
      isShowMeOnly('show me the logs for the top issue we need to address in our environment')
    ).toBe(false);
  });

  test('clause: collapse internal whitespace — "show  me   the  logs"', () => {
    expect(isShowMeOnly('show  me   the  logs')).toBe(true);
    expect(isShowMeOnly('  open\tthe   traces  ')).toBe(true);
    expect(isShowMeOnly('display\nthe\nmetrics')).toBe(true);
  });

  test('clause: strip surrounding ? and ! — "show me the logs?" / "open alerts!"', () => {
    expect(isShowMeOnly('show me the logs?')).toBe(true);
    expect(isShowMeOnly('open alerts!')).toBe(true);
    expect(isShowMeOnly('Display The Dashboards?!')).toBe(true);
    // Interior punctuation is not stripped, so this is not the complete phrase.
    expect(isShowMeOnly('show me the logs? and metrics')).toBe(false);
  });
});

describe('exploreUrl / dashboardUrl', () => {
  test('Explore panes include datasource uid and query', () => {
    const href = exploreUrl({
      uid: 'loki-1',
      type: 'loki',
      query: { expr: '{namespace="prod"}', queryType: 'range' },
    });
    expect(href.startsWith('/explore?')).toBe(true);
    expect(href).toContain('schemaVersion=1');
    expect(href).toContain('loki-1');
    expect(href).toContain('namespace');
  });


  test('dashboard is /d/uid', () => {
    expect(dashboardUrl('abc12def')).toBe('/d/abc12def');
  });

  test('appSubUrl prefix is kept on Explore and dashboard URLs', () => {
    const original = config.appSubUrl;
    config.appSubUrl = '/grafana';
    try {
      const href = exploreUrl({
        uid: 'loki-1',
        type: 'loki',
        query: { expr: '{namespace="prod"}', queryType: 'range' },
      });
      expect(href.startsWith('/grafana/explore?')).toBe(true);
      expect(dashboardUrl('abc12def')).toBe('/grafana/d/abc12def');

      const links = buildDrilldownLinks({
        lokiUid: 'loki-1',
        promUid: 'prom-1',
        logql: '{namespace="prod"}',
        promql: 'up',
        tempoSearch: '',
        traceIds: [],
        dashboardUids: ['dashuid1'],
      });
      expect(links.find((l) => l.id === 'explore-logs')?.href.startsWith('/grafana/explore?')).toBe(true);
      expect(links.find((l) => l.id === 'dash-dashuid1')?.href).toBe('/grafana/d/dashuid1');
    } finally {
      config.appSubUrl = original;
    }
  });

  test('trailing slash on appSubUrl is not doubled', () => {
    const original = config.appSubUrl;
    config.appSubUrl = '/grafana/';
    try {
      expect(dashboardUrl('abc12def')).toBe('/grafana/d/abc12def');
    } finally {
      config.appSubUrl = original;
    }
  });
});

describe('buildDrilldownLinks', () => {
  test('Explore plus Logs Drilldown when app is installed', () => {
    const links = buildDrilldownLinks({
      lokiUid: 'loki-1',
      promUid: 'prom-1',
      tempoUid: 'tempo-1',
      logql: '{namespace="prod"}',
      promql: 'up',
      tempoSearch: 'checkout',
      traceIds: ['abcdef123456'],
      dashboardUids: ['dashuid1'],
    });
    const labels = links.map((l) => l.label);
    expect(labels).toContain('Explore logs');
    expect(labels).toContain('Logs Drilldown');
    expect(labels).toContain('Explore metrics');
    expect(labels).not.toContain('Metrics Drilldown');
    expect(labels).toContain('Explore traces');
    expect(labels).toContain('Trace abcdef12');
    expect(labels).toContain('Dashboard dashuid1');
    expect(links.find((l) => l.id === 'dash-dashuid1')?.href).toBe('/d/dashuid1');
  });
});
