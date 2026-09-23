// Tests for .agents/skills/ship/scripts/preflight-deploy.mjs. Zero dependencies, offline.
// Run: node --test tests/
//
// Each case builds a throwaway git repo in the OS temp folder with a bare repo as `origin`, fakes
// GitHub through PREFLIGHT_GH, and serves version.json from a local http server when it needs one.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PREFLIGHT = join(ROOT, '.agents', 'skills', 'ship', 'scripts', 'preflight-deploy.mjs')
const TMP = mkdtempSync(join(tmpdir(), 'ship-preflight-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

// Isolate git from the machine's own config (hooks, signing, autocrlf).
writeFileSync(join(TMP, 'gitconfig'), '')
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(TMP, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
}

// Fake gh: answers repo view, run list and the check-runs API from a JSON file, and only for
// the commit named in it - so a run on any other commit is invisible, as on GitHub.
const FAKE_GH = join(TMP, 'fake-gh.mjs')
writeFileSync(FAKE_GH, `import { readFileSync } from 'node:fs'
const d = JSON.parse(readFileSync(process.env.FAKE_GH_DATA, 'utf8'))
const a = process.argv.slice(2)
if (a[0] === 'repo' && a[1] === 'view') { console.log(d.repo); process.exit(0) }
if (a[0] === 'run' && a[1] === 'list') {
  console.log(JSON.stringify(a[a.indexOf('--commit') + 1] === d.sha ? d.runs : []))
  process.exit(0)
}
if (a[0] === 'api') {
  const m = a[1].match(/commits\\/([0-9a-f]+)\\/check-runs/)
  for (const c of m && m[1] === d.sha ? d.checks : []) console.log(JSON.stringify(c))
  process.exit(0)
}
console.error('fake gh: unexpected ' + a.join(' ')); process.exit(1)
`)

let n = 0
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

const NODE_CI = `name: CI
on: [push]
jobs:
  check:
    name: Lint, test, build
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - name: Lint
        run: npm run lint
      - name: Test
        run: npm test
      - name: Build
        run: npm run build
`

// A repo with two commits, pushed to a bare origin. Returns the work dir and both shas.
function makeRepo({ workflow = NODE_CI, agents } = {}) {
  const dir = join(TMP, `case-${++n}`)
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')
  mkdirSync(join(work, '.github', 'workflows'), { recursive: true })
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin)
  git(work, 'init', '--quiet', '-b', 'main')
  writeFileSync(join(work, '.github', 'workflows', 'ci.yml'), workflow)
  if (agents) writeFileSync(join(work, 'AGENTS.md'), agents)
  writeFileSync(join(work, 'app.txt'), 'one\n')
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'one')
  writeFileSync(join(work, 'app.txt'), 'two\n')
  git(work, 'commit', '--quiet', '-am', 'two')
  git(work, 'remote', 'add', 'origin', origin)
  git(work, 'push', '--quiet', '-u', 'origin', 'main')
  return { dir, work, head: git(work, 'rev-parse', 'HEAD'), parent: git(work, 'rev-parse', 'HEAD~1') }
}

const run = (id, name, conclusion, status = 'completed') => ({ databaseId: id, workflowName: name, status, conclusion })
const job = (runId, name, conclusion, status = 'completed') =>
  ({ name, status, conclusion, details_url: `https://github.com/o/r/actions/runs/${runId}/job/${runId * 10}` })
const GREEN = { runs: [run(1, 'CI', 'success')], checks: [job(1, 'Lint, test, build', 'success')] }

// Runs the preflight asynchronously (a local version.json server lives in this process).
function preflight(repo, args, gh = GREEN, sha = repo.head) {
  const data = join(repo.dir, 'gh.json')
  writeFileSync(data, JSON.stringify({ repo: 'o/r', sha, ...gh }))
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PREFLIGHT, ...args], {
      cwd: repo.work,
      env: { ...ENV, PREFLIGHT_GH: `"${process.execPath}" "${FAKE_GH}"`, FAKE_GH_DATA: data },
    })
    let out = ''
    p.stdout.on('data', (b) => { out += b })
    p.stderr.on('data', (b) => { out += b })
    p.on('close', (code) => resolve({ code, out: out.replace(/\x1b\[\d+m/g, '') }))
  })
}
const status = (out, check) => out.match(new RegExp(`^\\s+(PASS|WARN|FAIL)\\s+${check}\\s`, 'm'))?.[1]

