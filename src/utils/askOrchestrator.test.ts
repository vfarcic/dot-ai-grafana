import {
  answerConflictsWithCurrent,
  answerHedgesOnCurrent,
  currentEvidenceSources,
  classifyFirstHop,
  isUnscopedQuestion,
  MAX_ASK_HOPS,
  runAskOrchestrator,
} from './askOrchestrator';
import { emptyThread, MAX_INTENT_CHARS } from './progressiveContext';
import { ALERT_CAP, LOG_LINE_CAP, PROM_SERIES_CAP, StackContextResult, TEMPO_TRACE_CAP } from './grafanaStack';
import { ToolCallResult } from './dotaiApi';

function stackResult(overrides: Partial<StackContextResult> = {}): StackContextResult {
  return {
    current:
      overrides.current ??
      'Loki last 15m:\nerror boom\n\nPrometheus last 15m:\npod-a ns/x restarts=3\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
    mapHint: overrides.mapHint ?? 'Loki Loki, Prometheus Prometheus',
    logLines: overrides.logLines ?? ['error boom'],
    promLines: overrides.promLines ?? ['pod-a ns/x restarts=3'],
    tempoLines: overrides.tempoLines ?? [],
    alertLines: overrides.alertLines ?? [],
    currentEmpty: overrides.currentEmpty ?? false,
  };
}

describe('classifyFirstHop', () => {
  test('observability language → grafana', () => {
    expect(classifyFirstHop('what are the top issues')).toBe('grafana');
    expect(classifyFirstHop('show logs for pod api')).toBe('grafana');
    expect(classifyFirstHop('any firing alerts?')).toBe('grafana');
    expect(classifyFirstHop('crashloop metrics')).toBe('grafana');
  });

  test('inventory language → dot-ai', () => {
    expect(classifyFirstHop('list namespaces')).toBe('dot-ai');
    expect(classifyFirstHop('show pods in kube-system')).toBe('dot-ai');
    expect(classifyFirstHop('how many nodes are there')).toBe('dot-ai');
  });

  test('default → grafana', () => {
    expect(classifyFirstHop('why is production unhealthy')).toBe('grafana');
  });
});

