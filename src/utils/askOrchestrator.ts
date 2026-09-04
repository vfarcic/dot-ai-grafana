import { AskBranch, callDotAITool, DotAITool, ToolCallResult } from './dotaiApi';
import { ASK_CANCELLED_MESSAGE } from './askErrors';
import {
  appendHistory,
  buildRequestText,
  mergeMap,
  rewriteCurrent,
  ToolThread,
} from './progressiveContext';
import {
  fetchStackContext,
  parsePodNamespace,
  PodNamespaceTarget,
  StackContextResult,
} from './grafanaStack';

/** Max dot-ai POSTs per user Ask (ask-log lines). Grafana DS reads do not count. */
export const MAX_ASK_HOPS = 3;

export type FirstHop = 'grafana' | 'dot-ai';

/** Re-exported so callers get the branch union from the orchestrator's own surface. */
export type { AskBranch };

export type AskMeta = {
  hop: number;
  hops: number;
  current_empty: boolean;
  first_hop: FirstHop;
  branch: AskBranch;
};

export type OrchestratorResult = {
  ok: boolean;
  summary: string;
  errorMessage?: string;
  thread: ToolThread;
  firstHop: FirstHop;
  hops: number;
  currentEmpty: boolean;
  lastPacked?: string;
};

/**
 * First hop from the question:
 * - alerts / logs / metrics / traces / top issues → Grafana
 * - live K8s inventory (list namespaces/pods/…) → dot-ai
 * - default → Grafana (combination ownership)
 */
export function classifyFirstHop(question: string): FirstHop {
  const q = question.toLowerCase().replace(/\s+/g, ' ').trim();

  // Observability / problem language wins even when phrased as list/show.
  if (
    /\b(top issues?|alerts?|alertmanager|firing|logs?|logql|metrics?|promql|prometheus|traces?|tempo|loki|oom|crashloop|crash|failing|failed|failure|latency|error rate|slo|sli|restarts?)\b/.test(
      q
    )
  ) {
    return 'grafana';
  }

  if (
    /\b(list|show|what|which|how many)\b[\s\S]{0,40}\b(namespaces?|pods?|deployments?|services?|nodes?|statefulsets?|daemonsets?|jobs?|cronjobs?|ingresses?|configmaps?|secrets?)\b/.test(
      q
    ) ||
    /\b(namespaces?|pods?)\b[\s\S]{0,20}\b(are there|exist|available)\b/.test(q)
  ) {
    return 'dot-ai';
  }

  return 'grafana';
}

/** True when the question names no pod, namespace, or app — search everywhere. */
export function isUnscopedQuestion(question: string): boolean {
  const target = parsePodNamespace(question);
  if (target.pod || target.namespace) {
    return false;
  }
  if (/\b(?:app(?:lication)?|deployment|workload)[/:=\s]+[a-z0-9][a-z0-9.-]{0,252}\b/i.test(question)) {
    return false;
  }
  return true;
}

/** Current blocks whose body is real evidence, not an empty/missing note. */
export function currentEvidenceSources(stackCurrent: string): string[] {
  const stack = stackCurrent.trim();
  if (!stack) {
    return [];
  }

  const blocks: Array<[string, RegExp]> = [
    ['Loki', /Loki last 15m[^\n]*:\n([\s\S]*?)(?=\n\n[A-Z]|\n*$)/i],
    ['Prometheus', /Prometheus last 15m[^\n]*:\n([\s\S]*?)(?=\n\n[A-Z]|\n*$)/i],
    ['Tempo', /Tempo last 15m[^\n]*:\n([\s\S]*?)(?=\n\n[A-Z]|\n*$)/i],
    ['Alertmanager', /Alertmanager[^\n]*:\n([\s\S]*?)(?=\n\n[A-Z]|\n*$)/i],
  ];

  const out: string[] = [];
  for (const [name, re] of blocks) {
    const body = re.exec(stack)?.[1]?.trim();
    if (body && !/^(no log lines|no metric samples|no traces|no alerts|.*datasource missing)/i.test(body)) {
      out.push(name);
    }
  }
  return out;
}

