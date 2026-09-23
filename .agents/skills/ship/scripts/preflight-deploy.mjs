#!/usr/bin/env node
// Pre-deploy gate: the mechanical checks, run before every production deploy.
// Run from the project root before every production deploy. Exits 1 on any FAIL.
//
//   node preflight-deploy.mjs --live https://example.com
//   node preflight-deploy.mjs --live https://example.com --path apps/web   (monorepo subfolder)
//   node preflight-deploy.mjs --first-deploy          (nothing is live yet)
//   node preflight-deploy.mjs --live <url> --no-ci    (repo has no CI; downgrades that check to WARN)
//   node preflight-deploy.mjs --live <url> --require CI --require "Lint, test, build"
//
// --require <name> (repeatable) names a check that must be green on this exact commit. A name
// matches a workflow name or a job (check run) name. Default: CI, the workflow name of every
// CI template in this skill. Missing, pending, failed, cancelled or skipped = FAIL.
//
// No dependencies (Node 18+). Needs git; needs `gh` (authenticated) to read CI results.
// PREFLIGHT_GH replaces the gh command, e.g. PREFLIGHT_GH='node fake-gh.mjs' (used by tests).

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : args[i + 1]
}
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []))
const flag = (name) => args.includes(`--${name}`)
const LIVE = opt('live')?.replace(/\/+$/, '')
const PATH = opt('path') ?? '.'
const FIRST = flag('first-deploy')
const NO_CI = flag('no-ci')
const REQUIRED = opts('require').length ? opts('require') : ['CI']

const results = []
const record = (status, check, detail) => results.push({ status, check, detail })
const indent = (lines) => lines.join('\n      ')

function sh(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) return { ok: false, out: '', err: r.error.message }
  return { ok: r.status === 0, out: (r.stdout ?? '').trimEnd(), err: (r.stderr ?? '').trim() }
}
const git = (...a) => sh('git', a)
// PREFLIGHT_GH may hold a command plus arguments; double quotes group a path with spaces.
const GH = (process.env.PREFLIGHT_GH || 'gh').match(/"[^"]*"|\S+/g).map((s) => s.replace(/^"|"$/g, ''))
const gh = (...a) => sh(GH[0], [...GH.slice(1), ...a])
const firstLine = (s, fallback) => (s || '').split('\n')[0] || fallback

const top = git('rev-parse', '--show-toplevel')
if (!top.ok) {
  console.error('Not inside a git repository - a deploy must come from a commit.')
  process.exit(1)
}
const head = git('rev-parse', 'HEAD').out
const short = head.slice(0, 7)
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out

// 0. Refresh remote state. Remote-tracking refs are only as fresh as the last fetch, and a stale
// ref can say "pushed" about a branch that was since deleted or rewritten.
const remote = git('config', `branch.${branch}.remote`).out || 'origin'
const fetched = git('fetch', '--quiet', '--prune', remote)

// 1. Committed - only the app's own path, so a shared monorepo's other WIP does not block it.
const dirty = git('status', '--porcelain', '--', PATH).out
if (dirty) {
  const lines = dirty.split('\n')
  record('FAIL', 'Committed', `${lines.length} uncommitted path(s) under ${PATH}:\n      ${indent(lines.slice(0, 10))}${lines.length > 10 ? '\n      ...' : ''}`)
} else {
  record('PASS', 'Committed', `no uncommitted changes under ${PATH}`)
}

// 2. Pushed - HEAD exists on a remote-tracking branch, checked against freshly fetched refs.
if (!fetched.ok) {
  record('FAIL', 'Pushed', `could not refresh ${remote} (git fetch: ${firstLine(fetched.err, 'failed')}) - remote refs may be stale, so "pushed" cannot be proven`)
} else {
  const remotes = git('branch', '-r', '--contains', head).out
    .split('\n').map((s) => s.trim()).filter((s) => s && !s.includes('->'))
  if (remotes.length) record('PASS', 'Pushed', `${short} is on ${remotes.join(', ')} (fetched ${remote} just now)`)
  else record('FAIL', 'Pushed', `${short} is not on any branch of ${remote} - git push ${remote} ${branch}`)
}

// 3. CI green on this exact commit - every required check by name, at job level.
// Read the COMMITTED workflows at HEAD: an uncommitted ci.yml has never run on anything.
const workflowFiles = git('-C', top.out, 'ls-tree', '--name-only', 'HEAD:.github/workflows').out
  .split('\n').filter((f) => /\.ya?ml$/.test(f))
if (!workflowFiles.length) {
  record(NO_CI ? 'WARN' : 'FAIL', 'CI green', 'no .github/workflows in this repo - add a CI workflow (.github/workflows/ci.yml)')
} else {
  const ci = readChecks()
  if (ci.error) record(NO_CI ? 'WARN' : 'FAIL', 'CI green', ci.error)
  else judgeChecks(ci.runs, ci.checks)
}

