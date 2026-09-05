import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { of } from 'rxjs';
import AppConfig, { AppConfigProps } from './AppConfig';
import { testIds } from 'components/testIds';

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: jest.fn(),
}));

const mockGetBackendSrv = getBackendSrv as jest.MockedFunction<typeof getBackendSrv>;

type LocationImpl = { reload: () => void };

let restoreLocationStub: (() => void) | null = null;

/**
 * `AppConfig` reloads the page after a successful save, so these tests need `window.location.reload`
 * to be observable. How that is possible depends on the jsdom version:
 *
 * - jsdom <= 21 (jest-environment-jsdom 29): `window.location` is a configurable accessor, so the
 *   whole object can be replaced. It must be replaced with `configurable: true`, otherwise the next
 *   test to stub it fails with `TypeError: Cannot redefine property: location`.
 * - jsdom >= 22 (jest-environment-jsdom 30): `Location` is implemented with WebIDL
 *   [LegacyUnforgeable] members. `window.location` is a non-configurable accessor and
 *   `location.reload` is a non-writable own property, so `Object.defineProperty(window, 'location')`
 *   throws `Cannot redefine property: location` and `jest.spyOn(window.location, 'reload')` throws
 *   `Cannot assign to read only property 'reload'`. The wrapper delegates to a jsdom implementation
 *   object, which is writable, so the stub goes there instead.
 *
 * Either way the stub is undone after every test so it cannot leak into another suite.
 */
function stubLocationReload(): jest.Mock {
  const reloadMock = jest.fn();
  const descriptor = Object.getOwnPropertyDescriptor(window, 'location');

  if (descriptor?.configurable) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { reload: reloadMock },
    });
    restoreLocationStub = () => {
      Object.defineProperty(window, 'location', descriptor);
    };
    return reloadMock;
  }

  const implSymbol = Object.getOwnPropertySymbols(window.location).find((symbol) => String(symbol) === 'Symbol(impl)');
  if (!implSymbol) {
    throw new Error('Cannot stub window.location.reload: window.location is unforgeable and exposes no jsdom impl');
  }

  const impl = (window.location as unknown as Record<symbol, LocationImpl>)[implSymbol];
  // Own property shadowing `LocationImpl.prototype.reload`; deleting it restores the real one.
  impl.reload = reloadMock;
  restoreLocationStub = () => {
    delete (impl as Partial<LocationImpl>).reload;
  };
  return reloadMock;
}

function restoreLocation(): void {
  restoreLocationStub?.();
  restoreLocationStub = null;
}

