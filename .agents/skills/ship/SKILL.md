---
name: ship
description: CI and a careful production deploy gate. Sets up CI (GitHub Actions on Linux, lockfile relock, Node version pin, version.json stamp) and runs every production deploy through a checklist - explicit user go, preflight script, rollback prepared before upload, safe upload order, and proof that it is live. Use when the user says "deploy", "ship it", "push to production", "release", "go live", "set up CI", or is about to upload a build to a server or hosting provider. Never deploys on its own initiative.
---

# ship - CI and the deploy gate

The build loop ends when a change is reviewed and pushed. This skill covers what comes after:
CI proves the commit on a clean Linux machine, and a production deploy runs through a gate in a
fixed order. Every rule below exists because skipping it broke a real production site once.

**Two laws**
1. **The user calls what ships.** CI runs on every push; a production deploy runs only when the
   user says so for THIS change. A "deploy it" from last week does not cover today's diff. A push
   to a branch that auto-deploys (Cloudflare Pages `main`, Vercel production) IS a deploy and
   needs the same go.
2. **"I deployed it" is not "it's live".** A deploy is finished when the live site is proven to
   serve the new build and the changed feature works on a real page. Until then report it as
   "uploaded, unverified".

---

## 1. Set up once per project

**Record the target.** Add a `## Deploy` section to the project instructions file (AGENTS.md or
your tool's equivalent): target, live URL, server path / process name, deploy command, rollback
command. Unknowns stay `TBD` - never invent a server path; read it from the server on the first
deploy. Where each host keeps build settings and env vars, how it rolls back and one gotcha
each (Cloudflare Pages, Vercel, Netlify, Render, Railway, Fly.io, GitHub Pages, Docker, VPS):
[references/hosts.md](references/hosts.md).

| App shape | Good default target | Why |
|---|---|---|
| Static / Astro / marketing site | Cloudflare Pages | Free, commercial use allowed, unlimited bandwidth |
| SPA + Node API, database on disk | A VPS with nginx + pm2 | Full control, one box |
| Heavy Next.js SSR/ISR | Vercel (paid plan for commercial use) | Built for it; the free plan forbids commercial use and caps crons at daily |
| Browser extension | Store zip built from a release copy | Never zip the dev/test folder - test labels and flags leak |

**Set up secrets before the first deploy.** `.env` in `.gitignore`, a `.env.example` with names
only, one config module that reads them, production values only in the host's settings, and a
gitleaks scan of the whole history before the first push: [references/secrets-and-env.md](references/secrets-and-env.md).

**Add CI** (copy from this skill's `assets/`):
- `assets/ci.yml` -> `.github/workflows/ci.yml`. Every push to `main` and every PR: `npm ci` on
  Linux, lint, test, build. A lockfile written by npm on Windows can be rejected by `npm ci` on
  Linux - CI finds that in minutes instead of on deploy day.
- Other stacks: copy ONE of `assets/ci-python.yml` (uv + ruff + pytest), `assets/ci-go.yml`
  (vet, test, build; Go version from `go.mod`) or `assets/ci-rust.yml` (fmt, clippy, test) to
  `.github/workflows/ci.yml` instead. The Node-only files below (relock, Node pin,
  `write-version.mjs`) do not apply; use `write-version.sh` for the version stamp.
- Every template is a workflow named `CI` with one job whose `name:` says what it proves (for
  example `Lint, test, build`). Keep those names: the preflight requires checks BY NAME. A green
  run means lint and tests actually ran - there is no `--if-present`, and the Go and Rust
  templates fail when the project has no tests at all. A project with no tests yet on purpose
  deletes the test step(s) and writes `Tests: none - <reason>` in AGENTS.md, so the choice is
  visible and the preflight reports it.
- `assets/relock.yml` -> `.github/workflows/relock.yml`. Regenerates `package-lock.json` on Linux
  and commits it. After ANY dependency change: `gh workflow run relock.yml`, then `git pull`, then
  `gh workflow run ci.yml` (a bot's push does not trigger other workflows).
- `assets/check-node-pin.mjs` -> `scripts/`, wired as `"prebuild"`, with an exact `.nvmrc`
  (e.g. `24.8.0`, not `24`). Fails the build when any package refuses the pinned Node - hosts
  install exactly that version, so builds that pass locally on a newer Node can die there.
  Needs `semver` as a devDependency.
- `assets/write-version.mjs` -> `scripts/`, wired as `"postbuild"` (pass the output folder if it
  is not `dist`). Writes `version.json` = `{"commit", "builtAt"}` into the build, so "what is
  live?" has a factual answer. Any other stack: `assets/write-version.sh` -> `scripts/`, run
  right after the build as `sh scripts/write-version.sh <output-folder>` (needs only git and a
  POSIX shell).
- `scripts/preflight-deploy.mjs` -> the project's `scripts/`. The mechanical half of the gate.
- CI never deploys and never holds production credentials. Deploys run from the user's machine,
  where a human can stop them.

**Give build output a folder nothing else uses.** Bundlers like Vite EMPTY their output folder;
point it at a folder that holds anything else and that content is deleted with a green build.
Deploy from an explicit allow-list of paths, never a glob.

---

## 2. The gate - before every production deploy

Run `node scripts/preflight-deploy.mjs --live <url>` from the project root (`--first-deploy` if
nothing is live yet, `--path <folder>` inside a monorepo, `--no-ci` only if the repo truly has no
CI - and say so in the report). It fetches the remote first, checks items 1-4 and exits 1 on any
failure. Items 5-10 are judgment: report each as PASS or N/A with one line of evidence.

`--require <name>` (repeatable) names each check that must be green on this commit - a workflow
name or a job name. The default is `CI`, the workflow name every template here uses; a repo
whose workflow has another name passes it explicitly (`--require "Check kit"`). Record the exact
`--require` list in the project's `## Deploy` section so every deploy checks the same jobs.

1. **Committed.** No uncommitted changes in the app. Deploy from a commit, never a working tree.
   If live was built from uncommitted files, commit them first or the next build reverts them.
2. **Pushed.** The commit is on the remote, so what ships can always be recovered. Checked
   against freshly fetched refs; if the fetch fails, this FAILS - stale refs prove nothing.
3. **CI green on this exact commit.** Every required check ran on THIS commit and passed. A
   required check that never ran, is still running, failed, was cancelled or was skipped FAILS,
   and so does any other failing run on the commit. Not the previous commit, not "it passed
   locally". The **Tests** line then reads the committed workflows: PASS names the test command
   CI runs, WARN means CI has no test step (green does not mean tested) or reports a declared
   `Tests: none` policy, FAIL means the test command has `--if-present`.
4. **Scope known.** The preflight lists every commit between live `version.json` and HEAD. That
   list is what goes live - not just "my fix". Name unreleased or unreviewed work riding along to
   the user BEFORE upload. It also FAILS if live holds commits HEAD lacks: deploying would
   silently delete that work.
5. **Reviewed.** Security scan clean and code review passed on the whole release diff, not only
   the last chunk.
6. **Target read from the server, not from notes.** VPS: `pm2 show <name>` for the real working
   directory. Hosted: the build settings (preset, command, output folder, Node version) match
   the repo.
7. **No live regression.** Grep the LIVE bundle for one visible string or CSS class per major
   feature (minifiers strip function names and comments); if your build lacks one, you are about
   to delete a live feature. Backend: download the live server file and `diff` it. For an SPA,
   also load a sub-path and a `?query` URL - adding a router to a page that had none turns every
   unknown path into a blank screen unless there is a catch-all route.
8. **Contract order.** If a request or response shape changed, the API ships first and accepts
   BOTH the old and new field names, so old cached pages keep working.
9. **Release, not test.** Test flags off, and no test-only label, panel or seed data anywhere a
   flag flip does not reach.
10. **Real headers.** A new browser library is tested under the LIVE Content-Security-Policy -
    a dev server sends none, and a CSP failure is total.

**Prepare the rollback before uploading:**
- Web root: `tar czf /root/<app>-web-<timestamp>.tgz -C <web-root> .` on the server.
- SQLite: `sqlite3 <db> ".backup '/root/<app>-<timestamp>.db'"` - never `cp` a live WAL database.
  Postgres/Supabase: a dump or a point-in-time marker.
- Server file: `cp <file> /root/<file>.bak-<timestamp>`.
- Write the exact restore command into the report BEFORE the upload.
- A schema change needs more than a backup: expand/contract, a dry run on a copy of production
  data, a way back for every migration, and the migration running before the code that needs
  it. Follow [references/migrations.md](references/migrations.md).

---

## 3. Deploy - order matters

- **Migration before API before client** when they change: an additive (expand) migration first,
  so the code already live keeps working against it ([references/migrations.md](references/migrations.md)).
- **Upload an archive, not a recursive copy.** `scp -r dir/.` from Windows can fail halfway and
  look like success. Tar it, upload the archive, extract on the server. In Git Bash give tar
  `--force-local` when the path has a drive letter, or `C:/...` is read as a remote host and no
  archive is written.
- **New hashed assets first, `index.html` last, prune old chunks after.** Deleting old assets
  first leaves the old page pointing at files that no longer exist - a blank page for every
  visitor in that window. Swap `index.html` atomically (upload as `index.html.new`, then `mv`).
- **Extract only what changed** when the server holds files your build does not (uploads, media):
  `tar -xzf archive path1 path2` overwrites those paths and deletes nothing else.
- **Versioned runtime folders** (wasm, models, codecs) carry the version in the path, or a long
  cache serves the old runtime to the new code.
- **Backend:** `node --check` the file on the server before restarting; `pm2 save` after any
  process change.

---

## 4. Prove it is live

1. Live `version.json` shows the commit you built; for an SPA the live `index.html` references
   your new entry file. If not, purge the CDN cache for `/index.html`.
2. Health endpoint returns 200 and the process logs show no boot errors.
3. **Use the changed feature on the real site**, the way a user would (a browser script on the
   live URL, or `curl` with real inputs including one failure case). HTTP 200 on the home page
   proves nothing about the change.
4. Hosted builds: wait for the build (Cloudflare takes ~30-60s), then check the host's deployment
   LIST for a failed build - a failed build leaves the last good one serving.
5. Report: deployed commit, scope, what was verified live and how, what still needs the user
   (real phone, hard refresh, a paid flow), and the rollback command.

**Roll back without debate** when the changed feature fails live, the health check fails, or the
logs show boot errors. Restore first, investigate second.

---

## 5. Second time you deploy a project: script it

Write `scripts/deploy.mjs` (or `.sh`) in the project and stop typing the steps by hand: a
`--dry-run` flag that prints every command, a build step that refuses to upload if an expected
output file is missing, the backup, the ordered upload, and a live check at the end that fails
loudly. The project's `## Deploy` section then names that one command - and the gate above still
runs before it.
