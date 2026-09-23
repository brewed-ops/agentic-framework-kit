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
| `greploop` | Three AI reviewers score each change out of 5; the AI fixes and re-checks until 5/5 |
| `scanloop` | Free local scan for leaked secrets, risky code and vulnerable packages |
| `ship` | CI on every push, plus a careful deploy checklist: back up first, prove it is live |
| `code-structure` | Keeps one clean version of each thing (by [Michael Shimeles](https://github.com/michaelshimeles/skills) - fetched from his repo by the installer) |

Plus a starter **global rules file** (the rulebook your AI reads every session) and a
**project rules template** (AGENTS.md) that keeps the loop on in every project.

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
`claude,cursor`, or `all`. Existing skills are backed up before being replaced, and an existing
rules file is never overwritten.

| Tool | Skills go to | Global rules file |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/CLAUDE.md` |
| Codex | `~/.agents/skills/` | `~/.codex/AGENTS.md` |
| Cursor | `~/.agents/skills/` | Settings > Rules > User Rules |
| Gemini CLI | `~/.agents/skills/` | `~/.gemini/GEMINI.md` |
| Antigravity | `~/.gemini/config/skills/`, `~/.gemini/antigravity-cli/skills/` | `~/.gemini/GEMINI.md` |
| GitHub Copilot | `~/.agents/skills/` | `~/.copilot/copilot-instructions.md` |

Then start a new session in your tool, open an empty folder, and say **"brewedops app"**.

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