async function withLive(commit, fn) {
  const server = createServer((req, res) => {
    if (req.url !== '/version.json') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ commit }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try { return await fn(`http://127.0.0.1:${server.address().port}`) } finally { server.close() }
}

test('all required checks green, tests run, live is an ancestor -> PASS, exit 0', async () => {
  const repo = makeRepo()
  const r = await withLive(repo.parent, (url) => preflight(repo, ['--live', url]))
  assert.equal(status(r.out, 'Committed'), 'PASS', r.out)
  assert.equal(status(r.out, 'Pushed'), 'PASS', r.out)
  assert.equal(status(r.out, 'CI green'), 'PASS', r.out)
  assert.match(r.out, /required checks passed on \w+: CI/)
  assert.equal(status(r.out, 'Tests'), 'PASS', r.out)
  assert.match(r.out, /CI runs npm test \(ci\.yml\)/)
  assert.equal(status(r.out, 'Scope'), 'PASS', r.out)
  assert.equal(r.code, 0, r.out)
})

test('required job named with --require passes at job level', async () => {
  const r = await preflight(makeRepo(), ['--first-deploy', '--require', 'CI', '--require', 'Lint, test, build'])
  assert.equal(status(r.out, 'CI green'), 'PASS', r.out)
  assert.match(r.out, /passed on \w+: CI, Lint, test, build/)
  assert.equal(r.code, 0, r.out)
})

test('required check missing (nothing ran) -> FAIL', async () => {
  const r = await preflight(makeRepo(), ['--first-deploy'], { runs: [], checks: [] })
  assert.equal(status(r.out, 'CI green'), 'FAIL', r.out)
  assert.match(r.out, /required "CI" never ran/)
  assert.equal(r.code, 1)
})

test('CI green only on the previous commit -> FAIL (never ran on this one)', async () => {
  const repo = makeRepo()
  const r = await preflight(repo, ['--first-deploy'], GREEN, repo.parent)
  assert.equal(status(r.out, 'CI green'), 'FAIL', r.out)
  assert.match(r.out, /required "CI" never ran/)
})

test('required workflow skipped -> FAIL', async () => {
  const r = await preflight(makeRepo(), ['--first-deploy'], { runs: [run(1, 'CI', 'skipped')], checks: [] })
  assert.equal(status(r.out, 'CI green'), 'FAIL', r.out)
  assert.match(r.out, /required "CI" did not pass: CI \(skipped\)/)
})

test('required job skipped -> FAIL', async () => {
  const gh = { runs: [run(1, 'CI', 'success')], checks: [job(1, 'Lint, test, build', 'skipped')] }
  const r = await preflight(makeRepo(), ['--first-deploy', '--require', 'Lint, test, build'], gh)
  assert.equal(status(r.out, 'CI green'), 'FAIL', r.out)
  assert.match(r.out, /required "Lint, test, build" did not pass/)
})

test('required job still running -> FAIL', async () => {
  const gh = { runs: [run(1, 'CI', '', 'in_progress')], checks: [job(1, 'Lint, test, build', null, 'in_progress')] }
  const r = await preflight(makeRepo(), ['--first-deploy'], gh)
  assert.equal(status(r.out, 'CI green'), 'FAIL', r.out)
  assert.match(r.out, /still running/)
})

test('unrelated workflow green but the required one absent -> FAIL', async () => {
  const gh = { runs: [run(2, 'Docs', 'success')], checks: [job(2, 'build-docs', 'success')] }
  const r = await preflight(makeRepo(), ['--first-deploy'], gh)
  assert.equal(status(r.out, 'CI green'), 'FAIL', r.out)
  assert.match(r.out, /required "CI" never ran/)
  assert.match(r.out, /workflows on \w+: Docs - if your CI has another name, pass --require/)
})

test('required green but another run on the commit failed -> FAIL', async () => {
  const gh = { runs: [...GREEN.runs, run(3, 'Preview', 'failure')], checks: [...GREEN.checks, job(3, 'preview', 'failure')] }
  const r = await preflight(makeRepo(), ['--first-deploy'], gh)
  assert.equal(status(r.out, 'CI green'), 'FAIL', r.out)
  assert.match(r.out, /other checks failed on \w+: Preview \(failure\)/)
  assert.match(r.out, /passed: CI/)
})

test('git fetch fails -> Pushed FAIL', async () => {
  const repo = makeRepo()
  git(repo.work, 'remote', 'set-url', 'origin', join(repo.dir, 'gone.git'))
  const r = await preflight(repo, ['--first-deploy'])
  assert.equal(status(r.out, 'Pushed'), 'FAIL', r.out)
  assert.match(r.out, /could not refresh origin/)
  assert.equal(r.code, 1)
})

test('commit not pushed -> Pushed FAIL', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo.work, 'app.txt'), 'three\n')
  git(repo.work, 'commit', '--quiet', '-am', 'three')
  const r = await preflight({ ...repo, head: git(repo.work, 'rev-parse', 'HEAD') }, ['--first-deploy'])
  assert.equal(status(r.out, 'Pushed'), 'FAIL', r.out)
  assert.match(r.out, /is not on any branch of origin/)
})

