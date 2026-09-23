# Changelog

Versions follow `MAJOR.MINOR.PATCH`. The installed version is written next to each skills
folder (`agentic-framework-kit.installed`); `./install.sh --version` prints the kit's.

## 1.1.0 - 2026-09-24

**What "passed" means**
- greploop's report now has four sections: executed checks, review findings, coverage gaps, and the
  release decision. It says "Passed the configured checks" or "Did not pass: <which>", never "no bugs".
- `greploop/scripts/review.mjs` enforces the rules in code: it validates each reviewer reply, re-anchors
  findings to their quoted code, moves findings on untouched lines to pre-existing, merges and dedupes,
  keeps the ledger, refuses disputes without proof, runs the checks itself, and enforces the budget.
- Exit gate fixed: every reviewer must score 4 or 5. The old rule (two 5s) made a change with only
  minor findings unable to finish.
- `scanloop/scripts/scan.mjs` runs the scanners and writes one report. A required scanner that is
  missing or errors makes the scan INCOMPLETE, never clean. Old reports are deleted before a run. Tool
  versions and commands are recorded. Allowlist entries need a `reason` and an `expires` date.
- The deploy preflight fetches first, requires named CI checks at job level (`--require`, default `CI`),
  fails on a required check that never ran, was skipped, or is still running, and reports whether CI
  ran any tests at all.
- CI templates no longer use `--if-present`: a missing test or lint script fails. The Go and Rust
  templates fail when a project has no tests.

**Profiles**
- greploop has quick, standard and thorough profiles, each with an iteration and reviewer budget. The
  runner picks one from the change and can escalate.

**Evidence**
- `examples/benchmark/`: 8 changes, 6 with a planted bug proven by a failing test. One reviewer and the
  three-reviewer panel both caught 6 of 6, with no false alarms. Checked again in CI on every push.
- `examples/greploop-run/`: one full run, with every command and its output.
- `COMPATIBILITY.md`: what has been tested, per AI tool, OS and script, and what has not.
- CI now also runs every Node test, installer failure paths in bash, PowerShell 7 and 5.1, actionlint on
  every workflow and template, and each language's CI template against a small fixture project.

**Installers**
- code-structure is pinned to commit `4b72f46` of michaelshimeles/skills and checked against a SHA-256
  hash. A mismatch or failed download is refused and the installer exits non-zero.
- New: `--version` / `-Version`, `--uninstall`, `--restore`, `--project <dir>` (one project, no global
  rules, backups kept out of git), `--skills <list>`, and `--force`.
- A same-named skill the kit did not install stops the install with nothing changed.
- Each skills folder gets an install record. Reruns say "updating X -> Y", and old backups are pruned
  to the newest 3.

**Build loop and project setup**
- A "check first" step: write the failing test (or browser check) before the code.
- Stack-aware project template: folder and naming rules come from the chosen stack.
- CI templates for Python, Go and Rust alongside Node, plus a language-neutral `write-version.sh`.
- ship covers secrets and environment variables, database migrations, and more hosts (Netlify, Render,
  Railway, Fly.io, GitHub Pages, Docker on a VPS).

**Other**
- License detection: third-party notes moved from LICENSE to NOTICE, so GitHub reads the license as MIT.

## 1.0.0 - 2026-09-24

- First release: brewedops-app, greploop, scanloop and ship skills in the Agent Skills format;
  AGENTS.md setup guide; installers for Claude Code, Codex, Cursor, Gemini CLI, Antigravity and
  GitHub Copilot.
