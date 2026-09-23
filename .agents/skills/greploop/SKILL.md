---
name: greploop
description: Automated code-review loop. The diff is split into bundles of related files; each pass dispatches a PANEL of fresh strict-reviewer subagents per bundle (correctness / security+contracts / quality-gates) that read the changed files in full, apply per-file-type rules, score 1-5 with snippet-anchored findings, and the main agent applies the fixes - re-reviewing from clean context until the panel agrees 5/5 with zero blocking/major findings, or 5 iterations max. Use when the user says "/greploop", "review loop", "loop until 5/5", "auto-fix this PR", or wants a PR/branch driven to a clean review without leaving the terminal. No external review service required - the reviewers are fresh subagents (or fresh sessions) of whatever AI coding tool you use.
---

# greploop - local review loop (no paid reviewer)

A self-hosted take on greptile/CodeRabbit-style review. Same iterate-to-clean loop, but
instead of calling a paid API for the score, a PANEL of fresh reviewer subagents from your own
AI tool scores the diff each pass. On a flat-rate plan re-reviewing and running several
reviewers costs nothing extra - lean on it; on pay-per-token billing each pass costs tokens, which
is one more reason to keep diffs small. That ensemble is what makes
this MORE robust than one reviewer, not less: one reviewer has one blind spot; orthogonal
lenses don't share it.

Pairs with **scanloop**: scanloop runs the deterministic catch (gitleaks secrets, semgrep
SAST, osv-scanner dep CVEs) on the diff first. greploop is the LLM-JUDGMENT layer - it does
NOT re-implement that scanning; it treats any scanloop finding as a pre-seeded blocking item.

## The two roles (never blur them)

- **Reviewer panel** = fresh subagents. Claude Code: the `code-reviewer` agent type (fall back
  to `general-purpose`). Codex, Cursor, Antigravity, Copilot CLI (`/fleet`) and VS Code: their
  subagent feature - ask for it explicitly (Codex only spawns subagents when told to).
  **No subagents available** (e.g. Copilot's cloud agent): run the three lenses one after
  another, and start each one from a FRESH context - a new session or chat that gets only the
  diff, the rules and that lens - never the conversation that wrote the code. They ONLY read
  code and return a verdict - they NEVER edit files. A new
  panel is spawned every iteration so each review starts from a clean context: this keeps the
  score honest instead of a reviewer rubber-stamping its own earlier opinion.
- **Fixer** = you, the main agent. You apply the fixes, maintain the finding ledger across
  iterations, and run the merge. You never score your own work. The merge is mechanical, not a
  sixth opinion.

## Step 0 - Resolve the target

1. PR mode (`/greploop 80`): `gh pr checkout <n>`; the diff is `git diff <base>...HEAD` where
   base = `gh pr view <n> --json baseRefName`.
2. Local mode: diff against the default branch. Resolve it in order - (a) `git symbolic-ref
   --short refs/remotes/origin/HEAD` then strip `origin/`; (b) if that fails, test which of
   `main`/`master`/`develop` exists via `git rev-parse --verify`; (c) if still ambiguous, STOP
   and ask. Never assume `main`. Then sanity-check the captured diff is non-empty - an empty
   diff means the base is wrong; stop and re-resolve.
3. Dirty working tree: **default to committing the in-scope change on the current branch.**
   NEVER `git stash` in a shared / monorepo working tree (one repo holding many projects) - stash reverts every project's uncommitted work and `pop` can fail to
   restore it. If unrelated changes are mixed in and you cannot commit cleanly, STOP and ask how
   to isolate. Never review a mix of committed + uncommitted noise.
4. Exclude non-reviewable paths from the captured diff (they blow context and waste findings):
   lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `*.lock`), build/framework output (`dist/`,
   `build/`, `.next/`, `.astro/`, `.svelte-kit/`, `.turbo/`, `.vite/`), `node_modules/`,
   `vendor/`, minified bundles (`*.min.js`, `*.min.css`), generated code (`*.generated.*`,
   `*.gen.*`), test snapshots (`__snapshots__/`, `*.snap`), binaries, DB files. Use a pathspec,
   e.g. `git diff <base>...HEAD -- . ':(exclude)package-lock.json' ':(exclude)dist/'`.
   **Do NOT exclude test files.** open-code-review excludes tests; greploop must not - R3 checks
   that tests were added and not weakened to pass, which it cannot do on a diff with tests removed.
   Record every excluded path with its reason; it goes in the final report.
