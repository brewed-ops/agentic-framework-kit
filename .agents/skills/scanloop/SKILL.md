---
name: scanloop
description: Free local static-analysis + secret-scan pass on the current diff - the deterministic half greploop's LLM reviewer can't do. A bundled Node runner (scripts/scan.mjs, zero dependencies) runs gitleaks (secrets), semgrep (SAST, telemetry off, pinnable rules) and osv-scanner (dependency CVEs) on the changed files, applies a committed allowlist whose entries need a reason and a review date, collates findings into greploop's finding shape, and writes a report.json with tool versions, commands and a CLEAN / BLOCKING / INCOMPLETE verdict. A missing or failed required scanner is INCOMPLETE, never clean. Use when the user says "/scanloop", "scan pass", "security scan the diff", "run the scanners", or right before greploop in the build loop. No paid service - all tools are open-source and run locally; code never leaves the machine.
---

# scanloop - local static + secret scan (no paid reviewer)

The deterministic complement to greploop. greploop is an AI reviewer panel - smart, but it can
*miss* a hardcoded key or an injection sink. scanloop runs real open-source scanners that don't
miss those, scoped to the diff, then feeds what they find into greploop so the LLM panel triages
and applies the fixes. The scanners FIND; greploop FIXES. They compose.

**Privacy (the whole point - read this).** Your CODE never leaves the machine. semgrep always runs
with `--metrics=off` and never `--config auto` (that logs in to semgrep.dev and sends usage
metrics). Registry packs (`p/...`) are downloaded as rules - nothing about your code is uploaded.
The one disclosed exception: osv-scanner sends dependency NAME+VERSION (not code) to OSV.dev to
look up CVEs - set `"osvOffline": true` in `.scanloop/config.json` for zero egress on sensitive
client code.

## The tools it drives

| Job | Tool | Scope |
|-----|------|------|
| Secret scanning | **gitleaks** | the commit range `<merge-base>..HEAD`, always with `--redact` |
| SAST | **semgrep** | the changed files it has rules for, `--baseline-commit <merge-base>`, `--metrics=off` |
| Dependency CVEs | **osv-scanner** | only the changed lockfiles/manifests, never the tree |

Install all three if you can (the brewedops-app bootstrapper does it in Phase 1). **Windows:**
all three run native. semgrep installs via `pip install --user semgrep` into your Python user
Scripts folder (e.g. `%APPDATA%\Python\Python3xx\Scripts`) - add that to PATH if `semgrep` is
not found. The runner finds `.exe` tools on PATH; a `.cmd`/`.bat` shim is not spawned (point the
env override below at the real executable instead).

## Step 1 - Run the scanner (primary path)

From anywhere inside the repo:

```bash
node <skill-dir>/scripts/scan.mjs            # base resolved automatically
node <skill-dir>/scripts/scan.mjs --base main --json   # report JSON on stdout, summary on stderr
node <skill-dir>/scripts/scan.mjs --full-history       # gitleaks over ALL history (onboarding)
```

| Flag | Meaning |
|---|---|
| `--base <ref>` | diff base. Default: `origin/HEAD` (stripped to the branch), then `main`, `master`, `develop`. None found = exit 2 |
| `--out <dir>` | where report.json and the raw tool outputs go. Default `.scanloop` |
| `--json` | print the full report JSON to stdout (the human summary moves to stderr) |
| `--full-history` | gitleaks scans every commit, not just this change. Run it on onboarding and now and then - a key committed long ago never shows up in a future diff |

**Exit codes** - act on these, not on the prose:

| Exit | Verdict | Meaning |
|---|---|---|
| 0 | `CLEAN` | every required scanner ran and found no blocking or major issue |
| 1 | `BLOCKING` | at least one blocking or major finding - hand them to greploop |
| 2 | `INCOMPLETE` | a required scanner is missing or errored, no scanner ran, the working tree is not committed, or files changed during the scan - **never report this as clean** |
| 2 | (usage) | bad flag, not a git repo, base not found, nothing to scan, bad config.json |

What the runner does, in order:

1. Deletes this run's previous `report.json` and raw outputs (`gitleaks.json`, `semgrep.json`,
   `osv.json`) first, so a stale report can never be read as this run's result. The report is
   written last, atomically; if the runner crashes there is no report, not an old one.