describe('isUnscopedQuestion / answerConflictsWithCurrent', () => {
  test('top issues is unscoped; named pod is not', () => {
    expect(isUnscopedQuestion('top issues')).toBe(true);
    expect(isUnscopedQuestion('how healthy is the cluster')).toBe(true);
    expect(isUnscopedQuestion('logs for pod api in namespace prod')).toBe(false);
    expect(isUnscopedQuestion('app=argocd status')).toBe(false);
  });

  test('bogus English pods do not block hop-2 across', () => {
    expect(isUnscopedQuestion('show failing pods in production')).toBe(true);
    expect(isUnscopedQuestion('top issues in the cluster')).toBe(true);
    expect(isUnscopedQuestion('which pods are crashlooping in staging')).toBe(true);
    // Real hyphenated workload — scoped, hop-2 across must not fire for this reason.
    expect(isUnscopedQuestion('why is checkout-api CrashLooping in prod?')).toBe(false);
    expect(isUnscopedQuestion('show logs for pod checkout-api in namespace production')).toBe(false);
  });

  test('denial vs Loki evidence is a conflict', () => {
    const current =
      'Loki last 15m (pod/argocd-application-controller ns/demo-gitops):\ncomparing app state\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts';
    expect(
      answerConflictsWithCurrent(current, "The namespace 'demo-gitops' does not exist in the current cluster.")
    ).toBe(true);
    expect(answerConflictsWithCurrent(current, 'Controller is healthy and reconciling apps.')).toBe(false);
  });

  test('live ask-log hop-1 denials are conflicts (regression: TEST window 20:42:55Z, hops=1)', () => {
    const current =
      'Loki last 15m (pod/argocd-application-controller ns/demo-gitops):\ncomparing app state\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts';

    // Verbatim from the failing ask-log line — neither matched the old literal regex.
    expect(
      answerConflictsWithCurrent(
        current,
        "The pod 'argocd-application-controller-0' in namespace 'demo-gitops' is not available in the current cluster context."
      )
    ).toBe(true);
    expect(
      answerConflictsWithCurrent(
        current,
        'The ArgoCD controller logs shown in the provided Current data (Loki logs) are from a different cluster/context.'
      )
    ).toBe(true);
    expect(
      answerConflictsWithCurrent(current, 'These appear to be from a different cluster.')
    ).toBe(true);

    // "not accessible" is Hop3's hedge marker, NOT a denial — keeping it out of `denies`
    // is what leaves hedgeFollowUp reachable on hop 3.
    expect(
      answerConflictsWithCurrent(
        current,
        'The workload is not accessible via standard kubectl contexts in the accessible cluster APIs.'
      )
    ).toBe(false);
  });

  test('currentEvidenceSources reports only blocks with real lines', () => {
    const current =
      'Loki last 15m:\nboom\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nAlertA firing';
    expect(currentEvidenceSources(current)).toEqual(['Loki', 'Alertmanager']);
    expect(currentEvidenceSources('')).toEqual([]);
  });

  test('soft "not accessible" over real evidence is a hedge, a committed answer is not', () => {
    const current =
      'Loki last 15m (pod/argocd-application-controller ns/demo-gitops):\ncomparing app state\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts';
    const hedge =
      'The argocd-application-controller pod in namespace demo-gitops is not accessible via standard kubectl contexts in the accessible cluster APIs.';

    expect(answerHedgesOnCurrent(current, hedge)).toBe(true);
    expect(answerHedgesOnCurrent(current, 'I cannot confirm the pod is running.')).toBe(true);
    expect(answerHedgesOnCurrent(current, 'Controller is reconciling apps on the host cluster.')).toBe(false);
    // No Current evidence means there is nothing for the answer to hedge against.
    expect(answerHedgesOnCurrent('', hedge)).toBe(false);
  });

  test('quoted upstream "HTTP 404 Not Found" is not a denial of Current', () => {
    const current =
      'Loki last 15m:\nlevel=error msg="trigger reload: 403 Forbidden"\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nKubePodCrashLooping firing';

    // Verbatim shape of the hop-2 top-issues summary that burned hop 3 (TEST window 20:48:49Z).
    const quoted404 =
      'Top Issues Across All Clusters (Host + vClusters)\n1. **Prometheus Remote Write Receiver Disabled** (ONGOING)\n   - Error: "HTTP 404 Not Found" returned by the remote write endpoint\n   - Repeated every few seconds in the last 15m';
    expect(answerConflictsWithCurrent(current, quoted404)).toBe(false);

    // Same token inside a raw log line is also upstream noise, not a denial.
    const logLine =
      'Observed errors:\nlevel=error ts=2026-09-01T20:47:34Z caller=runutil.go:117 msg="received non-200 response: 404 Not Found"';
    expect(answerConflictsWithCurrent(current, logLine)).toBe(false);

    // The guard must not swallow a real denial that happens to sit in the same answer.
    const mixed = `${quoted404}\n\nAlso, the namespace 'demo-gitops' does not exist in this cluster.`;
    expect(answerConflictsWithCurrent(current, mixed)).toBe(true);

    // Captured verbatim from a live top-issues hop-2 answer (bundle 8b792963). A Secret
    // the CLUSTER reports missing is a finding, not the model denying Current — escalating
    // on it would burn hop 3 exactly like the 404 did. `secret`/`configmap` are therefore
    // deliberately NOT k8s subjects for denial purposes; adding them reopens the defect.
    const secretMissing =
      '2. **Renovate Bot Failure** (CreateContainerConfigError, 8 days stuck)\n   - Issue: Secret "github-forgejo-mirror-token-x-demo-devtools-x-vclus-8b98f6efab" not found\n   - Impact: Renovate dependency automation cannot run';
    expect(answerConflictsWithCurrent(current, secretMissing)).toBe(false);
    expect(answerHedgesOnCurrent(current, secretMissing)).toBe(false);

    // F1 (window 21:06:27Z): live answers arrive as ONE newline-free paragraph. Stripping
    // log noise line-granular threw the denial away with it and the conflict hop stopped
    // firing. Stripping must be span-granular, so the denial here still counts.
    const oneParagraph =
      'The namespace \'demo-gitops\' does not exist in the current cluster. However, the Loki logs provided in the Current context show level=info ts=2026-09-01T21:06:30Z msg="GetRepoObjs stats" app-namespace=demo-gitops, so the workload is emitting telemetry from somewhere.';
    expect(answerConflictsWithCurrent(current, oneParagraph)).toBe(true);

    // ...while the same paragraph shape carrying only upstream noise still must not escalate.
    const noisyNoDenial =
      'Prometheus remote write is failing. Observed level=error ts=2026-09-01T20:47:34Z msg="received non-200 response: 404 Not Found" repeatedly in the last 15m.';
    expect(answerConflictsWithCurrent(current, noisyNoDenial)).toBe(false);

    // Denial and log token in the SAME sentence — the exact shape that defeated the line
    // filter, and that a sentence-split fallback would defeat again.
    const sameSentence =
      'The namespace \'demo-gitops\' does not exist even though level=info msg="GetRepoObjs stats" app-namespace=demo-gitops keeps arriving.';
    expect(answerConflictsWithCurrent(current, sameSentence)).toBe(true);

    // Subject only INSIDE the quotes: generic quote-stripping would delete it and fail
    // the adjacency check closed, so quoted spans are left intact on purpose.
    const subjectInQuotes = "The pod 'argocd-application-controller' was not found.";
    expect(answerConflictsWithCurrent(current, subjectInQuotes)).toBe(true);
  });
});

