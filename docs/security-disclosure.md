# Security disclosure (public fork)

This repository is a **public fork**. Anything published here (PR bodies, issues, ADRs, commit messages that land on default branches) reaches a wider audience than a single private deployment.

## How we handle security fixes

1. **Fix first.** Prefer a patch (or private coordination with maintainers) before publishing reproduction detail.
2. **Describe the control, not the exploit** in public artifacts — PR summaries, issues, ADRs, release notes. Say what role or check is required and that unauthorised callers are denied. Do **not** publish endpoint + method + precondition + impact recipes while a base branch is still unpatched.
3. **Keep reproduction detail private** until the fix is released (or the vulnerable revision is no longer the one operators run). Full notes may live in ignored local paths (e.g. under `.ai/`) or private maintainer channels — not in the public PR body.
4. **Still flag priority.** Public text must make clear that a security fix exists and should be prioritised; vague-to-useless is also a failure.
5. **Commit messages and test names** may name the control (e.g. Editor+ gate). That is enough for review without a walkthrough.

If unsure whether a passage helps an attacker against the **current unpatched** state, omit the recipe and offer detail privately on request.
