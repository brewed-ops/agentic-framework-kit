# greploop per-file rules

Loaded by greploop Step 1. Each `## ` heading is a comma-separated list of globs; a file takes
the FIRST section whose glob matches it (so specific globs sit above general ones), and a file
nothing matches takes `Default`. Attach only the matched sections to a bundle's reviewers.

Curated from alibaba/open-code-review's rule docs (Apache-2.0,
`internal/config/rules/rule_docs/`), trimmed to this stack and to defects rather than taste.
The "Do not report" lines are theirs too: each one names a known false-positive shape, learned
from production review traffic. They cut noise without cutting real bugs - keep them.

House rules from CLAUDE.md are NOT repeated here; they go to every reviewer as MUST-CHECK.

A project can add `.greploop/rules.md` in the same format; its sections append to these.

---

## .github/workflows/**/*.yml, .github/workflows/**/*.yaml

- `pull_request_target` with `actions/checkout` of the PR head: runs untrusted code with write
  permissions. Blocking.
- `${{ github.event.* }}` (issue title, PR body, branch name) interpolated straight into `run:`
  is script injection. Pass it through `env:` instead. Blocking.
- Secrets echoed to logs, or credentials hardcoded instead of `secrets.*`.
- Missing or broad `permissions` (`write-all`, or no key at all); each job should declare only
  what it needs.
- Third-party actions pinned to a mutable tag instead of a commit SHA (`actions/*` on a major
  tag is fine).
- `needs:` pointing at a job ID that does not exist; misspelled action inputs (silently ignored).
- A step that needs git history (tags, merge-base, changelog) without `fetch-depth: 0`.
- `|| true` or `continue-on-error: true` hiding a failure that should fail the job.
- Jobs without `timeout-minutes` on self-hosted runners.

## **/package.json

- A newly added dependency at `latest` or `*` (only on added lines).
- The same package in both `dependencies` and `devDependencies`.
- A tool used in `scripts` (eslint, vitest, prettier, tsx) not declared in `devDependencies`.
- A new runtime dependency at all: flag it so the author confirms it was intended (house rule
  in most projects: no new deps without flagging).

## **/*.astro

- Frontmatter data reaching client HTML, inline scripts, or hydrated islands: check it is not a
  secret, a non-`PUBLIC_` env value, cookie, header, session, or `Astro.locals` value.
- Templates that assume frontmatter values are reactive in the browser (they run once).
- `client:*` on an `.astro` component or a dynamic tag (it only works on imported framework
  components); `client:load` on non-critical UI where `client:idle`/`client:visible` fits;
  `client:only` without the framework string or fallback content.
- Props crossing a hydration boundary that are not serializable (functions, class instances,
  circular objects) or are far larger than the island needs.
- `<script define:vars>` carrying secrets or large payloads (it inlines JSON per instance).
- `set:html` on anything not clearly trusted or sanitized. Blocking unless the source is proven
  safe.
- `is:global` where scoped styles or a narrow `:global(...)` would do; scoped selectors that
  assume they can style a child component's internals.
- A component that accepts `class` from the parent but does not forward it.
- Plain `<img>` / `public/` assets where the code expects Astro image optimization.

## **/*.ts, **/*.tsx, **/*.js, **/*.jsx, **/*.mjs, **/*.cjs

Correctness
- Null/undefined reaching code that assumes a value: property access or destructuring on a
  result that can be `null` (a `find`, a `getElementById`, an optional API field).
- Dead code: branches whose condition is always false, code after `return`/`throw`, variables
  declared and never read.
- `==`/`!=` where the coercion changes the result (`0 == ''`, `null == undefined`).
- `any` added without a comment saying why; a type assertion (`as X`) papering over a shape
  the API does not actually return.
- Spelling errors in exported names, props, or user-facing strings.

React
- Hooks called conditionally, in loops, or outside a component/hook.
- `useEffect` with missing dependencies (stale closure) or a subscription/timer/listener with
  no cleanup.
- A component declared inside another component's body: it gets a new identity every render,
  remounts, and loses its state. Hoist it.
- Side effects during render (fetching, DOM writes, state updates outside handlers/effects).
- `React.memo`/`useMemo`/`useCallback` defeated by a new object/array/function prop created
  every render.
- Keys from array index on lists that reorder, insert, or delete (state moves to the wrong row).

Async
- Promises neither awaited nor `.catch`ed; `async` errors swallowed with no user-visible path.
- Independent awaits run sequentially in a loop where `Promise.all` was intended, or dependent
  ones run in parallel where order matters.
- Race: a response for an old request overwriting state after a newer one (no abort/ignore).