function readChecks() {
  let repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').out.trim()
  if (!repo) {
    const url = git('remote', 'get-url', remote).out
    repo = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? ''
  }
  if (!repo) return { error: `could not tell which GitHub repo ${remote} is (gh repo view failed) - is gh installed and authenticated?` }
  const runs = gh('run', 'list', '--commit', head, '--json', 'databaseId,workflowName,status,conclusion', '--limit', '100')
  if (!runs.ok) return { error: `could not read workflow runs with gh (${firstLine(runs.err, 'gh failed')})` }
  // Job-level results. --jq prints one JSON object per line across every page.
  const checks = gh('api', `repos/${repo}/commits/${head}/check-runs`, '--paginate',
    '--jq', '.check_runs[] | {name, status, conclusion, details_url}')
  if (!checks.ok && /No commit found|HTTP 422/.test(checks.err)) return { error: `GitHub has no commit ${short} - push it, then wait for CI` }
  if (!checks.ok) return { error: `could not read check runs with gh (${firstLine(checks.err, 'gh failed')})` }
  try {
    return {
      runs: JSON.parse(runs.out || '[]'),
      checks: checks.out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)),
    }
  } catch (e) {
    return { error: `could not parse gh output (${e.message})` }
  }
}

function judgeChecks(runs, checks) {
  const state = (x) => (x.status !== 'completed' ? x.status || 'pending' : x.conclusion || 'unknown')
  const label = (x) => `${x.workflowName ?? x.name} (${state(x)})`
  const jobsOf = (run) => checks.filter((c) => (c.details_url || '').includes(`/runs/${run.databaseId}/`))
  const used = new Set()
  const problems = []
  const passed = []

  for (const name of REQUIRED) {
    const wf = runs.filter((r) => r.workflowName === name)
    // A matrix job shows up as "name (variant)".
    const jobs = checks.filter((c) => c.name === name || c.name.startsWith(`${name} (`))
    const all = [...wf, ...jobs]
    all.forEach((x) => used.add(x))
    wf.forEach((r) => jobsOf(r).forEach((j) => used.add(j)))
    if (!all.length) {
      problems.push(`required "${name}" never ran on ${short}`)
      continue
    }
    const pending = all.filter((x) => x.status !== 'completed')
    const bad = all.filter((x) => x.status === 'completed' && x.conclusion !== 'success')
    const emptyRun = wf.filter((r) => r.conclusion === 'success' && jobsOf(r).length && jobsOf(r).every((j) => j.conclusion === 'skipped'))
    if (pending.length) problems.push(`required "${name}" still running: ${pending.map(label).join(', ')} - wait, then re-run this`)
    else if (bad.length) problems.push(`required "${name}" did not pass: ${bad.map(label).join(', ')}`)
    else if (emptyRun.length) problems.push(`required "${name}" ran no jobs - every job was skipped`)
    else passed.push(name)
  }

  // Anything else on this commit that failed or is still running also blocks the deploy.
  const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])
  const others = [...runs, ...checks].filter((x) => !used.has(x))
  const otherPending = others.filter((x) => x.status !== 'completed')
  const otherBad = others.filter((x) => x.status === 'completed' && BAD.has(x.conclusion))
  if (otherBad.length) problems.push(`other checks failed on ${short}: ${otherBad.map(label).join(', ')}`)
  if (otherPending.length) problems.push(`other checks still running on ${short}: ${otherPending.map(label).join(', ')}`)

  if (problems.length) {
    const ran = [...new Set(runs.map((r) => r.workflowName))]
    const hint = passed.length ? [`passed: ${passed.join(', ')}`] : []
    if (problems.some((p) => p.includes('never ran'))) {
      hint.push(ran.length ? `workflows on ${short}: ${ran.join(', ')} - if your CI has another name, pass --require <name>` : `no workflow ran on ${short} - push it, or run: gh workflow run ci.yml`)
    }
    record('FAIL', 'CI green', indent([...problems, ...hint]))
  } else {
    record('PASS', 'CI green', `required checks passed on ${short}: ${passed.join(', ')}${others.length ? ` (+${others.length} other check(s) not failing)` : ''}`)
  }
}

