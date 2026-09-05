import { DotAITool } from './dotaiApi';

/** Conversation turn. UI shows full text; packer may send a condensed Prior block. */
export type HistoryTurn = {
  role: 'you' | 'answer';
  text: string;
};

export type ToolThread = {
  current: string;
  map: string;
  history: HistoryTurn[];
};

/** Max History turns shown on screen (each You or Answer counts as one). */
export const MAX_HISTORY_TURNS = 5;

/** Cap for rewritten Current (chars). Leaves headroom so packed intent stays ≤ MAX_INTENT_CHARS. */
export const MAX_CURRENT_CHARS = 700;

/** Cap for the Map line (chars). */
export const MAX_MAP_CHARS = 400;

/**
 * Hard cap for packed query/remediate intent sent to dot-ai.
 *
 * Counted in UTF-16 code units (`String.length`), NOT bytes: a 1000-unit intent of
 * mostly non-BMP text measures ~1810 UTF-8 bytes on the wire, so this bounds neither
 * bytes nor tokens if dot-ai ever grows such a limit. Slicing is surrogate-safe (see
 * `sliceUnits`), so a truncated tail never emits a lone surrogate.
 */
export const MAX_INTENT_CHARS = 1000;

export function emptyThread(): ToolThread {
  return { current: '', map: '', history: [] };
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
 * Soft cap for condensed Prior (History) content, excluding the "Prior:" label.
 * Keeps follow-up referents without crowding Current/Question under MAX_INTENT_CHARS.
 *
 * Counted in UTF-16 code units like MAX_INTENT_CHARS, not bytes.
 */
export const MAX_PRIOR_CHARS = 240;

/**
 * Pack Stable + Current + Prior + Map + box for the next POST.
 *
 * Prior is a condensed view of recent History turns (referents over prose): the
 * operator's own question text and prose from dot-ai's answers, which routinely
 * quotes concrete Loki/Prometheus/Tempo/Alertmanager lines. Full History stays on
 * screen; only the condensed block leaves the browser.
 *
 * The box (the operator's question, plus any plugin-written follow-up instructions)
 * is reserved BEFORE evidence is packed, so growing datasource output can never
 * delete or truncate what was asked. Always ≤ MAX_INTENT_CHARS, shedding in order:
 * follow-up instruction lines down to the Current floor, then Map, then Prior shrunk
 * to its latest turn, then Tempo, Loki, Prometheus and Alertmanager lines, then Prior
 * entirely, then a cap of the Current block itself. The packed tail holds the box,
 * and is never blind-capped.
 *
 * Prior outranks fresh evidence: while it survives, evidence lines are peeled to make
 * room for it. But evidence is never spent on a Prior that does not ship — when Prior
 * is dropped, the evidence reduction restarts from the untouched Current, so a pack
 * without Prior carries exactly the evidence it would have carried with no history at
 * all (`reduceEvidence`).
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
  /** Full display history; packer condenses recent turn(s) into Prior. */
  history?: HistoryTurn[];
}): string {
  const box = args.box.trim();
  const instructions = (args.instructions ?? []).map((line) => line.trim()).filter(Boolean);
  const fullCurrent = args.current.trim();
  let map = args.map.trim();
  let prior = condensePriorTurns(args.history ?? [], MAX_PRIOR_CHARS);

  const pack = (c: string, m: string, p: string, instr: string[], question = box): string => {
    const parts: string[] = [stablePreamble(args.tool)];
    if (c) {
      parts.push('', 'Current:', c);
    }
    if (p) {
      parts.push('', 'Prior:', p);
    }
    if (m) {
      parts.push('', 'Map:', m);
    }
    parts.push('', args.tool === 'remediate' ? 'Issue:' : 'Question:', [question, ...instr].join('\n'));
    return parts.join('\n');
  };

  /**
   * Reduce evidence for one Prior value, always starting from the untouched Current:
   * drop the Tempo block, then peel Loki, Prometheus and Alertmanager body lines.
   * Map is already gone by the time this runs. Returns the reduced Current and the
   * packed string, whether or not it fits, so the caller can retry with less Prior.
   */
  const reduceEvidence = (p: string, instr: string[]): { current: string; text: string } => {
    let current = dropTempoSection(fullCurrent);
    let text = pack(current, '', p, instr);
    if (text.length <= MAX_INTENT_CHARS) {
      return { current, text };
    }
    for (const head of TRIM_ORDER) {
      current = trimSection(current, head, (c) => pack(c, '', p, instr).length, MAX_INTENT_CHARS);
      text = pack(current, '', p, instr);
      if (text.length <= MAX_INTENT_CHARS) {
        return { current, text };
      }
    }
    return { current, text };
  };

  let text = pack(fullCurrent, map, prior, instructions);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 0. Reserve the box. Only the plugin-written follow-up lines yield, and only
  //    until Current can hold its floor — the question itself is never shed here.
  //    Measured Prior-free: Prior is sheddable further down the ladder, so counting
  //    it here would shed instruction lines that the pack can still afford.
  let instr = instructions;
  const floor = fullCurrent ? Math.min(MIN_CURRENT_CHARS, fullCurrent.length) + CURRENT_LABEL_CHARS : 0;
  while (instr.length > 0 && MAX_INTENT_CHARS - pack('', '', '', instr).length < floor) {
    instr = instr.slice(0, -1);
  }
  text = pack(fullCurrent, map, prior, instr);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 1. Drop Map (chips are convenience; Prior keeps follow-up referents)
  map = '';
  text = pack(fullCurrent, map, prior, instr);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 2. Shrink Prior to the single latest turn, tighter budget
  if (prior) {
    prior = condensePriorTurns(args.history ?? [], Math.min(160, MAX_PRIOR_CHARS), 1);
    text = pack(fullCurrent, map, prior, instr);
    if (text.length <= MAX_INTENT_CHARS) {
      return text;
    }
  }

  // 3. Reduce Current evidence while Prior is still in the pack: those peeled lines
  //    are what Prior costs, and that cost is documented in the egress contract.
  let reduced = reduceEvidence(prior, instr);
  if (reduced.text.length <= MAX_INTENT_CHARS) {
    return reduced.text;
  }

  // 4. Drop Prior — and refund the evidence it was charged for. Reducing again from
  //    the untouched Current is the difference between "Prior cost three log lines"
  //    and "three log lines were peeled for a Prior block that then did not ship".
  if (prior) {
    prior = '';
    reduced = reduceEvidence(prior, instr);
    if (reduced.text.length <= MAX_INTENT_CHARS) {
      return reduced.text;
    }
  }

  // 5. Cap the Current block — the evidence — never the packed string, whose tail
  //    is the box. Capping the pack is what silently deleted the question.
  const capped = cap(
    reduced.current,
    reduced.current.length - (reduced.text.length - MAX_INTENT_CHARS)
  );
  text = pack(capped, map, prior, instr);
  if (text.length <= MAX_INTENT_CHARS) {
    return text;
  }

  // 6. Preamble + question alone overflow: no evidence is left to cut, so cap the
  //    question deliberately rather than letting a blind cap eat its tail.
  const overhead = pack('', '', '', []).length - box.length;
  return pack('', '', '', [], cap(box, MAX_INTENT_CHARS - overhead));
}