Security
- User input into `innerHTML`, `dangerouslySetInnerHTML`, `document.write`, or a URL/`href`
  without escaping or allowlisting. Blocking.
- `eval`, `new Function`, or string-form `setTimeout`/`setInterval`.
- API keys, tokens, or secrets in client-side code or bundled env vars.
- Modifying native prototypes (`Array.prototype`, `Object.prototype`).
- Business-significant hardcoded values (URLs, IDs, prices, limits) that belong in config.

Do not report
- Style preferences (`let` vs `const` where both are correct, ternary vs `if`, promise chains
  vs async/await) when behavior is identical.
- Edge cases a type contract or upstream validation already rules out - check the caller first.

## **/*.py, **/*.pyi

- Mutable default arguments (`def f(x=[])`); class-level mutable attributes shared across
  instances by accident; closures capturing a loop variable.
- Empty input assumed non-empty (`xs[0]`, `max()`, `min()` on a possibly empty sequence);
  `d[k]` where the key can be missing; division where the divisor can be zero.
- Bare `except:` or `except Exception: pass`; re-raising without `from err` so the cause is
  lost; a `try` wrapping far more than the line that can fail.
- `assert` used to validate external input (stripped under `python -O`).
- `is` compared against string/number literals (interning-dependent); `== True` where a truthy
  non-`True` value would compare unequal.
- Files, sockets, locks, DB connections opened outside `with` and leaked on an early return or
  exception.
- Blocking calls (`requests`, `time.sleep`, sync file I/O) inside `async def`; `asyncio` tasks
  created and never awaited.
- `eval`/`exec` on untrusted input, `subprocess(..., shell=True)` built from input, `pickle` or
  `yaml.load` without `SafeLoader` on untrusted data, SQL built with f-strings, `random` for
  tokens, `md5`/`sha1` for passwords, untrusted paths joined without traversal checks. Blocking.

Do not report
- Unused imports/params in `.pyi` stubs; short-lived scripts' resource handling; concurrency
  issues with no evidence the code runs concurrently; `== None` beyond a minor.

## **/*.sql, **/migrations/**, **/supabase/**

- Dropping, renaming, or narrowing a column/table/enum value that deployed code or other
  migrations still use - grep the callers before accepting it. Blocking.
- A new `NOT NULL` column with no default or backfill for existing rows; a new gating column
  (a flag that filters rows) with no backfill, which silently hides every existing row.
- A unique constraint added to existing data with no dedupe step.
- An index created on a column before the `ALTER` that adds it, or an index dropped that a
  hot query or a uniqueness guarantee depends on.
- Supabase: a new table without RLS enabled, or a policy that lets one user read or write
  another user's rows (missing `auth.uid()` ownership check). Blocking.
- `ON DELETE CASCADE` that can delete data the change did not mean to own.
- Destructive statements (`DELETE`, `UPDATE` without `WHERE`, `TRUNCATE`) in a migration with
  no guard or comment saying it is intended.

## **/*.prisma

- Relation fields whose optionality, `fields`, or `references` disagree; a relation name
  changed on one side only.
- `onDelete`/`onUpdate` that can delete, null, or orphan data unexpectedly; `SetNull` on a
  required relation.
- Removing/renaming/narrowing a model, field, enum value, `@id`, `@unique`, `@map`, or native
  type in a way that loses data or breaks deployed client code; a required field with no
  default or backfill.
- A unique constraint added to existing data without a dedupe path, or removed when auth,
  tenancy, `connect`, or `upsert` depends on it.
- Database URLs or credentials hardcoded in the schema.

Do not report
- Formatting, naming style, or speculative indexes with no query evidence; anything
  `prisma validate` already catches mechanically.

## **/*.css, **/*.scss

- Colors, spacing, or radii as literals where the project has a token/CSS variable for them
  (read the stylesheet's `:root` first).
- Animating `width`, `height`, `top`, `left`, `margin`, or `padding` instead of
  `transform`/`opacity`.
- `h-screen`/`100vh` for full-height layout on mobile (use `100dvh`).
- A selector scoped too broadly (`body`, `a`, `nav`, `input`) inside a component or embed
  stylesheet, leaking into the host page.
- `position: fixed` inside a transformed ancestor (it becomes relative to that ancestor).

## **/*.json, **/*.json5, **/*.yml, **/*.yaml

- Misspelled KEYS (a config key typo is silently ignored). Ignore values.
- Duplicate keys (the later one wins silently).

## Default

- Correctness: missing boundary conditions, unhandled failures, thread/async safety.
- Security: injection, sensitive data exposure, missing permission checks.
- Performance: N+1 queries, work repeated inside loops, resources not released.
- Tests: critical paths and boundary conditions covered.