// 3a. Tests - does the committed CI actually run a test command? Green without tests proves
// only that the code builds.
const TEST_CMD = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npm\s+t\b|npx\s+(?:vitest|jest)\b|vitest\b|jest\b|(?:uv\s+run\s+|python3?\s+-m\s+)?pytest\b|go\s+test\b|cargo\s+(?:test|nextest)\b|node\s+--test\b|deno\s+test\b|dotnet\s+test\b|mix\s+test\b|(?:mvn|gradle|\.\/gradlew)\b.*\b(?:test|verify|check)\b)/
// The app's AGENTS.md (relative to --path) first, then the repo root's.
const agents = [`HEAD:./${join(PATH, 'AGENTS.md').replace(/\\/g, '/')}`, 'HEAD:AGENTS.md'].map((ref) => git('show', ref))
const policy = agents.map((r) => (r.ok ? r.out.match(/^\s*(?:[-*]\s+)?Tests:\s*none\b.*$/im)?.[0].trim() : null)).find(Boolean)
if (!workflowFiles.length) {
  record('WARN', 'Tests', policy ? `no CI; declared policy: ${policy}` : 'no CI - nothing proves tests run')
} else {
  const found = []
  for (const f of workflowFiles) {
    const text = git('-C', top.out, 'show', `HEAD:.github/workflows/${f}`).out
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#') || /^-?\s*name:/.test(t)) continue
      const m = t.match(TEST_CMD)
      if (m) found.push({ f, cmd: t.replace(/^-?\s*run:\s*/, ''), ifPresent: t.includes('--if-present') })
    }
  }
  const soft = found.filter((x) => x.ifPresent)
  if (soft.length) record('FAIL', 'Tests', `--if-present passes when there is no test script - remove it:\n      ${indent(soft.map((x) => `${x.f}: ${x.cmd}`))}`)
  else if (found.length) record('PASS', 'Tests', `CI runs ${[...new Set(found.map((x) => `${x.cmd} (${x.f})`))].join(', ')}`)
  else if (policy) record('WARN', 'Tests', `CI has no test step; declared policy: ${policy}`)
  else record('WARN', 'Tests', 'CI has no test step - green does not mean tested (or write "Tests: none - <reason>" in AGENTS.md)')
}

// 3b. Node pin - the project's own check, when it has one.
const pinScript = join(PATH, 'scripts', 'check-node-pin.mjs')
if (existsSync(pinScript)) {
  const pin = sh('node', [pinScript])
  record(pin.ok ? 'PASS' : 'FAIL', 'Node pin', (pin.ok ? pin.out : pin.err || pin.out).split('\n')[0])
} else if (existsSync(join(PATH, 'package.json'))) {
  record('WARN', 'Node pin', 'no scripts/check-node-pin.mjs - hosts that install the .nvmrc Node can fail where local builds pass')
}

// 4. Scope - what goes live, and whether live holds work this build would revert.
if (FIRST) {
  record('WARN', 'Scope', 'first deploy: nothing live to compare against - everything in HEAD ships')
} else if (!LIVE) {
  record('FAIL', 'Scope', 'pass --live <url> (reads <url>/version.json), or --first-deploy')
} else {
  let live = null
  try {
    const res = await fetch(`${LIVE}/version.json`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (res.ok) live = (await res.json()).commit ?? null
    if (!live) record('FAIL', 'Scope', `${LIVE}/version.json returned ${res.status} with no "commit" - have the build write version.json with the git commit`)
  } catch (e) {
    record('FAIL', 'Scope', `could not read ${LIVE}/version.json (${e.message})`)
  }
  if (live) {
    const known = git('cat-file', '-e', `${live}^{commit}`).ok
    if (!known) {
      record('FAIL', 'Scope', `live commit ${live.slice(0, 7)} is not in this repo - git fetch, or live was built from somewhere else`)
    } else if (!git('merge-base', '--is-ancestor', live, head).ok) {
      const lost = git('log', '--oneline', `${head}..${live}`, '--', PATH).out
      record('FAIL', 'Scope', `live ${live.slice(0, 7)} has commits HEAD does not - deploying would REVERT them:\n      ${lost.split('\n').join('\n      ') || '(outside --path)'}`)
    } else {
      const ships = git('log', '--oneline', '--no-merges', `${live}..${head}`, '--', PATH).out
      const n = ships ? ships.split('\n').length : 0
      if (!n) record('WARN', 'Scope', `live is already ${live.slice(0, 7)}; nothing new under ${PATH} would ship`)
      else record('PASS', 'Scope', `${n} commit(s) go live (${live.slice(0, 7)}..${short}) - name every one before you deploy:\n      ${ships.split('\n').join('\n      ')}`)
    }
  }
}

const icon = { PASS: '\x1b[32mPASS\x1b[0m', WARN: '\x1b[33mWARN\x1b[0m', FAIL: '\x1b[31mFAIL\x1b[0m' }
console.log(`\nPre-deploy gate - ${branch} @ ${short}${LIVE ? ` -> ${LIVE}` : ''}\n`)
for (const r of results) console.log(`  ${icon[r.status]}  ${r.check.padEnd(10)} ${r.detail}`)

const failed = results.filter((r) => r.status === 'FAIL').length
console.log('\nStill yours to confirm: the release diff was reviewed, the target was read from the server,')
console.log('no live feature goes missing, the API ships before the client, test flags are off, and new')
console.log('libraries were tested under the live security headers.')
console.log('Then prepare the rollback BEFORE uploading.\n')
if (failed) {
  console.log(`\x1b[31m${failed} check(s) failed - do not deploy.\x1b[0m\n`)
  process.exit(1)
}
console.log('\x1b[32mMechanical checks passed.\x1b[0m\n')