2. Resolves base, merge-base and HEAD; records their shas and the start time. Changed files =
   `git diff --name-only --diff-filter=d <merge-base>...HEAD`. HEAD with no commits beyond the base
   is a usage error (commit the change, or pass `--base`).
3. Scopes each tool: gitleaks gets the commit range; semgrep gets an explicit file list (never a
   directory - target discovery in a big monorepo can hang) of only the files in a language it
   has packs for, with packs chosen from the changed extensions (`p/javascript`, `p/typescript`,
   `p/react`, `p/python`, `p/golang`, `p/java`, `p/kotlin`, `p/ruby`, `p/php`, `p/csharp`,
   `p/rust`, `p/c`, `p/dockerfile`) on top of `p/security-audit` + `p/secrets` +
   `p/owasp-top-ten`; osv-scanner gets `-L <file>` for each changed lockfile/manifest it can read.
4. Runs the three in parallel and records per tool: `status`, `version` (from its own version
   command), the exact `command` array, `exitCode`, `reason`, finding count.
5. Applies the allowlist (Step 2), normalizes and demotes (Step 3), writes the report, prints a
   short summary and exits with the code above.

**Tool status:** `ran` | `not-applicable` (nothing for it in this diff, e.g. no lockfile changed)
| `missing` (not on PATH) | `error` (exit >= 2, no output file, unparseable output, or exit 1 with
no findings in the output). Exit 1 with parseable findings is the normal "found something"
result, not an error. osv-scanner's exit 128 ("no packages in the lockfile") counts as ran, empty.

**Uncommitted tree = INCOMPLETE.** gitleaks only scans commits, so an uncommitted edit or an
untracked file (not gitignored) was never secret-scanned. The runner still runs (semgrep drops
`--baseline-commit` on a dirty tree, since it aborts otherwise), lists the files in `untracked` and
`incompleteBecause`, and returns INCOMPLETE. **Commit the in-scope change first - do NOT `git
stash`.** In a repo shared by several projects, stash reverts every project's uncommitted work
and `pop` can fail to restore it. Gitignore scratch files so they do not count.

**What was scanned.** The report records `fingerprint`: a sha256 of the diff against the merge-base
plus the bytes of every untracked file, taken before the scanners start (and checked again after -
a change mid-scan is INCOMPLETE). greploop's `review.mjs scan` recomputes it and refuses a report
whose merge-base, commit or fingerprint is not the current code's, so a report of older code can
never count as this scan.

### Required tools and config

Default: **gitleaks + semgrep** are required; **osv-scanner** is required only when a
manifest/lockfile changed. A required tool that is `missing` or `error` makes the scan
`INCOMPLETE`. A tool with nothing to scan in this diff is `not-applicable` and does not count
against the scan. Override per project in `.scanloop/config.json` (committed):

```json
{
  "required": ["gitleaks", "semgrep", "osv-scanner"],
  "semgrepConfigs": ["./.scanloop/rules/"],
  "osvOffline": true
}
```

- `required` - which tools must run when they apply (subset of the three).
- `semgrepConfigs` - replaces the registry packs entirely (paths or `p/...` ids). A local path
  that does not exist is an `error`, not a silent skip.
- `osvOffline` - adds `--offline --download-offline-databases` to osv-scanner.

### Pinning rule packs (reproducible results)

Registry packs (`p/security-audit`, ...) are fetched live and **change over time** - the same
commit can pass today and fail next month. The report marks this: `tools.semgrep.pinned` is
`false` and a note says so. To pin, vendor the packs into the repo once and point
`semgrepConfigs` at the folder:

```bash
mkdir -p .scanloop/rules
for p in security-audit secrets owasp-top-ten javascript typescript; do
  curl -sL "https://semgrep.dev/c/p/$p" -o ".scanloop/rules/$p.yml"
done
```

Commit `.scanloop/rules/`, set `"semgrepConfigs": ["./.scanloop/rules/"]`, and refresh the files
deliberately (a reviewed commit) when you want newer rules. The report then shows
`pinned: true`, the configs used, and the semgrep version - enough to reproduce a result.
Note: semgrep prefixes vendored rule ids with the folder path (e.g.
`scanloop.rules.javascript.lang...`), so allowlist `rule:` values written against registry ids
need that prefix after you switch. Check the semgrep rules license covers your use before
committing rules to a public repo.

### Env overrides (tests, odd installs)

