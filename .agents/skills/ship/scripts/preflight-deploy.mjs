#!/usr/bin/env node
// Pre-deploy gate: the mechanical checks, run before every production deploy.
// Run from the project root before every production deploy. Exits 1 on any FAIL.
//
//   node preflight-deploy.mjs --live https://example.com
//   node preflight-deploy.mjs --live https://example.com --path apps/web   (monorepo subfolder)
//   node preflight-deploy.mjs --first-deploy          (nothing is live yet)
//   node preflight-deploy.mjs --live <url> --no-ci    (repo has no CI; downgrades that check to WARN)
//
// No dependencies. Needs git; needs `gh` (authenticated) to read CI results.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : args[i + 1]
}
const flag = (name) => args.includes(`--${name}`)
const LIVE = opt('live')?.replace(/\/+$/, '')
const PATH = opt('path') ?? '.'
const FIRST = flag('first-deploy')
const NO_CI = flag('no-ci')

const results = []
const record = (status, check, detail) => results.push({ status, check, detail })

function sh(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8' })
  if (r.error) return { ok: false, out: '', err: r.error.message }
  return { ok: r.status === 0, out: (r.stdout ?? '').trimEnd(), err: (r.stderr ?? '').trim() }
}
const git = (...a) => sh('git', a)

const top = git('rev-parse', '--show-toplevel')
if (!top.ok) {
  console.error('Not inside a git repository - a deploy must come from a commit.')
  process.exit(1)
}
const head = git('rev-parse', 'HEAD').out
const short = head.slice(0, 7)
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out

// 1. Committed - only the app's own path, so a shared monorepo's other WIP does not block it.
const dirty = git('status', '--porcelain', '--', PATH).out
if (dirty) {
  const lines = dirty.split('\n')
  record('FAIL', 'Committed', `${lines.length} uncommitted path(s) under ${PATH}:\n      ${lines.slice(0, 10).join('\n      ')}${lines.length > 10 ? '\n      ...' : ''}`)
} else {
  record('PASS', 'Committed', `no uncommitted changes under ${PATH}`)
}

// 2. Pushed - HEAD exists on a remote-tracking branch.
const remotes = git('branch', '-r', '--contains', head).out
  .split('\n').map((s) => s.trim()).filter((s) => s && !s.includes('->'))
if (remotes.length) record('PASS', 'Pushed', `${short} is on ${remotes.join(', ')}`)
else record('FAIL', 'Pushed', `${short} is not on any remote branch - git push origin ${branch}`)

// 3. CI green on this exact commit.
// Read the COMMITTED workflows at HEAD: an uncommitted ci.yml has never run on anything.
const hasWorkflows = git('-C', top.out, 'ls-tree', '--name-only', 'HEAD:.github/workflows').out !== ''
if (!hasWorkflows) {
  record(NO_CI ? 'WARN' : 'FAIL', 'CI green', 'no .github/workflows in this repo - add a CI workflow (.github/workflows/ci.yml)')
} else {
  const runs = sh('gh', ['run', 'list', '--commit', head, '--json', 'workflowName,status,conclusion', '--limit', '20'])
  if (!runs.ok) {
    record(NO_CI ? 'WARN' : 'FAIL', 'CI green', `could not read CI results with gh (${runs.err.split('\n')[0] || 'gh failed'})`)
  } else {
    const list = JSON.parse(runs.out || '[]')
    const pending = list.filter((r) => r.status !== 'completed')
    const failed = list.filter((r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'skipped')
    const names = (rs) => rs.map((r) => `${r.workflowName} (${r.conclusion || r.status})`).join(', ')
    if (!list.length) record('FAIL', 'CI green', `no CI run found for ${short} - push it, or run: gh workflow run ci.yml`)
    else if (failed.length) record('FAIL', 'CI green', `failed on ${short}: ${names(failed)}`)
    else if (pending.length) record('FAIL', 'CI green', `still running on ${short}: ${names(pending)} - wait, then re-run this`)
    else record('PASS', 'CI green', `${list.length} run(s) passed on ${short}: ${names(list)}`)
  }
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
