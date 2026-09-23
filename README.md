# BrewedOps Agentic Framework kit

The tools, rules and loop from https://brewedops.cloud/framework, packaged so you can install
them in the AI coding tool you already use: **Claude Code, Codex, Cursor, Gemini CLI, Antigravity
or GitHub Copilot.** No Obsidian required - memory is a plain folder of notes.

**The idea:** you are the boss, the AI is the helper. You decide what to build and what ships;
the AI does the typing. Build in small pieces, and every piece gets tidied, scanned and reviewed
before the next one starts. Nothing goes live until you say so.

## What you get

| Skill | What it does |
|---|---|
| `brewedops-app` | Sets up a new project: asks what it is for, picks a stack, adds CI, writes the project rules |
| `greploop` | AI reviewers check each change (one for small low-risk changes, three for the rest); the AI fixes and re-checks until no blocking or major issue is left, then reports what ran and what was not covered |
| `scanloop` | Free local scan for leaked secrets, risky code and vulnerable packages |
| `ship` | CI on every push, plus a careful deploy checklist: back up first, prove it is live |
| `code-structure` | Keeps one clean version of each thing - see below (by [Michael Shimeles](https://github.com/michaelshimeles/skills), fetched from his repo) |

Plus a starter **global rules file** (the rulebook your AI reads every session) and a
**project rules template** (AGENTS.md) that keeps the loop on in every project.

**See it work first:** [`examples/benchmark/`](examples/benchmark/) is a small, repeatable test: 8
changes to a demo API, 6 with a proven planted bug. One reviewer and the three-reviewer panel both
caught 6 of 6 with no false alarms - and both found a real bug in a change that was supposed to be
clean. Read its limits before quoting it. [`examples/greploop-run/`](examples/greploop-run/) is one full
run, every command and its output, from the first review to the final report. What has and has not been tested, per AI tool and OS:
[COMPATIBILITY.md](COMPATIBILITY.md).

### About code-structure

Left alone, an AI copies the same logic into every place that needs it - three slightly
different "send email" or "call the API" blocks, and a bug fixed in one survives in the others.
code-structure is a skill that stops that: repeated operational steps get pulled into one
shared service function, and the feature code ("actions") only decides *when* to call it. It is
written by Michael Shimeles and has no license for redistribution, so this kit does not copy it -
the installer fetches it from his repo at a fixed commit and checks its hash. Read the exact
version you will get before installing:
[code-structure/SKILL.md @ 4b72f46](https://github.com/michaelshimeles/skills/blob/4b72f46b045e6fef52e6a98d4c162dd309826aed/code-structure/SKILL.md).
Skip it with `--no-code-structure`.

## Install - the easy way

Open this folder in your AI tool and say:

> Read AGENTS.md and install this kit for me.

`AGENTS.md` is written for your AI: it runs the installer for your tool, fills in your rules
with you, sets up your notes folder, and checks everything loaded.

## Install - by hand

```bash
git clone https://github.com/brewed-ops/agentic-framework-kit
cd agentic-framework-kit
./install.sh --tool codex --dry-run      # see what it will do
./install.sh --tool codex --rules        # do it
```
```powershell
# Windows PowerShell
git clone https://github.com/brewed-ops/agentic-framework-kit
cd agentic-framework-kit
.\install.ps1 -Tool codex -DryRun
.\install.ps1 -Tool codex -Rules
```

`--tool` takes `claude`, `codex`, `cursor`, `gemini`, `copilot`, `antigravity`, a list like
`claude,cursor`, or `all`. Skills the kit installed before are backed up before being replaced. A
same-named skill the kit did NOT install (your own) stops the install with nothing changed - rerun with
`--force` to back it up and replace it. An existing rules file is never overwritten.

**Only one project, or only some skills:**
```bash
./install.sh --tool codex --project ~/code/my-app     # into my-app/.agents/skills, nothing global
./install.sh --tool claude --skills greploop,ship     # just these two
```
Project mode writes no global rules (the project's AGENTS.md is the rules file), keeps its backups out
of git, and lets teammates get the skills by committing `.agents/skills/`.

| Tool | Skills go to | Global rules file |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/CLAUDE.md` |
| Codex | `~/.agents/skills/` | `~/.codex/AGENTS.md` |
| Cursor | `~/.agents/skills/` | Settings > Rules > User Rules |
| Gemini CLI | `~/.agents/skills/` | `~/.gemini/GEMINI.md` |
| Antigravity | `~/.gemini/config/skills/`, `~/.gemini/antigravity-cli/skills/` | `~/.gemini/GEMINI.md` |
| GitHub Copilot | `~/.agents/skills/` | `~/.copilot/copilot-instructions.md` |

Then start a new session in your tool, open an empty folder, and say **"brewedops app"**.

## Update, check the version, uninstall

```bash
git pull && ./install.sh --tool codex        # update: rerun the same install
./install.sh --version                       # the kit's version (installed one: ~/.agents/agentic-framework-kit.installed)
./install.sh --tool codex --restore          # undo the last install or update; run again to swap back
./install.sh --tool codex --uninstall        # remove the kit's skills
```
PowerShell: the same with `-Tool`, `-Version`, `-Restore`, `-Uninstall`, `-Project`, `-Skills`,
`-Force`. Replaced or removed skills are moved to a `<skills folder>-backup/` folder, never deleted
outright; the newest 3 backup sets are kept. Uninstall never touches your rules file. The installer
exits non-zero when it stops on a conflict, when code-structure fails its hash check or download (the
kit's own skills are still installed), or when there is nothing to restore. What changed between versions: [CHANGELOG.md](CHANGELOG.md).

## Also install (the skills use these)

- **Node.js + git** - required
- **opensrc** - `npm install -g opensrc` - lets the AI read a package's real source instead of guessing
- **gitleaks, semgrep, osv-scanner** - the free scanners behind scanloop (install what you can)
- **GitHub CLI** - `gh auth login` - the deploy check reads your CI results with it

Per-OS commands: [`.agents/skills/brewedops-app/references/setup.md`](.agents/skills/brewedops-app/references/setup.md).

## Credits

Framework ideas from [Mickey (Michael Shimeles)](https://github.com/michaelshimeles/skills) and
[Nick Saraev](https://www.youtube.com/@NickSaraev). greploop borrows ideas from Alibaba's
[open-code-review](https://github.com/alibaba/open-code-review) (Apache-2.0).
Put together by [BrewedOps](https://brewedops.cloud/framework).

## License

MIT - see [LICENSE](LICENSE). Third-party notes (the Apache-2.0 review rules adapted from open-code-review, and code-structure) are in [NOTICE](NOTICE).
