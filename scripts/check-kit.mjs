#!/usr/bin/env node
// Checks the kit before it ships. Exits 1 on any failure. Run: node scripts/check-kit.mjs
//  - every skill uses only portable Agent Skills frontmatter (agentskills.io)
//  - name matches its folder, description fits the 1024-char limit, SKILL.md stays under 500 lines
//  - every .mjs parses
//  - no personal paths, hosts or names leaked from the author's own setup
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SKILLS = join(ROOT, '.agents', 'skills')
const PORTABLE = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
// Things that belong to one person's machine, never to a public kit.
const PERSONAL = [/Kenneth/i, /kvill/i, /[A-Z]:\\ClaudeCode/i, /D:\/ClaudeCode/i, /187\.77\./, /hostinger/i,
  /Fineman/i, /michaelnfineman/i, /\bMyOS\b/, /Obsidia[\\/]Kape/i, /\bfeedback_[a-z_]+/, /\breference_[a-z_]+\.md/]

const errors = []
const fail = (file, msg) => errors.push(`${relative(ROOT, file)}: ${msg}`)

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    // Build output and tool caches are gitignored and never ship; a local fixture run writes paths into them.
    if (['.git', 'node_modules', 'target', '.venv', 'dist', '__pycache__', '.pytest_cache', '.ruff_cache', '.scanloop', '.greploop'].includes(n)) return []
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

for (const name of readdirSync(SKILLS)) {
  const dir = join(SKILLS, name)
  if (!statSync(dir).isDirectory()) continue
  const file = join(dir, 'SKILL.md')
  let text
  try { text = readFileSync(file, 'utf8') } catch { fail(dir, 'missing SKILL.md'); continue }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) { fail(file, 'no YAML frontmatter'); continue }
  const fields = Object.fromEntries(m[1].split(/\r?\n/).filter((l) => /^[a-z-]+:/.test(l))
    .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]))
  for (const k of Object.keys(fields)) if (!PORTABLE.has(k)) fail(file, `non-portable frontmatter field "${k}"`)
  if (fields.name !== name) fail(file, `name "${fields.name}" must match folder "${name}"`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) fail(file, 'name must be lowercase-hyphenated, max 64 chars')
  if (!fields.description) fail(file, 'missing description')
  else if (fields.description.length > 1024) fail(file, `description is ${fields.description.length} chars (max 1024)`)
  const lines = text.split('\n').length
  if (lines > 500) fail(file, `${lines} lines (keep SKILL.md under 500; move detail to references/)`)
}

for (const file of walk(ROOT)) {
  if (!['.md', '.mjs', '.sh', '.ps1', '.yml', '.json'].includes(extname(file))) continue
  if (relative(ROOT, file) === join('scripts', 'check-kit.mjs')) continue
  const text = readFileSync(file, 'utf8')
  for (const re of PERSONAL) {
    const hit = text.match(re)
    if (hit) fail(file, `personal reference "${hit[0]}"`)
  }
  if (extname(file) === '.mjs') {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (r.status !== 0) fail(file, `does not parse: ${r.stderr.split('\n').find((l) => l.includes('Error')) ?? r.stderr}`)
  }
}

if (errors.length) {
  console.error(`check-kit: ${errors.length} problem(s)\n  ${errors.join('\n  ')}`)
  process.exit(1)
}
console.log('check-kit: all skills portable, scripts parse, no personal references')
