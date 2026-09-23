// Tests for .agents/skills/scanloop/scripts/scan.mjs. Zero deps: node --test tests/scanloop-scan.test.mjs
// Each test builds a throwaway git repo (base commit on main, change on a feature branch) and
// stubs the three scanners with small node scripts via SCANLOOP_GITLEAKS / _SEMGREP / _OSV.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCAN = join(dirname(fileURLToPath(import.meta.url)), '..', '.agents', 'skills', 'scanloop', 'scripts', 'scan.mjs')
const FUTURE = '2999-01-01'
const PAST = '2000-01-01'

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

// files: the change committed on a feature branch on top of main. baseFiles: what main holds.
// Each repo lives at <temp parent>/repo so stubs and argv logs sit outside the repo.
function repo(files, baseFiles = { 'README.md': 'base\n' }) {
  const dir = join(mkdtempSync(join(tmpdir(), 'scanloop-')), 'repo')
  mkdirSync(dir)
  const write = (map) => {
    for (const [p, c] of Object.entries(map)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c) }
  }
  sh(dir, 'init', '-q')
  sh(dir, 'checkout', '-q', '-b', 'main')
  write(baseFiles)
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'base')
  sh(dir, 'checkout', '-q', '-b', 'feature')
  write(files)
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'change')
  return dir
}

