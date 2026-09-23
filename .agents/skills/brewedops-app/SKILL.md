---
name: brewedops-app
description: Bootstrap a new project with the BrewedOps Agentic Framework - checks the framework pieces are installed (global rules file, notes folder, opensrc, code-structure, scanloop, greploop, ship), asks what the app is for and recommends a stack (never defaults to React/Vite), picks a deploy target, scaffolds the project with CI, and writes a project AGENTS.md that keeps the build loop always on. Works in Claude Code, Codex, Cursor, Gemini CLI, Antigravity and Copilot. Use when the user says "brewedops app", "set up a new project with the framework", "bootstrap this", "use the framework", or opens an empty folder and wants to start building.
---

# brewedops-app - start a project the framework way

Turns an empty folder into a project wired to the BrewedOps Agentic Framework
(https://brewedops.cloud/framework). **The user is the boss; you are the helper.** You type,
search and fix; the user decides what to build and what ships.

## The framework in one breath

| Part | Job | Lives in |
|---|---|---|
| Global rules file | The rulebook, read first every session | your tool's global instructions file |
| Notes folder | Long-term memory across sessions | a plain Markdown folder (Obsidian optional) |
| opensrc | Real package source, so you stop guessing APIs | global CLI |
| code-structure | One clean version of each thing | skill |
| scanloop | Free local secret + SAST + dependency scan of the diff | skill |
| greploop | Review panel that loops fixes until 5/5 | skill |
| ship | CI on every push; deploys only on the user's go, through a checklist | skill |

**The build loop**, one small piece at a time: decide one small thing -> read real source with
opensrc -> build it (you type, the user steers) -> code-structure tidies -> clarity pass ->
scanloop -> greploop to 5/5 -> commit, push, CI green -> next piece. Nothing goes live until the
user says "deploy", and then it goes through the `ship` skill.

**The clarity pass** (on the code just changed, after code-structure): same behavior, fewer
lines, no nested ternaries, no dense one-liners, flatten needless nesting, name things for what
they are, never refactor untouched code.

**Four habits:** plan before you build (goal, done-criteria, files touched, how to check) - keep
the AI sharp (small chunks, start fresh sessions instead of stuffing one) - make it prove the work
(a real check, looped until an objective bar) - every bug is an upgrade (add the rule or note that
stops it recurring).

---

## Phase 0 - Detect the tool and what is installed

Work out which tool you are running in (you know your own name; if unsure, ask). Then check each
piece and print a PASS / MISSING checklist before doing anything else. Do not reinstall what
passes.

| Piece | How to check |
|---|---|
| Global rules file | the file for your tool exists and is not empty - see `references/setup.md` |
| Notes folder | the global rules file names a notes path and that folder exists |
| opensrc | `opensrc --version` |
| code-structure, scanloop, greploop, ship | the skill folders exist in your tool's skills directory (`references/setup.md`) |
| scanloop's scanners | `gitleaks version`, `semgrep --version`, `osv-scanner --version` |
| GitHub CLI | `gh auth status` (the ship preflight reads CI results with it) |
| Node.js + git | `node -v`, `git --version` |

If everything passes, say "Framework: all pieces present" and go to Phase 2.

## Phase 1 - Install what is missing

Follow `references/setup.md` for each MISSING piece - it has the per-tool paths and the exact
commands. If the user has this kit checked out, `install.sh` / `install.ps1` at the kit root does
the skills in one step. Two things can not be scripted and need the user: filling in the
`<ANGLE BRACKET>` parts of the global rules file (`references/global-rules.md`), and (only if they want it) Obsidian's app. Ask,
then continue. Re-run the Phase 0 checks afterwards.

## Phase 2 - What is this app, and what stack fits

Never default to React/Vite.

1. Look at the folder first. If it already has `package.json`, `pyproject.toml`, `Cargo.toml` or
   a git history, read it and infer - do not ask what is already answered.
2. Ask the user **what the app is for** (web app/dashboard, marketing site, mobile app, desktop
   app, CLI, API/backend, browser extension, AI agent, real-time/collaborative, game, data).
3. Read `references/tech-stacks.md` and recommend the best-fit stack with a one-line reason and
   ONE alternative.
4. In the same round, pick the **deploy target** (the table in the `ship` skill, section 1) - the
   stack and the host are one decision; an SSR framework on a static host fails at deploy time.
5. Wait for the user's OK before writing any files.

## Phase 3 - Scaffold and wire the project

1. Scaffold with the stack's official tool (`npm create vite@latest`, `npm create astro@latest`,
   `npx create-next-app@latest`, `npx create-expo-app`, `cargo new`, `uv init`...). Check current
   flags with opensrc or `--help` - do not guess.
2. Write the project instructions file from `references/project-agents-md.template.md` as
   `AGENTS.md` at the project root. Fill every `{{PLACEHOLDER}}`; anything unknown stays `TBD`.
   Then add your tool's pointer to it:
   - Claude Code: a `CLAUDE.md` containing the single line `@AGENTS.md`
   - Gemini CLI: `.gemini/settings.json` with `{"context":{"fileName":["AGENTS.md","GEMINI.md"]}}`
   - Codex, Cursor, Antigravity, Copilot: nothing - they read `AGENTS.md` directly
3. Wire CI and the deploy rails from the `ship` skill (section 1): copy `ci.yml` + `relock.yml`
   into `.github/workflows/`, `check-node-pin.mjs` + `write-version.mjs` + `preflight-deploy.mjs`
   into `scripts/`, add `"prebuild"` / `"postbuild"`, `npm i -D semver`, write an exact `.nvmrc`.
   Non-Node stacks: adapt the CI commands and skip the Node-only scripts.
4. `git init` if needed, a stack-appropriate `.gitignore`, and one commit:
   `chore: scaffold <stack> + framework AGENTS.md + CI`. Push only if the user asks. After the
   first push, confirm CI actually ran green (`gh run list --limit 1`) - a workflow that never
   ran proves nothing.
5. Confirm the scaffold runs (`npm run dev` or equivalent) AND the build passes before calling
   it ready.

## Phase 4 - Hand off to the build loop

Say:

> Framework wired. We build one small piece at a time: you name it -> I read the real source
> with opensrc -> build it while you steer -> code-structure tidies -> clarity pass -> scanloop
> scans -> greploop reviews to 5/5 -> commit, push, CI green. Nothing goes live until you say
> "deploy". What is the first small thing?

Then stop and wait. Do not start building a feature on your own.
