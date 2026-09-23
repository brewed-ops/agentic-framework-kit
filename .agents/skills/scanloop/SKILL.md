---
name: scanloop
description: Free local static-analysis + secret-scan pass on the current diff - the deterministic half greploop's LLM reviewer can't do. Runs gitleaks (secrets), semgrep (SAST, pinned offline rules + telemetry off), and osv-scanner (dependency CVEs) on the changed files, respects a committed false-positive allowlist, collates findings into greploop's finding shape, and hands them off as MUST-CHECK input. Use when the user says "/scanloop", "scan pass", "security scan the diff", "run the scanners", or right before greploop in the build loop. No paid service - all tools are open-source and run locally; code never leaves the machine.
---

# scanloop - local static + secret scan (no paid reviewer)

The deterministic complement to greploop. greploop is an AI reviewer panel - smart, but it can
*miss* a hardcoded key or an injection sink. scanloop runs real open-source scanners that don't
miss those, scoped to the diff, then feeds what they find into greploop so the LLM panel triages
and applies the fixes. The scanners FIND; greploop FIXES. They compose.

**Privacy (the whole point - read this).** Your CODE never leaves the machine. To keep that true
you MUST run semgrep with telemetry off and pinned rules (NEVER `--config auto` - it logs in to
semgrep.dev and sends usage metrics). The one disclosed exception: osv-scanner sends dependency
NAME+VERSION (not code) to OSV.dev to look up CVEs - use `--offline` + `--download-offline-databases`
for zero egress when scanning sensitive client code. This is the half of CodeRabbit's value
(Semgrep/secret-scanning) rebuilt at $0 with no client-code exposure.

## The tools it drives

| Job | Tool | Invocation note |
|-----|------|------|
| Secret scanning | **gitleaks** | catches hardcoded keys/tokens an LLM eyeballs past |
| SAST | **semgrep** | pinned rule packs + `--metrics=off`, NOT `--config auto` |
| Dependency CVEs | **osv-scanner** | only when a manifest/lockfile changed; target that file, not the tree |

The brewedops-app bootstrapper auto-installs all three (Phase 1). If one is missing, skip it with a
one-line note and run the rest. **But if ZERO scanners actually run, never report "clean" - report
`SCAN NOT PERFORMED` as a blocking handoff** (a security pass that scanned nothing is not a pass).

**Windows note:** all three run native. semgrep (1.165+) installs via `pip install --user semgrep`
into your Python user Scripts folder (e.g. `%APPDATA%\Python\Python3xx\Scripts`) - add that to
PATH if `semgrep` is not found. If semgrep can't run, say so LOUDLY in the report
(SAST did not run), don't bury it as a skip.

## Step 0 - Resolve the target

1. Find the base in order: `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`);
   else test which of `main`/`master`/`develop` exists via `git rev-parse --verify`; else STOP and
   ask. Don't assume `main`.
2. Capture the changed-file list once (`git diff --name-only <base>...HEAD`). Scopes differ by tool
   and that's intended - gitleaks scans the commit range, semgrep baselines against `<base>`,
   osv-scanner targets only changed manifests - but ALL are bounded to this change; none scans the
   whole monorepo.
3. Dirty tree: **commit the in-scope change first - do NOT `git stash`.** In a repo shared by
   several projects, stash reverts every project's uncommitted work and `pop` can fail to restore it. If you
   can't commit cleanly, scope the scanners to the explicit changed-file list instead.
4. Read the **allowlist** if present (Step 0.5).

## Step 0.5 - Respect the committed false-positive allowlist

scanloop reads `.scanloop/allowlist.yml` at the repo root if it exists - a small, committed,
reviewable list of already-triaged false positives so they don't re-block every run:

```yaml
# .scanloop/allowlist.yml - committed; every entry needs a reason + initials/date
suppressions:
  - tool: semgrep            # gitleaks | semgrep | osv-scanner
    path: "server/db.ts"
    rule: "javascript.sequelize.security.sequelize-injection"
    reason: "param is an internal enum, not user input - KV 2026-06-20"
```

A finding matching an entry is dropped before collation and never reaches greploop. Everything not
listed still blocks. Prefer each tool's NATIVE ignore too (`.gitleaks.toml [allowlist]`,
`.semgrepignore`, inline `# nosemgrep: <rule>`), but honor this one unified file so triage lives in
one place. Removing an entry re-arms that finding.

## Step 1 - Run the scanners (changed files only, in parallel)

Independent tools - launch together, then wait. **Non-zero exit when a tool FINDS something is the
expected outcome, not a crash:** gitleaks/semgrep/osv all exit 1 when they have findings. Parse each
tool's JSON regardless of exit code; only treat exit >= 2 (or no parseable output) as a real error.
A **missing report file means that scanner never ran** - report it as not performed, never "clean".
Verify current flags with `<tool> --help` if unsure - don't guess.

