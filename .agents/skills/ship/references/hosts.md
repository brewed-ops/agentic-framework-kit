# Hosts: settings, rollback, proof, one gotcha each

For every host the same four questions: where the build settings and env vars live, how to
roll back, how to prove the new build is live, and the one thing that bites people. Dashboards
and CLIs change - when a step here does not match what you see, check the host's docs rather
than guessing a flag. Proof of live is always the same idea: fetch `<live-url>/version.json`
(written by `write-version.mjs` / `write-version.sh`) and compare its `commit` to what you built.

Secrets per host: [secrets-and-env.md](secrets-and-env.md). Schema changes: [migrations.md](migrations.md).

## Cloudflare Pages

- **Settings:** dashboard, Workers & Pages, the project, Settings (build command, output folder,
  root directory, variables per production / preview). Node version comes from `.nvmrc`,
  `.node-version` or a `NODE_VERSION` variable; pin an exact version.
- **Rollback:** Deployments, All deployments, the menu on a successful production deployment,
  "Rollback to this deployment". Preview deployments are not rollback targets.
- **Prove live:** `version.json` on the production domain; also open the deployment LIST - a
  failed build leaves the previous one serving, so the site looks fine but is old.
- **Gotcha:** a push to the production branch of a Git-connected project IS a production
  deploy. Build-time variables are baked into the output, so a changed variable needs a new
  deploy before it shows up.

## Vercel

- **Settings:** project settings (framework preset, build and output settings, Node version) and
  Environment Variables per Production / Preview / Development. `vercel env pull` writes the
  development values to a local file.
- **Rollback:** Instant Rollback on the production deployment tile or from the Deployments list,
  or `vercel rollback`. Hobby can roll back only to the immediately previous production
  deployment; Pro and Enterprise to any deployment that was once aliased to production.
- **Prove live:** `version.json` on the production domain, and the production deployment tile
  shows the commit.
- **Gotcha:** after a rollback Vercel turns off auto-assignment of production domains, so new
  pushes do NOT go live until you promote a deployment ("Undo Rollback" or `vercel promote`).
  A rollback also keeps the old deployment's environment variables. The Hobby plan is for
  non-commercial use.

## Netlify

- **Settings:** `netlify.toml` in the repo (`[build] command`, `publish`) overrides the UI; env
  vars in Site configuration, Environment variables, scoped by deploy context. Values written in
  `netlify.toml` are committed, so never put secrets there.
- **Rollback:** open a previous successful deploy in the Deploys list and "Publish deploy". It is
  instant and does not rebuild.
- **Prove live:** `version.json`; the Deploys list marks which deploy is published.
- **Gotcha:** with auto publishing on, the next Git-triggered production deploy overwrites your
  rollback. Lock publishing (or stop pushing) until the fix is ready. An SPA needs a
  `/* /index.html 200` rewrite or deep links 404.

## Render

- **Settings:** the service's Settings (build and start command) or a `render.yaml` Blueprint in
  the repo; env vars in the service's Environment tab, Environment Groups, or secret files.
- **Rollback:** the service's deploy history, "Rollback" on an earlier deploy. It redeploys that
  deploy's build artifact and its environment variables. Only a limited number of recent
  artifacts are kept, depending on plan.
- **Prove live:** `version.json`, the service's Events / Logs for the new deploy starting cleanly.
- **Gotcha:** a rollback from the dashboard turns OFF auto-deploy for the service; turn it back on
  in Settings once fixed. The default filesystem is ephemeral - a SQLite file or uploads on disk
  are lost on every deploy unless they live on a persistent disk.

## Railway

- **Settings:** the service's Settings, or `railway.json` / `railway.toml` config-as-code in the
  repo; env vars in the service's Variables tab, with shared variables at project level and
  references to other services' variables.
- **Rollback:** Deployments, the menu on an earlier successful deployment, Rollback. It restores
  that deployment's image and variables. Deployments older than the plan's retention cannot be
  rolled back to.
- **Prove live:** `version.json`, deploy logs showing the new deployment active.
- **Gotcha:** the app must listen on the port Railway provides in `PORT`, not a hard-coded one,
  or the deploy "succeeds" and every request fails.

## Fly.io

- **Settings:** `fly.toml` in the repo (build, `[env]` for non-secret values, services and
  `internal_port`). Secrets via `fly secrets set NAME=value`, which restarts every Machine
  (`--stage` defers that to the next deploy).
- **Rollback:** no rollback command; list images with `fly releases --image` and redeploy one with
  `fly deploy --image <image-ref>`. That uses the CURRENT `fly.toml` and secrets, not the old ones.
- **Prove live:** `version.json`, `fly status` for Machine health, `fly logs` for boot errors.
- **Gotcha:** the app must listen on `0.0.0.0` and the port set as `internal_port`; listening on
  localhost passes locally and fails health checks on Fly. Volumes belong to one Machine and are
  not replicated.

## GitHub Pages

- **Settings:** repo Settings, Pages: publish from a branch folder, or from a GitHub Actions
  workflow (needed for any build step other than Jekyll).
- **Rollback:** revert the bad commit and push, or re-run the last good deploy workflow run (a
  re-run builds that run's original commit).
- **Prove live:** `version.json`; the Actions run for the deploy and the Pages environment show
  the deployed commit. Allow a few minutes for the CDN.
- **Gotcha:** static only - no runtime secrets exist, and anything a build step reads from Actions
  secrets ends up in public files. A project site is served under `/<repo>/`, so set the
  bundler's base path, and there are no server rewrites for SPA deep links.

## Docker on a VPS

- **Settings:** `Dockerfile` + `compose.yaml` in the repo. Env vars from an `env_file:` on the
  server (owner-only permissions, never committed). Never pass secrets as build `ARG`/`ENV` -
  they are stored in the image layers.
- **Rollback:** tag every image with the commit (`app:<sha>`), keep the previous tags, set the
  compose image tag back to the last good one and `docker compose up -d`. Write the previous tag
  in the deploy report before switching.
- **Prove live:** `version.json` through the public URL (not only from inside the server),
  `docker compose ps` for health, `docker compose logs` for boot errors.
- **Gotcha:** ports published by Docker bypass common host firewalls such as ufw, because Docker
  writes its own iptables rules. Bind internal services to `127.0.0.1:` and put a reverse proxy
  in front.

## Plain VPS: nginx + a process manager

- **Settings:** the nginx site config and the process manager's config (a pm2 ecosystem file or
  a systemd unit) live on the server - read them from there, never from notes. Env vars in a
  systemd `EnvironmentFile=` or the ecosystem file, owner-only, outside the web root.
- **Rollback:** one folder per release (`releases/<sha>`) and a `current` symlink; point it back
  at the previous release and reload. Or restore the archive taken before upload (SKILL.md
  section 2).
- **Prove live:** `version.json` via the public URL, `pm2 show <name>` or `systemctl status
  <unit>` for the process and its real working directory, logs for boot errors, `nginx -t`
  before any reload.
- **Gotcha:** `pm2 restart` keeps the environment the process started with; pass
  `--update-env` after changing variables, and `pm2 save` so a reboot restores the new state.
