# Project AGENTS.md template

Write everything below the cut line to the new project's root as `AGENTS.md` in Phase 3 and fill
every `{{PLACEHOLDER}}` (unknown = `TBD`, never invented). Keep it to about a page. Its job: every
future session in this folder, in any AI tool, reaches for opensrc before any package, runs the
build loop after each piece, and never deploys outside the ship gate. Do not trim those blocks.

--- 8< --- copy everything below this line into the project's AGENTS.md --- 8< ---

# {{PROJECT_NAME}}

{{APP_TYPE}}. Built with the BrewedOps Agentic Framework (https://brewedops.cloud/framework).

## Stack
{{STACK}}
{{STACK_NOTES}}

## Structure
- Feature folders: `src/features/<domain>/`
- API and data logic in `lib/` - never in components
- Components render. Hooks orchestrate. Lib functions do the work.
- Files `kebab-case` | Components `PascalCase` | Functions `camelCase`

## Real package code (opensrc) - always, before using any dependency
- Run `opensrc path <package>` and read the real source before writing code that uses it.
  npm `opensrc path <name>` | Python `pypi:<name>` | Rust `crates:<name>` | GitHub `<user>/<repo>`
- Cite the file you read. Never guess method names, options or types, even for familiar packages.

## The build loop - after every small piece
1. **code-structure skill**: one version of each operational step; repeats go into a service
   layer. Actions own the rules, services own the mechanics.
2. **Clarity pass** on the changed code only: same behavior, fewer lines, no nested ternaries,
   no clever one-liners, no refactoring of untouched code.
3. **scanloop skill**: gitleaks + semgrep + osv-scanner on the diff. Every secret is blocking.
4. **greploop skill**: review panel scores 1-5; fix blocking + major findings, re-review from a
   fresh context until 5/5. Keep diffs small - a big diff never converges.
5. Commit, push, CI green. That is "done". It is not "live".

## CI and deploy (ship skill)
- Target: {{DEPLOY_TARGET}} | Live: {{LIVE_URL}} | Server path / process: {{SERVER_PATH_OR_TBD}}
- Deploy command: {{DEPLOY_COMMAND_OR_TBD}} | Rollback: {{ROLLBACK_COMMAND_OR_TBD}}
- CI (`.github/workflows/ci.yml`) runs a clean install, lint, test and build on Linux for every
  push to `main` and every PR.
- After ANY dependency change: `gh workflow run relock.yml`, `git pull`, `gh workflow run ci.yml`.
- **Nothing deploys unless the user says "deploy" for this change.** A push to an
  auto-deploying branch counts as a deploy.
- Before every deploy: `node scripts/preflight-deploy.mjs --live {{LIVE_URL}}` must pass, then
  the ship skill's checklist - rollback prepared BEFORE upload.
- Uploaded is not live. Check the live `version.json`, then use the changed feature on the real
  site. Report what was verified and what the user still needs to check.

## Notes (long-term memory)
- Notes folder: {{NOTES_PATH}} (plain Markdown).
- Search it before any web search when a task touches past work or decisions.
- On "save progress": a dated note under `10 - Projects/{{PROJECT_NAME}}/` - what changed,
  what went wrong, what to remember - then commit and push.

## House rules
- Everything in the user's global rules file applies here too.
- {{PROJECT_SPECIFIC_RULES_OR_DELETE_THIS_LINE}}

--- 8< --- end of project AGENTS.md --- 8< ---
