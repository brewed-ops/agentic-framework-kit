# greploop runner - `scripts/review.mjs`

The rules in SKILL.md, enforced by code instead of by memory. Node 18+, no npm packages, runs the
same on Linux, macOS and Windows. Run it from anywhere inside the repo under review:

```bash
node <skill-dir>/scripts/review.mjs <command> [options]
```

State lives in `.greploop/run.json` in the reviewed repo. Add this to that repo's `.gitignore`
(the two `!` lines keep the files a project commits on purpose):

```gitignore
.greploop/*
!.greploop/config.json
!.greploop/rules.md
```

## Commands

| Command | What it does |
|---|---|
| `init --base <ref> [--profile quick\|standard\|thorough] [--bundles <file>] [--reset] [--force-size]` | Starts a run: merge-base and head sha, the reviewable file list (Step 0 exclusions applied, each excluded path with its reason), the profile and its budget, the bundles, and the checks the project provides. |
| `snapshot --bundle <id>` | Hashes the bundle's files as they are now and prints the hash (stdout). Take it right before dispatching the bundle's reviewers. |
| `add --bundle <id> --snapshot <hash> [--iter <n>] [--file <reply.json>] [--supplement]` | Validates one reviewer reply (from `--file`, else stdin), refuses it if the bundle changed since the snapshot, re-anchors and scope-checks its findings, stores it. Counts as one reviewer dispatch whether accepted or rejected. |
| `merge <n>` | Closes iteration n: dedupes findings across lenses and bundles, updates the ledger, scores each bundle. |
| `resolve <id> --how "<what changed>" [--test "<cmd>"] [--reverted-exit <n>]` | Marks a ledger row fixed. `--test` is executed and must pass. |
| `dispute <id> --ground A\|B --proof "<quoted line>"` | Marks a ledger row disputed, if the ground and proof hold up. |
| `run <name> --cmd "<command>" [--scope "<what it covered>"]` | Executes a check (test, build, lint, typecheck) and records its exit code and duration. |
| `check <name> --cmd "<command>" --exit <code> [--scope "..."]` | Records a check you ran yourself. Shown as "claimed". Prefer `run`. |
| `scan <path/to/.scanloop/report.json>` | Imports a scanloop report of the current code (refused otherwise): scanner statuses become executed checks or coverage gaps, findings become ledger rows. |
| `assign <file> --bundle <id>` | Adds a file a fix created to the bundle of the file that imports it. |
| `escalate [--profile standard\|thorough]` | Moves the run up a profile, keeping the ledger, checks and scans. The next iteration reviews every bundle. |
| `status` | Per-bundle exit state, open ledger rows, release conditions. Exit 0 = exit condition met, 1 = not met, 2 = budget exhausted. |
| `report [--md]` | The final report, in four sections. |

Every mutating command takes `.greploop/lock`, so two calls cannot overwrite each other's state.
If a crash leaves the lock behind, delete it.

## init

- **Diff.** The working tree against `git merge-base <base> HEAD`, so committed and uncommitted
  changes are both in, and every line number refers to the file as it is on disk. Untracked files
  that are not gitignored are in too, as new files: `init` lists them, they are bundled and
  reviewed like any change, and a file created later shows up as "changed files in no bundle"
  until you `assign` it. Commit, gitignore or delete anything that is not part of the change. An
  empty diff is an error: the base is wrong.
- **Exclusions.** Lockfiles, build output, `node_modules/`, `vendor/`, minified bundles, generated
  code, test snapshots, binaries, DB files, deleted files. Extra globs from
  `.greploop/config.json` `"exclude"`. Tests are never excluded.
- **Bundles.** With no `--bundles`, a diff of at most 10 files and 400 changed lines is one bundle
  called `all`. Anything bigger needs a bundles file, which you write after grouping per Step 0:

  ```json
  [{"id": "auth", "files": ["src/auth/session.ts", "src/auth/session.test.ts"]},
   {"id": "ui", "files": ["src/components/Login.tsx"]}]
  ```

  Every reviewable file must be in exactly one bundle, at most 10 files per bundle. More than 6
  bundles is refused unless you pass `--force-size` (only when the user said to proceed).