```bash
mkdir -p .scanloop

# Secrets - JSON to stdout over the commit range (gitleaks v8: 'git' subcommand, not 'detect')
gitleaks git --no-banner --redact --report-format json --report-path .scanloop/gitleaks.json \
  --log-opts="<base>..HEAD" . &

# SAST - pinned packs, telemetry OFF, only NEW findings vs base. NEVER --config auto.
# Pass the changed files as an explicit, quoted list - NEVER a directory: inside a large
# monorepo semgrep's target discovery can hang and writes no report. (File list + baseline: ~5s.)
mapfile -t FILES < <(git diff --name-only --diff-filter=d <base>...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.py')
semgrep scan --metrics=off \
  --config p/security-audit --config p/secrets --config p/owasp-top-ten \
  --config p/javascript --config p/typescript --config p/react \
  --baseline-commit <base> --json --output .scanloop/semgrep.json "${FILES[@]}" &

# Dependency CVEs - ONLY if a manifest/lockfile is in the changed-file list; target THAT file.
osv-scanner scan source -L <changed-lockfile> --format json --output-file .scanloop/osv.json &

wait
```

For truly zero-egress client work: vendor the rule packs once into a local dir and use
`--config ./.scanloop/rules/`, and add `--offline --download-offline-databases` to osv-scanner. Drop
language packs the repo doesn't use; `security-audit` + `secrets` + `owasp-top-ten` always run.
Conditional extras (only if that file type changed - skip silently if the tool is absent): `Dockerfile*`
-> `hadolint`; `*.tf`/IaC -> `checkov -d .`; `*.ts/tsx/js/jsx` -> `eslint` with the security plugin
IF the repo already has eslint configured. These are gated, not default - most diffs trigger none.

**Full-history secret sweep (separate, not every pass):** on new-repo onboarding or periodically, run
`gitleaks git --no-banner --redact --report-format json --report-path -` over ALL history - a key
committed long ago never appears in a future diff. Diff-mode is the per-pass default.

## Step 2 - Collate into greploop's finding shape

Normalize every hit (after dropping allowlisted ones) into the structure greploop consumes:

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
  severity field, so don't look for one. Keep `--redact` so the secret is never echoed.
- **semgrep** read `extra.severity`: ERROR -> blocking, WARNING -> major, INFO -> minor. Downgrade a
  low-`extra.metadata.confidence` ERROR to major (auto/community rules over-fire).
- **osv-scanner** has NO CRITICAL/HIGH/MODERATE/LOW field. Read `vulnerabilities[].severity` (a CVSS
  vector/score) or `database_specific.severity` when present. Bucket by CVSS base score: >=7.0 ->
  blocking, 4.0-6.9 -> major, <4.0 -> minor. osv has no reachability - a HIGH on a transitive/dev-only
  dep is NOT auto-blocking; mark it major with `triage: confirm the vulnerable API is imported`.

**Pre-tag false positives by path (deterministic, no judgment):** if a hit's file matches
`**/*.{test,spec}.*`, `**/__tests__/**`, `**/fixtures/**`, `**/*.example*`, `**/*.sample*`,
`**/mocks/**`, `**/vendor/**`, `**/dist/**`, `**/build/**` -> set `triage_hint: likely-fp` and demote
one severity level - EXCEPT gitleaks hits, which stay blocking (a real secret in a fixture is still
leaked). Everything else is `in-scope`.

## Step 3 - Hand off to greploop's ledger

scanloop does NOT edit files - it only finds and triages. Pass the collated findings into greploop as
pre-seeded ledger entries (its Step 1.5), each carrying `rule_id` so greploop dedupes them against its
own reviewer-panel findings (no double-fixing one line). Every non-allowlisted `in-scope` blocking
finding is `must-validate-then-fix`; `likely-fp` findings are `confirm-or-suppress` - if greploop's
panel confirms a false positive, it APPENDS the entry to `.scanloop/allowlist.yml` so the next run
skips it (closing the triage loop permanently). gitleaks hits bypass validation: blocking, always.
Run scanloop once per loop pass, immediately before greploop, so the panel sees scanner findings in
context. If invoked standalone, print the report and verdict - don't edit.

## Final report

When the scan ends, print:
- tools run, and any skipped (with WHY - uninstalled / not applicable / Windows-semgrep)
- counts by severity, and whether this was a real scan or `SCAN NOT PERFORMED` (zero scanners ran)
- the collated findings (file:line, source, rule_id, issue, triage_hint)
- handoff line: "N blocking + M major passed to greploop" or "clean - all scanners ran, no findings"

## Why it stays small + honest limits

Scoped to the diff, like greploop - baseline against `<base>` so you only see what THIS change
introduced, not pre-existing findings that aren't yours to fix this pass. Limits to state plainly:
OSS semgrep taint is mostly intra-file, and diff-scoping can miss a taint source in an unchanged file
- this is a fast deterministic gate, not whole-program dataflow. greploop's reviewer panel is the
cross-file backstop.
