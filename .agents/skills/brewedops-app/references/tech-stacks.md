# Tech-stack decision matrix

Used in Phase 2. The point of this file is to stop the reflex of scaffolding React/Vite for
everything. Ask what the app is for, then recommend the best fit below: primary pick, one
alternative, a one-line reason - and wait for the user's OK. If the user's global rules name a
different default for a category, follow it but say what the trade-off is.

| What it's for | Primary recommendation | Alternative | Why |
|---|---|---|---|
| Marketing site / landing page / blog / docs | Astro + Tailwind | Next.js (static export) | Mostly-static content ships near-zero JS; fast and good for SEO. An SPA is overkill. |
| Web app / dashboard / SaaS (auth, data, routing) | Next.js (App Router) + Supabase + Tailwind | React + Vite + a backend | Routing, API routes, auth and SSR in one. Vite SPA only if there is already a separate backend. |
| Internal tool / CRUD admin / quick utility | React + Vite + TS + Supabase | Next.js | Fast dev loop, no SSR needed. |
| Mobile app (iOS/Android) | Expo (React Native) + TS | Capacitor (wrapping an existing web app) | Expo for native-first; Capacitor when a web UI just needs to reach the stores. |
| Desktop app | Tauri (Rust core + web UI) | Electron + electron-vite | Tauri = small binaries, low memory. Electron when a Node-heavy main process is required. |
| CLI tool | Node.js + TS (commander / clack) | Python (typer) or Rust (clap) | Node near the JS ecosystem; Python for data/scripting; Rust for one fast binary. |
| API / backend service | Hono (TS) or Fastify | Python FastAPI | Hono is light and runs on Node/Bun/edge. FastAPI when Python libraries (ML, data) are needed. |
| Browser extension | Vite + CRXJS + TS | WXT | Manifest V3 wiring handled, hot reload in the extension. |
| AI agent / LLM product | Node.js + TS + the model provider's SDK | Python + the same | Read the provider's current docs (or opensrc the SDK) before writing calls. |
| Real-time / collaborative | Next.js + Supabase Realtime (or Liveblocks) | Node + ws + Postgres | Do not hand-roll websockets unless the collaboration model is unusual. |
| Game / canvas / interactive | Vite + TS + the right engine (Phaser 2D, Three.js 3D) | plain canvas | Match the engine to 2D/3D; skip a UI framework for pure canvas. |
| Data / notebook / analysis | Python + uv + Jupyter / Polars | - | Not a web stack - do not force React onto it. |

## Defaults once a stack is chosen

- TypeScript for anything JS; type the API and database responses.
- Web styling: Tailwind. One icon library per project, never emoji as UI icons.
- Database/auth: Supabase (hosted) or SQLite (self-hosted / mobile).
- Whatever the stack, the project AGENTS.md still requires opensrc before packages, a failing
  check first, code-structure, the clarity pass, scanloop, greploop and the ship gate. The loop
  does not care about the stack; the folder layout does.

## Structure per stack

Copy the matching row into the project AGENTS.md as `{{STRUCTURE_RULES}}` (as bullets) and
`{{TEST_COMMAND}}`. Follow the stack's own conventions - do not force one stack's layout on another.

| Stack | Layout and naming | Test command |
|---|---|---|
| React + Vite / Next.js | Feature folders `src/features/<domain>/`; API and data logic in `lib/`, never in components; components render, hooks orchestrate, lib does the work. Files `kebab-case`, components `PascalCase`, functions `camelCase`. Next.js: routes in `app/`, server-only code never imported by client components. | `npx vitest run` (Next.js: same, or `npx jest`) |
| Astro | Pages in `src/pages/`, layouts in `src/layouts/`, components in `src/components/`; content in `src/content/` with a collection schema; client JS only in islands that need it. | `npx vitest run`; build check `npx astro check && npm run build` |
| Expo (React Native) | Routes in `app/` (expo-router), shared UI in `components/`, API/data in `lib/`; platform-specific files `*.ios.tsx` / `*.android.tsx`. | `npx jest` |
| Tauri / Electron | Web UI in `src/` (as for React); native side in `src-tauri/` (Rust) or `electron/main/` - the UI never touches the file system directly, it asks the native side. | UI: `npx vitest run`; Rust side: `cargo test` |
| Browser extension | `src/background/`, `src/content/`, `src/popup/` (and `options/`); messages between them go through one typed module. | `npx vitest run` |
| Node / TS CLI or API | `src/commands/` (CLI) or `src/routes/` (API), shared logic in `src/lib/`; one entry file; config from env in one module. Files `kebab-case`. | `npx vitest run` |
| Python (CLI, API, data) | `src/<package>/` layout, modules `snake_case`, classes `PascalCase`; entry point in `cli.py` or `main.py`; tests in `tests/` mirroring the package; dependencies in `pyproject.toml` via uv. | `uv run pytest` |
| Go | `cmd/<app>/main.go` for binaries, packages in `internal/<domain>/`, short lowercase package names; tests `*_test.go` beside the code; errors returned, not panicked. | `go test ./...` |
| Rust | `src/main.rs` (binary) or `src/lib.rs` (library), modules `snake_case`, types `PascalCase`; unit tests in a `#[cfg(test)] mod tests` per file, integration tests in `tests/`. | `cargo test` |
| Data / notebooks | Exploration in `notebooks/`, reusable code in `src/<package>/` (notebooks import it, never copy it), raw data in `data/` (gitignored). | `uv run pytest` |