- **Profile.** `--profile`, else `.greploop/config.json` `"profile"`, else automatic: `thorough` when a
  non-docs path looks like auth, payments, migrations, secrets or deploy config; `quick` when no
  risky path, no dependency manifest or lockfile, no security headers/config, and the change is
  docs-only or at most 40 lines in at most 3 files; `standard` otherwise. These are path-name
  heuristics. `quick` is refused on a risky path. Choosing `standard` where `thorough` was
  recommended, or `quick` over the size limit, is allowed and written into the report.
- **Checks the project provides.** Detected from `package.json` scripts (`test`, `build`, `lint`,
  `typecheck`), `go.mod`, `Cargo.toml`, pytest config, and Makefile targets.

## Budgets

| Profile | Reviewers per bundle | Max iterations | Max reviewer dispatches |
|---|---|---|---|
| quick | 1 (`"lens": "all"`) | 1 | 2 x bundles |
| standard | 3 | 3 | 12 x bundles (3 lenses x 3 iterations, plus one re-dispatch per lens) |
| thorough | 3 | 5 | 18 x bundles (3 lenses x 5 iterations, plus one re-dispatch per lens) |

`add` refuses (exit 2) once the iterations or dispatches are used. A rejected or partial reply
counts as a dispatch: a reviewer that keeps returning bad JSON is spending the budget. Wall clock is
shown in `status` against the profile's estimate but not enforced.

## snapshot and add - which code a reply describes

A reviewer reads the bundle's files from disk, so its reply describes the files as they were when
it was dispatched. `snapshot --bundle <id>` records a hash of those files (names and contents);
give the same hash to every reviewer of that bundle and pass it to `add --snapshot <hash>`.

- `add` refuses a hash that `snapshot` never issued for that bundle, and refuses the reply when the
  bundle's files no longer match the snapshot: the reviewer read code that is gone. That refusal
  still counts as a dispatch. Take a new snapshot and re-dispatch.
- `merge` refuses while any reply's snapshot differs from the bundle's current files (they changed
  after `add`). Re-dispatch those reviewers on a new snapshot; `add` replaces a reply whose
  snapshot is out of date.
- The merged result stores the snapshot the reviewers saw, so any later edit makes the bundle
  "changed since the iteration N review" in `status`.

In practice: merge before you fix. Editing a bundle between dispatch and merge throws its replies away.

## add - what a reply must look like