describe('Components/AppConfig', () => {
  let props: AppConfigProps;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();

    mockFetch = jest.fn();
    mockGetBackendSrv.mockReturnValue({ fetch: mockFetch } as never);

    props = {
      plugin: {
        meta: {
          id: 'sample-app',
          name: 'Sample App',
          type: PluginType.app,
          enabled: true,
          jsonData: {},
        },
      },
      query: {},
    } as unknown as AppConfigProps;
  });

  afterEach(() => {
    restoreLocation();
  });

  test('renders API settings with auth token, URL, save and test connection', () => {
    const plugin = { meta: { ...props.plugin.meta, enabled: false } };

    // @ts-ignore - We don't need to provide `addConfigPage()` and `setChannelSupport()` for these tests
    render(<AppConfig plugin={plugin} query={props.query} />);

    expect(screen.queryByRole('group', { name: /dot-ai api settings/i })).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.appConfig.apiKey)).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.appConfig.apiUrl)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save api settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /test connection/i })).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.appConfig.testConnection)).toBeInTheDocument();
  });

  test('disables test connection until url and token are present', () => {
    const plugin = { meta: { ...props.plugin.meta, enabled: true, jsonData: {} } };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    expect(screen.getByTestId(testIds.appConfig.testConnection)).toBeDisabled();
  });

  test('error status without message shows Connection test failed, not Connection successful', async () => {
    mockFetch.mockReturnValue(of({ data: { status: 'error' } }));

    const plugin = {
      meta: {
        ...props.plugin.meta,
        enabled: true,
        jsonData: { apiUrl: 'http://dot-ai:3456' },
        secureJsonFields: { apiKey: true },
      },
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    fireEvent.click(screen.getByTestId(testIds.appConfig.testConnection));

    const status = await screen.findByTestId(testIds.appConfig.testStatus);
    expect(status).toHaveTextContent('Connection test failed');
    expect(status).not.toHaveTextContent('Connection successful');
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  test('ok status with empty message falls back to Connection successful', async () => {
    mockFetch.mockReturnValue(of({ data: { status: 'ok' } }));

    const plugin = {
      meta: {
        ...props.plugin.meta,
        enabled: true,
        jsonData: { apiUrl: 'http://dot-ai:3456' },
        secureJsonFields: { apiKey: true },
      },
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    fireEvent.click(screen.getByTestId(testIds.appConfig.testConnection));

    const status = await screen.findByTestId(testIds.appConfig.testStatus);
    expect(status).toHaveTextContent('Connection successful');
    expect(screen.getByText('Connection OK')).toBeInTheDocument();
  });

  test('ok status with connected false keeps not-connected wording', async () => {
    mockFetch.mockReturnValue(of({ data: { status: 'ok', connected: false } }));

    const plugin = {
      meta: {
        ...props.plugin.meta,
        enabled: true,
        jsonData: { apiUrl: 'http://dot-ai:3456' },
        secureJsonFields: { apiKey: true },
      },
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    fireEvent.click(screen.getByTestId(testIds.appConfig.testConnection));

    await waitFor(() => {
      expect(screen.getByTestId(testIds.appConfig.testStatus)).toHaveTextContent(
        'dot-ai responded but Kubernetes reports not connected'
      );
    });
  });

  test('submit saves apiUrl and omits secureJsonData when key is already stored', async () => {
    mockFetch.mockReturnValue(of({ data: {} }));
    const reloadMock = stubLocationReload();

    const plugin = {
      meta: {
        ...props.plugin.meta,
        id: 'sample-app',
        enabled: true,
        pinned: false,
        jsonData: { apiUrl: 'http://dot-ai:3456' },
        secureJsonFields: { apiKey: true },
      },
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    fireEvent.click(screen.getByTestId(testIds.appConfig.submit));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/api/plugins/sample-app/settings', method: 'POST' })
      );
    });

    const call = mockFetch.mock.calls.find(([opts]) => opts.url === '/api/plugins/sample-app/settings');
    expect(call).toBeDefined();
    expect(call![0].data.jsonData).toEqual({
      apiUrl: 'http://dot-ai:3456',
      debugLog: false,
      showContext: true,
      sendGrafanaEvidence: true,
    });
    expect(call![0].data.secureJsonData).toBeUndefined();

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalled();
    });
  });

  test('submit sends a newly typed auth token as secureJsonData', async () => {
    mockFetch.mockReturnValue(of({ data: {} }));
    const reloadMock = stubLocationReload();

    const plugin = {
      meta: {
        ...props.plugin.meta,
        id: 'sample-app',
        enabled: true,
        pinned: false,
        jsonData: { apiUrl: 'http://dot-ai:3456' },
      },
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    fireEvent.change(screen.getByTestId(testIds.appConfig.apiKey), {
      target: { value: 'new-secret-token' },
    });
    fireEvent.click(screen.getByTestId(testIds.appConfig.submit));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/api/plugins/sample-app/settings', method: 'POST' })
      );
    });

    const call = mockFetch.mock.calls.find(([opts]) => opts.url === '/api/plugins/sample-app/settings');
    expect(call).toBeDefined();
    expect(call![0].data.secureJsonData).toEqual({ apiKey: 'new-secret-token' });

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalled();
    });
  });

  test('submit persists Debug Log on and Show context off', async () => {
    mockFetch.mockReturnValue(of({ data: {} }));
    stubLocationReload();

    const plugin = {
      meta: {
        ...props.plugin.meta,
        id: 'sample-app',
        enabled: true,
        pinned: false,
        jsonData: { apiUrl: 'http://dot-ai:3456' },
        secureJsonFields: { apiKey: true },
      },
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    fireEvent.click(screen.getByTestId(testIds.appConfig.debugLog));
    fireEvent.click(screen.getByTestId(testIds.appConfig.showContext));
    fireEvent.click(screen.getByTestId(testIds.appConfig.submit));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const call = mockFetch.mock.calls.find(([opts]) => opts.url === '/api/plugins/sample-app/settings');
    expect(call).toBeDefined();
    expect(call![0].data.jsonData).toEqual({
      apiUrl: 'http://dot-ai:3456',
      debugLog: true,
      showContext: false,
      sendGrafanaEvidence: true,
    });
  });

  test('submit persists Send Grafana evidence off', async () => {
    mockFetch.mockReturnValue(of({ data: {} }));
    stubLocationReload();

    const plugin = {
      meta: {
        ...props.plugin.meta,
        id: 'sample-app',
        enabled: true,
        pinned: false,
        jsonData: { apiUrl: 'http://dot-ai:3456' },
        secureJsonFields: { apiKey: true },
      },
    };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    fireEvent.click(screen.getByTestId(testIds.appConfig.sendGrafanaEvidence));
    fireEvent.click(screen.getByTestId(testIds.appConfig.submit));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const call = mockFetch.mock.calls.find(([opts]) => opts.url === '/api/plugins/sample-app/settings');
    expect(call).toBeDefined();
    expect(call![0].data.jsonData).toEqual({
      apiUrl: 'http://dot-ai:3456',
      debugLog: false,
      showContext: true,
      sendGrafanaEvidence: false,
    });
  });

  /**
   * The description under this switch is one of only two places the product tells an
   * operator what leaves the browser. It said "Off = question text only", which stopped
   * being true once prior-turn content was packed: `skipStack` suppresses the datasource
   * read, not Prior, Map or the rewritten Current.
   */
  test('Send Grafana evidence description states what off does NOT cover', () => {
    // @ts-ignore
    render(<AppConfig plugin={props.plugin} query={props.query} />);

    const description = screen
      .getByText(/When on, Query reads Loki\/Prometheus\/Tempo\/Alertmanager/)
      .textContent!;

    expect(description).not.toMatch(/question text only/i);
    expect(description).toMatch(/When off, no datasource is read/);
    expect(description).toMatch(/the session Current summary/);
    expect(description).toMatch(/Map of resource names/);
    expect(description).toMatch(
      /condensed Prior block \(up to 240 chars of earlier questions and answers, where the question side can also carry follow-up instructions this page adds automatically\) are still sent/
    );
  });
});
