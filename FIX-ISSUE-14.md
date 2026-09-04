# Fix for issue #14 — packed intent silently dropped the question

`buildRequestText` enforced the 1000-char intent cap by shedding in four stages:
Map → Tempo → Loki lines → hard `cap()` of the whole packed string. Two gaps
compounded: stage 3 peeled only Loki, so Prometheus series and Alertmanager
alerts were never shed; and stage 4 truncated the *tail* of the packed string,
which is exactly where `pack()` puts `Question:` / `Issue:`. On a cluster with
metrics **and** alerts, dot-ai received ~1000 chars of evidence with nothing
asked.

## What changed

### `src/utils/progressiveContext.ts`

1. **The box is reserved before evidence is packed.** `buildRequestText` now
   takes an optional `instructions?: string[]` alongside `box`. `box` is the
   operator's own question (or the Remediate issue) and is never shed;
   `instructions` are plugin-written follow-up directives and *are* sheddable,
   tail first. Before the evidence ladder runs, instruction lines yield until
   Current has room for `MIN_CURRENT_CHARS` (240) — so a corrective hop keeps
   both its instruction and real evidence for that instruction to quote,
   instead of one starving the other.
2. **The shedding ladder reaches Prometheus and Alertmanager.**
   `trimLokiSection` became a generic `trimSection(current, head, …)` driven by
   `TRIM_ORDER = ['Loki last 15m', 'Prometheus last 15m', 'Alertmanager']`.
   Order is unchanged where it was already correct — Map first, then Tempo,
   then Loki — and only extends past Loki, where it used to give up. Lines are
   peeled from the tail of a block, which is its lowest-ranked entry (`topk`
   output and the alert list arrive ordered).
3. **No blind `cap()` of a string whose tail is the question.** The final
   truncation now caps the **Current block** — the evidence — and re-packs. The
   only remaining case that touches user input is a question that alone exceeds
   the budget: there is no evidence left to cut by then, so the question is
   capped explicitly rather than by a cap of the whole pack.
4. **`cap()` / `oneLine()` no longer split surrogate pairs** (optional item in
   the issue). Budgets stay in UTF-16 code units; a `sliceUnits` helper drops an
   orphaned high surrogate that would otherwise render as U+FFFD. Both also
   return `''` for a non-positive budget instead of a lone `…` longer than the
   budget it was handed.

`MAX_INTENT_CHARS` is unchanged at 1000. Only the allocation policy changed.

### `src/utils/askOrchestrator.ts`

`acrossClustersFollowUp` / `conflictFollowUp` / `hedgeFollowUp` returned
`[question, ...directives].join('\n')`. They now return the directive lines
only (`acrossClustersInstructions` / `conflictInstructions` /
`hedgeInstructions`), and `callDotAI(box, branch, instructions)` passes them to
the packer separately — which is what lets the packer tell the user's words
apart from its own. The two inline refine follow-ups were converted the same
way. Display History and Map still record the whole ask, instructions included,
so on-screen behaviour is unchanged.

## Measured before / after

Fixtures use this repo's real caps (`LOG_LINE_CAP` 30, `PROM_SERIES_CAP` 8,
`TEMPO_TRACE_CAP` 5, `ALERT_CAP` 8), the exact line shapes `formatCurrent` /
`factsFromPromFrames` / `textLinesFromFrames` produce, and an 87-char question.
Raw sizes land within ~1% of the numbers in the issue.

| Cluster state | raw Current | packed before | question before | packed after | question after | Current packed after |
|---|---|---|---|---|---|---|
| no alerts, no traces | 2110 | 972 | **kept** | 972 | **kept** | 679 |
| alerts firing, no traces | 2756 | 1000 | **DROPPED** | 921 | **kept** | 628 |
| alerts + traces | 2861 | 1000 | **DROPPED** | 921 | **kept** | 628 |
| alerts + traces, long namespace | 3081 | 1000 | **DROPPED** | 927 | **kept** | 634 |

"before" packed all three failing rows to exactly 1000 chars ending in an
ellipsis, with no `Question:` label at all — matching the field data in the
issue (10 of 51 logged asks exactly 1000 chars, 12 ending in an ellipsis).

Corrective hop 2 (question + the five `conflictFollowUp` directives, full stack
Current):

| | packed | question | first directive | last directive | Current packed |
|---|---|---|---|---|---|
| before | 1000 (ends `…`) | **DROPPED** | **DROPPED** | dropped | 0 |
| after | 988 | **kept** | **kept** | shed | 300 |

The last directive is shed deliberately: it is plugin-written, it is the lowest
priority line, and shedding it at line granularity is what buys back the 300
chars of evidence the surviving directives tell the model to quote. Before the
fix the same overflow was paid by a mid-sentence cut through the question.

## Tests

`src/utils/progressiveContext.test.ts` gains a
`buildRequestText reserves the question (issue #14)` block: the four table rows
(question present **verbatim** and packed text ending on it, not on an
ellipsis), Remediate's `Issue:` text, Prometheus shedding, Alertmanager
shedding, the never-truncated-tail invariant, instruction shedding with the
Current floor held, the oversized-question last resort, and surrogate-pair
safety. `src/utils/askOrchestrator.test.ts` gains an end-to-end
`every hop keeps the operator question (issue #14)` conflict-hop test.

11 of the 12 new assertions fail against the pre-fix code (verified by reverting
just the two production files and re-running). The twelfth is the
`no alerts, no traces` row, the control case the issue reports as already
working.

No existing test was changed: all 103 pre-existing tests pass unchanged.

## Verification

```
npm ci                 clean
npx jest               9 suites, 115 tests, all passing (103 pre-existing + 12 new)
npx tsc --noEmit       clean
npx eslint .           0 errors, 4 warnings (all pre-existing, in files not touched here)
```