test('test step with --if-present -> Tests FAIL', async () => {
  const repo = makeRepo({ workflow: NODE_CI.replace('run: npm test', 'run: npm test --if-present') })
  const r = await preflight(repo, ['--first-deploy'])
  assert.equal(status(r.out, 'Tests'), 'FAIL', r.out)
  assert.match(r.out, /ci\.yml: npm test --if-present/)
  assert.equal(r.code, 1)
})

test('no test step -> Tests WARN, gate still passes', async () => {
  const repo = makeRepo({ workflow: NODE_CI.replace(/ {6}- name: Test\n {8}run: npm test\n/, '') })
  const r = await preflight(repo, ['--first-deploy'])
  assert.equal(status(r.out, 'Tests'), 'WARN', r.out)
  assert.match(r.out, /CI has no test step - green does not mean tested/)
  assert.equal(r.code, 0, r.out)
})

test('declared "Tests: none" policy in AGENTS.md is reported -> WARN', async () => {
  const repo = makeRepo({
    workflow: NODE_CI.replace(/ {6}- name: Test\n {8}run: npm test\n/, ''),
    agents: '# App\n\nTests: none - static brochure site, no logic yet\n',
  })
  const r = await preflight(repo, ['--first-deploy'])
  assert.equal(status(r.out, 'Tests'), 'WARN', r.out)
  assert.match(r.out, /declared policy: Tests: none - static brochure site/)
})

test('uncommitted change -> Committed FAIL', async () => {
  const repo = makeRepo()
  writeFileSync(join(repo.work, 'app.txt'), 'dirty\n')
  const r = await preflight(repo, ['--first-deploy'])
  assert.equal(status(r.out, 'Committed'), 'FAIL', r.out)
  assert.match(r.out, /app\.txt/)
  assert.equal(r.code, 1)
})

test('live commit is not an ancestor of HEAD -> Scope FAIL', async () => {
  const repo = makeRepo()
  // A commit that exists locally but is not in HEAD's history, as if live came from another branch.
  const side = git(repo.work, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'hotfix on live')
  const r = await withLive(side, (url) => preflight(repo, ['--live', url]))
  assert.equal(status(r.out, 'Scope'), 'FAIL', r.out)
  assert.match(r.out, /has commits HEAD does not - deploying would REVERT them/)
  assert.equal(r.code, 1)
})