/** Denial phrasings, all taken from the live ask-log rather than invented. */
const DENIAL_PHRASE =
  /\b(?:does not exist|doesn't exist|do not exist|don't exist|not found|no such|unknown namespace|could not find|couldn't find|was not found|weren't found|wasn't found|not currently deployed|not available|(?:appears? to be |are |is )?from a different cluster)\b/gi;

/** The denial has to be ABOUT a Kubernetes object; otherwise it is upstream noise. */
const K8S_SUBJECT =
  /\b(?:namespaces?|ns|pods?|deployments?|workloads?|statefulsets?|daemonsets?|replicasets?|containers?|services?|apps?|applications?|clusters?|vclusters?|contexts?)\b/i;

/**
 * Text the model is ASSERTING, with the text it is merely QUOTING removed. Only
 * log-shaped `key=value` spans are stripped (including `key="quoted value"`), which is
 * what carries upstream noise like `msg="received non-200 response: 404 Not Found"`.
 *
 * Stripping is SPAN-granular, never line-granular: live answers arrive as a single
 * newline-free paragraph, so dropping whole lines threw away the denial along with the
 * log token and silently disabled the conflict hop.
 *
 * Generic quoted spans are deliberately NOT stripped. Prose quotes resource names, and
 * an answer phrased "'demo-gitops' does not exist" keeps its subject only inside the
 * quotes — deleting those spans would fail the adjacency check closed. A bare quoted
 * "HTTP 404 Not Found" is already handled by the HTTP-status guard instead.
 */
function assertedText(answer: string): string {
  return answer.replace(/\b[\w.-]+=(?:"[^"]*"|'[^']*'|`[^`]*`|\S+)/gi, ' ');
}

/**
 * Answer denies facts that Grafana Current already holds (wrong cluster / vcluster).
 * Triggers a follow-up hop that must not discard Current evidence.
 *
 * Phrasings are taken from the live ask-log, not invented — hop 1 on the argocd Ask said
 * "…is not available in the current cluster context" and "…are from a different cluster/context",
 * neither of which matched the original literal "appear to be from a different cluster".
 *
 * A denial says the thing does not exist / is not there. "Not accessible" and friends are
 * hedges, not denials — they belong to answerHedgesOnCurrent, and adding them here would
 * shadow the hedge branch and make the hop-3 escalation unreachable.
 *
 * A phrase only counts when the model asserts it about a Kubernetes object. Quoting an
 * upstream "HTTP 404 Not Found" is not a denial: that false positive burned hop 3 on the
 * unscoped top-issues Ask in the 2026-09-01T20:48Z TEST window.
 */
export function answerConflictsWithCurrent(stackCurrent: string, answer: string): boolean {
  if (!answer.trim() || currentEvidenceSources(stackCurrent).length === 0) {
    return false;
  }

  const asserted = assertedText(answer);
  for (const match of asserted.matchAll(DENIAL_PHRASE)) {
    const start = match.index ?? 0;
    const before = asserted.slice(Math.max(0, start - 60), start);
    const after = asserted.slice(start + match[0].length, start + match[0].length + 60);

    // "HTTP 404 Not Found" / "500 not available" is a transport error, not a missing workload.
    if (/\b(?:HTTP\s*)?[45]\d{2}\b[^.\n]{0,12}$/i.test(before)) {
      continue;
    }
    // "…from a different cluster" already names its own subject; "not found" / "no such"
    // do not, so those must sit next to the object they deny.
    if (K8S_SUBJECT.test(match[0]) || K8S_SUBJECT.test(before) || K8S_SUBJECT.test(after)) {
      return true;
    }
  }

  return false;
}

/**
 * Answer neither denies Current nor commits to it: it concedes the evidence but parks
 * the target behind "not accessible" / "cannot confirm" instead of resolving where it runs.
 * Real shape from the ask-log hop 2:
 *   "…is not accessible via standard kubectl contexts in the accessible cluster APIs."
 * Only meaningful once a conflict hop already told the model not to deny Current.
 */
export function answerHedgesOnCurrent(stackCurrent: string, answer: string): boolean {
  const text = answer.trim();
  if (!text) {
    return false;
  }

  const hedges =
    /\b(?:not accessible|inaccessible|not visible|no visibility|not reachable|no direct access|outside the accessible|standard kubectl contexts?|accessible cluster APIs?)\b/i.test(
      text
    ) ||
    /\b(?:cannot|can't|could not|couldn't|unable to)\s+(?:be\s+)?(?:confirm|confirmed|verify|verified|access|accessed|reach|reached|determine|determined|locate|located|query|queried)\b/i.test(
      text
    );
  if (!hedges) {
    return false;
  }

  return currentEvidenceSources(stackCurrent).length > 0;
}

function wantsObservabilityFollowUp(question: string, summary: string): boolean {
  return /\b(fail|error|crash|issue|alert|log|metric|restart|oom|backoff|top issues?)\b/i.test(
    `${question}\n${summary}`
  );
}

/**
 * Follow-up directives are returned as lines, not a joined box, so the packer can
 * shed them from the tail under budget pressure while the question stays whole.
 */
function acrossClustersInstructions(): string[] {
  return [
    'Follow-up: search across ALL clusters and vclusters (not only the default kube context).',
    'Keep and prefer concrete Grafana Current facts (Loki/Prom/Tempo/Alertmanager) — do not deny namespaces/pods that already appear in Current.',
    'If a name is missing in one cluster, check other clusters/vclusters before saying it does not exist.',
  ];
}

/**
 * Hop-2 prompt after the answer denied something Current proves.
 * Names the datasources and the pod/ns Current actually covers so the model
 * cannot re-run the same "namespace does not exist" denial on softer wording.
 */
function conflictInstructions(stackCurrent: string): string[] {
  const sources = currentEvidenceSources(stackCurrent);
  const header =
    /(?:Loki last 15m|Prometheus last 15m|Tempo last 15m|Alertmanager)\s*\(([^)\n]*)\)\s*:/i.exec(
      stackCurrent
    );
  const scope: PodNamespaceTarget = header ? parsePodNamespace(header[1]) : {};
  const target = [scope.pod ? `pod/${scope.pod}` : '', scope.namespace ? `ns/${scope.namespace}` : '']
    .filter(Boolean)
    .join(' ');

  return [
    'Follow-up: your previous answer is REJECTED — it denied a fact that Grafana Current already proves.',
    `Grafana Current above holds live evidence from ${sources.length > 0 ? sources.join(', ') : 'the host observability stack'}${target ? ` for ${target}` : ''}, read from this Grafana host in the last 15m.`,
    'Do NOT deny facts in Current. Do NOT say the namespace/pod does not exist, was not found, is not deployed, or belongs to a different cluster.',
    'The kube context you query is one cluster among several; absence there is not absence. Current is ground truth for the host cluster.',
    'Answer the original question FROM the Current evidence: quote the concrete Loki/Prometheus/Tempo/Alertmanager lines, then state which cluster/vcluster the workload appears to run in and what remains unknown.',
  ];
}

/**
 * Hop-3 prompt: hop 2 stopped denying Current but still refused to answer from it.
 * Last hop in the cap — demand a committed answer, not another accessibility caveat.
 */
function hedgeInstructions(stackCurrent: string): string[] {
  const sources = currentEvidenceSources(stackCurrent);

  return [
    'Final follow-up: your previous answer still hedged — it parked the target behind "not accessible" / "cannot confirm" instead of answering the question.',
    `Whether your kube context can reach the workload is NOT the question. Grafana Current holds live ${sources.length > 0 ? sources.join(', ') : 'host observability'} evidence read from this Grafana host in the last 15m, and that evidence stands on its own.`,
    'Do NOT repeat that the pod/namespace is unreachable, not visible, not accessible, or outside your available contexts.',
    'Answer now FROM Current: state what the workload is doing per the concrete evidence lines, name the cluster/vcluster it most likely runs in, and list only what is genuinely still unknown.',
  ];
}

/**
 * Run one user Ask through the hop loop (cap MAX_ASK_HOPS dot-ai calls).
 * Query: Grafana stack and/or dot-ai; answer FROM Current when stack was packed.
 * Hop 2+ fires when unscoped (search all clusters) or Current vs answer conflict.
 * Remediate: single analysis hop.
 */
export async function runAskOrchestrator(args: {
  tool: DotAITool;
  question: string;
  thread: ToolThread;
  fetchStack?: (q: string) => Promise<StackContextResult>;
  callTool?: (tool: DotAITool, text: string, meta?: AskMeta) => Promise<ToolCallResult>;
  signal?: AbortSignal;
  skipStack?: boolean;
}): Promise<OrchestratorResult> {
  const question = args.question.trim();
  const fetchStack = args.fetchStack ?? fetchStackContext;
  const callTool = args.callTool ?? ((t, text, meta) => callDotAITool(t, text, meta, args.signal));
  const tool = args.tool;

  const aborted = () => Boolean(args.signal?.aborted);

  if (tool === 'remediate') {
    if (aborted()) {
      return {
        ok: false,
        summary: '',
        errorMessage: ASK_CANCELLED_MESSAGE,
        thread: args.thread,
        firstHop: 'dot-ai',
        hops: 0,
        currentEmpty: !args.thread.current.trim(),
        lastPacked: '',
      };
    }
    const packed = buildRequestText({
      tool,
      current: args.thread.current,
      map: args.thread.map,
      box: question,
    });
    const meta: AskMeta = {
      hop: 1,
      hops: 1, // remediate is one planned hop
      current_empty: !args.thread.current.trim(),
      first_hop: 'dot-ai',
      branch: 'initial',
    };
    const result = await callTool(tool, packed, meta);
    if (!result.ok) {
      return {
        ok: false,
        summary: result.summary || '',
        errorMessage: result.errorMessage || 'Request failed',
        thread: args.thread,
        firstHop: 'dot-ai',
        hops: 1,
        currentEmpty: meta.current_empty,
        lastPacked: packed,
      };
    }
    const summaryText = result.summary.trim() ? result.summary : 'dot-ai returned no summary';
    return {
      ok: true,
      summary: summaryText,
      thread: {
        current: rewriteCurrent(args.thread.current, question, summaryText),
        map: mergeMap(args.thread.map, question, summaryText),
        history: appendHistory(args.thread.history, question, summaryText),
      },
      firstHop: 'dot-ai',
      hops: 1,
      currentEmpty: meta.current_empty,
      lastPacked: packed,
    };
  }

  const firstHop = classifyFirstHop(question);
  const unscoped = isUnscopedQuestion(question);
  let hops = 0;
  let map = args.thread.map;
  let history = args.thread.history;
  let lastPacked = '';
  let lastSummary = '';
  let stackSnapshot = '';
  let stackEmpty = true;
  let currentEmpty = !args.thread.current.trim();

  const loadStack = async (q: string) => {
    if (args.skipStack) {
      return;
    }
    try {
      const stack = await fetchStack(q);
      stackSnapshot = stack.current;
      stackEmpty = stack.currentEmpty;
      currentEmpty = stack.currentEmpty;
      map = mergeMap(stack.mapHint, map, q);
    } catch (e) {
      const why = e instanceof Error ? e.message : 'Grafana stack query failed';
      stackSnapshot = `Grafana stack read failed:\n${why}`;
      stackEmpty = true;
      currentEmpty = true;
      map = mergeMap(map, q);
    }
  };

  const callDotAI = async (
    box: string,
    branch: AskBranch,
    instructions: string[] = []
  ): Promise<ToolCallResult> => {
    if (aborted()) {
      return {
        ok: false,
        status: 0,
        summary: lastSummary,
        raw: null,
        errorMessage: ASK_CANCELLED_MESSAGE,
      };
    }
    if (hops >= MAX_ASK_HOPS) {
      return {
        ok: false,
        status: 0,
        summary: lastSummary,
        raw: null,
        errorMessage: 'hop cap reached',
      };
    }
    hops += 1;
    const packed = buildRequestText({
      tool: 'query',
      current: stackSnapshot || args.thread.current,
      map,
      box,
      instructions,
    });
    lastPacked = packed;
    const meta: AskMeta = {
      hop: hops, // current hop (1-based)
      hops: MAX_ASK_HOPS, // planned cap — not the same field as hop
      current_empty: currentEmpty,
      first_hop: firstHop,
      branch,
    };
    const result = await callTool('query', packed, meta);
    if (result.ok) {
      lastSummary = result.summary.trim() ? result.summary : 'dot-ai returned no summary';
      // Display History and Map keep the whole ask, instructions included, even when
      // the packer had to shed some of those lines to stay inside the intent budget.
      const asked = [box, ...instructions].join('\n');
      map = mergeMap(map, asked, lastSummary);
      history = appendHistory(history, asked, lastSummary);
    }
    return result;
  };

  const finish = (ok: boolean, errorMessage?: string): OrchestratorResult => {
    const summary = lastSummary || (ok ? 'dot-ai returned no summary' : '');
    const displaySeed = stackSnapshot || args.thread.current;
    return {
      ok,
      summary,
      errorMessage,
      thread: {
        current: ok ? rewriteCurrent(displaySeed, question, summary) : displaySeed || args.thread.current,
        map,
        history: ok ? history : args.thread.history,
      },
      firstHop,
      hops,
      currentEmpty,
      lastPacked,
    };
  };

  if (firstHop === 'grafana') {
    // Always Grafana stack for observability Asks (cluster-wide if no pod/ns).
    await loadStack(question);
    const r1 = await callDotAI(question, 'initial');
    if (!r1.ok) {
      return finish(false, r1.errorMessage || 'Request failed');
    }

    let conflictHopUsed = false;

    // Hop 2+: unscoped → all clusters; conflict → do not deny Current; empty → refine target.
    while (hops < MAX_ASK_HOPS) {
      const conflict = answerConflictsWithCurrent(stackSnapshot, lastSummary);
      const askedTarget = parsePodNamespace(question);
      const answerTarget = parsePodNamespace(lastSummary);

      if (unscoped && hops === 1) {
        const r = await callDotAI(question, 'across', acrossClustersInstructions());
        if (!r.ok) {
          return finish(false, r.errorMessage || 'Request failed');
        }
        continue;
      }

      if (conflict) {
        conflictHopUsed = true;
        const r = await callDotAI(question, 'conflict', conflictInstructions(stackSnapshot));
        if (!r.ok) {
          return finish(false, r.errorMessage || 'Request failed');
        }
        continue;
      }

      // Hop 3: the conflict hop stopped the denial but the answer still hedges
      // ("not accessible" / "cannot confirm") — force a committed answer from Current.
      if (conflictHopUsed && answerHedgesOnCurrent(stackSnapshot, lastSummary)) {
        const r = await callDotAI(question, 'hedge', hedgeInstructions(stackSnapshot));
        if (!r.ok) {
          return finish(false, r.errorMessage || 'Request failed');
        }
        continue;
      }

      if (
        stackEmpty &&
        !askedTarget.pod &&
        !askedTarget.namespace &&
        (answerTarget.pod || answerTarget.namespace)
      ) {
        const refineQ =
          answerTarget.pod && answerTarget.namespace
            ? `logs and metrics for pod ${answerTarget.pod} in namespace ${answerTarget.namespace}`
            : answerTarget.pod
              ? `logs and metrics for pod ${answerTarget.pod}`
              : `logs and metrics in namespace ${answerTarget.namespace}`;
        await loadStack(refineQ);
        if (!stackEmpty) {
          const r = await callDotAI(question, 'refine', [
            `Follow-up: use Grafana Current for ${[
              answerTarget.pod ? `pod/${answerTarget.pod}` : '',
              answerTarget.namespace ? `ns/${answerTarget.namespace}` : '',
            ]
              .filter(Boolean)
              .join(' ')}. Prefer Current facts; search other clusters only if still needed.`,
          ]);
          if (!r.ok) {
            return finish(false, r.errorMessage || 'Request failed');
          }
          continue;
        }
      }

      break;
    }

    if (hops > 0 && !lastSummary) {
      return finish(false, 'Request failed');
    }
    return finish(true);
  }

  // Inventory first — stack only when the answer/question points at a problem or unscoped obs bleed.
  const r1 = await callDotAI(question, 'initial');
  if (!r1.ok) {
    return finish(false, r1.errorMessage || 'Request failed');
  }

  if (wantsObservabilityFollowUp(question, lastSummary) && hops < MAX_ASK_HOPS) {
    const hint = parsePodNamespace(`${question}\n${lastSummary}`);
    const refineQ =
      hint.pod || hint.namespace
        ? `${question} ${hint.pod ? `pod ${hint.pod}` : ''} ${hint.namespace ? `namespace ${hint.namespace}` : ''}`.trim()
        : question;
    await loadStack(refineQ);
    // Always take the observability leg once triggered (cluster-wide OK); never skip solely on empty parse.
    if (hops < MAX_ASK_HOPS) {
      const r2 = await callDotAI(question, 'refine', [
        'Use Grafana Current facts in your answer. Search other clusters/vclusters if names are missing in the default context.',
      ]);
      if (!r2.ok) {
        return finish(false, r2.errorMessage || 'Request failed');
      }
    }
  }

  let conflictHopUsed = false;
  while (hops < MAX_ASK_HOPS) {
    const conflict = answerConflictsWithCurrent(stackSnapshot, lastSummary);
    // Hop 3 on this leg too: a conflict hop that only softened the denial still owes an answer.
    const hedges = conflictHopUsed && answerHedgesOnCurrent(stackSnapshot, lastSummary);
    if (!conflict && !hedges) {
      break;
    }
    const r = await callDotAI(
      question,
      conflict ? 'conflict' : 'hedge',
      conflict ? conflictInstructions(stackSnapshot) : hedgeInstructions(stackSnapshot)
    );
    if (!r.ok) {
      return finish(false, r.errorMessage || 'Request failed');
    }
    conflictHopUsed = true;
  }

  return finish(true);
}
