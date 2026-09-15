# Doc gates

Four mechanical checks that reproduce, without a human, the kind of finding a
docs/config PR review otherwise has to re-derive by hand every time.

```bash
npm run doc-gates                              # everything, base auto-detected
python3 scripts/doc-gates/run.py --base main   # identical, without npm
python3 scripts/doc-gates/run.py --gates bc -v # subset, show skipped rows
python3 scripts/doc-gates/run.py --links       # add the warn-only link check
```

Standard library Python only — no `npm install`, no `pip install`, no network.
CI runs the same command (`.github/workflows/doc-gates.yml`), so the local run and
the PR check cannot disagree. No hook is installed; run it yourself before pushing.
Exit code 1 on any finding; warnings never change the exit code.

## What each gate proves

| Gate | Check | Why a machine, not a reviewer |
|------|-------|-------------------------------|
| **A** | The diff touches `.config/**` | `.config/README.md` says the directory is auto-generated, and `.github/workflows/cp-update.yml` regenerates it monthly. Such an edit is silently reverted with CI still green — the worst kind of change, because nothing fails. |
| **B** | A doc phrase appears while the symbol implementing it does not exist | Claim/symbol parity. Docs written alongside an unmerged branch describe behaviour the merged tree does not have. Nothing in the build notices. |
| **C** | A documented number or ordering disagrees with source | Timeouts, character caps, the Map token cap, the Grafana floor, the `@grafana/*` pins, plugin id / nav / role, and the shedding-ladder order. |
| **D** | A compose image is not pinned by digest; external links | A mutable tag makes the same commit test a different image tomorrow. |

## Not automated, on purpose

Two review judgements are deliberately absent, because a gate that emits
opinions is a gate people learn to ignore:

- **scope versus plan** — whether a PR's contents match what it said it would do;
- **trunk hygiene** — whether an expected-red test belongs on `main` at all.

Every finding this tool prints is a fact with a `file:line` and a source
reference. If a finding is ever an opinion, that row is a bug.

## Adding a Gate B row (the common case)

Edit `claims.json`, copy a row, change three fields:

```json
{
  "id": "short-kebab-id",
  "phrases": ["the exact doc wording", "an alternative wording"],
  "ignore_case": true,
  "requires": { "symbol": "SymbolThatMustExist" },
  "reason": "what the doc promises and what breaks if the symbol is absent",
  "introduced_by": "PR #NN"
}
```

Semantics: **the phrase may appear only if the symbol exists in the tree.**
`requires` takes either `symbol` (literal) or `regex`, plus an optional `paths`
list to scope the search to specific files. Test and mock files never count as
an implementation — see `symbol_exclude`.

## Adding a Gate C row

Edit `constants.json`. Every expected value is extracted from source at run
time; nothing is hardcoded, so a deliberate change to a constant updates both
sides at once and the gate stays quiet. Kinds:

- `numeric_member` — every number the doc states in an anchored context must be
  one of the values the source regex yields.
- `equals` — the single value source defines must equal what the doc states
  (`numeric: true` to compare number words, `prefix_of_source: true` for `11.4`
  against `11.4.0`).
- `conditional_forbid` — the doc pattern is only wrong while a source condition
  holds.
- `ladder` — the shedding order, derived from `buildRequestText` markers and the
  `TRIM_ORDER` array. Reading it from source is the point: PR #49 inverted the
  ladder so the question is now capped **last**, and a hardcoded expectation
  would have had to be rewritten (or, worse, would have kept passing).
  A helper closure declared above the ladder (`reduceEvidence`) is expanded where
  it is **called**, not where it is written, so the derived order is the order the
  code runs. Each rung in `LADDER_RUNGS` must be proven by a marker; if one is not,
  the marker table has rotted against a refactor and the row skips saying which
  rung it lost, rather than reporting a truncated order as doc drift.

If a value cannot be extracted unambiguously the row **skips** and says so under
`-v`. A skipped row is better than a fragile regex that fires on clean code.

## Gate D and GitHub Actions pinning

`uses:` SHA pinning is enforced by default. Every action in `.github/workflows/`
must be pinned to a 40-character commit SHA (e.g. `uses: actions/checkout@<sha> # v7.0.1`).
`--warn-unpinned-actions` can be passed to demote unpinned action findings to warnings.
The external link check is warn-only for the same reason: a link checker that
fails CI on somebody else's outage is a liability.