`SCANLOOP_GITLEAKS`, `SCANLOOP_SEMGREP`, `SCANLOOP_OSV` replace the command for that tool. The
value is either a **JSON array** (`["node", "/path/fake-gitleaks.mjs"]` - the first item is the
executable, the rest are prepended args) or **a single executable path**, used whole (spaces in
the path are fine; it is never split).

### report.json

```
verdict, complete          CLEAN | BLOCKING | INCOMPLETE, and whether every required tool ran
startedAt, finishedAt
base {ref, sha, mergeBase}, head {sha, branch}, dirty, untracked[], fullHistory, changedFiles
fingerprint, outDir        what was scanned (sha256, see above) and where the outputs went
required, requiredConfigured, incompleteBecause
tools.<name>               status, required, version, command, exitCode, reason, findings,
                           (semgrep) configs, pinned, baseline
counts {blocking, major, minor}
findings[]                 greploop's finding shape (Step 3)
suppressed {total, byEntry[] with a per-entry suppressed count}
allowlistProblems[]        entries that did NOT suppress: invalid | expired
notes[]                    uncommitted tree, unpinned rules, package.json without lockfile, ...
```

Add the outputs to `.gitignore` (keep config and allowlist committed):
`.scanloop/report.json`, `.scanloop/gitleaks.json`, `.scanloop/semgrep.json`, `.scanloop/osv.json`.
gitleaks runs with `--redact`, so no secret value is written to its output or to the report.

## Step 2 - The committed false-positive allowlist

`.scanloop/allowlist.yml` (or `.scanloop/allowlist.json` with the same fields, as an array or
`{"suppressions": [...]}`) is a small, committed, reviewable list of already-triaged false
positives so they don't re-block every run:

```yaml
# .scanloop/allowlist.yml - committed; every entry needs a reason and a review date
suppressions:
  - tool: semgrep            # gitleaks | semgrep | osv-scanner
    path: "server/db.ts"     # exact, or a glob: * within a folder, ** across folders
    rule: "javascript.sequelize.security.sequelize-injection"   # the finding's rule_id
    reason: "param is an internal enum, not user input - AB 2026-06-20"
    expires: 2026-12-31      # YYYY-MM-DD review date
```

- Matching is tool + path + rule. `rule` is the finding's `rule_id` (gitleaks RuleID, semgrep
  check_id, osv vulnerability id).
- `reason` and `expires` are **required**. An entry missing either, with a bad date, or an
  unknown tool is `invalid`; one whose `expires` has passed is `expired`. Neither suppresses
  anything - the finding comes back and the entry is listed in `allowlistProblems` so a human
  re-triages it (renew the date with a fresh reason, or delete the entry).
- The runner parses exactly this list-of-maps shape (no YAML library): `key: value` pairs,
  quoted or plain values, `#` comments. Anything else in the file is reported as `invalid` and
  nothing from that file suppresses.
- The report counts how many findings each entry suppressed; an entry that suppresses nothing
  for a long time is a candidate for removal.

Prefer each tool's NATIVE ignore too (`.gitleaks.toml [allowlist]`, `.gitleaksignore`,
`.semgrepignore`, inline `# nosemgrep: <rule>`), but keep triage in this one file where you can -
it is the only one with a reason and a review date. Removing an entry re-arms that finding.

## Step 3 - Collated finding shape (what the runner emits)

Every non-suppressed hit becomes:

```json
{
  "source": "gitleaks|semgrep|osv-scanner",
  "rule_id": "the tool's rule/check id (lets greploop's ledger dedupe across passes)",
  "severity": "blocking|major|minor",
  "file": "path:line",
  "issue": "what the scanner flagged",
  "triage_hint": "in-scope | likely-fp:<reason>",
  "fix": "concrete change (or 'triage: confirm not a false positive')"
}
```

Severity mapping (scanners over-report; this keeps the signal honest):
- **gitleaks** any hit -> **blocking** (a real secret in a diff is never a nit). gitleaks has no
  severity field. The value is redacted everywhere.
- **semgrep** `extra.severity`: ERROR -> blocking, WARNING -> major, INFO -> minor. A
  low-`extra.metadata.confidence` ERROR is downgraded to major (community rules over-fire).
