#!/usr/bin/env python3
"""Doc-drift gates for dot-ai-grafana.

Four mechanical checks that reproduce, by hand-free means, the review findings a
human otherwise has to re-derive on every docs PR:

  A  generated-directory guard   - .config/** is regenerated monthly; edits are lost
  B  claim/symbol parity         - a doc phrase may appear only if its symbol exists
  C  constants parity            - documented numbers/order must match source
  D  pin + link hygiene          - compose images pinned by digest; links reachable

Every finding is a fact with a file:line. Nothing here scores style or intent.

Usage:
    python3 scripts/doc-gates/run.py                 # all gates, base auto-detected
    python3 scripts/doc-gates/run.py --base main     # explicit diff base for gate A
    python3 scripts/doc-gates/run.py --gates bcd     # subset
    python3 scripts/doc-gates/run.py --links         # add the (warn-only) link check
    python3 scripts/doc-gates/run.py -v              # also print skipped rows

Exit code 1 if any gate produced a finding. Warnings never change the exit code.
Standard library only: no npm install, no pip install.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Repo root under test. Overridable with --repo so the gates can be replayed
# against an arbitrary checkout (a fixture commit) without moving the script.
REPO = ROOT.parent.parent

WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20,
}


class Report:
    def __init__(self, verbose: bool) -> None:
        self.findings: list[str] = []
        self.warnings: list[str] = []
        self.skips: list[str] = []
        self.verbose = verbose

    def finding(self, gate: str, where: str, message: str) -> None:
        self.findings.append(f"{gate} {where}: {message}")

    def warn(self, gate: str, where: str, message: str) -> None:
        self.warnings.append(f"{gate} {where}: {message}")

    def skip(self, gate: str, row: str, why: str) -> None:
        self.skips.append(f"{gate} skipped {row}: {why}")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(REPO), *args],
        check=False, capture_output=True, text=True,
    ).stdout.strip()


def read(rel: str) -> str | None:
    path = REPO / rel
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def glob_match(rel: str, pattern: str) -> bool:
    """Path glob where `**/` spans zero or more directories and `*` never crosses `/`.

    fnmatch alone is wrong here: `docs/**/*.md` would miss `docs/index.md`.
    """
    parts = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            parts.append("(?:[^/]+/)*")
            i += 3
        elif pattern.startswith("**", i):
            parts.append(".*")
            i += 2
        elif pattern[i] == "*":
            parts.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            parts.append("[^/]")
            i += 1
        else:
            parts.append(re.escape(pattern[i]))
            i += 1
    return re.fullmatch("".join(parts), rel) is not None


def doc_files(globs: list[str]) -> list[str]:
    """Tracked markdown matching globs, deterministic order."""
    tracked = git("ls-files").splitlines()
    out = []
    for rel in tracked:
        if any(glob_match(rel, g) for g in globs):
            out.append(rel)
    return sorted(set(out))


# --------------------------------------------------------------------------- A
def gate_a(rep: Report, base: str | None) -> None:
    """Fail any diff that touches .config/**."""
    gate = "GATE-A"
    if not base:
        rep.skip(gate, "diff", "no diff base resolved (pass --base <ref>)")
        return
    if not git("rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"):
        # Silently diffing against a ref that is not there would report a green gate
        # that checked nothing. Say so instead.
        rep.skip(gate, "diff", f"base ref {base} not found in this checkout")
        return
    merge_base = git("merge-base", base, "HEAD") or base
    changed = [p for p in git("diff", "--name-only", merge_base, "HEAD").splitlines() if p]
    # Uncommitted work counts too, so a local run matches what CI will see.
    changed += [p for p in git("diff", "--name-only", "HEAD").splitlines() if p]
    hits = sorted({p for p in changed if p.startswith(".config/")})
    if not hits:
        return
    cron = ""
    wf = read(".github/workflows/cp-update.yml")
    if wf:
        m = re.search(r"cron:\s*'([^']+)'", wf)
        if m:
            cron = f" on cron '{m.group(1)}'"
    for path in hits:
        rep.finding(
            gate, path,
            ".config/** is auto-generated (.config/README.md: \"not intended to be changed\") "
            f"and .github/workflows/cp-update.yml regenerates it{cron}. This edit will be "
            "silently reverted while CI stays green. Move the change to a file that "
            "overrides it (e.g. docker-compose.yaml extends the base service).",
        )


# --------------------------------------------------------------------------- B
def _symbol_exists(spec: dict, cfg: dict) -> bool:
    pattern = spec.get("regex") or re.escape(spec["symbol"])
    rx = re.compile(pattern)
    paths = spec.get("paths")
    if paths:
        candidates = [p for p in paths if (REPO / p).is_file()]
    else:
        candidates = []
        for root in cfg["symbol_roots"]:
            for path in sorted((REPO / root).rglob("*")):
                if not path.is_file():
                    continue
                rel = path.relative_to(REPO).as_posix()
                if any(glob_match(rel, ex) or glob_match(path.name, ex)
                       for ex in cfg["symbol_exclude"]):
                    continue
                candidates.append(rel)
    for rel in candidates:
        text = read(rel)
        if text and rx.search(text):
            return True
    return False


def gate_b(rep: Report) -> None:
    gate = "GATE-B"
    cfg = json.loads((ROOT / "claims.json").read_text())
    files = doc_files(cfg["doc_globs"])
    if not files:
        rep.skip(gate, "docs", "no tracked docs matched")
        return
    for claim in cfg["claims"]:
        if _symbol_exists(claim["requires"], cfg):
            continue
        flags = re.IGNORECASE if claim.get("ignore_case") else 0
        rx = re.compile("|".join(f"(?:{p})" for p in claim["phrases"]), flags)
        need = claim["requires"].get("symbol") or claim["requires"]["regex"]
        where = claim["requires"].get("paths") or cfg["symbol_roots"]
        for rel in files:
            text = read(rel) or ""
            for m in rx.finditer(text):
                rep.finding(
                    gate, f"{rel}:{line_of(text, m.start())}",
                    f"[{claim['id']}] doc says \"{m.group(0)}\" but `{need}` is not in "
                    f"{'/'.join(where)}. {claim['reason']}"
                    + (f" (symbol lives in {claim['introduced_by']})" if claim.get("introduced_by") else ""),
                )


# --------------------------------------------------------------------------- C
def _source_values(src: dict) -> list[str] | None:
    text = read(src["file"])
    if text is None:
        return None
    vals = re.findall(src["regex"], text)
    if not vals:
        return None
    return vals


def _num(token: str) -> int | None:
    if token.isdigit():
        return int(token)
    return WORD_NUMBERS.get(token.lower())


# (pattern, token, rung). `rung` names the step the marker proves; markers sharing a
# rung are alternative spellings of it. Every rung in LADDER_RUNGS must be proven or
# the row skips rather than compare a half-resolved order - see derive_source_ladder.
# A marker with no rung ("") is a regression sentinel, not a step.
LADDER_MARKERS: list[tuple[str, str, str]] = [
    (r"^\s*instr = instr\.slice\(", "instructions", "instructions"),
    (r"^\s*map = ''", "map", "map"),
    # Reassignment only: `let prior = condensePriorTurns(...)` builds Prior, it does
    # not shed it. Both the shrink and the later drop are hits; first one wins.
    (r"^\s*prior = ", "prior", "prior"),
    (r"\bdropTempoSection\(", "tempo", "tempo"),
    (r"for \(const head of TRIM_ORDER\)", "@TRIM_ORDER", "evidence"),
    (r"\btrimLokiSection\(", "loki", "evidence"),
    (r"trimSection\(current, '([A-Za-z]+)", "@literal", "evidence"),
    (r"\bcap\(\s*(?:reduced\.)?current\b", "current", "current"),
    (r"\bcap\(\s*box\b", "question", "question"),
    (r"return cap\(\s*text\b", "packed-tail", ""),
]

# The rungs a trustworthy ladder must resolve. Losing one means the table above has
# rotted against a refactor, not that the step is gone: the row skips and says so.
LADDER_RUNGS = ("instructions", "map", "prior", "tempo", "evidence", "current", "question")

DOC_LADDER_TOKENS: list[tuple[str, str]] = [
    (r"plugin-written|follow-up (?:instruction )?lines|instruction lines", "instructions"),
    (r"\bMap\b", "map"),
    (r"\bPrior\b", "prior"),
    (r"\bTempo\b", "tempo"),
    (r"\bLoki\b", "loki"),
    (r"\bPrometheus\b", "prometheus"),
    (r"\bAlertmanager\b", "alertmanager"),
    # Matched on the capping step, mirroring the `cap(current,` source marker: a doc
    # naming Current as the floor the instruction shed protects is not shedding it.
    (r"caps? (?:the )?\*{0,2}Current", "current"),
    (r"\bquestion\b|\bpacked tail\b", "question"),
]

LADDER_VERB = re.compile(r"\b(sheds?|peels?|drops?|trims?)\b", re.IGNORECASE)


def _lift_closures(body: str) -> dict[str, tuple[str, int]]:
    """Pull `const name = (...) => { ... };` helpers out of a function body.

    Returns {name: (definition, offset)}. A helper's markers belong to the rung that
    CALLS it, not to the line it is written on: `reduceEvidence` is declared above the
    ladder but runs in the middle of it, so a flat textual scan reads the evidence
    steps first and derives an order the code never applies.
    """
    found: dict[str, tuple[str, int]] = {}
    for m in re.finditer(r"^  const (\w+) = \([^)]*\)[^=]*=> \{", body, re.M):
        depth, i = 0, m.end() - 1
        while i < len(body):
            if body[i] == "{":
                depth += 1
            elif body[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        found[m.group(1)] = (body[m.start(): i + 1], m.start())
    return found


def _blank(body: str, spans: list[tuple[int, int]]) -> str:
    """Blank out spans, keeping newlines so offsets and line numbers still hold."""
    out = list(body)
    for lo, hi in spans:
        for i in range(lo, min(hi, len(out))):
            if out[i] != "\n":
                out[i] = " "
    return "".join(out)


def _scan_rungs(text: str, offset: int, trim_order: list[str],
                closures: dict[str, tuple[str, int]], seen: frozenset[str]):
    """Yield (token, offset, rung) for every marker in `text`, in textual order.

    A call to a lifted closure expands in place to that closure's own markers, so the
    yielded sequence is the order the ladder runs rather than the order it is written.
    """
    events: list[tuple[int, tuple]] = []
    for pattern, token, rung in LADDER_MARKERS:
        for m in re.finditer(pattern, text, re.M):
            events.append((m.start(), ("marker", m, token, rung)))
    for name, (definition, at) in closures.items():
        if name in seen:
            continue
        for m in re.finditer(rf"\b{re.escape(name)}\(", text):
            events.append((m.start(), ("call", name, definition, at)))
    events.sort(key=lambda e: e[0])
    for _, ev in events:
        if ev[0] == "call":
            _, name, definition, at = ev
            yield from _scan_rungs(definition, at, trim_order, closures, seen | {name})
            continue
        _, m, token, rung = ev
        if token == "@TRIM_ORDER":
            tokens = trim_order
        elif token == "@literal":
            tokens = [m.group(1).lower()]
        else:
            tokens = [token]
        for tok in tokens:
            yield tok, offset + m.start(), rung


def derive_source_ladder(rel: str) -> tuple[list[str], dict[str, int], list[str]] | None:
    """Read the shedding order out of buildRequestText. Never hardcoded.

    Third element is the rungs no marker proved. A non-empty list means the marker
    table has rotted against a refactor and the derived order is a truncated guess,
    so the caller must skip rather than report the difference as drift.
    """
    text = read(rel)
    if text is None:
        return None
    start = text.find("export function buildRequestText")
    if start < 0:
        return None
    end = text.find("\n}\n", start)
    body = text[start: end if end > 0 else len(text)]
    trim_order: list[str] = []
    m = re.search(r"const TRIM_ORDER = \[(.*?)\]", text, re.S)
    if m:
        trim_order = [s.split()[0].lower() for s in re.findall(r"'([^']+)'", m.group(1))]
    closures = _lift_closures(body)
    ladder = _blank(body, [(at, at + len(d)) for d, at in closures.values()])
    order: list[str] = []
    lines: dict[str, int] = {}
    proven: set[str] = set()
    for tok, off, rung in _scan_rungs(ladder, 0, trim_order, closures, frozenset()):
        proven.add(rung)
        if tok not in order:
            order.append(tok)
            lines[tok] = line_of(text, start) + body.count("\n", 0, off)
    missing = [r for r in LADDER_RUNGS if r not in proven]
    return (order, lines, missing) if order else None


def _doc_ladder(text: str) -> tuple[int, list[str]] | None:
    """Pick the doc line describing the ladder and read its order of steps."""
    best = None
    for idx, line in enumerate(text.splitlines(), start=1):
        verbs = len(LADDER_VERB.findall(line))
        named = sum(1 for kw in ("Tempo", "Loki", "Map") if kw in line)
        if verbs >= 2 and named >= 2:
            score = verbs + named
            if best is None or score > best[0]:
                best = (score, idx, line)
    if best is None:
        return None
    _, idx, line = best
    first = LADDER_VERB.search(line)
    region = line[first.start():]
    found: list[tuple[int, str]] = []
    for pattern, token in DOC_LADDER_TOKENS:
        m = re.search(pattern, region)
        if m:
            found.append((m.start(), token))
    found.sort()
    seq: list[str] = []
    for _, token in found:
        if token not in seq:
            seq.append(token)
    return idx, seq


def gate_c(rep: Report) -> None:
    gate = "GATE-C"
    cfg = json.loads((ROOT / "constants.json").read_text())
    files = doc_files(cfg["doc_globs"])
    if not files:
        rep.skip(gate, "docs", "no tracked docs matched")
        return

    for row in cfg["rows"]:
        kind = row["kind"]

        if kind == "ladder":
            derived = derive_source_ladder(row["source"]["file"])
            if derived is None:
                rep.skip(gate, row["id"], f"could not read buildRequestText from {row['source']['file']}")
                continue
            src_order, src_lines, missing = derived
            # A half-resolved ladder is not evidence of drift, it is evidence that the
            # marker table lost a step to a refactor. Say that instead of comparing a
            # truncated order against the doc and calling the difference a doc bug.
            if missing:
                rep.skip(
                    gate, row["id"],
                    f"no marker in LADDER_MARKERS resolves {', '.join(missing)} in "
                    f"{row['source']['file']} - refresh the table before trusting the order",
                )
                continue
            for rel in files:
                text = read(rel) or ""
                doc = _doc_ladder(text)
                if doc is None:
                    continue
                idx, doc_order = doc
                if doc_order == src_order:
                    continue
                rep.finding(
                    gate, f"{rel}:{idx}",
                    f"[{row['id']}] documented shedding order {' -> '.join(doc_order)} != "
                    f"source order {' -> '.join(src_order)} "
                    f"({row['source']['file']}:{min(src_lines.values())}-{max(src_lines.values())}). "
                    + row["reason"],
                )
                blind_cap = bool(src_order) and src_order[-1] == "packed-tail"
                for tok in doc_order:
                    if tok in src_order:
                        continue
                    # 'question' under a blind cap gets its own, more precise finding below.
                    if tok == "question" and blind_cap:
                        continue
                    rep.finding(
                        gate, f"{rel}:{idx}",
                        f"[{row['id']}] doc names a shedding step '{tok}' that "
                        f"{row['source']['file']} does not implement",
                    )
                if blind_cap and "question" in doc_order:
                    rep.finding(
                        gate, f"{rel}:{idx}",
                        f"[{row['id']}] last resort in source is a blind cap of the whole packed "
                        f"string ({row['source']['file']}:{src_lines['packed-tail']}), whose tail is "
                        "the question - so the question is what the hard cap cuts, not what it "
                        "protects",
                    )
            continue

        if kind == "conditional_forbid":
            cond = row["when"]
            text = read(cond["file"])
            if text is None:
                rep.skip(gate, row["id"], f"{cond['file']} missing")
                continue
            if not re.search(cond["present"], text):
                rep.skip(gate, row["id"], f"{cond['present']} not in {cond['file']}")
                continue
            if re.search(cond["absent"], text):
                rep.skip(gate, row["id"], f"{cond['file']} pins a static matrix")
                continue
            anchor = re.compile(row["doc"]["anchor"], re.IGNORECASE)
            forbid = re.compile(row["doc"]["forbid"])
            exempt = row["doc"].get("exempt")
            exempt_rx = re.compile(exempt, re.IGNORECASE) if exempt else None
            for rel in files:
                body = read(rel) or ""
                for idx, line in enumerate(body.splitlines(), start=1):
                    if not anchor.search(line):
                        continue
                    # A line that names the resolver is describing the dynamic
                    # matrix, not freezing a copy of it.
                    if exempt_rx and exempt_rx.search(line):
                        continue
                    hits = forbid.findall(line)
                    if row["doc"].get("distinct"):
                        hits = sorted(set(hits))
                    if len(hits) >= row["doc"].get("min_hits", 1):
                        rep.finding(
                            gate, f"{rel}:{idx}",
                            f"[{row['id']}] doc enumerates {', '.join(hits)} - {row['reason']}",
                        )
            continue

        values = _source_values(row["source"])
        if values is None:
            rep.skip(gate, row["id"], f"no source value extracted from {row['source']['file']}")
            continue
        distinct = sorted(set(values))
        if row["source"]["mode"] == "one" and len(distinct) != 1:
            rep.skip(gate, row["id"], f"source value ambiguous: {distinct}")
            continue

        anchor = re.compile(row["doc"]["anchor"], re.IGNORECASE)
        extract = re.compile(row["doc"]["extract"], re.IGNORECASE)
        scope_after = row["doc"].get("scope_after")
        for rel in files:
            body = read(rel) or ""
            for idx, line in enumerate(body.splitlines(), start=1):
                if not anchor.search(line):
                    continue
                region = line
                if scope_after:
                    m = re.search(scope_after, line)
                    if not m:
                        continue
                    region = line[m.end():]
                for hit in extract.finditer(region):
                    claimed = hit.group(1)
                    if kind == "numeric_member":
                        if claimed in distinct:
                            continue
                        rep.finding(
                            gate, f"{rel}:{idx}",
                            f"[{row['id']}] doc states {claimed}, source defines "
                            f"{{{', '.join(distinct)}}} ({row['source']['file']}). {row['reason']}",
                        )
                    else:
                        expected = distinct[0]
                        if row.get("numeric"):
                            got, want = _num(claimed), _num(expected)
                            if got is not None and got == want:
                                continue
                        elif row.get("prefix_of_source"):
                            if expected.startswith(claimed):
                                continue
                        elif claimed == expected:
                            continue
                        rep.finding(
                            gate, f"{rel}:{idx}",
                            f"[{row['id']}] doc states {claimed}, source says {expected} "
                            f"({row['source']['file']}). {row['reason']}",
                        )


# --------------------------------------------------------------------------- D
IMAGE_RX = re.compile(r"^\s*image:\s*(\S+)", re.MULTILINE)
USES_RX = re.compile(r"^\s*(?:-\s*)?uses:\s*(\S+)", re.MULTILINE)
SHA_RX = re.compile(r"^[0-9a-f]{40}$")


def gate_d(rep: Report, check_links: bool, warn_actions: bool) -> None:
    gate = "GATE-D"
    tracked = git("ls-files").splitlines()

    # D1 - compose images must be pinned by digest.
    # .config/ is excluded: it is generated (gate A) and its image is env-interpolated.
    composes = [p for p in tracked
                if fnmatch.fnmatch(Path(p).name, "docker-compose*.yaml")
                or fnmatch.fnmatch(Path(p).name, "docker-compose*.yml")]
    for rel in composes:
        if rel.startswith(".config/"):
            continue
        text = read(rel) or ""
        for m in IMAGE_RX.finditer(text):
            ref = m.group(1).strip("'\"")
            if "${" in ref:  # resolved at run time (CI matrix); nothing to pin here
                continue
            if "@sha256:" in ref:
                continue
            rep.finding(
                gate, f"{rel}:{line_of(text, m.start())}",
                f"image `{ref}` is not pinned by digest. Tags are mutable, so the same "
                "commit can test a different image tomorrow. Pin as `name:tag@sha256:...`.",
            )

    # D2 - GitHub Actions SHA pinning. Every workflow `uses:` must be pinned
    # to a 40-character commit SHA (finding). If warn_actions is explicitly set,
    # it is demoted to a warning for backwards compatibility.
    for rel in [p for p in tracked if p.startswith(".github/workflows/")]:
        text = read(rel) or ""
        for m in USES_RX.finditer(text):
            ref = m.group(1)
            if "@" not in ref:
                continue
            if SHA_RX.match(ref.rsplit("@", 1)[1]):
                continue
            msg = f"`uses: {ref}` is not pinned to a 40-char SHA"
            if warn_actions:
                rep.warn(gate, f"{rel}:{line_of(text, m.start())}", msg)
            else:
                rep.finding(gate, f"{rel}:{line_of(text, m.start())}", msg)
    # D3 - external links. Warn-only: a link checker that fails CI on somebody
    # else's outage is a liability, and this gate must stay trustworthy.
    if check_links:
        lychee = shutil.which("lychee")
        if not lychee:
            rep.skip(gate, "links", "lychee not installed (npx/binary); link check not run")
            return
        targets = [p for p in tracked if p == "README.md" or p.startswith("docs/")]
        targets = [p for p in targets if p.endswith(".md")]
        if not targets:
            return
        proc = subprocess.run(
            [lychee, "--no-progress", "--max-concurrency", "4", "--accept",
             "200,206,301,302,403,429", *targets],
            cwd=REPO, capture_output=True, text=True, check=False,
        )
        if proc.returncode != 0:
            for line in proc.stdout.splitlines():
                if line.strip().startswith("[ERR]") or "✗" in line:
                    rep.warn(gate, "links", line.strip())


# --------------------------------------------------------------------------- main
def resolve_base(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    env = os.environ.get("GITHUB_BASE_REF")
    candidates = ([f"origin/{env}", env] if env else []) + [
        "upstream/main", "origin/main", "main",
    ]
    for ref in candidates:
        if ref and git("rev-parse", "--verify", "--quiet", ref):
            return ref
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", help="diff base for gate A")
    ap.add_argument("--gates", default="abcd", help="subset of gates to run, e.g. bc")
    ap.add_argument("--links", action="store_true", help="run the warn-only external link check")
    ap.add_argument("--warn-unpinned-actions", action="store_true",
                    help="downgrade unpinned workflow `uses:` check to a warning instead of failing")
    ap.add_argument("-v", "--verbose", action="store_true", help="print skipped rows")
    ap.add_argument("--repo", help="repo root to check (default: the repo this script lives in)")
    args = ap.parse_args()
    if args.repo:
        global REPO
        REPO = Path(args.repo).resolve()

    rep = Report(args.verbose)
    gates = args.gates.lower()
    if "a" in gates:
        gate_a(rep, resolve_base(args.base))
    if "b" in gates:
        gate_b(rep)
    if "c" in gates:
        gate_c(rep)
    if "d" in gates:
        gate_d(rep, args.links, args.warn_unpinned_actions)

    for line in rep.findings:
        print(line)
    for line in rep.warnings:
        print(f"warning: {line}")
    if args.verbose:
        for line in rep.skips:
            print(f"note: {line}")

    if rep.findings:
        print(f"\n{len(rep.findings)} finding(s). See scripts/doc-gates/README.md.", file=sys.stderr)
        return 1
    print("doc-gates: no findings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
