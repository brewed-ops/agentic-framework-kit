// Tests for .agents/skills/greploop/scripts/review.mjs. Zero deps: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '.agents', 'skills', 'greploop', 'scripts', 'review.mjs')
const NODE = `"${process.execPath}"`

const BASE = `// math helpers
export function add(a, b) {
  return a + b
}

export function sub(a, b) {
  return a - b
}
`
// line 3 changed; lines 9-12 added (divide sits on lines 10-12, "return a / b" is line 11)
const CHANGED = `// math helpers
export function add(a, b) {
  return Number(a) + Number(b)
}

export function sub(a, b) {
  return a - b
}

export function divide(a, b) {
  return a / b
}
`
const FORMAT = `export function money(n) {
  return '$' + n.toFixed(2)
}
`
const FILES = ['src/math.js', 'src/format.js']

function makeRepo({ config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'greploop-'))
  const g = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout }
  const write = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s) }
  g('init', '-q', '-b', 'main')
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'test'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) g('config', k, v)
  write('.gitignore', '.greploop/*\n!.greploop/config.json\n')
  write('src/math.js', BASE)
  if (config) write('.greploop/config.json', JSON.stringify(config))
  g('add', '-A'); g('commit', '-qm', 'base')
  g('checkout', '-qb', 'feat')
  write('src/math.js', CHANGED); write('src/format.js', FORMAT)
  g('add', '-A'); g('commit', '-qm', 'change')
  return { dir, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
function rv(dir, args, input) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', input: input ?? '' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const state = (dir) => JSON.parse(readFileSync(join(dir, '.greploop', 'run.json'), 'utf8'))
const reply = (lens, score, findings = [], over = {}) => JSON.stringify({
  lens, score, summary: 'read both files in full, grepped callers of add and divide',
  coverage: Object.fromEntries(FILES.map((f) => [f, 'reviewed'])), findings, pre_existing: [], ...over,
})
const finding = (code, issue, severity = 'major', file = 'src/math.js:1') => ({ severity, file, code, issue, fix: 'guard it' })
function cleanPanel(dir) {
  for (const l of ['correctness', 'security', 'quality']) assert.equal(rv(dir, ['add', '--bundle', 'all'], reply(l, 5)).code, 0)
  assert.equal(rv(dir, ['merge', '1']).code, 0)
}
function scanFile(dir, verdict) {
  const p = join(dir, '.greploop', `scan-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify({
    tools: {
      gitleaks: { status: 'ran', version: '8.21.0', command: 'gitleaks git --log-opts=main..HEAD .' },
      semgrep: { status: verdict === 'INCOMPLETE' ? 'missing' : 'ran', version: '1.100.0', command: 'semgrep scan --metrics=off' },
      'osv-scanner': { status: 'not-applicable', version: null, command: null },
    },
    required: ['gitleaks', 'semgrep'], complete: verdict !== 'INCOMPLETE', findings: [], verdict,
  }))
  return p
}
const SECTIONS = ['Executed checks', 'Review findings', 'Coverage gaps', 'Release decision']

test('a valid reply is accepted', () => {
  const r = makeRepo()
  try {
    assert.equal(rv(r.dir, ['init', '--base', 'main', '--profile', 'standard']).code, 0)
    const a = rv(r.dir, ['add', '--bundle', 'all'], reply('correctness', 5))
    assert.equal(a.code, 0, a.out)
    assert.match(a.out, /accepted correctness on bundle all/)
  } finally { r.cleanup() }
})

test('a reply missing a coverage path is rejected until a supplement covers it', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    const a = rv(r.dir, ['add', '--bundle', 'all'], reply('security', 5, [], { coverage: { 'src/math.js': 'reviewed' } }))
    assert.equal(a.code, 1)
    assert.match(a.out, /coverage is missing src\/format\.js/)
    assert.equal(state(r.dir).iterations[1].replies.all, undefined)
    const s = rv(r.dir, ['add', '--bundle', 'all', '--supplement'], reply('security', 5, [], { coverage: { 'src/format.js': 'skipped: pure formatting, no logic in this lens' } }))
    assert.equal(s.code, 0, s.out)
    assert.match(state(r.dir).iterations[1].replies.all.security.coverage['src/format.js'], /^skipped: /)
  } finally { r.cleanup() }
})

test('a non-integer score is rejected', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    for (const score of [4.5, '4']) {
      const a = rv(r.dir, ['add', '--bundle', 'all'], reply('quality', score))
      assert.equal(a.code, 1)
      assert.match(a.out, /score must be an integer 1-5/)
    }
  } finally { r.cleanup() }
})

test('a drifted line number is re-anchored to the verbatim snippet', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    const a = rv(r.dir, ['add', '--bundle', 'all'], reply('correctness', 3, [finding('  return a / b', 'divide by zero returns Infinity', 'major', 'src/math.js:2')]))
    assert.equal(a.code, 0, a.out)
    const f = state(r.dir).iterations[1].replies.all.correctness.findings[0]
    assert.equal(f.line, 11)
    assert.equal(f.anchored, true)
  } finally { r.cleanup() }
})

test('a hallucinated snippet is marked unanchored', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    const a = rv(r.dir, ['add', '--bundle', 'all'], reply('correctness', 3, [finding('return a % b', 'modulo by zero', 'major', 'src/math.js:11')]))
    assert.equal(a.code, 0, a.out)
    assert.match(a.out, /1 unanchored/)
    assert.equal(state(r.dir).iterations[1].replies.all.correctness.findings[0].anchored, false)
  } finally { r.cleanup() }
})

test('a finding on a line the diff did not touch moves to pre_existing', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    const a = rv(r.dir, ['add', '--bundle', 'all'], reply('correctness', 3, [finding('return a - b', 'subtraction coerces strings silently', 'major', 'src/math.js:7')]))
    assert.equal(a.code, 0, a.out)
    const rep = state(r.dir).iterations[1].replies.all.correctness
    assert.equal(rep.findings.length, 0)
    assert.equal(rep.pre.length, 1)
    assert.equal(rep.pre[0].line, 7)
  } finally { r.cleanup() }
})

test('exit gate: minor-only findings (every reviewer at 4) are clean; one reviewer at 3 is not', () => {
  const minor = [finding('return a / b', 'divide by zero returns Infinity', 'minor', 'src/math.js:10')]
  for (const [scores, clean] of [[[4, 4, 4], true], [[5, 5, 3], false]]) {
    const r = makeRepo()
    try {
      rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
      ;['correctness', 'security', 'quality'].forEach((l, i) => {
        const res = rv(r.dir, ['add', '--bundle', 'all'], reply(l, scores[i], scores[i] < 5 ? minor : []))
        assert.equal(res.code, 0, res.out)
      })
      assert.equal(rv(r.dir, ['merge', '1']).code, 0)
      const out = rv(r.dir, ['status']).out
      if (clean) assert.match(out, /bundle all: CLEAN/)
      else assert.match(out, /bundle all: not clean - a reviewer scored 3 or lower/)
    } finally { r.cleanup() }
  }
})

test('merge dedupes across lenses, takes the max severity and tags consensus', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    assert.equal(rv(r.dir, ['add', '--bundle', 'all'], reply('correctness', 4, [finding('return a / b', 'divide by zero returns Infinity', 'minor', 'src/math.js:10')])).code, 0)
    assert.equal(rv(r.dir, ['add', '--bundle', 'all'], reply('security', 3, [finding('return a / b', 'unchecked divisor from input', 'major', 'src/math.js:12')])).code, 0)
    assert.equal(rv(r.dir, ['add', '--bundle', 'all'], reply('quality', 5)).code, 0)
    const m = rv(r.dir, ['merge', '1'])
    assert.equal(m.code, 0, m.out)
    const { ledger, iterations } = state(r.dir)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].severity, 'major')
    assert.equal(ledger[0].consensus, true)
    assert.deepEqual(ledger[0].lenses.sort(), ['correctness', 'security'])
    assert.equal(iterations[1].result.bundles.all.min, 3)
    assert.equal(rv(r.dir, ['status']).code, 1)
  } finally { r.cleanup() }
})

test('disputes: protected subjects refused, proof required and checked', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    rv(r.dir, ['add', '--bundle', 'all'], reply('correctness', 3, [finding('return a / b', 'b can be undefined here, so the result is NaN', 'major', 'src/math.js:11')]))
    rv(r.dir, ['add', '--bundle', 'all'], reply('security', 3, [finding("return '$' + n.toFixed(2)", 'the dollar sign is hardcoded for every locale', 'major', 'src/format.js:2')]))
    rv(r.dir, ['add', '--bundle', 'all'], reply('quality', 5))
    assert.equal(rv(r.dir, ['merge', '1']).code, 0)
    const [nullRow, localeRow] = state(r.dir).ledger
    const p = rv(r.dir, ['dispute', nullRow.id, '--ground', 'B', '--proof', 'return a / b'])
    assert.equal(p.code, 1)
    assert.match(p.out, /protected subject \(null\/undefined deref/)
    const noProof = rv(r.dir, ['dispute', localeRow.id, '--ground', 'B'])
    assert.equal(noProof.code, 1)
    assert.match(noProof.out, /needs --proof/)
    const fake = rv(r.dir, ['dispute', localeRow.id, '--ground', 'B', '--proof', 'const currency = locale.symbol'])
    assert.equal(fake.code, 1)
    assert.match(fake.out, /Ground B refused/)
    const ok = rv(r.dir, ['dispute', localeRow.id, '--ground', 'B', '--proof', "return '$' + n.toFixed(2)"])
    assert.equal(ok.code, 0, ok.out)
    assert.equal(state(r.dir).ledger[1].status, 'disputed')
  } finally { r.cleanup() }
})

test('quick profile: budget exhaustion refuses more reviews and status exits 2', () => {
  const r = makeRepo()
  try {
    const i = rv(r.dir, ['init', '--base', 'main'])
    assert.match(i.out, /greploop run: quick/)
    assert.equal(rv(r.dir, ['add', '--bundle', 'all'], reply('all', 3, [finding('return a / b', 'divide by zero returns Infinity')])).code, 0)
    assert.equal(rv(r.dir, ['merge', '1']).code, 0)
    const s = rv(r.dir, ['status'])
    assert.equal(s.code, 2, s.out)
    assert.match(s.out, /escalate/)
    const more = rv(r.dir, ['add', '--bundle', 'all'], reply('all', 5))
    assert.equal(more.code, 2)
    assert.match(more.out, /budget/)
    const e = rv(r.dir, ['escalate'])
    assert.equal(e.code, 0, e.out)
    assert.equal(state(r.dir).profile, 'standard')
  } finally { r.cleanup() }
})

test('quick profile: the reviewer dispatch cap holds even for rejected replies', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'quick'])
    assert.equal(rv(r.dir, ['add', '--bundle', 'all'], 'not json').code, 1)
    const second = rv(r.dir, ['add', '--bundle', 'all'], 'still not json')
    assert.match(second.out, /STOP and show the raw output/)
    const third = rv(r.dir, ['add', '--bundle', 'all'], reply('all', 5))
    assert.equal(third.code, 2)
    assert.match(third.out, /2 reviewer dispatches used/)
  } finally { r.cleanup() }
})

test('report: four sections, and "Did not pass" when a required check failed', () => {
  const r = makeRepo({ config: { requiredChecks: ['test'] } })
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    cleanPanel(r.dir)
    assert.equal(rv(r.dir, ['scan', scanFile(r.dir, 'CLEAN')]).code, 0)
    const t = rv(r.dir, ['run', 'test', '--cmd', `${NODE} -e "process.exit(3)"`, '--scope', 'unit tests'])
    assert.equal(t.code, 0, t.out)
    const rep = rv(r.dir, ['report']).out
    const heads = [...rep.matchAll(/^== (.+) ==$/gm)].map((m) => m[1])
    assert.deepEqual(heads, SECTIONS)
    assert.match(rep, /Did not pass: .*test failed/)
    assert.doesNotMatch(rep, /Passed the configured checks/)
    assert.doesNotMatch(rep, /no bugs/i)
    const md = rv(r.dir, ['report', '--md']).out
    assert.deepEqual([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]), SECTIONS)
  } finally { r.cleanup() }
})

test('report: "Did not pass" when scanloop was INCOMPLETE', () => {
  const r = makeRepo({ config: { requiredChecks: ['test'] } })
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    cleanPanel(r.dir)
    rv(r.dir, ['scan', scanFile(r.dir, 'INCOMPLETE')])
    rv(r.dir, ['run', 'test', '--cmd', `${NODE} -e "process.exit(0)"`])
    const rep = rv(r.dir, ['report']).out
    assert.match(rep, /Did not pass: scanloop INCOMPLETE/)
    assert.match(rep, /scanner semgrep: missing/)
  } finally { r.cleanup() }
})

test('report: "Passed the configured checks" only when every condition is met', () => {
  const r = makeRepo({ config: { requiredChecks: ['test'] } })
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    cleanPanel(r.dir)
    // required check not run yet
    rv(r.dir, ['scan', scanFile(r.dir, 'CLEAN')])
    assert.match(rv(r.dir, ['report']).out, /Did not pass: test never ran/)
    rv(r.dir, ['run', 'test', '--cmd', `${NODE} -e "process.exit(0)"`])
    assert.equal(rv(r.dir, ['status']).code, 0)
    const rep = rv(r.dir, ['report']).out
    assert.match(rep, /^Passed the configured checks$/m)
    assert.doesNotMatch(rep, /Did not pass/)
    assert.doesNotMatch(rep, /no bugs/i)
    // any later code change makes the evidence stale
    r.write('src/format.js', FORMAT + '// touched\n')
    assert.match(rv(r.dir, ['report']).out, /Did not pass: review exit condition; scan is stale; test stale/)
  } finally { r.cleanup() }
})

test('report: a project with no test command passes only as "untested"', () => {
  const r = makeRepo()
  try {
    rv(r.dir, ['init', '--base', 'main', '--profile', 'standard'])
    cleanPanel(r.dir)
    rv(r.dir, ['scan', scanFile(r.dir, 'CLEAN')])
    const rep = rv(r.dir, ['report']).out
    assert.match(rep, /Passed the configured checks - untested: no test command ran \(the project provides none\)/)
    assert.match(rep, /no test command ran/)
  } finally { r.cleanup() }
})
