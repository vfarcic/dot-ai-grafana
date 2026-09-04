import {
  appendHistory,
  buildRequestText,
  extractResourceHints,
  MAX_CURRENT_CHARS,
  MAX_HISTORY_TURNS,
  MAX_INTENT_CHARS,
  MIN_CURRENT_CHARS,
  mergeMap,
  rewriteCurrent,
  stablePreamble,
} from './progressiveContext';
import { ALERT_CAP, LOG_LINE_CAP, PROM_SERIES_CAP, TEMPO_TRACE_CAP } from './grafanaStack';

/**
 * A stack Current in the exact shape formatCurrent writes, with every block at the
 * real caps from grafanaStack and the line widths factsFromPromFrames /
 * textLinesFromFrames produce on a live cluster. Issue #14 measured the question
 * being dropped on precisely these shapes.
 */
function stackCurrent(opts: { alerts: boolean; traces: boolean; namespace?: string }): string {
  const ns = opts.namespace ?? 'prod';
  const pod = 'checkout-api';
  const scope = `(pod/${pod} ns/${ns})`;
  const logs = Array.from(
    { length: LOG_LINE_CAP },
    (_, i) => `10:${String(i).padStart(2, '0')}:12.4Z level=error liveness probe failed: 500`
  );
  const prom = Array.from(
    { length: PROM_SERIES_CAP },
    (_, i) => `${pod}-7d9f8b6c4-x0q${i} ns/${ns} restarts=${21 - i}`
  );
  const tempo = opts.traces
    ? Array.from({ length: TEMPO_TRACE_CAP }, (_, i) => `trace 4bf92f3577b34da${i}`)
    : ['no traces'];
  const alerts = opts.alerts
    ? Array.from(
        { length: ALERT_CAP },
        (_, i) => `KubePodCrashLoopBackOff pod=${pod}-7d9f8b6c4-x0q${i} ns=${ns} severity=critical`
      )
    : ['no alerts'];

  return [
    `Loki last 15m ${scope}:`,
    logs.join('\n'),
    '',
    `Prometheus last 15m ${scope}:`,
    prom.join('\n'),
    '',
    `Tempo last 15m ${scope}:`,
    tempo.join('\n'),
    '',
    `Alertmanager ${scope}:`,
    alerts.join('\n'),
  ].join('\n');
}

/** 87 chars — the question width issue #14 measured the ladder dropping. */
const OPERATOR_QUESTION =
  'why is checkout-api CrashLooping in production, and which pods are restarting the most?';

