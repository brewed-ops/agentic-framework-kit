# Secrets and environment variables

A secret is anything that grants access: API keys, database URLs with passwords, signing keys,
webhook secrets, OAuth client secrets, SMTP passwords. The rules below keep them out of git,
out of public bundles, and out of CI.

## 1. Never commit a secret

- `.env`, `.env.local`, `.env.production` and any `*.pem` / `*.key` go in `.gitignore` before
  the first commit, not after.
- Commit a `.env.example` with every variable NAME and a comment, never a value:

  ```sh
  # Postgres connection string for this environment
  DATABASE_URL=
  # Server-side only. Never prefix with VITE_ or NEXT_PUBLIC_.
  PAYMENT_API_KEY=
  # Public: safe in the browser bundle
  VITE_API_BASE_URL=
  ```

- A new variable is added to `.env.example` in the same commit as the code that reads it. A
  deploy that fails because a variable is missing should be caught by reading this file, not by
  a crash on the server.

## 2. One value per environment

Development, preview/staging and production each get their own values: their own database,
their own API keys (test mode keys for payment providers), their own webhook secrets. A
production key on a laptop or in a preview deploy is a production key in more places than it
needs to be. If a provider offers restricted or scoped keys, use the narrowest scope that works.

## 3. Load them in one place

Read environment variables in ONE config module (for example `src/lib/config.ts` or
`app/config.py`). It reads each variable once, fails at startup with a clear message when a
required one is missing, and exports typed values. Everything else imports from it.

```ts
function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var ${name} - see .env.example`)
  return v
}
export const config = { databaseUrl: required('DATABASE_URL') }
```

Why: a grep for `process.env` / `os.environ` then shows exactly one file, a missing variable
fails at boot instead of on the first request that needs it, and nothing logs the whole
environment by accident.

## 4. Browser bundles are public

Every variable a bundler inlines into client code is readable by anyone who opens the site:
`VITE_*` (Vite), `NEXT_PUBLIC_*` (Next.js), `PUBLIC_*` (Astro, SvelteKit), `REACT_APP_*`
(Create React App), `EXPO_PUBLIC_*` (Expo). Only put values there that you would print on the
home page: a public API base URL, a publishable key, an analytics site id. A secret key with a
public prefix is leaked on the next build. Anything secret stays on a server route or function
that the browser calls.

After a build, grep the output folder for the first few characters of each real secret. If
one is there, the build is leaking it.

## 5. Where each host keeps them

Set production values in the host's own settings, never in a committed file. Most hosts
separate production from preview values; set both deliberately. Details per host in
[hosts.md](hosts.md).

| Host | Where |
|---|---|
| Cloudflare Pages | Project settings, variables and secrets, per production / preview |
| Vercel | Project settings, Environment Variables, per Production / Preview / Development |
| Netlify | Site configuration, Environment variables, per deploy context |
| Render | Service Environment tab, or an Environment Group shared by services |
| Railway | Service Variables tab; shared variables at the project level |
| Fly.io | `fly secrets set NAME=value` for secrets; `[env]` in `fly.toml` only for non-secrets |
| GitHub Pages | None at runtime. Build-time values come from Actions secrets and end up public |
| VPS / Docker | An env file on the server, owner-only (`chmod 600`), outside the web root |

Most hosts apply a changed variable only to the NEXT deploy. After changing one, redeploy and
confirm the new value is in effect.

## 6. CI holds as little as possible

- CI needs secrets only for what it actually runs. Lint, test and build usually need none.
- Tests use test values, a throwaway database, or mocks. Never point CI at production data.
- CI holds no production deploy credentials: deploys run from a human's machine after the gate
  passes (see SKILL.md). If a team later moves deploys into CI, that job gets its own
  environment with required reviewers, and nothing else in the workflow can read its secrets.
- Workflows that run on pull requests from forks do not receive repository secrets. Keep it that
  way; never rewrite a workflow to hand secrets to untrusted code.

## 7. Scan history before it is public

Deleting a secret in a new commit does not remove it: every earlier commit still holds it.
Scan the WHOLE history with gitleaks (or a similar scanner):

```sh
gitleaks git .          # recent gitleaks; older versions use: gitleaks detect --source .
```

Run it before the first push to any remote, and again before making a private repo public.
Add a pre-commit hook or a CI step so new leaks are caught when they are written.

## 8. When a secret leaks

Order matters.

1. **Rotate first.** Create a new key at the provider, deploy it, then revoke the old one. Once
   a secret has been pushed anywhere, assume it was copied; cleaning history does not undo that.
2. **Check for use.** Look at the provider's logs or usage dashboard for activity you did not
   make between the leak and the revocation.
3. **Then clean history** if the repo will be (or is) public: `git filter-repo` to remove the
   file or replace the string, force-push, and tell every collaborator to re-clone. Forks and
   caches may still hold the old commits - which is why step 1 comes first.
4. **Fix the cause.** Add the file to `.gitignore`, add the scanner, move the value into the
   config module. One line in the project's instructions file saying what happened stops the
   next agent from repeating it.