5. **Bundle the files.** Partition the reviewable files into bundles of related files - each
   file in exactly one bundle, max 10 files and ~400 changed lines per bundle. Group by, in
   order: a source file with its own test; producer + consumer (interface/type + implementation,
   a hook + the component that uses it, an API route + its client in `lib/`); variants of one
   resource (`en.json` + `es.json`, light + dark theme files); same feature folder serving one
   concern. A file unrelated to everything else is its own bundle. A diff under ~400 lines and
   ~10 files is simply ONE bundle - the old single-panel flow, unchanged.
   Why: one reviewer context holding a whole big diff cuts corners and misses files; a bundle is
   small enough to hold fully, and grouping keeps the cross-file pairs (source+test, type+impl)
   in the same context where their mismatches are visible. (Ported from open-code-review's file
   grouping, which runs this at Alibaba scale.)
   Size ceiling: more than 6 bundles (~2,500 changed lines) is still too big to converge in 5
   iterations - report the bundle list and recommend splitting the PR; proceed only if the user
   explicitly says to.
6. Capture the diff once at the top of each iteration (it changes as you fix).

## Step 1 - Load review criteria

Read the project's instructions file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or
`.cursor/rules/` - whichever your tool uses) plus your global rules file, and extract every hard
rule the reviewer must enforce - e.g. no emoji in UI, no hardcoded colors, one icon library,
anti-slop card patterns, tests must stay green. Pass these to the panel as MUST-CHECK items. A
finding that violates a stated house rule is always `blocking`.

Then load per-file rules: read `references/file-rules.md` next to this SKILL.md and, for each
bundle, attach ONLY the sections whose globs match that bundle's files (first match wins per
file; unmatched files get the Default section). Scoped rules keep each reviewer's attention on
what can actually go wrong in those file types instead of a wall of every rule for every stack.
A project can add its own `.greploop/rules.md` in the same format - its sections are appended
after the built-in ones for matching files. If `references/file-rules.md` is missing (a bare
single-file install), skip this and review on the lenses alone.

## Step 1.5 - Finding ledger (you, the fixer, own this across iterations)

Keep a running table for the whole run: `finding -> iteration raised -> how fixed -> status
(open|resolved|disputed)`. Because each reviewer panel is fresh and has no memory, this ledger
is the only thing that catches (a) a fix that silenced a symptom instead of the root cause and
(b) a finding that regressed in a later pass. Hand the ledger to every new panel as
"PREVIOUSLY-RAISED - confirm each is still genuinely resolved at its root; re-flag any that
regressed." The loop cannot exit while any ledger row is `open`.

## Step 2 - The loop (max 5 iterations, panel review)

For iteration `i` from 1 to 5:

1. **Review (panel of 3 per bundle, in parallel).** For every bundle that needs review this
   iteration (see "Which bundles re-review" below), dispatch its three reviewers, all at
   once so they run in parallel (in one message or batch where your tool allows it). Each reviewer gets its bundle's diff and file
   PATHS (the files it owns), the list of the OTHER changed files as context only, the
   MUST-CHECK rules, the bundle's matched file-rules sections, the ledger rows for its files,
   and a DIFFERENT lens. **Every reviewer must, before scoring: read each of its files in FULL
   (not just the hunk), and `grep` the repo for callers/importers of any changed/removed/renamed
   symbol** - a diff alone hides cross-file regressions.
   **Scope rule (give it to every reviewer verbatim):** findings must target code in YOUR
   bundle's files that this diff added or changed, or a caller anywhere that this diff broke.
   Other files are evidence, never the subject. A real problem in code the diff did not touch
   goes in `pre_existing`, not `findings` - it is reported but never blocks the loop, because the
   loop cannot converge on bugs this change did not introduce. Deleted lines are reference only.
   Lenses:
   - **R1 Correctness & regressions** - logic errors, edge cases, off-by-one, null/undefined,
     error & failure handling, state leaking across layers, races, and dead callers of anything
     removed/renamed.
   - **R2 Security & contracts** - authz / IDOR / broken access control, business-logic abuse,
     injection beyond scanloop's reach, API / type / DB-response contract drift, backward-compat.
   - **R3 Quality gates** - performance footguns (N+1, work in loops, O(n^2)), test coverage of
     the change (added or updated, not weakened to pass), and EVERY MUST-CHECK house rule.
   Each reviewer scores ONLY through its lens and returns strict JSON:
   ```json
   {
     "lens": "correctness|security|quality",
     "score": 1-5,
     "summary": "one line, incl. which callers/files you opened",
     "coverage": {"path/a.ts": "reviewed", "path/b.css": "skipped: <concrete reason>"},
     "findings": [
       {"severity": "blocking|major|minor", "file": "path:line",
        "code": "the offending line(s), copied VERBATIM from the file",
        "issue": "what's wrong", "fix": "concrete change to make"}
     ],
     "pre_existing": [{"file": "path:line", "code": "verbatim", "issue": "..."}]
   }
   ```
   Each reviewer must enumerate ALL findings it sees, not stop at the first blocker. If a
   reply isn't parseable as this shape, re-dispatch that one reviewer once with "return ONLY the
   JSON object"; if it fails again, STOP and surface the raw output - never treat an unparseable
   review as a pass. **Coverage is mandatory:** every path in the reviewer's bundle must appear
   in `coverage` as `reviewed` or `skipped: <reason>`. A missing path means the reviewer cut corners - re-dispatch
   that reviewer for the missing files only. (Ported from alibaba/open-code-review: agents on
   bigger diffs silently review some files and drop others.)
