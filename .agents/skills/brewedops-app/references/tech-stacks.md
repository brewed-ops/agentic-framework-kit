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
- Structure: feature folders `src/features/<domain>/`, API/data logic in `lib/`, components
  render / hooks orchestrate / lib does the work. Files `kebab-case`, components `PascalCase`.
- Whatever the stack, the project AGENTS.md still requires opensrc before packages,
  code-structure, the clarity pass, scanloop, greploop and the ship gate. The loop does not care
  about the stack.