One JSON object, optionally inside a single ```` ```json ```` fence, with exactly these keys:

| Key | Rule |
|---|---|
| `lens` | `correctness`, `security` or `quality`; `all` in the quick profile. One reply per lens per bundle per iteration. |
| `score` | Integer 1-5. `4.5` and `"4"` are rejected. |
| `summary` | Non-empty string. |
| `coverage` | Object with EVERY file of the bundle as a key, value `reviewed` or `skipped: <reason>`. Extra keys are ignored. |
| `findings` | Array of `{severity: blocking\|major\|minor, file: "path:line", code, issue, fix}`, all non-empty strings, no other keys. |
| `pre_existing` | Array of `{file, code, issue}` (optional `fix`). |

Consistency: a score of 5 with any finding is rejected (5 means nothing found through that lens),
and a blocking or major finding caps the score at 3.

On rejection the runner prints every violation; re-dispatch that reviewer with them. After the
second invalid reply from the same reviewer it says STOP: show the raw output to the user.

**Partial coverage.** If the only problem is files missing from `coverage`, the reply is held as
partial and the runner names the missing files. Re-dispatch the reviewer for those files only and
add its answer with `--supplement`; the two halves are combined (score = the lower one).

**Re-anchoring.** Each finding's `code` is searched in the named file, whitespace-tolerant per
line (a one-line snippet may be a fragment of at least 4 characters; in a multi-line snippet the
first line may be the tail of a line and the last line the head). The match nearest the claimed
line wins and overwrites it. No match: the finding is kept, marked `unanchored` - the candidate for
a Ground A dispute.

**Scope.** A finding whose anchored lines include none that this diff added or changed (for a pure
deletion, the lines on either side of it count) moves to `pre_existing` - unless its issue text says
the diff broke it ("this change", "the diff", "renamed", "removed", "no longer", "now returns",
"signature changed", and similar). Then it stays, tagged `caller`. This is a keyword heuristic:
reviewers should say plainly when an untouched caller broke because of the change.

## merge

- Findings are the same when they are in the same file and their anchored lines overlap or sit
  within 2 lines, or one snippet contains the other (at least 12 characters, or equal).
- Severity = the highest reported. Raised by 2 or more lenses = `consensus` - fix first.
- The ledger: a merged finding that matches an open or disputed row updates it; one whose snippet
  matches a resolved row reopens it as `regressed`; anything else becomes a new row (`F1`, `F2`...).
- A finding counts against the bundle that owns its file (or, for a file in no bundle, the
  bundles whose reviewers raised it). Bundle score = MIN of its lenses; run score = MIN of bundles.
- The first iteration of a profile reviews every bundle; `thorough` requires every bundle in every
  iteration. Other iterations take whichever bundles need re-review. Merge refuses while a bundle
  is missing a lens or a partial reply is waiting.

## resolve and dispute

- `resolve` needs `--how`. With `--test`, the runner executes it and refuses unless it exits 0.
  `--reverted-exit` is the exit code you saw with the fix reverted - it must be non-zero (0 means
  the test does not prove the fix). This half is recorded by claim; the runner does not revert
  your code. In `thorough`, both are required for every blocking or major reviewer finding.
- `dispute` needs `--ground A|B` and a one-line `--proof`.
  - Ground A (the code is not in the file): refused if the snippet is found in the file.
  - Ground B (one line contradicts the claim): the proof must be a line that exists in the file.
  - Refused for gitleaks hits (suppress a false positive in `.scanloop/allowlist.yml` instead).
  - Refused for protected subjects, detected by keywords in the issue text: null/undefined deref,
    bounds/off-by-one, race/async ordering, behavior or compatibility change, unused parameter. A
    keyword heuristic that errs toward refusing - fix the finding, or prove it with a failing test
    and `resolve --test`.

## scan

Refuses a report that did not scan the current code: it must record a `fingerprint` (scanloop
1.2+), its merge-base must be this run's, its `head.sha` must be the current HEAD, and its
fingerprint must equal the current code's (scan.mjs and review.mjs compute the same sha256 of the
diff against the merge-base plus the bytes of every untracked file, leaving out the scan's own
output files). Then it reads the scanloop report (`tools{name: {status, version, command}}`, `required`, `complete`,
`findings[]`, `verdict`). Each finding becomes (or updates) a ledger row keyed by tool, rule and
file. On a re-import, an open scanner row that a tool which ran no longer reports is resolved as
"no longer reported" - fixed by re-running, not by claim - and a resolved row reported again is
reopened. `missing`, `not-applicable` and `error` tools show up as coverage gaps.

## Release decision

`report` lists each condition as met or unmet, then one line: `Passed the configured checks` or
`Did not pass: <which>`. The conditions:

- the review exit condition holds for every bundle (SKILL.md Step 2.4), and every changed file is in
  a bundle
- no open blocking or major ledger row, reviewer or scanner
- a scanloop report was imported, its verdict is not INCOMPLETE, and every scanner it lists as
  required ran
- each required check ran on the current code and exited 0
- `thorough` only: a full-history gitleaks sweep ran (a gitleaks entry whose command has no
  `--log-opts`, or a report with `"fullHistory": true` from `scan.mjs --full-history`), and every
  blocking/major fix has a passing test plus a non-zero `--reverted-exit`

"Current code" is a sha256 fingerprint of the diff against the merge-base plus the name and bytes
of every untracked file. A check is bound to the fingerprint from just before it ran, a scan to the
one scanloop recorded before its scanners started. Either is stale after any later edit, including
an edit to an untracked file; committing does not make it stale, editing does. scanloop marks a
scan of an uncommitted tree INCOMPLETE (gitleaks reads commits only), so untracked or uncommitted
work cannot reach "Passed the configured checks".

Required checks: `.greploop/config.json` `"requiredChecks": ["test", "build"]` when present;
otherwise every check the project provides plus every check you recorded. When no required check
is named `test` and no `test` check passed, the decision line says `untested` explicitly.

The report never claims the code is correct. Lens scores appear as reviewer confidence.
