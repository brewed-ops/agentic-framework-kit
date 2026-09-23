# AGENTS.md - read this first, AI

You are an AI coding assistant (Claude Code, Codex, Cursor, Gemini CLI, Antigravity, Copilot or
similar) and the user has pointed you at the **BrewedOps Agentic Framework kit**. Your job is to
install it for the tool you are running in, help the user fill in their rules, and then use it.
The user is the boss: they decide what gets built and what ships. You do the typing.

## What is in this kit

| Path | What it is |
|---|---|
| `.agents/skills/brewedops-app/` | Bootstrap: sets up a new project the framework way (stack, CI, project AGENTS.md) |
| `.agents/skills/greploop/` | Review loop: a panel of 3 reviewers scores each change 1-5; fix and re-review until 5/5 |
| `.agents/skills/scanloop/` | Free local scan of each change: secrets (gitleaks), code patterns (semgrep), vulnerable dependencies (osv-scanner) |
| `.agents/skills/ship/` | CI setup + the careful deploy gate (preflight script, rollback first, prove it live) |
| `.agents/skills/brewedops-app/references/global-rules.md` | Starter global rules file for the user |
| `.agents/skills/brewedops-app/references/setup.md` | Per-tool paths and per-piece install steps |
| `install.sh` / `install.ps1` | Copies the skills into the right folder for each tool |

`code-structure` (the "keep one clean version of each thing" skill by Michael Shimeles) is not
bundled - its author has not licensed it for redistribution. The installers fetch it from
https://github.com/michaelshimeles/skills.

## Install it - do these in order

1. **Know your tool.** You know which tool you are. If the user uses several, ask which ones.
2. **Preview, then install the skills.** From this kit's folder, run the installer with
   `--dry-run` first, show the user what it will do, then run it for real:
   - macOS / Linux / Git Bash: `./install.sh --tool <tool> --dry-run`, then without `--dry-run`
   - Windows PowerShell: `.\install.ps1 -Tool <tool> -DryRun`, then without `-DryRun`
     (if scripts are blocked: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Tool <tool>`)
   - Tools: `claude`, `codex`, `cursor`, `gemini`, `copilot`, `antigravity`, or `all`.
   - Add `--rules` / `-Rules` to place the starter global rules file. It never overwrites an
     existing one - it writes a `.framework-template.md` next to it instead.
   The installer backs up any skill folder it replaces into a sibling `-backup` folder.
3. **Fill in the rules with the user.** Open their global rules file (the installer prints its
   path; Cursor has none - paste the template into Settings > Rules > User Rules). Ask the user
   for each `<ANGLE BRACKET>` value: name, what they do, timezone, house rules. If a
   `.framework-template.md` was written because they already had rules, merge only the missing
   sections into their existing file and show them the diff. Never delete their rules.
4. **Pick a notes folder (long-term memory).** Obsidian is optional. Default: a plain folder,
   e.g. `~/agent-notes/`, with `00 - Inbox`, `10 - Projects`, `20 - Areas`, `30 - Resources`,
   `40 - Archive`. Put its path in the rules file. If your tool only writes inside the current
   project, use a `notes/` folder per project instead. Details: `references/setup.md`.
5. **Install the command-line tools** the skills use - ask before installing anything system-wide:
   Node.js + git (required), `opensrc` (`npm install -g opensrc`), the scanners (gitleaks,
   semgrep, osv-scanner), and the GitHub CLI `gh` (then `gh auth login`). Exact commands per OS
   are in `references/setup.md`. Missing scanners are fine - scanloop skips them and says so.
6. **Reload and verify.** Most tools only read skills at session start: tell the user to start
   a new session, then check the skills are listed (Claude Code `/skills`, Codex `/skills`,
   Gemini CLI `/skills list`, others: ask the tool "what skills do you have?"). Report exactly
   what installed and what is still missing.

**Tool notes**
- Gemini CLI reads `GEMINI.md`, not `AGENTS.md`, unless a project sets
  `.gemini/settings.json` to `{"context":{"fileName":["AGENTS.md","GEMINI.md"]}}`. It also asks
  for approval before activating a skill - that is expected.
- Codex only uses subagents when asked. greploop asks for them; if a tool has no subagents,
  greploop runs its three reviews one after another, each in a fresh session.
- Cursor and Copilot also read `~/.claude/skills`. If the user runs Claude Code too, skills can
  show up twice - that is cosmetic.

## Use it

- **New project:** open an empty folder and say "brewedops app". The skill checks the pieces,
  asks what the app is for, recommends a stack, sets up CI, and writes the project's AGENTS.md.
- **Every small piece of work:** read real package source with opensrc -> write a failing
  test or check -> build until it passes -> code-structure -> clarity pass -> scanloop ->
  greploop to 5/5 -> commit, push, CI green.
- **Deploying:** only when the user says "deploy" for that change, and only through the `ship`
  skill: preflight check, rollback prepared, safe upload order, prove it is live.

## If you are changing this kit itself

- Skills follow the open Agent Skills format (https://agentskills.io): `SKILL.md` with only
  `name` (matches the folder, lowercase-hyphenated) and `description` (under 1024 characters) in
  the frontmatter. No tool-specific fields.
- Run `node scripts/check-kit.mjs` before committing; CI runs it on every push.
- New shell scripts need the executable bit IN GIT (`git update-index --chmod=+x <file>`;
  a plain `chmod` on Windows is not recorded). `.gitattributes` keeps every file LF so bash
  scripts still run after a Windows checkout.
- Keep instructions tool-neutral. When a step differs per tool, give each tool's line.
