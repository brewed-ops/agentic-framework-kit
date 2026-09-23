#!/usr/bin/env node
// greploop benchmark harness. Zero dependencies; needs node + git.
//
//   node bench.mjs build <out-dir>    one blind review repo per case: branch main = demo base,
//                                     branch change = the case. No answer key, no proofs inside.
//   node bench.mjs verify-key         proves the answer key: each bug's proof test FAILS on the
//                                     case and PASSES after its reference fix; every case's own
//                                     tests pass (a bug CI already catches proves nothing about review)
//   node bench.mjs score <results>    scores reviewer replies against the answer key + judgments
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BASE = join(HERE, '..', 'demo-notes-api')
const KEY = JSON.parse(readFileSync(join(HERE, 'answer-key.json'), 'utf8')).cases
const ID = ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com']

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
function git(cwd, ...args) {
  const r = run('git', [...ID, ...args], cwd)
  if (r.code) throw new Error(`git ${args.join(' ')}: ${r.out}`)
  return r.out
}
const nodeTest = (cwd, glob) => run(process.execPath, ['--test', glob], cwd)

// The three greploop lenses, verbatim from greploop's SKILL.md; `all` is the quick-mode reviewer.
const R1 = '- R1 Correctness & regressions - logic errors, edge cases, off-by-one, null/undefined, error & failure handling, state leaking across layers, races, and dead callers of anything removed/renamed.'
const R2 = '- R2 Security & contracts - authz / IDOR / broken access control, business-logic abuse, injection beyond scanloop\'s reach, API / type / DB-response contract drift, backward-compat.'
const R3 = '- R3 Quality gates - performance footguns (N+1, work in loops, O(n^2)), test coverage of the change (added or updated, not weakened to pass), and EVERY MUST-CHECK house rule.'
const LENSES = {
  correctness: { LENS_NAME: 'R1 correctness', LENS_TEXT: R1 },
  security: { LENS_NAME: 'R2 security and contracts', LENS_TEXT: R2 },
  quality: { LENS_NAME: 'R3 quality gates', LENS_TEXT: R3 },
  all: { LENS_NAME: 'all three lenses at once (quick mode: you are the only reviewer)', LENS_TEXT: `${R1}\n${R2}\n${R3}` },
}

function buildCase(name, dir) {
  cpSync(BASE, dir, { recursive: true, filter: (p) => !p.includes('node_modules') })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base: demo notes api')
  git(dir, 'checkout', '-qb', 'change')
  git(dir, 'am', '-q', join(HERE, 'cases', `${name}.patch`))
}

const [cmd, arg] = process.argv.slice(2)

if (cmd === 'build') {
  if (!arg) { console.error('usage: node bench.mjs build <out-dir>'); process.exit(2) }
  for (const name of Object.keys(KEY)) {
    const dir = join(arg, name)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    buildCase(name, dir)
    console.log(`built ${dir}`)
  }
} else if (cmd === 'verify-key') {
  const work = mkdtempSync(join(tmpdir(), 'greploop-bench-'))
  let bad = 0
  for (const [name, c] of Object.entries(KEY)) {
    const dir = join(work, name)
    buildCase(name, dir)
    const own = nodeTest(dir, 'test/*.test.mjs')
    const lines = [`own tests ${own.code === 0 ? 'pass' : 'FAIL'}`]
    if (own.code !== 0) bad++
    if (c.kind === 'bug') {
      cpSync(join(HERE, 'proofs', `${name}.test.mjs`), join(dir, 'test', 'proof.test.mjs'))
      cpSync(join(HERE, 'proofs', 'spawn-server.mjs'), join(dir, 'test', 'spawn-server.mjs'))
      const before = nodeTest(dir, 'test/proof.test.mjs')
      git(dir, 'apply', join(HERE, 'fixes', `${name}.patch`))
      const after = nodeTest(dir, 'test/proof.test.mjs')
      const ownAfter = nodeTest(dir, 'test/*.test.mjs')
      const ok = before.code !== 0 && after.code === 0 && ownAfter.code === 0
      if (!ok) bad++
      lines.push(`proof fails on the change: ${before.code !== 0 ? 'yes' : 'NO'}`,
        `proof passes after the fix: ${after.code === 0 ? 'yes' : 'NO'}`,
        `all tests pass after the fix: ${ownAfter.code === 0 ? 'yes' : 'NO'}`)
    }
    console.log(`${name.padEnd(20)} ${c.kind.padEnd(5)} ${lines.join(' | ')}`)
  }
  rmSync(work, { recursive: true, force: true })
  if (bad) { console.error(`\n${bad} problem(s) - the answer key is not proven`); process.exit(1) }
  console.log('\nanswer key proven: every bug reproduces and every reference fix clears it')
} else if (cmd === 'prompt') {
  // node bench.mjs prompt <review-repo> <correctness|security|quality|all>
  const lens = process.argv[4]
  if (!arg || !LENSES[lens]) { console.error('usage: node bench.mjs prompt <review-repo> <correctness|security|quality|all>'); process.exit(2) }
  const files = git(arg, 'diff', '--name-only', 'main...change').trim().split('\n').join(', ')
  const rules = readFileSync(join(HERE, '..', '..', '.agents', 'skills', 'greploop', 'references', 'file-rules.md'), 'utf8')
  const jsRules = rules.split(/\n(?=## )/).find((s) => s.startsWith('## **/*.ts')).split('\n').slice(1).join('\n').trim()
  const fill = { REPO: arg, FILES: files, FILE_RULES: jsRules, LENS_ID: lens, ...LENSES[lens] }
  process.stdout.write(readFileSync(join(HERE, 'reviewer-prompt.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k]))
} else if (cmd === 'score') {
  await import('./score.mjs').then((m) => m.score(arg ?? join(HERE, 'results'), KEY))
} else {
  console.error('usage: node bench.mjs build <out-dir> | verify-key | score [results-dir]')
  process.exit(2)
}
