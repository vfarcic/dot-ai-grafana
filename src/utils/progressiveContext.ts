import { DotAITool } from './dotaiApi';
import { DrilldownLink } from './grafanaExplore';

/** Display-only turn; never included in POST body text. */
export type HistoryTurn = {
  role: 'you' | 'answer';
  text: string;
};

export type ToolThread = {
  current: string;
  map: string;
  history: HistoryTurn[];
  /** UI-only Explore/Drilldown links. Never POSTed. */
  drilldowns: DrilldownLink[];
};

/** Max History turns shown on screen (each You or Answer counts as one). */
export const MAX_HISTORY_TURNS = 5;

/** Cap for rewritten Current (chars). Leaves headroom so packed intent stays ≤ MAX_INTENT_CHARS. */
export const MAX_CURRENT_CHARS = 700;

/** Cap for the Map line (chars). */
export const MAX_MAP_CHARS = 400;

/** Hard cap for packed query/remediate intent sent to dot-ai (chars). */
export const MAX_INTENT_CHARS = 1000;

export function emptyThread(): ToolThread {
  return { current: '', map: '', history: [], drilldowns: [] };
}


export function stablePreamble(tool: DotAITool): string {
  if (tool === 'remediate') {
    return 'Tool: Remediate. Analysis only — do not apply or mutate cluster state. Answer FROM Current when present. Prefer Current facts over generic advice.';
  }
  return 'Tool: Query. Analysis and cluster facts only — no mutations. Answer FROM Current when present. Prefer concrete Current facts (logs, metrics, alerts, cluster data) over generic advice.';
}

/**
 * Slice to at most `units` UTF-16 code units without splitting a surrogate pair.
 * Budgets are counted in code units (String.length), so the unit stays the same —
 * only an orphaned high surrogate, which would render as U+FFFD, is dropped.
 */
function sliceUnits(text: string, units: number): string {
  if (units <= 0) {
    return '';
  }
  const out = text.slice(0, units);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    return out.slice(0, -1);
  }
  return out;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  if (max <= 0) {
    return '';
  }
  return `${sliceUnits(flat, max - 1).trimEnd()}…`;
}

function cap(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) {
    return t;
  }
  // A one-char budget cannot hold content plus the ellipsis; drop the block instead
  // of returning a lone "…" that is longer than the budget it was given.
  if (max <= 0) {
    return '';
  }
  return `${sliceUnits(t, max - 1).trimEnd()}…`;
}

/**
 * Filler words that must never become a resource-name or namespace chip.
 * Prose such as "namespaces are in Active status" is not an inventory fact.
 * Shared with parsePodNamespace so free-text questions do not invent pod names.
 */
export const HINT_STOPWORDS: Record<string, true> = {
  are: true,
  is: true,
  was: true,
  were: true,
  be: true,
  been: true,
  being: true,
  found: true,
  running: true,
  our: true,
  the: true,
  this: true,
  that: true,
  top: true,
  issue: true,
  need: true,
  address: true,
  environment: true,
};

/**
 * Minimum Current the packer defends for a hop that carries follow-up instructions.
 * A corrective hop tells the model to quote the concrete evidence lines, so shedding
 * Current to nothing to fit the instruction text would make the instruction incoherent.
 */
export const MIN_CURRENT_CHARS = 240;

/** Chars `pack` spends on the "\n\nCurrent:\n" label around a non-empty Current block. */
const CURRENT_LABEL_CHARS = '\n\nCurrent:\n'.length;

/** Section heads `formatCurrent` writes, used to find one block's boundaries. */
const SECTION_HEADS = 'Loki|Prometheus|Tempo|Alertmanager';

/**
 * Evidence blocks whose body lines can be peeled, in shedding order: logs are the
 * bulkiest and most repetitive, restart counts next, firing alerts last.
 */
const TRIM_ORDER = ['Loki last 15m', 'Prometheus last 15m', 'Alertmanager'];

/**
 * Pack Stable + Current + Map + box for the next POST.
 * History is intentionally omitted.
 *
 * The box (the operator's question, plus any plugin-written follow-up instructions)
 * is reserved BEFORE evidence is packed, so growing datasource output can never
 * delete or truncate what was asked. Always ≤ MAX_INTENT_CHARS, shedding in order:
 * follow-up instruction lines down to the Current floor, then Map, Tempo, Loki,
 * Prometheus and Alertmanager lines, then a cap of the Current block itself.
 * The packed tail holds the box, and is never blind-capped.
 */