/** Pair You+Answer turns chronologically; orphan answers (after display slice) are skipped. */
function historyPairs(history: HistoryTurn[]): Array<{ you: string; answer: string }> {
  const pairs: Array<{ you: string; answer: string }> = [];
  let pendingYou: string | null = null;
  for (const turn of history) {
    if (turn.role === 'you') {
      pendingYou = turn.text;
      continue;
    }
    if (turn.role === 'answer' && pendingYou !== null) {
      pairs.push({ you: pendingYou, answer: turn.text });
      pendingYou = null;
    }
  }
  return pairs;
}

/**
 * Condense prior turn(s) for the wire: keep the referent (resource chips / short A)
 * and a short Q so "the first one" can resolve. Most recent first; older only if budget allows.
 *
 * This is the only caller-visible bound on prior-turn egress: the returned string is
 * capped to `maxChars` here, because `formatPriorPair` is best-effort per line.
 */
export function condensePriorTurns(
  history: HistoryTurn[],
  maxChars: number,
  maxPairs = 2
): string {
  if (!history.length || maxChars <= 0 || maxPairs <= 0) {
    return '';
  }
  const pairs = historyPairs(history);
  if (!pairs.length) {
    return '';
  }

  const lines: string[] = [];
  // Walk newest → oldest so the latest referent always wins the budget.
  for (let i = pairs.length - 1; i >= 0 && lines.length < maxPairs; i--) {
    const pair = pairs[i];
    const used = lines.reduce((n, line) => n + line.length + (n > 0 ? 1 : 0), 0);
    const remaining = maxChars - used;
    if (remaining < 24 && lines.length > 0) {
      break;
    }
    const line = formatPriorPair(pair.you, pair.answer, Math.max(remaining, 24));
    if (!line) {
      continue;
    }
    // Prepend so final order is chronological.
    lines.unshift(line);
  }

  const joined = lines.join('\n');
  return joined.length <= maxChars ? joined : cap(joined, maxChars);
}

/**
 * One wire line: short Q + answer biased toward resource referents.
 *
 * Best-effort, NOT a hard bound: `aBudget` has a floor of 12 chars, so with a long
 * question the prefix plus that floor can exceed `budget` by up to ~19 chars. The
 * 240-char guarantee is enforced by the caller's `cap()` in `condensePriorTurns`, not
 * here — a refactor that removes that cap removes the only bound on Prior egress.
 */
function formatPriorPair(you: string, answer: string, budget: number): string {
  if (budget < 12) {
    return '';
  }
  const qBudget = Math.min(90, Math.max(20, Math.floor(budget * 0.35)));
  const q = oneLine(you, qBudget);
  const prefix = `You: ${q} | A: `;
  const aBudget = Math.max(12, budget - prefix.length);
  const hints = extractResourceHints(you, answer);
  // Prefer chips + a short prose tail so "first one" still maps to a name when present.
  const aSource = hints ? `${hints} — ${answer.replace(/\s+/g, ' ').trim()}` : answer;
  const a = oneLine(aSource, aBudget);
  return `${prefix}${a}`;
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
