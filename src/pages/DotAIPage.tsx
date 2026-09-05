import React, { FormEvent, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import {
  Alert,
  Button,
  Collapse,
  Field,
  Select,
  Spinner,
  TextArea,
  useStyles2,
} from '@grafana/ui';
import { testIds } from '../components/testIds';
import { DotAITool } from '../utils/dotaiApi';
import { ASK_CANCELLED_MESSAGE, askErrorTitle } from '../utils/askErrors';
import { emptyThread, ToolThread } from '../utils/progressiveContext';
import { runAskOrchestrator } from '../utils/askOrchestrator';


const TOOL_OPTIONS: Array<SelectableValue<DotAITool>> = [
  { label: 'Query', value: 'query', description: 'Natural language cluster questions' },
  { label: 'Remediate (analysis only)', value: 'remediate', description: 'AI issue analysis — no execute' },
];

type Threads = Record<DotAITool, ToolThread>;

type DotAIPageProps = {
  showContext?: boolean;
  sendGrafanaEvidence?: boolean;
};

function DotAIPage({ showContext = true, sendGrafanaEvidence = true }: DotAIPageProps) {
  const styles = useStyles2(getStyles);
  const abortRef = useRef<AbortController | null>(null);
  const [tool, setTool] = useState<DotAITool>('query');
  const [intent, setIntent] = useState('');
  const [loading, setLoading] = useState(false);
  const [responseText, setResponseText] = useState('');
  const [currentOpen, setCurrentOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const [threads, setThreads] = useState<Threads>({
    query: emptyThread(),
    remediate: emptyThread(),
  });

  const activeThread = threads[tool];

  const placeholder = useMemo(() => {
    if (tool === 'remediate') {
      return 'Describe the issue (e.g. why is checkout-api CrashLooping in prod?)';
    }
    return 'Ask about cluster resources (e.g. show failing pods in production)';
  }, [tool]);

  const runAsk = async (trimmed: string) => {
    if (!trimmed) {
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const thread = threads[tool];
    setLoading(true);
    setError(undefined);
    setResponseText('');
    try {
      const result = await runAskOrchestrator({
        tool,
        question: trimmed,
        thread,
        signal: ac.signal,
        skipStack: !sendGrafanaEvidence,
      });
      if (ac.signal.aborted) {
        setError(ASK_CANCELLED_MESSAGE);
        return;
      }
      setThreads((prev) => ({
        ...prev,
        [tool]: result.thread,
      }));
      if (result.ok) {
        setResponseText(result.summary);
        setIntent('');
      } else {
        setError(result.errorMessage || 'Request failed');
        if (result.summary) {
          setResponseText(result.summary);
        }
      }
    } catch (e) {
      if (ac.signal.aborted) {
        setError(ASK_CANCELLED_MESSAGE);
        return;
      }
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
      }
      setLoading(false);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (loading) {
      return;
    }
    await runAsk(intent.trim());
  };

  const onCancel = () => {
    abortRef.current?.abort();
  };

  const onRetry = () => {
    void runAsk(intent.trim());
  };

  const onClearThread = () => {
    if (loading) {
      return;
    }
    setThreads((prev) => ({
      ...prev,
      [tool]: emptyThread(),
    }));
    setResponseText('');
    setError(undefined);
  };

  const onAnalyzeThis = () => {
    if (loading) {
      return;
    }
    const queryCurrent = threads.query.current.trim();
    if (!queryCurrent) {
      return;
    }
    // Copy Current into Remediate box; Query History stays; analysis only.
    setTool('remediate');
    setIntent(queryCurrent);
    setError(undefined);
    setResponseText('');
  };

  const onIntentKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits; Shift+Enter keeps the default newline.
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (loading || !intent.trim()) {
      return;
    }
    event.currentTarget.form?.requestSubmit();
  };

  const showAnalyzeThis = tool === 'query' && Boolean(threads.query.current.trim()) && !loading;

  return (
    <PluginPage>
      <div className={styles.wrap} data-testid={testIds.dotai.container}>
        {sendGrafanaEvidence && (
          <Alert
            title="Grafana evidence"
            severity="info"
            data-testid={testIds.dotai.consent}
          >
            Asks send Grafana datasource facts (Loki, Prometheus, Tempo, Alertmanager) to your configured dot-ai server.
          </Alert>
        )}
        {tool === 'remediate' && (
          <Alert title="Analysis only" severity="info">
            Remediate never executes changes. For operate/execute, use the Headlamp plugin.
          </Alert>
        )}
        <form onSubmit={onSubmit} className={styles.form}>
          <Field label="Tool" description="Query cluster resources or request analysis-only remediation guidance.">
            <div data-testid={testIds.dotai.tool}>
              <Select
                options={TOOL_OPTIONS}
                value={TOOL_OPTIONS.find((o) => o.value === tool)}
                onChange={(v) => {
                  if (loading) {
                    return;
                  }
                  setTool((v.value as DotAITool) || 'query');
                  setResponseText('');
                  setError(undefined);
                }}
                inputId="dotai-tool"
                disabled={loading}
              />
            </div>
          </Field>

          <Field
            label={tool === 'remediate' ? 'Issue description' : 'Question'}
            description={
              tool === 'remediate'
                ? 'Analysis only — this plugin never executes changes.'
                : 'Plain-language intent sent to dot-ai query.'
            }
          >
            <TextArea
              data-testid={testIds.dotai.intent}
              value={intent}
              onChange={(e) => setIntent(e.currentTarget.value)}
              onKeyDown={onIntentKeyDown}
              placeholder={placeholder}
              rows={5}
              disabled={loading}
            />
          </Field>

          <div className={styles.actions}>
            <Button type="submit" data-testid={testIds.dotai.submit} disabled={loading || !intent.trim()}>
              {loading ? 'Running…' : tool === 'remediate' ? 'Analyze' : 'Ask'}
            </Button>
            {loading && (
              <Button type="button" variant="secondary" data-testid={testIds.dotai.cancel} onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              data-testid={testIds.dotai.clearThread}
              disabled={loading}
              onClick={onClearThread}
            >
              Clear thread
            </Button>
            {showAnalyzeThis && (
              <Button
                type="button"
                variant="secondary"
                data-testid={testIds.dotai.analyzeThis}
                disabled={loading}
                onClick={onAnalyzeThis}
              >
                Analyze this
              </Button>
            )}
            {loading && (
              <span className={styles.loading} data-testid={testIds.dotai.loading}>
                <Spinner inline={true} />
                Waiting for dot-ai…
              </span>
            )}
          </div>
        </form>

        {error && (
          <Alert title={askErrorTitle(error)} severity="error" data-testid={testIds.dotai.error} className={styles.block}>
            {error}
            {error !== ASK_CANCELLED_MESSAGE && (
              <div className={styles.actions}>
                <Button type="button" data-testid={testIds.dotai.retry} onClick={onRetry} disabled={loading || !intent.trim()}>
                  Retry
                </Button>
              </div>
            )}
          </Alert>
        )}

        {showContext && (activeThread.map || (activeThread.drilldowns && activeThread.drilldowns.length > 0)) && (
          <div className={styles.context} data-testid={testIds.dotai.map}>
            <h3 className={styles.responseTitle}>Map</h3>
            {activeThread.drilldowns && activeThread.drilldowns.length > 0 && (
              <div className={styles.drilldowns} data-testid={testIds.dotai.drilldown}>
                {activeThread.drilldowns.map((link) => (
                  <a
                    key={link.id}
                    className={styles.drilldownLink}
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
            {activeThread.map && <pre className={styles.pre}>{activeThread.map}</pre>}
          </div>
        )}

        {showContext && activeThread.current && (
          <div className={styles.context} data-testid={testIds.dotai.current}>
            <Collapse
              label="Current (Grafana evidence)"
              collapsible={true}
              isOpen={currentOpen}
              onToggle={() => setCurrentOpen(!currentOpen)}
            >
              <pre className={styles.pre}>{activeThread.current}</pre>
            </Collapse>

          </div>
        )}

        {showContext && activeThread.history.length > 0 && (
          <div className={styles.history} data-testid={testIds.dotai.history}>
            <h3 className={styles.responseTitle}>History</h3>
            <ul className={styles.historyList}>
              {activeThread.history.map((turn, idx) => (
                <li key={`${turn.role}-${idx}`} className={styles.historyItem}>
                  <strong>{turn.role === 'you' ? 'You' : 'Answer'}:</strong> {turn.text}
                </li>
              ))}
            </ul>
          </div>
        )}


        {responseText && (
          <div className={styles.response} data-testid={testIds.dotai.response}>
            <h3 className={styles.responseTitle}>Response</h3>
            <pre className={styles.pre}>{responseText}</pre>
          </div>
        )}
      </div>
    </PluginPage>
  );
}

export default DotAIPage;

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css`
    max-width: 960px;
  `,
  form: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  actions: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(2)};
  `,
  loading: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
  `,
  block: css`
    margin-top: ${theme.spacing(2)};
  `,
  context: css`
    margin-top: ${theme.spacing(2)};
    padding: ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.canvas};
  `,
  history: css`
    margin-top: ${theme.spacing(2)};
    padding: ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
  `,
  historyList: css`
    margin: 0;
    padding-left: ${theme.spacing(2)};
  `,
  historyItem: css`
    margin-bottom: ${theme.spacing(0.5)};
    word-break: break-word;
  `,
  response: css`
    margin-top: ${theme.spacing(2)};
    padding: ${theme.spacing(2)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  responseTitle: css`
    margin: 0 0 ${theme.spacing(1)} 0;
    font-size: ${theme.typography.h5.fontSize};
  `,
  drilldowns: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(1)};
  `,
  drilldownLink: css`
    color: ${theme.colors.text.link};
  `,
  pre: css`
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
