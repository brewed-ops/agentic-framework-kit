# One greploop run, start to finish

The `since-filter` change from the [benchmark](../benchmark/): a new `?since=<id>` filter on the notes
list, 21 lines in 3 files, with a planted off-by-one that the project's own tests do not catch. Every
command and its output is in [`transcript.txt`](transcript.txt). The final report is [`report.md`](report.md)
and the fix is [`fix.diff`](fix.diff). Run on 2026-09-24 in Claude Code, with reviewers on Claude Opus 5.5.

## What happened

| Step | Result |
|---|---|
| `init` | Auto-picked the **quick** profile: 21 lines, 3 files, no risky paths. Budget: 1 iteration, 2 reviewer runs |
| Iteration 1 (quick: one reviewer, all lenses) | Score 2. 2 blocking, 1 major, 1 minor. Budget used, so `status` said escalate |
| scanloop | gitleaks and semgrep ran, osv-scanner not applicable (no lockfile changed): clean |
| `escalate --profile standard` | Same ledger, next iteration reviews everything with the 3-lens panel |
| Iteration 2 (panel) | Every lens scored 3. All three reported F1, F2 and F3 (consensus). No false alarms |
| Validate, then fix | F1 was already proven by the benchmark's proof test. F2 and F3 were confirmed by reading the code. Three small fixes, each checked by reverting it and watching the new test fail |
| `resolve` x3, tests, lint, scanloop again | The runner ran the tests itself for each resolve: all green |
| Iteration 3 (fresh panel, given the ledger) | All three confirmed F1-F3 fixed at the root. Each scored 4, with only the two known minors left |
| `status` | **Not clean**, because of a greploop bug (below). After the fix: clean. Report: "Passed the configured checks" |

The findings, in plain words:
- **F1** (blocking): `since=<id>` returned the note with that id too (`>=` instead of `>`). That is the planted bug.
- **F2** (blocking): the test for it used another user's note id as the boundary, so it passed either way.
- **F3** (major): a malformed `since` (`abc`, `-1`) silently returned every note instead of a 400.
- **F4, F5** (minor, left open): no test combines `since` with paging, and `since` assumes numeric ids.
  The report lists both. Minors never block.

Iterations 1 and 2 reuse the benchmark replies, which were made on this exact commit, so they were
not run twice. Iteration 3 used three new reviewers ([`replies/`](replies/)), each given the ledger.

## The bug this run found in greploop itself

After iteration 3 the exit gate said "fewer than 2 of 3 reviewers scored 5". The old rule required two
5s, but the rubric defines 4 as "a minor issue", and the skill says minor findings never block. So a
change with only minor findings left could never finish, and the loop would push you to polish nits
or burn iterations. The rule is now: **every reviewer at 4 or 5**, with zero blocking or major findings.
A blocking or major finding caps a reply at 3, so a 4 can only mean "minors only". This is stricter
about a lone lucky 5, because all three reviewers now have to clear the bar, not just two. The
transcript shows the gate before and after the change, and
`tests/greploop-review.test.mjs` now has a test that fails under the old rule.

It also exposed a small leak: scanloop wrote each scanner's full executable path, including the home
folder, into the report. Scanners are now recorded by file name only.

## What this run does and does not show

It shows the mechanics working on a real change, end to end:
- profile choice and escalation
- strict reply validation, merge and consensus
- a fix checked against its revert
- checks the runner executed itself
- scanner status
- the four-section report, whose release decision is built from those facts

It is one run on a small change. How often greploop catches bugs is the benchmark's question, not
this page's.
