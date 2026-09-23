# greploop benchmark

Does the review step catch real bugs? Does a panel of three reviewers beat one? Does it cry wolf on
clean code? This folder answers those questions with a small, repeatable test instead of an opinion.

## What was tested

8 changes to a tiny notes API ([`../demo-notes-api`](../demo-notes-api)):

| Case | Lines changed | What is in it |
|---|---|---|
| since-filter | 20 | Planted bug: off-by-one (`>=` where the contract says "after") |
| delete-endpoint | 13 | Planted bug: any user can delete anyone's note (IDOR) |
| update-endpoint | 29 | Planted bug: bad JSON crashes the whole server |
| list-field-rename | 6 | Planted bug: renamed response field breaks the client in a file the diff never touched |
| persist-to-disk | 35 | Planted bug: un-awaited save - a failed write kills the process |
| validation-refactor | 10 | Planted bug: a "refactor" drops the length limit and edits the test that caught it |
| health-endpoint | 13 | Meant to be clean (turned out not to be - see below) |
| page-size-cap | 13 | Clean |

Every planted bug **passes the project's own tests** - a bug CI already catches proves nothing about
review. Each one is proven real by a test in [`proofs/`](proofs/) that fails on the change and passes after
the reference fix in [`fixes/`](fixes/). Run `node bench.mjs verify-key` to check that yourself.

Two conditions, fresh reviewers, no reviewer ever saw the answer key:
- **single** - one reviewer covering all three lenses (greploop's quick mode)
- **panel** - three reviewers, one lens each (correctness, security and contracts, quality gates)

Each reviewer got the prompt in [`reviewer-prompt.md`](reviewer-prompt.md), filled in by
`node bench.mjs prompt <repo> <lens>`: greploop's own lens text, scope rule, rubric and JSON shape, the
project's house rules, and the JavaScript section of greploop's file rules.

## Results

Run on 2026-09-24 with Claude Code (reviewer model Claude Opus 5.5, the `code-reviewer` subagent), one
run per reviewer. Numbers from `node bench.mjs score`:

| Condition | Reviewer runs | Planted bugs caught | Seen only as minor | Missed | Clean changes passed | False alarms | Other real issues (distinct) |
|---|---|---|---|---|---|---|---|
| panel | 24 | 6/6 | 0 | none | 1/2 | 0 | 9 |
| single | 8 | 6/6 | 0 | none | 1/2 | 0 | 9 |

"Caught" means a blocking or major finding that names the planted defect. A bug reported only as minor
would count as missed, because the loop does not fix minors - that did not happen here.

**What this says:**
- On small changes (6 to 35 lines), one reviewer found every planted bug. The three-reviewer panel found
  the same ones at three times the runs. That is why greploop now defaults small, low-risk changes to one
  reviewer and keeps the panel for bigger or riskier ones - this test gives no evidence that the panel
  earns its cost at this size.
- No false alarms: every blocking or major finding was checked against the code and was true.
- **The "clean" health-endpoint change was not clean.** All 4 reviewers flagged that moving URL parsing
  above the auth check turns an unauthenticated `GET //` from a 401 into a 500. That was not planted - it
  was a mistake made while writing the case, and a raw-socket probe confirmed it (401 on `main`, 500 on the
  change). It is counted as a real issue, not a false alarm, and the case was left as written: rewriting it
  after seeing the results would be grading our own homework.
- Reviewers also found 9 real problems nobody planted (distinct, per case), such as tests that cannot
  detect the bug they sit next to, overlapping file writes, and a loader that crashes on a corrupt file.
  Every verdict and its reason is in [`judge-rules.mjs`](judge-rules.mjs); the raw replies are in
  [`results/`](results/).

## Limits - read these before quoting the numbers

- 8 cases and one run per reviewer. That is a smoke test, not a statistic. A second run could differ.
- Every reviewer was the same model. The panel's lenses diversify the question, not the model, so they
  can share a blind spot; this test cannot show that because nothing was missed.
- The cases are small and each has one obvious seam. Bigger diffs, with several files per bundle, are
  where a single reviewer is more likely to cut corners - untested here.
- The verdicts ("seeded", "real", "false-alarm") are the maintainer's, not an independent judge's. They
  are written out one by one so anyone can disagree with a specific call.
- No other AI tool has been benchmarked yet. The prompts are plain text, so the same run works in any
  tool that can spawn a fresh reviewer.

## Run it yourself

```bash
node bench.mjs verify-key                 # prove every planted bug and every reference fix
node bench.mjs build /tmp/greploop-bench  # one blind repo per case
node bench.mjs prompt /tmp/greploop-bench/since-filter all > prompt.txt
# give prompt.txt to a fresh reviewer in your tool; save its JSON reply as
# results/since-filter/single.json (or panel-correctness.json, panel-security.json, panel-quality.json)
node judge-rules.mjs                      # after adding rules for any new finding
node bench.mjs score
```