describe('progressiveContext', () => {
  test('packed intent contract is 1000 chars', () => {
    expect(MAX_INTENT_CHARS).toBe(1000);
    expect(MAX_CURRENT_CHARS).toBe(700);
  });

  test('stable preamble distinguishes query vs remediate analysis-only', () => {
    expect(stablePreamble('query')).toMatch(/Query/i);
    expect(stablePreamble('query')).toMatch(/no mutations/i);
    expect(stablePreamble('remediate')).toMatch(/Remediate/i);
    expect(stablePreamble('remediate')).toMatch(/Analysis only/i);
    expect(stablePreamble('remediate')).toMatch(/do not apply/i);
  });

  test('buildRequestText sends Stable+Current+Map+box and omits History', () => {
    const text = buildRequestText({
      tool: 'query',
      current: 'pod/checkout-api is CrashLooping',
      map: 'pod/checkout-api, ns/prod',
      box: 'why is it restarting?',
    });

    expect(text).toContain(stablePreamble('query'));
    expect(text).toContain('Current:');
    expect(text).toContain('pod/checkout-api is CrashLooping');
    expect(text).toContain('Map:');
    expect(text).toContain('pod/checkout-api, ns/prod');
    expect(text).toContain('Question:');
    expect(text).toContain('why is it restarting?');
    // History must never appear in the packed POST body text
    expect(text).not.toMatch(/\bHistory\b/i);
    expect(text).not.toMatch(/\bYou:/);
    expect(text).not.toMatch(/\bAnswer:/);
  });

  test('buildRequestText first turn is Stable + Question only', () => {
    const text = buildRequestText({
      tool: 'query',
      current: '',
      map: '',
      box: '  show failing pods  ',
    });
    expect(text).toBe(`${stablePreamble('query')}\n\nQuestion:\nshow failing pods`);
  });

  test('buildRequestText remediate uses Issue label', () => {
    const text = buildRequestText({
      tool: 'remediate',
      current: 'ns/prod checkout failing',
      map: 'ns/prod',
      box: 'analyze crash',
    });
    expect(text).toContain(stablePreamble('remediate'));
    expect(text).toContain('Issue:');
    expect(text).toContain('analyze crash');
    expect(text).not.toMatch(/\bHistory\b/i);
  });

  test('buildRequestText packs huge Current to ≤ MAX_INTENT_CHARS', () => {
    const lokiLines = Array.from({ length: 80 }, (_, i) => `error-line-${i} ${'x'.repeat(40)}`).join('\n');
    const current = [
      'Loki last 15m (pod/checkout-api ns/prod):',
      lokiLines,
      '',
      'Prometheus last 15m:',
      'pod/checkout-api ns/prod restarts=12',
      '',
      'Tempo last 15m:',
      Array.from({ length: 20 }, (_, i) => `trace ${'a'.repeat(32)}${i}`).join('\n'),
      '',
      'Alertmanager:',
      'KubePodCrashLooping firing',
    ].join('\n');
    const map =
      'Loki Loki, Prometheus Prometheus, Tempo Tempo, Alertmanager Alertmanager, pod/checkout-api, ns/prod';

    expect(current.length).toBeGreaterThan(MAX_INTENT_CHARS);

    const text = buildRequestText({
      tool: 'query',
      current,
      map,
      box: 'why is checkout-api crashing?',
    });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(text).toContain('Question:');
    expect(text).toContain('why is checkout-api crashing?');
    // Map dropped first when over budget
    expect(text).not.toContain('\nMap:\n');
  });

  test('buildRequestText drops Tempo before trimming below budget', () => {
    const lokiBody = Array.from({ length: 12 }, (_, i) => `log-${i}-${'y'.repeat(30)}`).join('\n');
    const tempoBody = Array.from({ length: 30 }, (_, i) => `trace-${i}-${'z'.repeat(40)}`).join('\n');
    const current = [
      'Loki last 15m:',
      lokiBody,
      '',
      'Prometheus last 15m:',
      'restarts=1',
      '',
      'Tempo last 15m:',
      tempoBody,
      '',
      'Alertmanager:',
      'no alerts',
    ].join('\n');
    const map = 'x'.repeat(200);

    const text = buildRequestText({
      tool: 'query',
      current,
      map,
      box: 'status?',
    });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(text).not.toMatch(/Tempo last 15m/i);
    expect(text).toContain('Loki last 15m');
    expect(text).toContain('Prometheus last 15m');
  });

  test('buildRequestText trims Loki lines after Map and Tempo are dropped', () => {
    const lokiBody = Array.from({ length: 40 }, (_, i) => `error-line-${i} ${'w'.repeat(80)}`).join('\n');
    const current = [
      'Loki last 15m:',
      lokiBody,
      '',
      'Prometheus last 15m:',
      'restarts=3',
      '',
      'Tempo last 15m:',
      Array.from({ length: 10 }, (_, i) => `trace-${i}-${'z'.repeat(40)}`).join('\n'),
      '',
      'Alertmanager:',
      'firing',
    ].join('\n');

    const text = buildRequestText({
      tool: 'query',
      current,
      map: 'm'.repeat(400),
      box: 'why are pods crashing?',
    });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(text).not.toContain('\nMap:\n');
    expect(text).not.toMatch(/Tempo last 15m/i);
    expect(text).toContain('Loki last 15m');
    expect(text).toContain('Question:');
    expect(text).toContain('why are pods crashing?');
  });

  test('MAX_CURRENT_CHARS cannot overflow packed intent alone', () => {
    const hugeAnswer = 'fact '.repeat(500);
    const current = rewriteCurrent('', 'q', hugeAnswer);
    expect(current.length).toBeLessThanOrEqual(MAX_CURRENT_CHARS);
    const packed = buildRequestText({
      tool: 'query',
      current,
      map: 'm'.repeat(MAX_CURRENT_CHARS),
      box: 'follow up on the crash',
    });
    expect(packed.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
  });

  test('rewriteCurrent replaces with capped block including resources and next', () => {
    const current = rewriteCurrent(
      '',
      'show pod checkout-api in production namespace',
      'pod checkout-api is CrashLooping in namespace production. Restart count 12.'
    );
    expect(current).toMatch(/Asked:/);
    expect(current).toMatch(/What's true now:/);
    expect(current).toMatch(/Next:/);
    expect(current.length).toBeLessThanOrEqual(MAX_CURRENT_CHARS);
  });

  test('appendHistory caps display turns at MAX_HISTORY_TURNS', () => {
    let history = appendHistory([], 'q1', 'a1');
    history = appendHistory(history, 'q2', 'a2');
    history = appendHistory(history, 'q3', 'a3');
    // 3 pairs = 6 turns → sliced to last 5
    expect(history).toHaveLength(MAX_HISTORY_TURNS);
    expect(history[0].role).toBe('answer'); // oldest you dropped
    expect(history[history.length - 1]).toEqual({ role: 'answer', text: 'a3' });
  });

  test('mergeMap keeps short names only', () => {
    const map = mergeMap('', 'pod foo-bar in prod namespace is down', 'namespace: kube-system');
    expect(map.length).toBeLessThanOrEqual(400);
    expect(map.length).toBeGreaterThan(0);
  });

  test('extractResourceHints ignores filler words around "in"', () => {
    const hints = extractResourceHints('All 14 namespaces are in Active status');
    expect(hints).not.toContain('are@Active');
    expect(hints).not.toMatch(/\bare@/);
  });

  test('extractResourceHints still keeps real "name in namespace" pairs', () => {
    const hints = extractResourceHints('checkout-api in production is degraded');
    expect(hints).toContain('checkout-api@production');
  });
});

/**
 * Issue #14: the shedding ladder paid for datasource overflow by deleting the
 * operator's question. Stage 3 only peeled Loki, so Prometheus and Alertmanager
 * lines were never shed, and stage 4 capped the packed string — whose tail is the
 * question. Every case below dropped or truncated the question before the fix.
 */
describe('buildRequestText reserves the question (issue #14)', () => {
  const rows: Array<{ name: string; alerts: boolean; traces: boolean; namespace?: string }> = [
    { name: 'no alerts, no traces', alerts: false, traces: false },
    { name: 'alerts firing, no traces', alerts: true, traces: false },
    { name: 'alerts + traces', alerts: true, traces: true },
    { name: 'alerts + traces, long namespace', alerts: true, traces: true, namespace: 'production-team' },
  ];

  test.each(rows)('question survives a full stack Current: $name', (row) => {
    const current = stackCurrent(row);
    expect(current.length).toBeGreaterThan(MAX_INTENT_CHARS);

    const text = buildRequestText({
      tool: 'query',
      current,
      map: 'pod/checkout-api, ns/prod',
      box: OPERATOR_QUESTION,
    });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(text).toContain('Question:');
    // Verbatim, not merely present: the old stage-4 cap ate the question's tail.
    expect(text).toContain(OPERATOR_QUESTION);
    expect(text.endsWith(OPERATOR_QUESTION)).toBe(true);
    // The budget still buys real evidence, not just the question.
    expect(text).toContain('Loki last 15m');
  });

  test('remediate packs the same way: the Issue text is never shed', () => {
    const text = buildRequestText({
      tool: 'remediate',
      current: stackCurrent({ alerts: true, traces: true }),
      map: 'pod/checkout-api, ns/prod',
      box: OPERATOR_QUESTION,
    });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(text).toContain('Issue:');
    expect(text.endsWith(OPERATOR_QUESTION)).toBe(true);
  });

  test('Prometheus series are shed once Loki is exhausted', () => {
    // Loki holds a single line, so peeling it frees almost nothing; the overflow
    // has to come out of the 8 Prometheus series instead.
    const promLines = Array.from(
      { length: PROM_SERIES_CAP },
      (_, i) => `checkout-api-7d9f8b6c4-x0q${i} ns/production-platform-team restarts=${'9'.repeat(60)}`
    );
    const current = [
      'Loki last 15m (ns/production-platform-team):',
      'one surviving log line',
      '',
      'Prometheus last 15m (ns/production-platform-team):',
      promLines.join('\n'),
      '',
      'Alertmanager (ns/production-platform-team):',
      'no alerts',
    ].join('\n');

    const text = buildRequestText({ tool: 'query', current, map: '', box: OPERATOR_QUESTION });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(text.endsWith(OPERATOR_QUESTION)).toBe(true);
    expect(text).toContain('Prometheus last 15m');
    // Highest-ranked series kept, lowest-ranked tail shed.
    expect(text).toContain(promLines[0]);
    expect(text).not.toContain(promLines[PROM_SERIES_CAP - 1]);
  });

  test('Alertmanager lines are shed once Loki and Prometheus are exhausted', () => {
    const alertLines = Array.from(
      { length: ALERT_CAP },
      (_, i) => `KubePodCrashLoopBackOff-${i} ${'label=value '.repeat(8)}firing`
    );
    const current = [
      'Loki last 15m (ns/prod):',
      'no log lines',
      '',
      'Prometheus last 15m (ns/prod):',
      'no metric samples',
      '',
      'Alertmanager (ns/prod):',
      alertLines.join('\n'),
    ].join('\n');

    const text = buildRequestText({ tool: 'query', current, map: '', box: OPERATOR_QUESTION });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(text.endsWith(OPERATOR_QUESTION)).toBe(true);
    expect(text).toContain('Alertmanager');
    expect(text).toContain(alertLines[0]);
    expect(text).not.toContain(alertLines[ALERT_CAP - 1]);
  });

  test('the packed string never ends in a truncated question', () => {
    for (const row of rows) {
      const text = buildRequestText({
        tool: 'query',
        current: stackCurrent(row),
        map: 'm'.repeat(400),
        box: OPERATOR_QUESTION,
      });
      // The stage-4 cap left an ellipsis where the question's tail had been.
      expect(text.endsWith('…')).toBe(false);
      expect(text).toContain(OPERATOR_QUESTION);
    }
  });

  test('follow-up instructions shed from the tail, question and evidence floor stay', () => {
    const instructions = [
      'Follow-up: your previous answer is REJECTED — it denied a fact that Grafana Current already proves.',
      'Grafana Current above holds live evidence from Loki, Prometheus, Alertmanager, read from this Grafana host in the last 15m.',
      'Do NOT deny facts in Current. Do NOT say the namespace/pod does not exist, was not found, is not deployed, or belongs to a different cluster.',
      'The kube context you query is one cluster among several; absence there is not absence.',
      'Answer the original question FROM the Current evidence: quote the concrete Loki/Prometheus/Tempo/Alertmanager lines.',
    ];

    const text = buildRequestText({
      tool: 'query',
      current: stackCurrent({ alerts: true, traces: true }),
      map: 'pod/checkout-api, ns/prod',
      box: OPERATOR_QUESTION,
      instructions,
    });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    // Element 0 of the old array — the user's own question — is never shed.
    expect(text).toContain(OPERATOR_QUESTION);
    // The highest-priority directive survives; the tail yields to the evidence floor.
    expect(text).toContain(instructions[0]);
    expect(text).not.toContain(instructions[instructions.length - 1]);
    // Instructions yield to the Current floor rather than starving the evidence
    // the very same instructions tell the model to quote. The floor is a guarantee
    // of ROOM: the ladder peels whole lines, so what it packs lands under the room
    // it was handed, and used + slack is what has to clear the floor.
    const currentBlock = /\nCurrent:\n([\s\S]*?)\n\nQuestion:/.exec(text)?.[1] ?? '';
    const room = currentBlock.length + (MAX_INTENT_CHARS - text.length);
    expect(room).toBeGreaterThanOrEqual(MIN_CURRENT_CHARS);
    // Not just headers and ellipses: the ladder keeps the top alert — its last and
    // highest-value evidence — so the instruction to quote Current has something to quote.
    expect(currentBlock).toMatch(/KubePodCrashLoopBackOff pod=checkout-api-7d9f8b6c4-x0q0/);
  });

  test('a question that alone exceeds the budget is capped explicitly, not by the tail', () => {
    const huge = `why is ${'checkout-api '.repeat(120)}crashing?`;
    const text = buildRequestText({
      tool: 'query',
      current: stackCurrent({ alerts: true, traces: true }),
      map: 'ns/prod',
      box: huge,
    });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    // Evidence went first: nothing but user input is left to cut.
    expect(text).not.toContain('Current:');
    expect(text).toContain('Question:');
    expect(text).toContain('why is checkout-api');
  });

  test('capping never splits a surrogate pair', () => {
    // "Question:" pack overhead, so the cut can be aimed at an exact box offset.
    const overhead = stablePreamble('query').length + '\n\nQuestion:\n'.length;
    const cut = MAX_INTENT_CHARS - overhead - 1;
    // 🚀 starts one char before the cut: a raw code-unit slice halves the pair.
    const box = `${'a'.repeat(cut - 1)}🚀${'b'.repeat(MAX_INTENT_CHARS)}`;

    const text = buildRequestText({ tool: 'query', current: '', map: '', box });

    expect(text.length).toBeLessThanOrEqual(MAX_INTENT_CHARS);
    expect(text).not.toContain('\ud83d');
    expect([...text].every((ch) => ch.codePointAt(0) !== 0xfffd)).toBe(true);
  });
});
