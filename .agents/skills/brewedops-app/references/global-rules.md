# My AI rules

<!-- agentic-framework-kit: global rules v1 -->
<!--
Starter global rulebook for the BrewedOps Agentic Framework. Your AI reads this at the start of
every session, in every project. Fill in the <ANGLE BRACKET> parts, delete what does not apply,
and keep it to about a page - depth belongs in your notes folder, not here.

Where this file goes depends on your tool (the installer can place it for you):
  Claude Code      ~/.claude/CLAUDE.md
  Codex            ~/.codex/AGENTS.md
  Gemini CLI       ~/.gemini/GEMINI.md
  Antigravity      ~/.gemini/GEMINI.md   (shared with Gemini CLI)
  Copilot CLI      ~/.copilot/copilot-instructions.md
  Cursor           Settings > Rules > User Rules (paste it in - Cursor has no global rules file)
-->

## Who I am
- <Your name>, <what you do>. Timezone <e.g. UTC+8>.
- I build with AI and I am not a trained developer: <or delete this line>.
- Explain things in plain words; keep answers short unless I ask for detail.

## How we work
- I decide what to build and what ships. You do the typing, searching and fixing.
- Build one small piece at a time. A giant task overflows your memory and never gets clean.
- For anything bigger than a small change, write a short plan first: the goal, what "done"
  looks like, which files change, and how we will check it. Ask me before guessing on anything
  that would waste real effort if wrong.
- Never invent facts, prices, names or numbers. Mark anything unconfirmed as `[CONFIRM: X]`.
- Only an actual run earns the word "verified". Say plainly what you tested and what still
  needs me to check.

## Real package code (opensrc)
- Before writing code that uses ANY third-party package, run `opensrc path <package>` and read
  the real source. npm: `opensrc path <name>` | Python: `pypi:<name>` | Rust: `crates:<name>` |
  GitHub: `<user>/<repo>`. Cite the file you read. Never guess method names or options.

## After each small piece (the build loop)
0. **Check first**: before the code, write a test (or for UI, a browser check) that FAILS
   because the change is missing. Build until it passes. Never report "done" while a test,
   the lint or the build is red.
1. **code-structure** - keep ONE version of each operational step; extract repeats into a
   service layer. Actions own the rules, services own the mechanics.
2. **Clarity pass** on the code just changed - same behavior, fewer lines, no nested ternaries,
   no clever one-liners, no refactoring of untouched code.
3. **scanloop** - scan the diff for secrets, injection patterns and vulnerable dependencies.
   Every secret found is blocking.
4. **greploop** - review panel scores the diff 1-5; fix every blocking and major finding and
   re-review until 5/5.
5. Commit, push, and wait for CI to pass. That is "done" - not "live".

## Shipping (ship skill)
- Deploy ONLY when I say "deploy" for this specific change.
- Before deploying: run the preflight check, tell me every change that goes live, back up the
  live site and database, and write down the undo command.
- Upload new files first and the page that loads them last. Then prove it is live: check
  version.json, and use the changed feature on the real site.
- If the live check fails, roll back first and investigate after.

## Notes (long-term memory)
- My notes folder: <PATH, e.g. ~/agent-notes> (plain Markdown; Obsidian can open it as a vault).
- Search the notes BEFORE any web search when a task touches a past project, decision or client.
- On "save progress": write a dated note in `10 - Projects/<project>/` - what changed, what went
  wrong, what to remember - then commit and push the code.
- Update an existing note instead of creating a duplicate.

## House rules
- <Your taste and hard rules, e.g. "no emoji in UI", "one icon library", "TypeScript always",
  "never hardcode colors - use the design tokens".>
- A rule I state here is a blocking review finding when it is broken.

## Safety
- Assume anything you can reach, you might act on. Destructive actions (deleting files, sending
  email, touching production data) need my explicit OK every time.
- Never commit secrets. Never deploy from uncommitted files.