// A stub scanner: prints `version` for version calls, else writes `output` (JSON) to the path after
// the tool's output flag, logs its argv to <name>.argv.json, and exits `exit`.
function stub(dir, name, { output = null, exit = 0, version = `${name} 0.0.0-stub` } = {}) {
  const file = join(dir, '..', `${name}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, `
import { writeFileSync } from 'node:fs'
const a = process.argv.slice(2)
if (a[0] === 'version' || a[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0) }
writeFileSync(${JSON.stringify(join(dir, '..', `${name}.argv.json`))}, JSON.stringify(a))
const i = a.findIndex((x) => ['--report-path', '--output', '--output-file'].includes(x))
const out = ${JSON.stringify(output)}
if (out !== null && i >= 0) writeFileSync(a[i + 1], typeof out === 'string' ? out : JSON.stringify(out))
process.exit(${exit})
`)
  return JSON.stringify([process.execPath, file])
}

const CLEAN = {
  gitleaks: [],
  semgrep: { results: [], errors: [] },
  osv: { results: [] },
}
const leak = (file = 'app.js') => [{ RuleID: 'aws-access-token', Description: 'AWS key', File: file, StartLine: 3, Commit: 'abcdef1234', Secret: 'REDACTED', Match: 'REDACTED' }]
const sast = (path = 'app.js', severity = 'ERROR', check_id = 'js.injection.eval') =>
  ({ results: [{ check_id, path, start: { line: 2 }, extra: { message: 'eval of user input', severity, metadata: {} } }], errors: [] })

function scan(dir, tools = {}, args = []) {
  const env = { ...process.env }
  env.SCANLOOP_GITLEAKS = tools.gitleaks ?? stub(dir, 'gitleaks', { output: CLEAN.gitleaks })
  env.SCANLOOP_SEMGREP = tools.semgrep ?? stub(dir, 'semgrep', { output: CLEAN.semgrep })
  env.SCANLOOP_OSV = tools.osv ?? stub(dir, 'osv', { output: CLEAN.osv })
  const r = spawnSync(process.execPath, [SCAN, '--json', ...args], { cwd: dir, env, encoding: 'utf8' })
  let report = null
  try { report = JSON.parse(r.stdout) } catch { /* usage errors print no JSON */ }
  return { code: r.status, report, stderr: r.stderr }
}

const allow = (dir, yml) => { mkdirSync(join(dir, '.scanloop'), { recursive: true }); writeFileSync(join(dir, '.scanloop', 'allowlist.yml'), yml) }
const cleanup = (dir) => rmSync(join(dir, '..'), { recursive: true, force: true, maxRetries: 3 })

test('all clean -> exit 0 CLEAN, versions and commands recorded', () => {
  const dir = repo({ 'app.js': 'console.log(1)\n' })
  const { code, report } = scan(dir)
  assert.equal(code, 0)
  assert.equal(report.verdict, 'CLEAN')
  assert.equal(report.complete, true)
  assert.deepEqual(report.required, ['gitleaks', 'semgrep'])
  assert.equal(report.tools.gitleaks.version, 'gitleaks 0.0.0-stub')
  assert.ok(report.tools.gitleaks.command.includes('--redact'))
  assert.ok(report.tools.semgrep.command.includes('--metrics=off'))
  assert.match(report.head.sha, /^[0-9a-f]{40}$/)
  assert.match(report.base.sha, /^[0-9a-f]{40}$/)
  assert.ok(report.startedAt)
  cleanup(dir)
})

test('semgrep gets only files it has packs for, with language packs from the extensions', () => {
  const dir = repo({ 'app.ts': 'let a = 1\n', 'notes.md': 'hi\n', 'data.json': '{}\n' })
  const { code, report } = scan(dir)
  assert.equal(code, 0)
  const argv = JSON.parse(readFileSync(join(dir, '..', 'semgrep.argv.json'), 'utf8'))
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['app.ts'])
  assert.ok(argv.includes('p/typescript'))
  assert.ok(!argv.includes('p/python'))
  assert.ok(argv.includes('--baseline-commit'))
  assert.deepEqual(report.tools.semgrep.configs.slice(0, 3), ['p/security-audit', 'p/secrets', 'p/owasp-top-ten'])
  assert.equal(report.tools.semgrep.pinned, false)
  cleanup(dir)
})

test('gitleaks finding -> exit 1 BLOCKING, secret never in the report', () => {
  const dir = repo({ 'app.js': 'x\n' })
  const { code, report } = scan(dir, { gitleaks: stub(dir, 'gitleaks', { output: leak(), exit: 1 }) })
  assert.equal(code, 1)
  assert.equal(report.verdict, 'BLOCKING')
  assert.equal(report.findings[0].severity, 'blocking')
  assert.equal(report.findings[0].file, 'app.js:3')
  assert.equal(report.findings[0].rule_id, 'aws-access-token')
  assert.ok(!('Secret' in report.findings[0]) && !('Match' in report.findings[0]))
  cleanup(dir)
})

test('required tool missing -> exit 2 INCOMPLETE, never clean', () => {
  const dir = repo({ 'app.js': 'x\n' })
  const { code, report } = scan(dir, { semgrep: join(dir, '..', 'no-such-semgrep') })
  assert.equal(code, 2)
  assert.equal(report.verdict, 'INCOMPLETE')
  assert.equal(report.tools.semgrep.status, 'missing')
  assert.equal(report.complete, false)
  cleanup(dir)
})

test('tool exit 2 -> error -> INCOMPLETE', () => {
  const dir = repo({ 'app.js': 'x\n' })
  const { code, report } = scan(dir, { semgrep: stub(dir, 'semgrep', { output: CLEAN.semgrep, exit: 2 }) })
  assert.equal(code, 2)
  assert.equal(report.verdict, 'INCOMPLETE')
  assert.equal(report.tools.semgrep.status, 'error')
  cleanup(dir)
})

test('exit 0 but no report file -> error -> INCOMPLETE', () => {
  const dir = repo({ 'app.js': 'x\n' })
  const { code, report } = scan(dir, { gitleaks: stub(dir, 'gitleaks', { output: null }) })
  assert.equal(code, 2)
  assert.equal(report.tools.gitleaks.status, 'error')
  assert.match(report.tools.gitleaks.reason, /absent/)
  cleanup(dir)
})

test('stale report.json and raw outputs from a previous run are removed', () => {
  const dir = repo({ 'app.js': 'x\n' })
  mkdirSync(join(dir, '.scanloop'), { recursive: true })
  const stale = JSON.stringify({ verdict: 'CLEAN', stale: true })
  writeFileSync(join(dir, '.scanloop', 'report.json'), stale)
  writeFileSync(join(dir, '.scanloop', 'semgrep.json'), JSON.stringify(CLEAN.semgrep))
  // This run's semgrep writes nothing: the old semgrep.json must not be read as its result.
  const { code, report } = scan(dir, { semgrep: stub(dir, 'semgrep', { output: null }) })
  assert.equal(code, 2)
  assert.equal(report.tools.semgrep.status, 'error')
  const onDisk = JSON.parse(readFileSync(join(dir, '.scanloop', 'report.json'), 'utf8'))
  assert.equal(onDisk.stale, undefined)
  assert.equal(onDisk.verdict, 'INCOMPLETE')
  assert.ok(!existsSync(join(dir, '.scanloop', 'semgrep.json')))
  cleanup(dir)
})

test('allowlist entry with reason + future expires suppresses and is counted', () => {
  const dir = repo({ 'src/db.js': 'x\n' })
  allow(dir, `# triaged
suppressions:
  - tool: semgrep            # which scanner
    path: "src/*.js"
    rule: "js.injection.eval"
    reason: "input is an internal enum - reviewed"
    expires: ${FUTURE}
`)
  const { code, report } = scan(dir, { semgrep: stub(dir, 'semgrep', { output: sast('src/db.js') }) })
  assert.equal(code, 0)
  assert.equal(report.verdict, 'CLEAN')
  assert.equal(report.suppressed.total, 1)
  assert.equal(report.suppressed.byEntry[0].suppressed, 1)
  assert.equal(report.allowlistProblems.length, 0)
  cleanup(dir)
})

test('expired allowlist entry does not suppress and is reported', () => {
  const dir = repo({ 'src/db.js': 'x\n' })
  allow(dir, `suppressions:\n  - tool: semgrep\n    path: src/db.js\n    rule: js.injection.eval\n    reason: "old triage"\n    expires: ${PAST}\n`)
  const { code, report } = scan(dir, { semgrep: stub(dir, 'semgrep', { output: sast('src/db.js') }) })
  assert.equal(code, 1)
  assert.equal(report.suppressed.total, 0)
  assert.equal(report.allowlistProblems[0].problem, 'expired')
  cleanup(dir)
})

test('allowlist entry without reason does not suppress and is reported invalid', () => {
  const dir = repo({ 'src/db.js': 'x\n' })
  allow(dir, `suppressions:\n  - tool: semgrep\n    path: "**/db.js"\n    rule: js.injection.eval\n    expires: ${FUTURE}\n`)
  const { code, report } = scan(dir, { semgrep: stub(dir, 'semgrep', { output: sast('src/db.js') }) })
  assert.equal(code, 1)
  assert.equal(report.suppressed.total, 0)
  assert.equal(report.allowlistProblems[0].problem, 'invalid')
  assert.match(report.allowlistProblems[0].detail, /reason/)
  cleanup(dir)
})

test('allowlist.json is honoured too', () => {
  const dir = repo({ 'app.js': 'x\n' })
  mkdirSync(join(dir, '.scanloop'), { recursive: true })
  writeFileSync(join(dir, '.scanloop', 'allowlist.json'), JSON.stringify({ suppressions: [
    { tool: 'gitleaks', path: 'app.js', rule: 'aws-access-token', reason: 'documented dummy key', expires: FUTURE }] }))
  const { code, report } = scan(dir, { gitleaks: stub(dir, 'gitleaks', { output: leak(), exit: 1 }) })
  assert.equal(code, 0)
  assert.equal(report.suppressed.total, 1)
  cleanup(dir)
})

test('lockfile unchanged -> osv not-applicable and not required, even when missing', () => {
  const dir = repo({ 'app.js': 'x\n' })
  const { code, report } = scan(dir, { osv: join(dir, '..', 'no-such-osv') })
  assert.equal(code, 0)
  assert.equal(report.tools['osv-scanner'].status, 'not-applicable')
  assert.equal(report.tools['osv-scanner'].required, false)
  assert.ok(!report.required.includes('osv-scanner'))
  cleanup(dir)
})

test('lockfile changed -> osv required, targets that file; missing osv -> INCOMPLETE', () => {
  const dir = repo({ 'package-lock.json': '{}\n' })
  const ran = scan(dir)
  assert.equal(ran.code, 0)
  assert.ok(ran.report.required.includes('osv-scanner'))
  const argv = JSON.parse(readFileSync(join(dir, '..', 'osv.argv.json'), 'utf8'))
  assert.deepEqual(argv.slice(argv.indexOf('-L'), argv.indexOf('-L') + 2), ['-L', 'package-lock.json'])
  const missing = scan(dir, { osv: join(dir, '..', 'no-such-osv') })
  assert.equal(missing.code, 2)
  assert.equal(missing.report.verdict, 'INCOMPLETE')
  cleanup(dir)
})

test('osv CVSS buckets: 9.8 blocking, 5.0 major', () => {
  const dir = repo({ 'package-lock.json': '{}\n' })
  const out = { results: [{ source: { path: 'package-lock.json' }, packages: [{
    package: { name: 'lodash', version: '4.17.0', ecosystem: 'npm' },
    vulnerabilities: [{ id: 'GHSA-aaaa', summary: 'proto pollution' }, { id: 'GHSA-bbbb', summary: 'redos' }],
    groups: [{ ids: ['GHSA-aaaa'], max_severity: '9.8' }, { ids: ['GHSA-bbbb'], max_severity: '5.0' }] }] }] }
  const { code, report } = scan(dir, { osv: stub(dir, 'osv', { output: out, exit: 1 }) })
  assert.equal(code, 1)
  assert.deepEqual(report.findings.map((f) => [f.rule_id, f.severity]), [['GHSA-aaaa', 'blocking'], ['GHSA-bbbb', 'major']])
  cleanup(dir)
})

test('fixture paths demote semgrep one level but never demote gitleaks', () => {
  const dir = repo({ 'tests/fixtures/sample.js': 'x\n' })
  const { code, report } = scan(dir, {
    gitleaks: stub(dir, 'gitleaks', { output: leak('tests/fixtures/sample.js'), exit: 1 }),
    semgrep: stub(dir, 'semgrep', { output: sast('tests/fixtures/sample.js') }),
  })
  assert.equal(code, 1)
  const g = report.findings.find((f) => f.source === 'gitleaks')
  const s = report.findings.find((f) => f.source === 'semgrep')
  assert.equal(g.severity, 'blocking')
  assert.equal(g.triage_hint, 'in-scope')
  assert.equal(s.severity, 'major')
  assert.match(s.triage_hint, /^likely-fp:/)
  cleanup(dir)
})

test('no base resolvable -> exit 2 usage error', () => {
  const dir = repo({ 'app.js': 'x\n' })
  const r = scan(dir, {}, ['--base', 'does-not-exist'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /not a commit/)
  cleanup(dir)
})