2. **Merge (mechanical - you do this, no new subagent).** First re-anchor every finding: grep
   its `code` snippet in the named file and overwrite the line number with where it actually
   is - LLM line numbers drift, verbatim snippets do not. A snippet that matches nowhere in the
   file is a hallucinated location: re-read the file for what the `issue` describes; if it is
   not there, mark the finding `disputed`. Then union, deduped (same file and overlapping
   snippet, or within +/-2 lines); on a dup keep the clearest `fix` and set severity
   = MAX across reviewers. Dedupe across bundles too: a broken caller can be reported by the
   bundle that changed the symbol AND the bundle that owns the caller. Findings raised by 2+
   lenses are `[consensus]` - fix first. A `findings` entry that targets code the diff did not
   touch is moved to `pre_existing` (the scope rule, enforced mechanically). Bundle score = MIN
   of its three lenses; run score = MIN across bundles.
3. **Validate before fixing.** For each `blocking`/`major`, confirm it against the real code
   (read the lines, trace the logic, or write a quick failing test) BEFORE editing. Apply only
   confirmed findings; mark any you cannot reproduce `disputed` in the ledger and do NOT edit on
   it - a wrong `fix` field applied blindly injects real bugs. Disputed items don't block exit
   but are reported.
   **Disputing is the exit's loophole - you wrote the code, so your "can't reproduce" is the
   least trustworthy opinion in the loop.** A finding may be disputed ONLY on one of two grounds,
   and the ledger row must quote the proof: (A) the code it describes is not in the named file,
   or (B) a specific line in the file literally contradicts its central claim (it says "unused",
   the line shows the use; it says "no guard", the guard is right there) - one line, no chain of
   reasoning. "Looks fine to me", "unlikely in practice", and "can't confirm" are not grounds.
   **Never dispute a protected subject** - null/undefined deref, bounds/off-by-one, races and
   async ordering, a behavior or compatibility change (a field, message, status, default, or error
   path the old code produced and the new code does not), or a parameter accepted and never used.
   These are where a wrongly dropped finding costs most and your confidence is least reliable:
   fix them or prove them with a failing test. (Ported from open-code-review's review-filter
   prompt: keeping a wrong finding costs seconds, dropping a right one ships the bug.)