describe('runAskOrchestrator', () => {
  test('top issues triggers stack queries and a second across-clusters hop', async () => {
    const calls: Array<{ tool: string; text: string; meta?: unknown }> = [];
    const fetchStack = jest.fn(async () => stackResult());
    const callTool = jest.fn(async (tool, text, meta): Promise<ToolCallResult> => {
      calls.push({ tool, text, meta });
      return { ok: true, status: 200, summary: 'error boom in pod-a across clusters', raw: {} };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'top issues',
      thread: emptyThread(),
      fetchStack,
      callTool,
    });

    expect(result.ok).toBe(true);
    expect(result.firstHop).toBe('grafana');
    expect(fetchStack).toHaveBeenCalledTimes(1);
    expect(result.hops).toBe(2);
    expect(result.hops).toBeLessThanOrEqual(MAX_ASK_HOPS);
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain('Current:');
    expect(calls[0].text).toContain('Loki last 15m');
    expect(calls[0].text).toContain('error boom');
    expect(calls[0].text).toMatch(/Answer FROM Current/i);
    expect(calls[0].text).not.toMatch(/\bHistory\b/i);
    expect(calls[1].text).toContain('Loki last 15m');
    expect(calls[1].text).toMatch(/across ALL clusters/i);
    expect(calls[0].text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(calls[1].text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(calls[0].meta).toEqual(
      expect.objectContaining({
        hop: 1,
        hops: MAX_ASK_HOPS,
        current_empty: false,
        first_hop: 'grafana',
      })
    );
    expect(calls[1].meta).toEqual(
      expect.objectContaining({
        hop: 2,
        hops: MAX_ASK_HOPS,
        first_hop: 'grafana',
      })
    );
    expect(result.summary).toContain('error boom');
  });

  test('30×145-char Loki dump still packs every hop ≤ 1000', async () => {
    const lokiLines = Array.from({ length: 30 }, (_, i) => `k8s error line ${String(i).padStart(2, '0')} ${'x'.repeat(120)}`);
    const current = [
      'Loki last 15m (pod/checkout-api ns/prod):',
      ...lokiLines,
      '',
      'Prometheus last 15m:',
      'pod/checkout-api ns/prod restarts=12',
      '',
      'Tempo last 15m:',
      'trace abc123',
      '',
      'Alertmanager:',
      'KubePodCrashLooping firing',
    ].join('\n');
    expect(current.length).toBeGreaterThan(MAX_INTENT_CHARS);

    const callTool = jest.fn(async (_t, text): Promise<ToolCallResult> => {
      expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
      return { ok: true, status: 200, summary: 'error boom across clusters', raw: {} };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'top issues in the cluster',
      thread: emptyThread(),
      fetchStack: jest.fn(async () =>
        stackResult({
          current,
          logLines: lokiLines,
          currentEmpty: false,
        })
      ),
      callTool,
    });

    expect(result.ok).toBe(true);
    expect(callTool.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [, text] of callTool.mock.calls) {
      expect((text as string).length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
      expect(text as string).toContain('Loki last 15m');
      expect(text as string).toContain('Question:');
    }
  });

  test.each([
    [
      'not available in the current cluster context',
      "The pod 'argocd-application-controller-0' in namespace 'demo-gitops' is not available in the current cluster context.",
    ],
    [
      'are from a different cluster/context',
      'The ArgoCD controller logs shown in the provided Current data (Loki logs) are from a different cluster/context.',
    ],
  ])(
    'live hop-1 denial (%s) spends hop 2 instead of stopping at hops=1',
    async (_label, hop1Summary) => {
      // Orchestrator-level guard for the TEST FAIL at 20:42:55Z: the predicate being true
      // is not the contract — the contract is that the LOOP takes the second hop.
      const stack = stackResult({
        current:
          'Loki last 15m (pod/argocd-application-controller ns/demo-gitops):\nComparing app state\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
        logLines: ['Comparing app state'],
        promLines: [],
        currentEmpty: false,
      });
      const summaries = [
        hop1Summary,
        'argocd-application-controller in demo-gitops is reconciling on the host cluster per the Loki lines.',
      ];
      let n = 0;
      const callTool = jest.fn(async (_t, text): Promise<ToolCallResult> => {
        const summary = summaries[Math.min(n, summaries.length - 1)];
        n += 1;
        return { ok: true, status: 200, summary, raw: { packed: text } };
      });

      const result = await runAskOrchestrator({
        tool: 'query',
        question: 'show logs for pod argocd-application-controller in namespace demo-gitops',
        thread: emptyThread(),
        fetchStack: jest.fn(async () => stack),
        callTool,
      });

      expect(result.hops).toBe(2);
      expect(callTool).toHaveBeenCalledTimes(2);
      const secondPacked = (callTool.mock.calls[1][1] as string) || '';
      expect(secondPacked).toMatch(/Do NOT deny facts in Current/i);
      expect(secondPacked).toContain('Loki last 15m');
      expect(result.summary).not.toMatch(/not available|from a different cluster/i);
    }
  );

  test('Current vs answer conflict forces hop 2 and keeps Grafana evidence packed', async () => {
    const stack = stackResult({
      current:
        'Loki last 15m (pod/argocd-application-controller ns/demo-gitops):\nComparing app state\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
      logLines: ['Comparing app state'],
      promLines: [],
      currentEmpty: false,
    });
    const fetchStack = jest.fn(async () => stack);
    const summaries = [
      "The namespace 'demo-gitops' does not exist in the current cluster.",
      'Host Grafana Current shows argocd-application-controller logs in demo-gitops; also checked other clusters.',
    ];
    let n = 0;
    const callTool = jest.fn(async (_t, text): Promise<ToolCallResult> => {
      const summary = summaries[Math.min(n, summaries.length - 1)];
      n += 1;
      return { ok: true, status: 200, summary, raw: { packed: text } };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'show logs for pod argocd-application-controller in namespace demo-gitops',
      thread: emptyThread(),
      fetchStack,
      callTool,
    });

    expect(result.ok).toBe(true);
    expect(result.hops).toBe(2);
    expect(callTool).toHaveBeenCalledTimes(2);
    const secondPacked = (callTool.mock.calls[1][1] as string) || '';
    expect(secondPacked).toContain('Loki last 15m');
    expect(secondPacked).toContain('demo-gitops');
    expect(secondPacked).toMatch(/Do NOT deny facts in Current/i);
    expect(secondPacked).toMatch(/Do NOT say the namespace\/pod does not exist/i);
    expect(result.summary).toMatch(/argocd-application-controller|Grafana Current/i);
  });

  test('conflict hop 2 prompt names the Current datasources and target, and forbids denial', async () => {
    const stack = stackResult({
      current:
        'Loki last 15m (pod/argocd-application-controller ns/demo-gitops):\nComparing app state\n\nPrometheus last 15m (pod/argocd-application-controller ns/demo-gitops):\nno metric samples\n\nTempo last 15m (pod/argocd-application-controller ns/demo-gitops):\nno traces\n\nAlertmanager (pod/argocd-application-controller ns/demo-gitops):\nKubePodCrashLooping firing',
      logLines: ['Comparing app state'],
      promLines: [],
      alertLines: ['KubePodCrashLooping firing'],
      currentEmpty: false,
    });
    const summaries = [
      "The namespace 'demo-gitops' does not exist in the current cluster.",
      'Grafana Current shows argocd-application-controller in demo-gitops reconciling; KubePodCrashLooping is firing.',
    ];
    let n = 0;
    const callTool = jest.fn(async (_t, text): Promise<ToolCallResult> => {
      const summary = summaries[Math.min(n, summaries.length - 1)];
      n += 1;
      return { ok: true, status: 200, summary, raw: { packed: text } };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'show logs for pod argocd-application-controller in namespace demo-gitops',
      thread: emptyThread(),
      fetchStack: jest.fn(async () => stack),
      callTool,
    });

    expect(result.hops).toBe(2);
    const secondPacked = (callTool.mock.calls[1][1] as string) || '';

    // The Grafana evidence itself is still packed for hop 2 (Current may be
    // trimmed to the 1000-char intent cap, so assert headers not full Loki lines).
    expect(secondPacked).toContain('Loki last 15m');
    expect(secondPacked).toContain('KubePodCrashLooping firing');
    expect(secondPacked.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(((callTool.mock.calls[0][1] as string) || '').length).toBeLessThanOrEqual(MAX_INTENT_CHARS);

    // The follow-up names only the sources that actually carry data, plus the target.
    expect(secondPacked).toMatch(/live evidence from Loki, Alertmanager for pod\/argocd-application-controller ns\/demo-gitops/i);
    expect(secondPacked).not.toMatch(/evidence from[^\n]*Prometheus/i);

    // Hard denial ban — the soft "solely because" hedge is gone.
    expect(secondPacked).toMatch(/Do NOT deny facts in Current/i);
    expect(secondPacked).toMatch(/does not exist, was not found, is not deployed/i);
    expect(secondPacked).not.toMatch(/solely because/i);

    // A bare namespace-does-not-exist answer is not what the user ends up with.
    expect(result.summary).not.toMatch(/does not exist/i);
    expect(result.summary).toContain('demo-gitops');
  });

  test('hop 2 that still hedges on the conflict forces a third hop', async () => {
    const stack = stackResult({
      current:
        'Loki last 15m (pod/argocd-application-controller ns/demo-gitops):\nComparing app state\n\nPrometheus last 15m (pod/argocd-application-controller ns/demo-gitops):\nno metric samples\n\nTempo last 15m (pod/argocd-application-controller ns/demo-gitops):\nno traces\n\nAlertmanager (pod/argocd-application-controller ns/demo-gitops):\nKubePodCrashLooping firing',
      logLines: ['Comparing app state'],
      promLines: [],
      alertLines: ['KubePodCrashLooping firing'],
      currentEmpty: false,
    });
    const summaries = [
      // hop 1 — hard denial
      "The namespace 'demo-gitops' does not exist in the current cluster.",
      // hop 2 — verbatim shape from the ask-log: stops denying, still refuses to answer
      'The argocd-application-controller pod in namespace demo-gitops is not accessible via standard kubectl contexts in the accessible cluster APIs. However, Current observability evidence confirms this pod is actively running.',
      // hop 3 — commits
      'argocd-application-controller is reconciling ArgoCD applications on the host cluster per Loki; KubePodCrashLooping is firing.',
    ];
    let n = 0;
    const callTool = jest.fn(async (_t, text): Promise<ToolCallResult> => {
      const summary = summaries[Math.min(n, summaries.length - 1)];
      n += 1;
      return { ok: true, status: 200, summary, raw: { packed: text } };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'show logs for pod argocd-application-controller in namespace demo-gitops',
      thread: emptyThread(),
      fetchStack: jest.fn(async () => stack),
      callTool,
    });

    // The hedge is the whole point: a third dot-ai POST must happen, and no fourth.
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(result.hops).toBe(3);
    expect(result.hops).toBeLessThanOrEqual(MAX_ASK_HOPS);

    const thirdPacked = (callTool.mock.calls[2][1] as string) || '';
    expect(thirdPacked).toMatch(/Final follow-up: your previous answer still hedged/i);
    expect(thirdPacked).toMatch(/Do NOT repeat that the pod\/namespace is unreachable/i);
    expect(thirdPacked).toMatch(/live Loki, Alertmanager evidence/i);
    // Hop 3 still carries the Grafana evidence, not just the scolding.
    expect(thirdPacked).toContain('Loki last 15m');

    // The user ends on the committed answer, not the "not accessible" hedge.
    expect(result.summary).not.toMatch(/not accessible/i);
    expect(result.summary).toContain('reconciling');
  });

  test('hop 2 that answers from Current does not spend a third hop', async () => {
    const stack = stackResult({
      current:
        'Loki last 15m (pod/argocd-application-controller ns/demo-gitops):\nComparing app state\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
      logLines: ['Comparing app state'],
      promLines: [],
      currentEmpty: false,
    });
    const summaries = [
      "The namespace 'demo-gitops' does not exist in the current cluster.",
      'Per Loki, argocd-application-controller in demo-gitops is reconciling applications on the host cluster.',
    ];
    let n = 0;
    const callTool = jest.fn(async (_t, text): Promise<ToolCallResult> => {
      const summary = summaries[Math.min(n, summaries.length - 1)];
      n += 1;
      return { ok: true, status: 200, summary, raw: { packed: text } };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'show logs for pod argocd-application-controller in namespace demo-gitops',
      thread: emptyThread(),
      fetchStack: jest.fn(async () => stack),
      callTool,
    });

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.hops).toBe(2);
  });

  test('unscoped hop 2 that only quotes a 404 does not force a third hop', async () => {
    const stack = stackResult({
      current:
        'Loki last 15m:\nlevel=error msg="trigger reload: 403 Forbidden"\n\nPrometheus last 15m:\nremote_write_failures 12\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nKubePodCrashLooping firing',
      logLines: ['level=error msg="trigger reload: 403 Forbidden"'],
      promLines: ['remote_write_failures 12'],
      alertLines: ['KubePodCrashLooping firing'],
      currentEmpty: false,
    });
    const summaries = [
      'Top issues: Prometheus lifecycle reload is failing with 403 Forbidden.',
      // hop 2 quotes an upstream 404 — it denies nothing about a namespace or pod.
      'Top Issues Across All Clusters (Host + vClusters)\n1. Prometheus remote write disabled\n   - Error: "HTTP 404 Not Found" from the remote write endpoint',
    ];
    let n = 0;
    const callTool = jest.fn(async (_t, text): Promise<ToolCallResult> => {
      const summary = summaries[Math.min(n, summaries.length - 1)];
      n += 1;
      return { ok: true, status: 200, summary, raw: { packed: text } };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'top issues',
      thread: emptyThread(),
      fetchStack: jest.fn(async () => stack),
      callTool,
    });

    // hop1 + acrossClusters hop2, then stop. The spare hop stays unspent.
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.hops).toBe(2);
    const packedTexts = callTool.mock.calls.map((c) => (c[1] as string) || '');
    expect(packedTexts.some((t) => /previous answer is REJECTED/i.test(t))).toBe(false);
  });

  test('empty stack refine does not exceed hop cap', async () => {
    const fetchStack = jest
      .fn()
      .mockResolvedValueOnce(
        stackResult({
          current:
            'Loki last 15m:\nno log lines\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
          logLines: [],
          promLines: [],
          currentEmpty: true,
        })
      )
      .mockResolvedValueOnce(
        stackResult({
          logLines: ['OOMKilled'],
          promLines: ['api ns/prod restarts=9'],
          currentEmpty: false,
          current:
            'Loki last 15m (pod/api ns/prod):\nOOMKilled\n\nPrometheus last 15m:\napi ns/prod restarts=9\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
        })
      );

    let n = 0;
    const callTool = jest.fn(async (): Promise<ToolCallResult> => {
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          status: 200,
          summary: 'pod api is failing in namespace prod with restarts',
          raw: {},
        };
      }
      return { ok: true, status: 200, summary: 'OOMKilled on api in prod', raw: {} };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      // named enough to avoid forced unscoped hop-2; empty stack still refines from answer
      question: 'crashloop in production workload api',
      thread: emptyThread(),
      fetchStack,
      callTool,
    });

    expect(result.ok).toBe(true);
    expect(result.hops).toBeLessThanOrEqual(MAX_ASK_HOPS);
    expect(callTool.mock.calls.length).toBeLessThanOrEqual(MAX_ASK_HOPS);
    // unscoped-ish without pod/ns → hop2 across clusters may run before refine; still capped
    expect(result.hops).toBeGreaterThanOrEqual(1);
  });

  test('hop loop hard-stops at MAX_ASK_HOPS', async () => {
    const fetchStack = jest.fn(async () =>
      stackResult({
        current:
          'Loki last 15m (pod/x ns/y):\nline\n\nPrometheus last 15m:\nno metric samples\n\nTempo last 15m:\nno traces\n\nAlertmanager:\nno alerts',
        logLines: ['line'],
        currentEmpty: false,
      })
    );
    const callTool = jest.fn(async (): Promise<ToolCallResult> => ({
      ok: true,
      status: 200,
      summary: "The namespace 'y' does not exist in the current cluster.",
      raw: {},
    }));

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'logs for pod x in namespace y',
      thread: emptyThread(),
      fetchStack,
      callTool,
    });

    expect(result.hops).toBe(MAX_ASK_HOPS);
    expect(callTool).toHaveBeenCalledTimes(MAX_ASK_HOPS);
  });

  test('dot-ai-first inventory skips stack when healthy list', async () => {
    const fetchStack = jest.fn(async () => stackResult());
    const callTool = jest.fn(async (): Promise<ToolCallResult> => ({
      ok: true,
      status: 200,
      summary: 'namespaces: default, kube-system',
      raw: {},
    }));

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'list namespaces',
      thread: emptyThread(),
      fetchStack,
      callTool,
    });

    expect(result.firstHop).toBe('dot-ai');
    expect(result.hops).toBe(1);
    expect(fetchStack).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  test('remediate is single analysis hop', async () => {
    const callTool = jest.fn(async (tool, text, meta): Promise<ToolCallResult> => {
      expect(tool).toBe('remediate');
      expect(meta).toEqual(expect.objectContaining({ hops: 1, first_hop: 'dot-ai' }));
      expect(text).toMatch(/Analysis only/i);
      return { ok: true, status: 200, summary: 'restart deployment', raw: {} };
    });

    const result = await runAskOrchestrator({
      tool: 'remediate',
      question: 'pod crash',
      thread: { current: 'prior current', map: 'ns/x', history: [] },
      callTool,
    });

    expect(result.ok).toBe(true);
    expect(result.hops).toBe(1);
    expect(result.firstHop).toBe('dot-ai');
  });

  test('Grafana stack throw does not fail the Ask; packs failure note', async () => {
    const callTool = jest.fn(async (): Promise<ToolCallResult> => ({
      ok: true,
      status: 200,
      summary: 'pods listed',
      raw: {},
    }));
    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'show failing pods',
      thread: emptyThread(),
      fetchStack: async () => {
        throw new Error('ds.query exploded');
      },
      callTool,
    });
    expect(result.ok).toBe(true);
    expect(result.lastPacked).toMatch(/Grafana stack read failed/);
    expect(result.lastPacked).toMatch(/ds.query exploded/);
    expect(callTool).toHaveBeenCalled();
  });

  test('skipStack true does not fetch Grafana stack for grafana-first question', async () => {
    const fetchStack = jest.fn(async () => stackResult());
    const callTool = jest.fn(async (): Promise<ToolCallResult> => {
      return { ok: true, status: 200, summary: 'pods listed', raw: {} };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'show failing pods',
      thread: emptyThread(),
      fetchStack,
      callTool,
      skipStack: true,
    });

    expect(result.ok).toBe(true);
    expect(fetchStack).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalled();
    expect((callTool.mock.calls[0] as unknown as [string, string])[1]).toContain('show failing pods');
    expect((callTool.mock.calls[0] as unknown as [string, string])[1]).not.toContain('Loki last 15m');
  });

  test('aborted signal returns cancelled without calling the tool', async () => {
    const ac = new AbortController();
    ac.abort();
    const callTool = jest.fn();
    const result = await runAskOrchestrator({
      tool: 'query',
      question: 'show failing pods',
      thread: emptyThread(),
      fetchStack: jest.fn(async () => stackResult()),
      callTool,
      signal: ac.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/cancelled/i);
    expect(callTool).not.toHaveBeenCalled();
  });
});