- **osv-scanner** has no CRITICAL/HIGH field on the finding. The runner reads the group's
  `max_severity` (CVSS base score), else `database_specific.severity`: >= 7.0 -> blocking,
  4.0-6.9 -> major, < 4.0 -> minor, no score -> major. A dev-only dependency is capped at major.
  osv has no reachability, so every osv fix says `triage: confirm the vulnerable API is actually
  imported`. `file` is the lockfile path (no line).

**Path demotion (deterministic, no judgment):** a hit whose file matches `**/*.{test,spec}.*`,
`**/__tests__/**`, `**/fixtures/**`, `**/*.example*`, `**/*.sample*`, `**/mocks/**`,
`**/vendor/**`, `**/dist/**` or `**/build/**` gets `triage_hint: likely-fp:<pattern>` and drops
one severity level - EXCEPT gitleaks hits, which stay blocking and `in-scope` (a real secret in a
fixture is still leaked).

## Step 4 - Hand off to greploop's ledger

scanloop does NOT edit files - it only finds and triages. Pass `findings` from report.json into
greploop as pre-seeded ledger entries (its Step 1.5), each carrying `rule_id` so greploop dedupes
them against its own reviewer-panel findings (no double-fixing one line). Every `in-scope`
blocking finding is `must-validate-then-fix`; `likely-fp` findings are `confirm-or-suppress` - if
greploop's panel confirms a false positive, it APPENDS an entry (with `reason` and `expires`) to
`.scanloop/allowlist.yml` so the next run skips it. gitleaks hits bypass validation: blocking,
always. Run scanloop once per loop pass, immediately before greploop. If invoked standalone,
print the summary and verdict - don't edit.

**An `INCOMPLETE` verdict is a blocking handoff**, not a skip: say which required tool did not
run and why (from `incompleteBecause`), and either install/fix it and rerun, or get the user's
explicit OK to proceed without it. A security pass that scanned nothing is not a pass.

## Fallback - manual commands (only when Node is unavailable)

Same scopes as the runner. Exit 1 from a scanner means findings, not a crash; exit >= 2 or a
missing output file means that scanner did not run - report it, never call it clean. Delete old
outputs first so you never read a stale one.

```bash
mkdir -p .scanloop && rm -f .scanloop/gitleaks.json .scanloop/semgrep.json .scanloop/osv.json
MB=$(git merge-base <base> HEAD)

gitleaks git --no-banner --redact --report-format json --report-path .scanloop/gitleaks.json \
  --log-opts="$MB..HEAD" . &

mapfile -t FILES < <(git diff --name-only --diff-filter=d "$MB"...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.py')
semgrep scan --metrics=off --disable-version-check \
  --config p/security-audit --config p/secrets --config p/owasp-top-ten \
  --config p/javascript --config p/typescript \
  --baseline-commit "$MB" --json --output .scanloop/semgrep.json -- "${FILES[@]}" &

# only if a lockfile changed; one -L per changed lockfile
osv-scanner scan source -L <changed-lockfile> --format json --output-file .scanloop/osv.json &
wait
```

Then apply Steps 2 and 3 by hand (honor `reason` and `expires`), and record each tool's version
(`gitleaks version`, `semgrep --version`, `osv-scanner --version`) in your report.

Conditional extras (only if that file type changed, skipped silently if the tool is absent, not
run by the runner): `Dockerfile*` -> `hadolint`; `*.tf`/IaC -> `checkov -d .`; `*.ts/tsx/js/jsx`
-> `eslint` with the security plugin IF the repo already has eslint configured.

## Final report

When the scan ends, print (the runner's summary covers the first three):
- each tool: status, required or not, version, and WHY for anything not `ran`
- counts by severity and the verdict (`CLEAN`, `BLOCKING`, or `INCOMPLETE`)
- the findings (file:line, source, rule_id, issue, triage_hint), suppressed count, and any
  `invalid`/`expired` allowlist entries
- handoff line: "N blocking + M major passed to greploop", "clean - all required scanners ran, no
  blocking or major findings", or "INCOMPLETE - <tool> did not run: <reason>"

## Why it stays small + honest limits

Scoped to the diff, like greploop - baseline against the merge-base so you only see what THIS
change introduced, not pre-existing findings that aren't yours to fix this pass. Limits to state
plainly: OSS semgrep taint is mostly intra-file, and diff-scoping can miss a taint source in an
unchanged file - this is a fast deterministic gate, not whole-program dataflow. osv-scanner has no
reachability and cannot tell a direct from a transitive dependency here. greploop's reviewer
panel is the cross-file backstop.
