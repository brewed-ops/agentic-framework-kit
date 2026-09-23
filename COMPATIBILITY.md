# What has actually been tested

"Supported" is a claim. This page says which parts of that claim have evidence behind them, and what
kind. It is updated when a new test runs, not when a new tool is added to the list.

Evidence levels:
- **CI** - runs on every push in this repo's GitHub Actions ([`.github/workflows/`](.github/workflows/)).
- **Run** - done by hand at least once, output recorded (release notes or [`examples/`](examples/)).
- **Docs** - follows the tool's official documentation; nobody has run it yet.

## AI tools - does the tool find and use the skills?

| Tool | Install paths | Skills load and trigger | greploop subagent panel | Evidence |
|---|---|---|---|---|
| Claude Code | `~/.claude/skills/` | Yes | Yes - the [benchmark](examples/benchmark/) ran 32 fresh reviewers | Run |
| Codex CLI | `~/.agents/skills/`, `~/.codex/AGENTS.md` | Not yet verified | Codex spawns subagents only when asked; not yet verified | Docs |
| Cursor | `~/.agents/skills/` | Not yet verified | Not yet verified | Docs |
| Gemini CLI | `~/.agents/skills/`, `~/.gemini/GEMINI.md` | Not yet verified | Not yet verified | Docs |
| Antigravity | `~/.gemini/config/skills/`, `~/.gemini/antigravity-cli/skills/` | Not yet verified | Not yet verified | Docs |
| GitHub Copilot | `~/.agents/skills/`, `~/.copilot/copilot-instructions.md` | Not yet verified | Cloud agent has no subagents - greploop falls back to fresh sessions | Docs |

The installers putting files in those folders IS tested (next table). Whether each tool then loads them
is the "Docs" column - the paths come from each vendor's documentation as of September 2026. If you run
the kit in one of these tools, a note in an issue ("Codex 0.x on macOS: skills listed, greploop ran with
3 subagents") moves that row to "Run".

## Installers

| | Linux | macOS | Windows |
|---|---|---|---|
| `install.sh` (bash) | CI (ubuntu-latest) | Written for bash 3.2; not run | Run (Git Bash) |
| `install.ps1` | - | - | CI (PowerShell 7 and Windows PowerShell 5.1) |
| Failure paths (hash mismatch, conflict, uninstall, restore, backup pruning) | CI | not run | CI |

## Scripts

All need Node.js 18 or newer; developed and run on Node 24.

| Script | What checks it | Evidence |
|---|---|---|
| `ship/scripts/preflight-deploy.mjs` | `tests/ship-preflight.test.mjs` (throwaway git repos, fake `gh`) | CI; also Run against this repo's real GitHub checks |
| `scanloop/scripts/scan.mjs` | `tests/scanloop-scan.test.mjs` (stub scanners) | CI; Run with real gitleaks 8.30, semgrep 1.165, osv-scanner 2.3 on Windows |
| `greploop/scripts/review.mjs` | `tests/greploop-review.test.mjs` | CI |
| `scripts/check-kit.mjs` | runs itself | CI |

## CI templates (`ship/assets/`)

| Template | Evidence |
|---|---|
| `ci.yml` (Node) | CI - [`templates.yml`](.github/workflows/templates.yml) runs its steps on a fixture, plus a no-tests fixture that must fail |
| `ci-python.yml` | CI - same |
| `ci-go.yml` | CI - same (never run on the maintainer's machine) |
| `ci-rust.yml` | CI - same |

## Known gaps

- No macOS run of anything yet.
- No AI tool other than Claude Code has been driven through the full loop.
- The benchmark is 8 cases, one run each, one model - see its limits section.