/**
 * Issue #14 end to end: with Prometheus and Alertmanager both returning data, the
 * packer used to spend the whole 1000-char budget on evidence and cap the question
 * off the tail — on the corrective hops the follow-up instruction went with it.
 */
describe('every hop keeps the operator question (issue #14)', () => {
  const QUESTION = 'why is checkout-api CrashLooping in namespace production-team?';

  /** Loki, Prometheus and Alertmanager all at their grafanaStack caps. */
  function fullStackCurrent(): string {
    const scope = '(pod/checkout-api ns/production-team)';
    return [
      `Loki last 15m ${scope}:`,
      Array.from(
        { length: LOG_LINE_CAP },
        (_, i) => `10:${String(i).padStart(2, '0')}:12.4Z level=error liveness probe failed: 500`
      ).join('\n'),
      '',
      `Prometheus last 15m ${scope}:`,
      Array.from(
        { length: PROM_SERIES_CAP },
        (_, i) => `checkout-api-7d9f8b6c4-x0q${i} ns/production-team restarts=${21 - i}`
      ).join('\n'),
      '',
      `Tempo last 15m ${scope}:`,
      Array.from({ length: TEMPO_TRACE_CAP }, (_, i) => `trace 4bf92f3577b34da${i}`).join('\n'),
      '',
      `Alertmanager ${scope}:`,
      Array.from(
        { length: ALERT_CAP },
        (_, i) => `KubePodCrashLoopBackOff pod=checkout-api-7d9f8b6c4-x0q${i} ns=production-team severity=critical`
      ).join('\n'),
    ].join('\n');
  }

  test('conflict hop still carries the question and the corrective instruction', async () => {
    const current = fullStackCurrent();
    expect(current.length).toBeGreaterThan(MAX_INTENT_CHARS);

    const summaries = [
      "The namespace 'production-team' does not exist in the current cluster.",
      'Grafana Current shows checkout-api in production-team restarting; KubePodCrashLoopBackOff is firing.',
    ];
    let n = 0;
    const callTool = jest.fn(async (_t, text): Promise<ToolCallResult> => {
      const summary = summaries[Math.min(n, summaries.length - 1)];
      n += 1;
      return { ok: true, status: 200, summary, raw: { packed: text } };
    });

    const result = await runAskOrchestrator({
      tool: 'query',
      question: QUESTION,
      thread: emptyThread(),
      fetchStack: jest.fn(async () =>
        stackResult({ current, logLines: ['boom'], alertLines: ['KubePodCrashLoopBackOff'], currentEmpty: false })
      ),
      callTool,
    });

    expect(result.ok).toBe(true);
    expect(result.hops).toBe(2);

    for (const [, text] of callTool.mock.calls) {
      const packed = text as string;
      expect(packed.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
      // Verbatim, and not left dangling behind an ellipsis.
      expect(packed).toContain(QUESTION);
      expect(packed.endsWith('…')).toBe(false);
      // Evidence still gets packed — the question is reserved, not privileged.
      expect(packed).toContain('Loki last 15m');
    }

    // The corrective instruction the conflict hop exists to deliver survives too.
    expect(callTool.mock.calls[1][1] as string).toMatch(/Do NOT deny facts in Current/i);
  });
});
