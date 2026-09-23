# Changelog

Versions follow `MAJOR.MINOR.PATCH`. The installed version is written next to each skills
folder (`agentic-framework-kit.installed`); `./install.sh --version` prints the kit's.

## 1.1.0 - 2026-09-24

- **greploop quick mode**: small or docs-only changes get scanloop plus one reviewer and one
  round, instead of the full three-reviewer panel.
- **Test first** is now a step in the build loop: write the failing test, then the code.
- **Stack-aware project template**: folder and naming rules come from the chosen stack (React,
  Python, Go, Rust...), not a React layout for everything.
- **CI templates for Python, Go and Rust** alongside Node, and a language-neutral `write-version.sh`.
- **ship** covers secrets and environment variables, database migrations, and more hosts
  (Netlify, Render, Railway, Fly.io, GitHub Pages, Docker on a VPS).
- **code-structure is pinned** to commit `4b72f46` of michaelshimeles/skills and checked against a
  SHA-256 hash; a mismatch is refused instead of installed.
- Installers: `--version`, `--uninstall`, an install record per skills folder, "updating X -> Y"
  on rerun, and old backups pruned to the newest 3.
- License detection: third-party notes moved from LICENSE to NOTICE, so GitHub reads it as MIT.
- `examples/`: a real greploop run on a demo project, before and after.

## 1.0.0 - 2026-09-24

- First release: brewedops-app, greploop, scanloop and ship skills in the Agent Skills format;
  AGENTS.md setup guide; installers for Claude Code, Codex, Cursor, Gemini CLI, Antigravity and
  GitHub Copilot.
