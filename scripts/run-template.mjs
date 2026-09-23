#!/usr/bin/env node
// Runs the `run:` steps of a CI workflow template against a fixture project, so the templates in
// .agents/skills/ship/assets/ are proven on real projects instead of only copied.
//
// Usage: node scripts/run-template.mjs <template.yml> <fixture-dir> [--expect-fail]
//
// Each `run:` step executes in file order with `bash --noprofile --norc -eo pipefail -c` (what
// GitHub uses on Linux), in <fixture-dir> (or <fixture-dir>/<working-directory>), with CI=true.
// It stops at the first failing step. `uses:` steps are skipped: the calling job provides them.
//
// --expect-fail is for negative fixtures: it passes only when a step whose name contains "test"
// (any case, e.g. "Test" or "Require tests") fails. A failure anywhere else, or no failure, fails.
// An unnamed step is called "Run <first line>", as GitHub shows it.
//
// Parser limits, on purpose (a tiny line reader, not a YAML parser):
//  - steps are list items under a `steps:` key; every `steps:` block in the file runs, in order,
//    as if it were one job
//  - per step it reads only top-level `name`, `run`, `uses` and `working-directory`; `with`,
//    `env`, `if`, `shell`, `continue-on-error` and job-level `defaults` are ignored
//  - `run:` is a plain one-liner (quotes and a trailing ` # comment` stripped) or a `|` / `>`
//    block; a `>` block is joined with spaces, not with full YAML folding rules
//  - `${{ }}` expressions are not evaluated: a step using one stops the run with exit 2
//  - no anchors, aliases, flow style or multi-line quoted scalars
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const expectFail = args.includes('--expect-fail')
const [template, fixture] = args.filter((a) => a !== '--expect-fail')
if (!template || !fixture) {
  console.error('usage: node scripts/run-template.mjs <template.yml> <fixture-dir> [--expect-fail]')
  process.exit(2)
}

const indentOf = (l) => l.length - l.trimStart().length
const scalar = (v) => (/^(["']).*\1$/.test(v.trim()) ? v.trim().slice(1, -1) : v.replace(/\s+#.*$/, '').trim())

function parseSteps(text) {
  const lines = text.replace(/\r/g, '').split('\n')
  const steps = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i++].match(/^(\s*)steps:\s*(#.*)?$/)
    if (!m) continue
    const base = m[1].length
    let item = -1
    let step = null
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim() || line.trim().startsWith('#')) { i++; continue }
      const ind = indentOf(line)
      const dash = line.trimStart().startsWith('- ')
      if (ind < base || (ind === base && !dash)) break
      if (item < 0) item = ind
      let body
      if (ind === item && dash) { step = {}; steps.push(step); body = line.slice(ind + 2) }
      else if (ind === item + 2 && step) body = line.slice(ind)
      else { i++; continue } // nested maps (with:, env:) are not ours
      i++
      const kv = body.match(/^([\w-]+):\s*(.*)$/)
      if (!kv) continue
      let v = kv[2]
      if (/^[|>][-+]?\s*(#.*)?$/.test(v)) {
        const block = []
        while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > item + 2)) block.push(lines[i++])
        while (block.length && !block.at(-1).trim()) block.pop()
        const cut = Math.min(...block.filter((l) => l.trim()).map(indentOf))
        v = block.map((l) => l.slice(cut)).join(v[0] === '>' ? ' ' : '\n')
      } else v = scalar(v)
      step[kv[1]] = v
    }
  }
  return steps
}

const root = resolve(fixture)
if (!existsSync(root)) { console.error(`run-template: no fixture folder ${root}`); process.exit(2) }
const steps = parseSteps(readFileSync(template, 'utf8'))
if (!steps.some((s) => s.run !== undefined)) { console.error(`run-template: no run: steps in ${template}`); process.exit(2) }

console.log(`run-template: ${template} in ${fixture}${expectFail ? ' (expect a test step to fail)' : ''}`)
let failed = null
for (const [n, s] of steps.entries()) {
  const name = s.name || (s.run !== undefined ? `Run ${s.run.split('\n')[0]}` : `uses: ${s.uses}`)
  if (s.run === undefined) { console.log(`\n--- [${n + 1}] ${name}: skipped, the calling job provides it`); continue }
  if (s.run.includes('${{')) { console.error(`run-template: step "${name}" uses a \${{ }} expression, which this harness cannot evaluate`); process.exit(2) }
  const cwd = s['working-directory'] ? join(root, s['working-directory']) : root
  console.log(`\n=== [${n + 1}] ${name}\n$ ${s.run.replace(/\n/g, '\n$ ')}`)
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', s.run], {
    cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' },
  })
  const code = r.error ? 127 : (r.status ?? 1)
  if (r.error) console.error(`run-template: could not start bash: ${r.error.message}`)
  console.log(`=== [${n + 1}] ${name}: exit ${code}`)
  if (code !== 0) { failed = { name, code }; break }
}

if (!expectFail) {
  if (failed) { console.error(`\nrun-template: FAIL at "${failed.name}" (exit ${failed.code})`); process.exit(1) }
  console.log('\nrun-template: PASS - every run step exited 0')
} else if (!failed) {
  console.error('\nrun-template: FAIL - expected a test step to fail, but every step passed')
  process.exit(1)
} else if (!/test/i.test(failed.name)) {
  console.error(`\nrun-template: FAIL - expected a test step to fail, but "${failed.name}" failed first (exit ${failed.code}); the fixture is broken, not the guard`)
  process.exit(1)
} else {
  console.log(`\nrun-template: PASS - "${failed.name}" failed as expected (exit ${failed.code})`)
}