export function buildRequestText(args: {
  tool: DotAITool;
  current: string;
  map: string;
  box: string;
  /**
   * Plugin-written follow-up directives appended under the question. Unlike the
   * question they are sheddable: element order is priority order, tail first out.
   */
  instructions?: string[];
}): string {
  const box = args.box.trim();
  const instructions = (args.instructions ?? []).map((line) => line.trim()).filter(Boolean);
  let current = args.current.trim();
  let map = args.map.trim();

  const pack = (c: string, m: string, instr: string[], question = box): string => {
    const parts: string[] = [stablePreamble(args.tool)];
    if (c) {
      parts.push('', 'Current:', c);
    }
    if (m) {
      parts.push('', 'Map:', m);
    }
    parts.push('', args.tool === 'remediate' ? 'Issue:' : 'Question:', [question, ...instr].join('\n'));
    return parts.join('\n');
  };

  let text = pack(current, map, instructions);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 0. Reserve the box. Only the plugin-written follow-up lines yield, and only
  //    until Current can hold its floor — the question itself is never shed here.
  let instr = instructions;
  const floor = current ? Math.min(MIN_CURRENT_CHARS, current.length) + CURRENT_LABEL_CHARS : 0;
  while (instr.length > 0 && MAX_INTENT_CHARS - pack('', '', instr).length < floor) {
    instr = instr.slice(0, -1);
  }
  text = pack(current, map, instr);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 1. Drop Map
  map = '';
  text = pack(current, map, instr);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 2. Drop Tempo section from Current
  current = dropTempoSection(current);
  text = pack(current, map, instr);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 3. Peel Loki, then Prometheus, then Alertmanager body lines. Stopping at Loki
  //    was what let metric and alert lines crowd the question out of the budget.
  for (const head of TRIM_ORDER) {
    current = trimSection(current, head, (c) => pack(c, map, instr).length, MAX_INTENT_CHARS);
    text = pack(current, map, instr);
    if (text.length <= MAX_INTENT_CHARS) {
      return text;
    }
  }

  // 4. Cap the Current block — the evidence — never the packed string, whose tail
  //    is the box. Capping the pack is what silently deleted the question.
  current = cap(current, current.length - (text.length - MAX_INTENT_CHARS));
  text = pack(current, map, instr);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 5. Preamble + question alone overflow: no evidence is left to cut, so cap the
  //    question deliberately rather than letting a blind cap eat its tail.
  const overhead = pack('', '', []).length - box.length;
  return pack('', '', [], cap(box, MAX_INTENT_CHARS - overhead));
}

/** Remove the Tempo last-15m block from a stack Current string. */
function dropTempoSection(current: string): string {
  const next = current.replace(
    /\n*Tempo last 15m[^\n]*:\n[\s\S]*?(?=\n\n(?:Loki|Prometheus|Alertmanager)\b|\n*$)/i,
    '\n'
  );
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Peel body lines from the end of one Current block until packed length ≤ max.
 * The tail of a block is its lowest-ranked entry: `topk` output and the alert list
 * arrive ordered, and log lines arrive oldest-last.
 */
function trimSection(
  current: string,
  head: string,
  measure: (c: string) => number,
  max: number
): string {
  const match = new RegExp(
    `(${head}[^\\n]*:\\n)([\\s\\S]*?)(?=\\n\\n(?:${SECTION_HEADS})\\b|\\n*$)`,
    'i'
  ).exec(current);
  if (!match) {
    return current;
  }
  const before = current.slice(0, match.index);
  const header = match[1];
  let body = match[2];
  const rest = current.slice(match.index + match[0].length);
  const rebuild = (b: string) => `${before}${header}${b}${rest}`.replace(/\n{3,}/g, '\n\n').trim();

  let out = rebuild(body);
  while (measure(out) > max) {
    const lines = body.split('\n').filter((line, idx, arr) => line !== '' || idx < arr.length - 1);
    if (lines.length <= 1) {
      body = '…';
      out = rebuild(body);
      break;
    }
    lines.pop();
    body = lines.join('\n');
    out = rebuild(body);
  }
  return out;
}

/**
 * Best-effort short names / where-only hints from free text.
 * Keeps Map small; not a full inventory.
 */
export function extractResourceHints(...chunks: string[]): string {
  const text = chunks.join('\n');
  const found = new Set<string>();

  const nsRe = /\b(?:namespace|ns)[/:=\s]+([a-z0-9][a-z0-9-]{0,62})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = nsRe.exec(text)) !== null) {
    found.add(`ns/${m[1]}`);
  }

  const podRe = /\b(?:pod[s]?[/:\s]+)([a-z0-9][a-z0-9.-]{0,252})\b/gi;
  while ((m = podRe.exec(text)) !== null) {
    found.add(`pod/${m[1]}`);
  }

  // bare "name in namespace" / "name (namespace)" light patterns.
  // Free text like "namespaces are in Active status" would otherwise yield
  // junk chips such as "are@Active", so both sides reject filler words.
  const inNs = /\b([a-z0-9][a-z0-9.-]{1,60})\s+in\s+([a-z0-9][a-z0-9-]{0,62})\b/gi;
  while ((m = inNs.exec(text)) !== null) {
    if (HINT_STOPWORDS[m[1].toLowerCase()] || HINT_STOPWORDS[m[2].toLowerCase()]) {
      continue;
    }
    found.add(`${m[1]}@${m[2]}`);
  }

  return cap([...found].slice(0, 12).join(', '), MAX_MAP_CHARS);
}

export function mergeMap(previous: string, ...chunks: string[]): string {
  const parts = new Set<string>();
  for (const piece of [previous, extractResourceHints(...chunks)]) {
    for (const token of piece.split(/,\s*/)) {
      const t = token.trim();
      if (t) {
        parts.add(t);
      }
    }
  }
  return cap([...parts].slice(0, 12).join(', '), MAX_MAP_CHARS);
}

/** Replace Current with one rewritten block after a successful answer. */
export function rewriteCurrent(previous: string, userText: string, answer: string): string {
  const resources = extractResourceHints(previous, userText, answer);
  const lines = [
    resources ? `Resources: ${resources}` : undefined,
    `Asked: ${oneLine(userText, 180)}`,
    `What's true now: ${oneLine(answer, 500)}`,
    'Next: follow up in Query, or Analyze this for remediation analysis.',
  ].filter((line): line is string => Boolean(line));
  return cap(lines.join('\n'), MAX_CURRENT_CHARS);
}


/** Append You + Answer; keep only the last MAX_HISTORY_TURNS for display. */
export function appendHistory(history: HistoryTurn[], you: string, answer: string): HistoryTurn[] {
  const next = [
    ...history,
    { role: 'you' as const, text: you.trim() },
    { role: 'answer' as const, text: answer.trim() },
  ];
  return next.slice(-MAX_HISTORY_TURNS);
}
