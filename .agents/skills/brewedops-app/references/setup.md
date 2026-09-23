# Setup - per tool, per piece

Install only what Phase 0 marked MISSING. Paths below come from each tool's official docs
(checked September 2026). If a path has moved, trust the tool's current docs over this file.

## Where things go, per tool

| Tool | Global skills folder | Global rules file | Project rules file |
|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/CLAUDE.md` | `CLAUDE.md` containing `@AGENTS.md` |
| Codex (CLI, IDE, app) | `~/.agents/skills/` | `~/.codex/AGENTS.md` | `AGENTS.md` |
| Cursor | `~/.agents/skills/` | Settings > Rules > User Rules (no file) | `AGENTS.md` |
| Gemini CLI | `~/.agents/skills/` | `~/.gemini/GEMINI.md` | `AGENTS.md` + `.gemini/settings.json` (below) |
| Antigravity | `~/.gemini/config/skills/` (IDE), `~/.gemini/antigravity-cli/skills/` (CLI) | `~/.gemini/GEMINI.md` (shared with Gemini CLI) | `AGENTS.md` |
| GitHub Copilot | `~/.agents/skills/` | `~/.copilot/copilot-instructions.md` (CLI) | `AGENTS.md` |

- Gemini CLI only reads `AGENTS.md` when told to. Project `.gemini/settings.json`:
  `{"context":{"fileName":["AGENTS.md","GEMINI.md"]}}`
- Cursor and Copilot ALSO read `~/.claude/skills/`. If you use Claude Code alongside them, the
  same skill can appear twice - install to one folder per machine where possible.
- Gemini CLI asks for approval before it activates a skill. That is expected.
- Codex only spawns subagents when explicitly asked; greploop's instructions ask. Tools without
  subagents run greploop's three reviews one after another in fresh sessions.

## Global rules file

Copy `references/global-rules.md` (in this skill) to your tool's global rules file (table above) and
fill in the `<ANGLE BRACKET>` parts. If the file already exists, APPEND the sections you are
missing - never overwrite someone's existing rules. Keep it to about a page.

## Notes folder (long-term memory) - Obsidian is optional

The memory is just a folder of Markdown files your AI reads and writes with its normal file
tools. Pick one:

- **Plain folder (works everywhere, default):** create it and put its path in the rules file.
  ```bash
  mkdir -p ~/agent-notes/{"00 - Inbox","10 - Projects","20 - Areas","30 - Resources","40 - Archive"}
  ```
  If your tool sandboxes file writes to the current project (Codex does by default), either keep
  a `notes/` folder inside each project instead, or approve the write when asked.
- **Same folder, viewed in Obsidian:** install Obsidian, "Open folder as vault", pick the notes
  folder. Nothing else changes - the AI still reads the files directly.
- **Obsidian over MCP (optional extra, any MCP-capable tool):** install the "Local REST API"
  community plugin, copy its API key, then register `obsidian-mcp-server` in your tool's MCP
  config with `OBSIDIAN_API_KEY`, `OBSIDIAN_BASE_URL=https://127.0.0.1:27124` and
  `OBSIDIAN_VERIFY_SSL=false`. Claude Code example:
  ```bash
  claude mcp add obsidian -e OBSIDIAN_API_KEY=<key> -e OBSIDIAN_BASE_URL=https://127.0.0.1:27124 \
    -e OBSIDIAN_VERIFY_SSL=false -- npx -y obsidian-mcp-server
  ```

## opensrc (real package source)

Needs Node.js.
```bash
npm install -g opensrc
opensrc --version
opensrc path zod              # npm package
opensrc path pypi:requests    # Python
opensrc path vercel/next.js   # GitHub repo
```

## Skills from this kit (greploop, scanloop, ship, brewedops-app)

Run the kit's installer from the kit folder, or copy the folders by hand:
```bash
./install.sh --tool codex            # or claude, cursor, gemini, copilot, antigravity, all
```
```powershell
.\install.ps1 -Tool codex
```
By hand: copy each folder in `.agents/skills/` into the global skills folder from the table.

## code-structure (by Michael Shimeles)

Not included in this kit - it has no license for redistribution, so fetch it from its author.
The installer does this for you (unless you pass `--no-code-structure`) at a pinned commit and
checks the file's SHA-256, so a change upstream never reaches you without a kit release. By hand:
```bash
mkdir /tmp/ms-skills && cd /tmp/ms-skills && git init -q
git fetch --depth 1 https://github.com/michaelshimeles/skills 4b72f46b045e6fef52e6a98d4c162dd309826aed
git checkout FETCH_HEAD
sha256sum code-structure/SKILL.md   # expect 2f0ed408b525c65d422699490a159584fd977d0cfca5b15a5c9a47cf07b95f71
cp -r code-structure <your global skills folder>/
```

## scanloop's scanners (all free, open source)

```bash
# macOS / Linux
brew install gitleaks semgrep osv-scanner
```
```powershell
# Windows
winget install Gitleaks.Gitleaks
winget install Google.OSVScanner
pip install --user semgrep     # then add your Python user Scripts folder to PATH
```
Install what you can; scanloop skips a missing scanner and says so.

## GitHub CLI (for the ship preflight)

```bash
brew install gh        # macOS
winget install GitHub.cli   # Windows
gh auth login
```