4. **Check exit.** A bundle is CLEAN when ALL hold: its merged findings have zero `blocking`
   and zero `major`; none of its ledger rows is `open`; none of its reviewers scored <= 3; at
   least 2 of its 3 reviewers scored 5; and every one of its files is `reviewed` or skipped with
   a reason. A lone 5 never makes a bundle clean. STOP success only when EVERY bundle is clean.
   (Minor/nits and `pre_existing` never block - report, don't loop on taste.)
5. **Fix.** Apply confirmed `blocking`/`major` findings, `[consensus]` first. Smallest change
   that resolves each - surgical, no drive-by refactors. Update the ledger.
6. **Verify.** Run what the repo provides: `npx tsc --noEmit`, lint, the test script. A fix that
   breaks the build is not a fix - resolve before continuing. **If the repo provides NO
   build/lint/test gate, say so explicitly and treat the change as UNVERIFIED** - the panel score
   is then a code-read only; never claim "verified"/"tests pass" when nothing ran, and cap the
   reported confidence at 4 with "untested - manual verification needed". At minimum confirm the
   changed files still parse.
   **Every fix ships with an assertion that FAILS when the fix is reverted.** Check it: comment the
   fix out, run the test, watch it go red, restore. A test that stays green with the fix gone
   proves nothing - the most common version is asserting the fixed state instead of the broken one
   (a `hidden` pill asserted via the `.hidden` property, which was true the whole time the pill
   rendered). The next panel will find every one of these; find them first.
7. **Commit.** Atomic commit describing what this pass fixed (nothing fixed = nothing to commit;
   that's a valid clean exit). **Every number in the body is copied from tool output, never
   recalled or hand-counted** - check totals, byte sizes, "fixed" claims. Re-read the diff for any
   "fixed X" line and confirm X in the file (`cat -A` for whitespace). A body that overstates its
   own verification is itself a finding. Re-capture the diff and continue. In PR mode, push ONCE after the
   loop ends, not every pass (avoids 5 noisy CI runs); local mode commits only (push if asked).

If iteration 5 ends without meeting the exit condition, STOP. Do not exceed the cap.

**Which bundles re-review.** Iteration 1 reviews every bundle. After that, re-review a bundle
when (a) it is not yet clean, (b) a fix this pass edited one of its files, or (c) a fix changed
the signature, return shape, or behavior of a symbol one of its files imports - grep for the
importers, don't guess. A clean bundle that none of those touched stays clean; re-reviewing it
only adds noise. If a fix creates a new file, add it to the bundle of the file that imports it.

## Confidence rubric (give this to every reviewer)

- **5/5** - Ships. Correct, no bugs, follows house rules, no security/perf footguns, tests cover
  the change, no broken callers.
- **4/5** - Solid but a minor issue or a missing edge case / test.
- **3/5** - Happy-path only; a real bug, a missing guard, a broken caller, or a house-rule
  violation.
- **2/5** - Broken or unsafe in a common case; logic error, unhandled failure, leaked domain
  state across layers.
- **1/5** - Does not work, or introduces a security hole / data loss / crash.

Each reviewer scores the WORST material problem WITHIN ITS LENS, not an average and not problems
outside its lens. These anchors describe outcomes, not a substitute for actually reading the
files and callers - a 5 is only valid after the full-file + caller check. The panel score is the
MIN across lenses, so one blocking bug in any single lens caps the whole verdict at 2.

## Why it stays small

The loop only converges if each reviewer's slice is small enough to hold in one clean context.
Bundling (Step 0, item 5) is what makes that true for a mid-size diff: each panel sees at most ~400
lines, with the files that must be read together kept together. It does not rescue a 9k-line
PR - past ~6 bundles the fix/re-review churn outruns 5 iterations and cross-bundle regressions
multiply. Split that PR before looping; don't burn five iterations on something un-reviewable.

## Why a panel, not one reviewer

One reviewer is one noisy sample with one blind spot - a clean 5/5 from it is weak evidence.
Three orthogonal lenses don't share a blind spot, so a whole bug class (an authz hole the
correctness lens skims past) still gets caught, and the exit gate (2-of-3 at 5, none <= 3) means
no single lucky 5 ships. Diversity comes from different LENSES (deterministic, reproducible), not
temperature jitter. On a flat-rate plan the extra reviewers cost nothing; either way the real ceiling is coordination, so
keep diffs small and require JSON-only replies. It is still LLM judgement, not proof - only an
actual run earns the word "verified".

## Final report

When the loop ends, print:
- mode (local branch / PR #n), iterations run, bundles (label + file count each), panel size
- coverage: `N files changed = X reviewed + Y skipped (reason each) + Z excluded (reason each)`.
  The three must sum to N; if they don't, a file fell through and the run is not done.
- final run score + per-bundle, per-lens scores, and whether the change was verified or UNVERIFIED
- fixed this run: resolved findings (from the ledger)
- remaining: minor findings left, disputed findings (each with its Ground A/B proof), or - if
  you bailed at the cap - the open blocking/major items and why they resisted fixing
- pre-existing: real problems in code this diff did not touch - candidates for a separate PR
- next: e.g. "ready to merge" / "needs manual decision on X" / "split the PR" / "verify manually"
