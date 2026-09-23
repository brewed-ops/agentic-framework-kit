#!/usr/bin/env node
// greploop runner: validates reviewer replies, keeps the finding ledger, records executed checks
// and scanner results, enforces the profile budget, and prints the four-section report.
// Zero dependencies, Node 18+. Run from inside the repo under review.
// Full CLI: ../references/runner.md
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const LENSES = ['correctness', 'security', 'quality']
const SEV = { minor: 1, major: 2, blocking: 3 }
const PROFILES = {
  quick: { maxIterations: 1, reviewers: 1, dispatchesPerBundle: 2, estimate: 'a few minutes' },
  standard: { maxIterations: 3, reviewers: 3, dispatchesPerBundle: 12, estimate: 'roughly 10-40 minutes' },
  thorough: { maxIterations: 5, reviewers: 3, dispatchesPerBundle: 18, estimate: 'roughly 30-90 minutes' },
}
// State and scanner output never count as part of the change under review.
const EXCL = [':(exclude).greploop/run*', ':(exclude).greploop/lock', ':(exclude).scanloop/*.json']
const EXCLUDE_RULES = [
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb?|[^/]*\.lock)$/, 'lockfile'],
  [/(^|\/)(dist|build|\.next|\.astro|\.svelte-kit|\.turbo|\.vite)\//, 'build output'],
  [/(^|\/)(node_modules|vendor)\//, 'vendored dependencies'],
  [/\.min\.(js|css)$/, 'minified bundle'],
  [/\.(generated|gen)\.[^/]+$/, 'generated code'],
  [/(^|\/)__snapshots__\/|\.snap$/, 'test snapshot'],
  [/\.(db|sqlite|sqlite3)$/i, 'database file'],
]
const DOCS = /\.(md|mdx|txt|rst)$/i
// Path heuristics for picking a profile. Docs files never trigger them.
const THOROUGH_PATHS = [
  ['auth', /(^|[/._-])(auth|authn|authz|login|logout|session|sessions|permission|permissions|rbac|acl|oauth|sso|jwt|password|passwords)([/._-]|$)/i],
  ['payments', /payment|billing|stripe|checkout|invoice|subscription|paypal/i],
  ['migrations', /(^|\/)(migrations?|supabase)\/|\.(sql|prisma)$/i],
  ['secrets', /(^|\/)\.env(\.|$)|secret|credential|\.(pem|key|p12|pfx)$/i],
  ['deploy config', /(^|\/)\.github\/workflows\/|\.gitlab-ci\.ya?ml$|(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|Procfile|vercel\.json|netlify\.toml|fly\.toml|wrangler\.toml)$|\.tf$|(^|\/)(k8s|helm|deploy|infra|nginx)\//i],
]
const NOT_QUICK_PATHS = [
  ['dependency manifest', /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?)$/i],
  ['lockfile', EXCLUDE_RULES[0][0]],
  ['security headers/config', /(^|\/)(_headers|middleware\.[cm]?[jt]s|proxy\.[cm]?[jt]s)$|security|csp|cors/i],
]
// Keyword heuristics on a finding's issue text. They err toward refusing a dispute.
const PROTECTED = [
  ['null/undefined deref', /\bnull\b|\bundefined\b|\bnil\b|\bNone\b|null ?pointer|nullish|deref|may be missing|can be missing|optional (field|value|chaining)/i],
  ['bounds/off-by-one', /off[- ]by[- ]one|out[- ]of[- ]bounds|out of range|index(es)? (past|beyond)|bounds|fencepost|overflow|underflow|empty (array|list|input|string|sequence)|length ?- ?1/i],
  ['race/async ordering', /\brace\b|concurren|\basync\b|\bawait|unawaited|promise|\border(ing)?\b|deadlock|atomic|toctou|stale closure/i],
  ['behavior/compat change', /behaviou?r change|breaking|backward|compat|no longer|used to|previously|regress|default (changed|value)|status code|error path|contract/i],
  ['unused parameter', /unused (param|parameter|argument|arg)|(param|parameter|argument)\b.*\b(never|not) (used|read)|accepted and never used|ignored (param|parameter|argument)/i],
]
const BROKE_BY_DIFF = /\b(this|the) (diff|change|pr|patch|commit)\b|\b(renamed|removed|deleted|signature changed|no longer|now (returns|throws|expects|requires|takes))\b/i

// ---------- plumbing ----------
function die(msg, code = 1) { console.error(`review: ${msg}`); process.exit(code) }
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
if (top.status !== 0) die('not inside a git repository')
const ROOT = top.stdout.trim()
const STATE = join(ROOT, '.greploop')
const RUN = join(STATE, 'run.json')

function git(args, allowFail = false) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.status !== 0) { if (allowFail) return null; die(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`) }
  return r.stdout
}
const norm = (p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '')
const ws = (s) => String(s).replace(/\s+/g, ' ').trim()
const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const readText = (p) => { try { return readFileSync(join(ROOT, p), 'utf8') } catch { return null } }
const readLines = (p) => readText(p)?.split(/\r?\n/) ?? null
const maxSev = (a, b) => (SEV[a] >= SEV[b] ? a : b)

function lock() {
  mkdirSync(STATE, { recursive: true })
  const file = join(STATE, 'lock')
  const end = Date.now() + 15000
  for (;;) {
    try { closeSync(openSync(file, 'wx')); process.on('exit', () => { try { unlinkSync(file) } catch {} }); return } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (Date.now() > end) die('another review.mjs holds .greploop/lock (delete it if no run is active)')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}
function load() {
  if (!existsSync(RUN)) die('no run in .greploop/run.json - start with: review.mjs init --base <ref>')
  return JSON.parse(readFileSync(RUN, 'utf8'))
}
function save(run) { writeFileSync(RUN + '.tmp', JSON.stringify(run, null, 2)); renameSync(RUN + '.tmp', RUN) }

function parseArgs(argv) {
  const BOOL = new Set(['md', 'reset', 'force-size', 'supplement'])
  const pos = []; const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const k = a.slice(2)
    if (BOOL.has(k)) opt[k] = true
    else if (i + 1 < argv.length) opt[k] = argv[++i]
    else die(`--${k} needs a value`)
  }
  return { pos, opt }
}

// Content fingerprint of the change: the diff against the merge-base plus the bytes of every untracked
// file. Stable across commits, changes when any file changes. scanloop's scan.mjs computes the same
// value into its report, so an imported scan says which code it covered - keep the two identical.
// outDir: the scan's output folder (relative), whose files never count as part of the change.
const OUT_FILES = ['report.json', 'report.json.tmp', 'gitleaks.json', 'semgrep.json', 'osv.json']
const outExcl = (outDir) => (typeof outDir === 'string' ? OUT_FILES.map((f) => `:(exclude)${outDir ? `${outDir}/` : ''}${f}`) : [])
const readBytes = (p) => { try { return readFileSync(join(ROOT, p)) } catch { return Buffer.from('<unreadable>') } }
function untrackedFiles(outDir) {
  return git(['ls-files', '-z', '--others', '--exclude-standard', '--', '.', ...EXCL, ...outExcl(outDir)]).split('\0').filter(Boolean).sort()
}
function fingerprint(run, outDir) {
  const h = createHash('sha256').update('fp2\0')
  h.update(git(['diff', '--no-color', '--no-ext-diff', '--binary', run.mergeBase, '--', '.', ...EXCL, ...outExcl(outDir)]))
  for (const f of untrackedFiles(outDir)) h.update(`\0${f}\0`).update(readBytes(f))
  return h.digest('hex')
}
function contentHash(files) { return sha1(files.map((f) => f + '\0' + (readText(f) ?? '<missing>')).join('\0')).slice(0, 12) }
const lineCount = (buf) => { const s = buf.toString('utf8'); return s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0 }

function changedFiles(mergeBase) {
  const files = {}
  for (const l of git(['diff', '--numstat', '--no-renames', mergeBase, '--', '.', ...EXCL]).split('\n')) {
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(l)
    if (m) files[norm(m[3])] = { added: m[1] === '-' ? 0 : +m[1], deleted: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' }
  }
  for (const l of git(['diff', '--name-status', '--no-renames', mergeBase, '--', '.', ...EXCL]).split('\n')) {
    const m = /^(\w)\t(.+)$/.exec(l)
    if (m && files[norm(m[2])]) files[norm(m[2])].status = m[1]
  }
  // Untracked files are part of the change: git diff never shows them, so add them as new files.
  for (const f of untrackedFiles()) {
    const buf = readBytes(f); const binary = buf.subarray(0, 8000).includes(0)
    files[f] = { added: binary ? 0 : lineCount(buf), deleted: 0, binary, status: 'A', untracked: true }
  }
  return files
}
// Lines this change added or modified, per file, on the working-tree side.
function changedLines(run) {
  const map = {}; let cur = null
  for (const l of git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', run.mergeBase, '--', '.', ...EXCL]).split('\n')) {
    if (l.startsWith('+++ ')) { const p = l.slice(4).trim(); cur = p === '/dev/null' ? null : norm(p.replace(/^b\//, '')); if (cur) map[cur] ??= new Set() }
    else if (cur && l.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(l); const start = +m[1]; const n = m[2] === undefined ? 1 : +m[2]
      if (n === 0) { map[cur].add(start); map[cur].add(start + 1) } // pure deletion: the lines around it
      for (let i = start; i < start + n; i++) map[cur].add(i)
    }
  }
  for (const f of untrackedFiles()) { const n = lineCount(readBytes(f)); map[f] = new Set(); for (let i = 1; i <= n; i++) map[f].add(i) }
  return map
}

function globRe(g) {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i++ } }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
function ruleGlobs() {
  const out = []
  for (const text of [safeRead(join(SKILL_DIR, 'references', 'file-rules.md')), readText('.greploop/rules.md')]) {
    if (!text) continue
    for (const m of text.matchAll(/^## (.+)$/gm)) if (m[1].trim() !== 'Default') out.push(...m[1].split(',').map((g) => globRe(g.trim())))
  }
  return out
}
function safeRead(p) { try { return readFileSync(p, 'utf8') } catch { return null } }

function detectChecks() {
  const found = new Set()
  let pkg = null; try { pkg = JSON.parse(readText('package.json') ?? 'null') } catch {}
  const s = pkg?.scripts ?? {}
  if (s.test && !/no test specified/.test(s.test)) found.add('test')
  for (const k of ['build', 'lint']) if (s[k]) found.add(k)
  if (s.typecheck || s['type-check']) found.add('typecheck')
  if (readText('go.mod') !== null || readText('Cargo.toml') !== null) { found.add('test'); found.add('build') }
  if (['pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml'].some((f) => /pytest/.test(readText(f) ?? ''))) found.add('test')
  const mk = readText('Makefile') ?? ''
  for (const t of ['test', 'build', 'lint']) if (new RegExp(`^${t}:`, 'm').test(mk)) found.add(t)
  return [...found]
}

// ---------- anchoring + matching ----------
function fileRef(s) {
  const m = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(String(s).trim())
  return m ? { path: norm(m[1]), line: +m[2] } : { path: norm(s), line: null }
}
// Find a verbatim snippet in a file, whitespace-tolerant per line. Returns the match nearest the hint.
function anchor(lines, code, hint) {
  const want = String(code ?? '').split(/\r?\n/).map(ws).filter(Boolean)
  if (!lines || !want.length) return null
  const have = []
  lines.forEach((l, i) => { const t = ws(l); if (t) have.push([i + 1, t]) })
  const hits = []
  for (let s = 0; s + want.length <= have.length; s++) {
    let ok = true
    for (let k = 0; k < want.length && ok; k++) {
      const h = have[s + k][1]; const w = want[k]
      if (want.length === 1) ok = h === w || (w.length >= 4 && h.includes(w))
      else if (k === 0) ok = h.endsWith(w)
      else if (k === want.length - 1) ok = h.startsWith(w)
      else ok = h === w
    }
    if (ok) hits.push([have[s][0], have[s + want.length - 1][0]])
  }
  if (!hits.length) return null
  const d = (h) => (hint ? Math.abs(h[0] - hint) : 0)
  hits.sort((a, b) => d(a) - d(b))
  return { line: hits[0][0], endLine: hits[0][1] }
}
const snip = (c) => String(c ?? '').split(/\r?\n/).map(ws).filter(Boolean).join('\n')
function snippetOverlap(a, b) {
  const x = snip(a); const y = snip(b)
  if (!x || !y) return false
  if (x === y) return true
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]
  return s.length >= 12 && l.includes(s)
}
function sameSpot(a, b) {
  if (a.file !== b.file) return false
  if (a.anchored && b.anchored && a.line && b.line) {
    const overlap = a.line <= (b.endLine ?? b.line) && b.line <= (a.endLine ?? a.line)
    if (overlap || Math.abs(a.line - b.line) <= 2) return true
  }
  return snippetOverlap(a.code, b.code)
}

// ---------- validation ----------
function validate(text, files, lenses) {
  const errs = []; const missing = []
  const body = String(text).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/, '$1')
  let r
  try { r = JSON.parse(body) } catch (e) { return { errs: [`not valid JSON (${e.message}) - return ONLY the JSON object`], missing } }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { errs: ['the reply must be one JSON object'], missing }
  const str = (v) => typeof v === 'string' && v.trim() !== ''
  for (const k of Object.keys(r)) if (!['lens', 'score', 'summary', 'coverage', 'findings', 'pre_existing'].includes(k)) errs.push(`unknown key "${k}"`)
  if (!lenses.includes(r.lens)) errs.push(`lens must be ${lenses.join('|')}, got ${JSON.stringify(r.lens)}`)
  if (!Number.isInteger(r.score) || r.score < 1 || r.score > 5) errs.push(`score must be an integer 1-5, got ${JSON.stringify(r.score)}`)
  if (!str(r.summary)) errs.push('summary must be a non-empty string')
  if (!r.coverage || typeof r.coverage !== 'object' || Array.isArray(r.coverage)) errs.push('coverage must be an object {"path": "reviewed" | "skipped: <reason>"}')
  else {
    const cov = Object.fromEntries(Object.entries(r.coverage).map(([k, v]) => [norm(k), v]))
    for (const f of files) {
      if (!(f in cov)) missing.push(f)
      else if (cov[f] !== 'reviewed' && !/^skipped:\s*\S/.test(String(cov[f]))) errs.push(`coverage["${f}"] must be "reviewed" or "skipped: <reason>", got ${JSON.stringify(cov[f])}`)
    }
  }
  const list = (key, required, optional) => {
    if (!Array.isArray(r[key])) { errs.push(`${key} must be an array (use [] for none)`); return }
    r[key].forEach((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) { errs.push(`${key}[${i}] must be an object`); return }
      for (const k of Object.keys(f)) if (![...required, ...optional].includes(k)) errs.push(`${key}[${i}] has unknown key "${k}"`)
      for (const k of required) if (!str(f[k])) errs.push(`${key}[${i}].${k} must be a non-empty string`)
      if (key === 'findings' && str(f.severity) && !(f.severity in SEV)) errs.push(`findings[${i}].severity must be blocking|major|minor, got "${f.severity}"`)
    })
  }
  list('findings', ['severity', 'file', 'code', 'issue', 'fix'], [])
  list('pre_existing', ['file', 'code', 'issue'], ['fix'])
  if (!errs.length && Array.isArray(r.findings)) {
    const worst = r.findings.reduce((m, f) => Math.max(m, SEV[f.severity]), 0)
    if (r.score === 5 && r.findings.length) errs.push(`score 5 means no issues found through this lens, but findings lists ${r.findings.length} - lower the score or drop them`)
    else if (worst >= SEV.major && r.score > 3) errs.push(`a ${worst === 3 ? 'blocking' : 'major'} finding caps the score at 3, got ${r.score}`)
  }
  return { errs, missing, r }
}

function processReply(run, r, lens, bundleId) {
  const changed = changedLines(run); const cache = {}
  const lines = (p) => (p in cache ? cache[p] : (cache[p] = readLines(p)))
  const findings = []; const pre = []; const notes = { reanchored: 0, unanchored: 0, moved: 0 }
  for (const f of r.findings) {
    const ref = fileRef(f.file); const a = anchor(lines(ref.path), f.code, ref.line)
    const item = { file: ref.path, claimedLine: ref.line, line: a ? a.line : ref.line, endLine: a ? a.endLine : ref.line, anchored: !!a,
      code: f.code, severity: f.severity, issue: f.issue, fix: f.fix, lens, bundle: bundleId }
    if (!a) { notes.unanchored++; findings.push(item); continue }
    if (a.line !== ref.line) notes.reanchored++
    const set = changed[ref.path]; let touched = false
    for (let i = a.line; set && i <= a.endLine && !touched; i++) touched = set.has(i)
    if (!touched) {
      if (BROKE_BY_DIFF.test(f.issue)) item.caller = true
      else { pre.push({ ...item, reason: 'scope rule: no changed line' }); notes.moved++; continue }
    }
    findings.push(item)
  }
  for (const p of r.pre_existing) {
    const ref = fileRef(p.file); const a = anchor(lines(ref.path), p.code, ref.line)
    pre.push({ file: ref.path, line: a ? a.line : ref.line, anchored: !!a, code: p.code, issue: p.issue, lens, bundle: bundleId, reason: 'reported by reviewer' })
  }
  return { findings, pre, notes }
}

// ---------- run bookkeeping ----------
const currentIteration = (run) => run.lastMerged + 1
const lensesFor = (run) => (run.profile === 'quick' ? ['all'] : LENSES)
function budgetState(run) {
  const itersUsed = run.lastMerged - run.window.start + 1
  const dispatchesUsed = run.dispatches - run.window.dispatches
  return { itersUsed, dispatchesUsed, exhausted: itersUsed >= run.budget.maxIterations || dispatchesUsed >= run.budget.maxDispatches }
}
function setProfile(run, profile) {
  const p = PROFILES[profile]
  run.profile = profile
  run.budget = { maxIterations: p.maxIterations, reviewersPerBundle: p.reviewers, maxDispatches: p.dispatchesPerBundle * run.bundles.length,
    formula: `${p.dispatchesPerBundle} x ${run.bundles.length} bundle(s)`, estimate: p.estimate }
  run.window = { start: run.lastMerged + 1, dispatches: run.dispatches }
}
const ownerBundle = (run, file) => run.bundles.find((b) => b.files.includes(file))?.id ?? null
function unassigned(run) {
  const now = changedFiles(run.mergeBase)
  const known = new Set([...run.bundles.flatMap((b) => b.files), ...run.excluded.map((e) => e.path)])
  return Object.keys(now).filter((f) => !known.has(f) && now[f].status !== 'D' && !excludeReason(run, f, now[f]))
}
function excludeReason(run, f, info) {
  if (info?.status === 'D') return 'deleted in this diff (reference only)'
  if (info?.binary) return 'binary'
  for (const [re, why] of EXCLUDE_RULES) if (re.test(f)) return why
  for (const g of run.config.exclude ?? []) if (globRe(g).test(f)) return `excluded by .greploop/config.json (${g})`
  return null
}

function bundleState(run, b) {
  const reasons = []
  let last = null
  for (let i = run.lastMerged; i >= 1 && !last; i--) if (run.iterations[i]?.result?.bundles?.[b.id]) last = i
  if (!last) return { clean: false, reasons: ['not reviewed yet'], last }
  const res = run.iterations[last].result.bundles[b.id]
  if (contentHash(b.files) !== res.contentHash) reasons.push(`files changed since the iteration ${last} review - re-review`)
  const scores = Object.values(res.scores)
  // Every reviewer must be at 4 or 5. A blocking/major finding caps a reply at 3 (see add), so a 4 means
  // "minor findings only" - and minors never block. Requiring 5s made a minor-only change unable to exit.
  if (scores.some((s) => s <= 3)) reasons.push('a reviewer scored 3 or lower (every reviewer needs 4 or 5)')
  if (res.blocking + res.major) reasons.push(`iteration ${last} found ${res.blocking} blocking + ${res.major} major`)
  const open = run.ledger.filter((r) => r.status === 'open' && SEV[r.severity] >= SEV.major && b.files.includes(r.file))
  if (open.length) reasons.push(`open ledger rows: ${open.map((r) => r.id).join(', ')}`)
  return { clean: !reasons.length, reasons, last }
}
function exitState(run) {
  const bundles = run.bundles.map((b) => ({ id: b.id, ...bundleState(run, b) }))
  const runReasons = []
  const stray = run.ledger.filter((r) => r.status === 'open' && SEV[r.severity] >= SEV.major && !ownerBundle(run, r.file))
  if (stray.length) runReasons.push(`open blocking/major rows outside every bundle: ${stray.map((r) => r.id).join(', ')}`)
  const ua = unassigned(run)
  if (ua.length) runReasons.push(`changed files in no bundle (assign them): ${ua.join(', ')}`)
  return { bundles, runReasons, met: bundles.every((b) => b.clean) && !runReasons.length }
}

// ---------- commands ----------
function cmdInit(opt) {
  if (!opt.base) die('init needs --base <ref>')
  if (existsSync(RUN) && !opt.reset) die('a run already exists in .greploop/run.json - pass --reset to start over')
  const mergeBase = git(['merge-base', opt.base, 'HEAD']).trim()
  const head = git(['rev-parse', 'HEAD']).trim()
  let config = {}
  const cfgText = readText('.greploop/config.json')
  if (cfgText !== null) { try { config = JSON.parse(cfgText) } catch (e) { die(`.greploop/config.json is not valid JSON: ${e.message}`) } }
  if (config.requiredChecks !== undefined && !(Array.isArray(config.requiredChecks) && config.requiredChecks.every((c) => typeof c === 'string'))) die('config.requiredChecks must be an array of check names')
  const run = { version: 1, createdAt: new Date().toISOString(), base: opt.base, mergeBase, head, config, lastMerged: 0, dispatches: 0,
    iterations: {}, ledger: [], nextId: 1, preExisting: [], checks: [], scans: [], notes: [], rejections: {} }
  const files = changedFiles(mergeBase)
  if (!Object.keys(files).length) die(`empty diff against ${opt.base} - the base is wrong (or the change is not committed)`)
  run.files = files
  run.excluded = []
  const reviewable = []
  for (const [f, info] of Object.entries(files)) {
    const why = excludeReason(run, f, info)
    if (why) run.excluded.push({ path: f, reason: why }); else reviewable.push(f)
  }
  if (!reviewable.length) die('every changed file is excluded - nothing to review')
  const lines = reviewable.reduce((n, f) => n + files[f].added + files[f].deleted, 0)
  // bundles
  if (opt.bundles) {
    let spec; try { spec = JSON.parse(readFileSync(opt.bundles, 'utf8')) } catch (e) { die(`--bundles: ${e.message}`) }
    const list = Array.isArray(spec) ? spec : Object.entries(spec).map(([id, fl]) => ({ id, files: fl }))
    const seen = new Map(); const errs = []
    run.bundles = list.map((b, i) => {
      if (!b || typeof b.id !== 'string' || !Array.isArray(b.files) || !b.files.length) errs.push(`bundle ${i} needs {"id": string, "files": [paths]}`)
      const fl = (b?.files ?? []).map(norm)
      for (const f of fl) {
        if (!reviewable.includes(f)) errs.push(`${f} (bundle ${b.id}) is not a reviewable changed file`)
        if (seen.has(f)) errs.push(`${f} is in bundles ${seen.get(f)} and ${b.id}`); seen.set(f, b.id)
      }
      if (fl.length > 10) errs.push(`bundle ${b.id} has ${fl.length} files (max 10)`)
      return { id: String(b?.id), files: fl }
    })
    for (const f of reviewable) if (!seen.has(f)) errs.push(`${f} is in no bundle`)
    if (new Set(run.bundles.map((b) => b.id)).size !== run.bundles.length) errs.push('bundle ids must be unique')
    if (errs.length) die(`bundles rejected:\n  ${errs.join('\n  ')}`)
  } else {
    const ut = reviewable.filter((f) => files[f].untracked).length
    if (reviewable.length > 10 || lines > 400) die(`${reviewable.length} files / ${lines} changed lines is too big for one bundle - write a bundles file and pass --bundles (see references/runner.md)${ut ? `. ${ut} of those files are untracked - commit, gitignore or delete the ones that are not part of this change` : ''}`)
    run.bundles = [{ id: 'all', files: reviewable }]
  }
  if (run.bundles.length > 6 && !opt['force-size']) die(`${run.bundles.length} bundles - too big to converge; split the change (or pass --force-size if the user said to proceed)`)
  // profile
  const riskFiles = Object.keys(files).filter((f) => !DOCS.test(f))
  const thorough = THOROUGH_PATHS.filter(([, re]) => riskFiles.some((f) => re.test(f))).map(([n]) => n)
  const notQuick = NOT_QUICK_PATHS.filter(([, re]) => riskFiles.some((f) => re.test(f))).map(([n]) => n)
  const docsOnly = Object.keys(files).every((f) => DOCS.test(f))
  const small = lines <= 40 && reviewable.length <= 3
  const auto = thorough.length ? 'thorough' : !notQuick.length && (docsOnly || small) ? 'quick' : 'standard'
  const profile = opt.profile ?? config.profile ?? auto
  if (!PROFILES[profile]) die(`unknown profile "${profile}" (quick|standard|thorough)`)
  if (profile === 'quick' && (thorough.length || notQuick.length)) die(`quick refused: the change touches ${[...thorough, ...notQuick].join(', ')} - use standard or thorough`)
  if (profile === 'quick' && !docsOnly && !small) run.notes.push(`quick chosen for a change over the quick size (${reviewable.length} files, ${lines} lines)`)
  if (thorough.length && profile !== 'thorough') run.notes.push(`${profile} chosen although the change touches ${thorough.join(', ')} (thorough recommended)`)
  run.autoProfile = { profile: auto, reasons: [...thorough, ...notQuick] }
  setProfile(run, profile)
  run.providedChecks = detectChecks()
  mkdirSync(STATE, { recursive: true })
  save(run)
  console.log(`greploop run: ${profile} (auto: ${auto}${thorough.length ? `, risky: ${thorough.join(', ')}` : ''})`)
  console.log(`base ${opt.base} (${mergeBase.slice(0, 7)}) .. HEAD ${head.slice(0, 7)} - ${reviewable.length} reviewable files, ${lines} changed lines, ${run.excluded.length} excluded`)
  console.log(`budget: ${run.budget.maxIterations} iteration(s), ${run.budget.maxDispatches} reviewer dispatches (${run.budget.formula}), estimate ${run.budget.estimate}`)
  for (const b of run.bundles) console.log(`bundle ${b.id}: ${b.files.join(', ')}`)
  for (const e of run.excluded) console.log(`excluded ${e.path}: ${e.reason}`)
  console.log(`checks the project provides: ${run.providedChecks.join(', ') || 'none detected'}; required: ${(config.requiredChecks ?? run.providedChecks).join(', ') || 'none'}`)
  const ut = Object.keys(files).filter((f) => files[f].untracked)
  if (ut.length) console.log(`untracked files in scope (reviewed and fingerprinted like any change; scanloop needs them committed): ${ut.join(', ')}`)
  if (git(['status', '--porcelain', '--', '.', ...EXCL]).trim()) console.log('warning: uncommitted changes - commit the in-scope change before reviewing')
  if (git(['check-ignore', '-q', '.greploop/run.json'], true) === null) console.log('warning: .greploop/run.json is not gitignored - add ".greploop/*" plus "!.greploop/config.json" and "!.greploop/rules.md" to .gitignore')
}

function cmdAdd(opt) {
  const run = load(); const iter = currentIteration(run)
  if (opt.iter !== undefined && +opt.iter !== iter) die(`iteration ${opt.iter} is not the open one (${iter})`)
  if (iter - run.window.start + 1 > run.budget.maxIterations) die(`budget: ${run.profile} allows ${run.budget.maxIterations} iteration(s) and they are used - see status`, 2)
  if (run.dispatches - run.window.dispatches >= run.budget.maxDispatches) die(`budget: ${run.budget.maxDispatches} reviewer dispatches used (${run.budget.formula}) - see status`, 2)
  const b = run.bundles.find((x) => x.id === opt.bundle)
  if (!b) die(`add needs --bundle <id> (one of: ${run.bundles.map((x) => x.id).join(', ')})`)
  const snap = opt.snapshot
  if (!snap) die(`add needs --snapshot <hash>: run \`snapshot --bundle ${b.id}\` before dispatching the reviewer and pass the hash it printed`)
  if (!(run.snapshots ?? []).some((s) => s.bundle === b.id && s.hash === snap)) die(`${snap} is not a snapshot of bundle ${b.id} - take one with: snapshot --bundle ${b.id}`)
  const text = opt.file ? readFileSync(opt.file, 'utf8') : readFileSync(0, 'utf8')
  const it = (run.iterations[iter] ??= { replies: {}, partial: {} })
  run.dispatches++
  // The reply describes the code as it was at the snapshot. If the bundle changed since, it describes code that is gone.
  const now = contentHash(b.files)
  if (now !== snap) { save(run); die(`bundle ${b.id} changed after snapshot ${snap} (now ${now}) - this reply reviewed code that no longer exists. Take a new snapshot and re-dispatch the reviewer`) }
  const partial = opt.supplement ? it.partial[b.id] : null
  if (opt.supplement && !partial) { save(run); die(`no partial reply is waiting for bundle ${b.id}`) }
  if (partial && partial.snapshot !== snap) { delete it.partial[b.id]; save(run); die(`the partial reply for bundle ${b.id} reviewed snapshot ${partial.snapshot}; the bundle changed since, so it was dropped - re-dispatch the full review`) }
  const files = partial ? partial.missing : b.files
  const { errs, missing, r } = validate(text, files, partial ? [partial.lens] : lensesFor(run))
  const lens = r && lensesFor(run).includes(r.lens) ? r.lens : '?'
  const prev = it.replies[b.id]?.[lens]
  if (!errs.length && prev && !partial && prev.snapshot === snap) errs.push(`bundle ${b.id} already has a ${lens} reply this iteration`)
  if (errs.length || (missing.length && partial)) {
    const key = `${iter}/${b.id}/${lens}`; run.rejections[key] = (run.rejections[key] ?? 0) + 1
    save(run)
    const all = [...errs, ...missing.map((f) => `coverage is missing "${f}"`)]
    die(`reply rejected (${lens} on bundle ${b.id}):\n  ${all.join('\n  ')}\n${run.rejections[key] >= 2 ? 'second invalid reply for this reviewer - STOP and show the raw output to the user' : 're-dispatch this reviewer with the errors above'}`)
  }
  const done = processReply(run, r, lens, b.id)
  if (missing.length) {
    it.partial[b.id] = { lens, missing, snapshot: snap, score: r.score, summary: r.summary, coverage: r.coverage, ...done }
    save(run)
    die(`partial: coverage is missing ${missing.join(', ')}. Re-dispatch this reviewer for those files only, then: add --bundle ${b.id} --supplement`)
  }
  let reply = { snapshot: snap, score: r.score, summary: r.summary, coverage: Object.fromEntries(Object.entries(r.coverage).map(([k, v]) => [norm(k), v])), ...done }
  if (partial) {
    reply = { snapshot: snap, score: Math.min(partial.score, r.score), summary: `${partial.summary} | ${r.summary}`, coverage: { ...Object.fromEntries(Object.entries(partial.coverage).map(([k, v]) => [norm(k), v])), ...reply.coverage },
      findings: [...partial.findings, ...done.findings], pre: [...partial.pre, ...done.pre],
      notes: Object.fromEntries(Object.keys(done.notes).map((k) => [k, partial.notes[k] + done.notes[k]])) }
    delete it.partial[b.id]
  }
  ;(it.replies[b.id] ??= {})[lens] = reply
  save(run)
  const n = reply.notes
  console.log(`accepted ${lens} on bundle ${b.id} (iteration ${iter}, snapshot ${snap}${prev && !partial ? ', replacing a reply on an older snapshot' : ''}): score ${reply.score}, ${reply.findings.length} finding(s) - ${n.reanchored} re-anchored, ${n.unanchored} unanchored, ${n.moved} moved to pre_existing`)
}

function cmdMerge(pos) {
  const run = load(); const i = +pos[1]; const cur = currentIteration(run)
  if (i !== cur) die(`merge ${pos[1] ?? '?'}: the open iteration is ${cur}`)
  const it = run.iterations[i]
  if (!it || !Object.keys(it.replies).length) die(`no replies for iteration ${i}`)
  if (Object.keys(it.partial).length) die(`partial replies waiting for a supplement: ${Object.keys(it.partial).join(', ')}`)
  const need = lensesFor(run); const mustAll = run.profile === 'thorough' || i === run.window.start
  const problems = []
  for (const b of run.bundles) {
    const got = it.replies[b.id]
    if (!got) { if (mustAll) problems.push(`bundle ${b.id} was not reviewed (${run.profile === 'thorough' ? 'thorough re-reviews every bundle every iteration' : 'the first iteration reviews every bundle'})`); continue }
    const miss = need.filter((l) => !got[l]); if (miss.length) problems.push(`bundle ${b.id} is missing: ${miss.join(', ')}`)
    const now = contentHash(b.files)
    const stale = Object.entries(got).filter(([, rep]) => rep.snapshot !== now).map(([l, rep]) => `${l} (snapshot ${rep.snapshot})`)
    if (stale.length) problems.push(`bundle ${b.id} changed after these reviewers' snapshot, so their replies describe code that is gone: ${stale.join(', ')} - take a new snapshot and re-dispatch them (add replaces a stale reply)`)
  }
  if (problems.length) die(`cannot merge iteration ${i}:\n  ${problems.join('\n  ')}`)
  // dedupe
  const groups = []
  for (const [bid, byLens] of Object.entries(it.replies)) for (const rep of Object.values(byLens)) for (const f of rep.findings) {
    const g = groups.find((x) => sameSpot(x, f))
    if (!g) { groups.push({ ...f, lenses: [f.lens], bundles: [bid], fixes: [f.fix], caller: !!f.caller }); continue }
    if (SEV[f.severity] > SEV[g.severity]) { g.severity = f.severity; g.issue = f.issue }
    if (!g.lenses.includes(f.lens)) g.lenses.push(f.lens)
    if (!g.bundles.includes(bid)) g.bundles.push(bid)
    if (!g.fixes.includes(f.fix)) g.fixes.push(f.fix)
    g.caller = g.caller && !!f.caller
    if (!g.anchored && f.anchored) Object.assign(g, { anchored: true, line: f.line, endLine: f.endLine, code: f.code })
  }
  // refresh ledger anchors, then fold groups into the ledger
  for (const row of run.ledger) if (row.code && row.status !== 'resolved') {
    const a = anchor(readLines(row.file), row.code, row.line); if (a) Object.assign(row, { line: a.line, endLine: a.endLine, anchored: true })
  }
  const rows = []
  for (const g of groups) {
    const consensus = g.lenses.length >= 2
    let row = run.ledger.find((r) => r.status !== 'resolved' && sameSpot(r, g)) ?? run.ledger.find((r) => r.status === 'resolved' && r.file === g.file && snippetOverlap(r.code, g.code))
    if (!row) {
      row = { id: `F${run.nextId++}`, source: 'review', file: g.file, line: g.line, endLine: g.endLine, anchored: g.anchored, code: g.code, severity: g.severity,
        issue: g.issue, fixes: g.fixes, lenses: g.lenses, consensus, caller: g.caller, status: 'open', raised: i, lastSeen: i, history: [`iteration ${i}: raised by ${g.lenses.join(' + ')}`] }
      run.ledger.push(row)
    } else {
      if (row.status === 'resolved') { row.status = 'open'; row.regressed = true; row.history.push(`iteration ${i}: regressed - raised again after it was resolved`) }
      else if (row.status === 'disputed') { row.reRaised = (row.reRaised ?? 0) + 1; row.history.push(`iteration ${i}: raised again while disputed`) }
      else row.history.push(`iteration ${i}: still open`)
      row.severity = maxSev(row.severity, g.severity); row.lastSeen = i; row.consensus = row.consensus || consensus
      row.lenses = [...new Set([...(row.lenses ?? []), ...g.lenses])]; row.fixes = [...new Set([...(row.fixes ?? []), ...g.fixes])]
      if (g.anchored) Object.assign(row, { line: g.line, endLine: g.endLine, anchored: true, code: row.code ?? g.code })
    }
    rows.push({ row, g })
  }
  for (const byLens of Object.values(it.replies)) for (const rep of Object.values(byLens)) for (const p of rep.pre) {
    if (!run.preExisting.some((q) => sameSpot(q, p))) run.preExisting.push({ ...p, iteration: i })
  }
  // per-bundle results
  it.result = { bundles: {} }
  for (const b of run.bundles) {
    const got = it.replies[b.id]; if (!got) continue
    // a finding counts against the bundle that owns its file, else against the bundles that raised it
    const mine = rows.filter(({ g }) => { const o = ownerBundle(run, g.file); return o ? o === b.id : g.bundles.includes(b.id) })
    const count = (s) => mine.filter(({ g }) => g.severity === s).length
    const scores = Object.fromEntries(Object.entries(got).map(([l, rep]) => [l, rep.score]))
    it.result.bundles[b.id] = { scores, min: Math.min(...Object.values(scores)), blocking: count('blocking'), major: count('major'), minor: count('minor'), contentHash: Object.values(got)[0].snapshot, rows: mine.map(({ row }) => row.id) }
  }
  it.result.runScore = Math.min(...Object.values(it.result.bundles).map((x) => x.min))
  run.lastMerged = i
  save(run)
  console.log(`iteration ${i} merged: ${groups.length} finding(s) after dedupe, run score ${it.result.runScore} (min across bundles; reviewer confidence, not proof)`)
  for (const [id, res] of Object.entries(it.result.bundles)) console.log(`  bundle ${id}: ${Object.entries(res.scores).map(([l, s]) => `${l} ${s}`).join(', ')} -> ${res.min}; ${res.blocking} blocking, ${res.major} major, ${res.minor} minor`)
  for (const { row } of rows.sort((a, b) => SEV[b.g.severity] - SEV[a.g.severity] || b.g.lenses.length - a.g.lenses.length)) console.log(`  ${fmtRow(row)}`)
}

function fmtRow(r) {
  const tags = [r.severity, r.consensus && 'consensus', r.caller && 'caller', r.anchored === false && 'unanchored', r.regressed && 'regressed', r.source === 'scan' && `${r.tool} ${r.rule_id ?? ''}`.trim()].filter(Boolean)
  return `${r.id} [${tags.join('][')}] ${r.file}${r.line ? `:${r.line}` : ''} - ${r.issue}`
}
const cmdText = (c) => (Array.isArray(c) ? c.join(' ') : String(c))
function findRow(run, id) { const r = run.ledger.find((x) => x.id === id); if (!r) die(`no ledger row "${id}"`); return r }

function execute(cmd) {
  const t = Date.now()
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' })
  return { exit: r.status ?? 1, durationMs: Date.now() - t }
}

function cmdResolve(pos, opt) {
  const run = load(); const row = findRow(run, pos[1])
  if (row.status !== 'open') die(`${row.id} is ${row.status}, not open`)
  if (!opt.how) die('resolve needs --how "<what changed>"')
  const rev = opt['reverted-exit']
  if (run.profile === 'thorough' && row.source === 'review' && SEV[row.severity] >= SEV.major && (!opt.test || rev === undefined))
    die('thorough: a blocking/major fix needs --test "<cmd>" (run now, must pass) and --reverted-exit <n> (the exit code with the fix reverted, must be non-zero)')
  if (rev !== undefined) {
    if (!/^-?\d+$/.test(rev)) die('--reverted-exit must be an integer exit code')
    if (+rev === 0) die('--reverted-exit 0: the test stayed green with the fix reverted, so it does not prove the fix - assert the broken state')
  }
  let test = null
  if (opt.test) {
    const t = execute(opt.test)
    if (t.exit !== 0) die(`the test exited ${t.exit} with the fix in place - resolve only once it passes`)
    test = { cmd: opt.test, exit: t.exit, durationMs: t.durationMs }
  }
  Object.assign(row, { status: 'resolved', how: opt.how, test, revertedExit: rev === undefined ? null : +rev, resolvedIn: currentIteration(run) })
  row.history.push(`iteration ${currentIteration(run)}: resolved - ${opt.how}`)
  save(run); console.log(`${row.id} resolved`)
}

function cmdDispute(pos, opt) {
  const run = load(); const row = findRow(run, pos[1])
  if (row.status !== 'open') die(`${row.id} is ${row.status}, not open`)
  const ground = String(opt.ground ?? '').toUpperCase()
  if (!['A', 'B'].includes(ground)) die('dispute needs --ground A (the code is not in the file) or --ground B (one line in the file contradicts the claim)')
  const proof = String(opt.proof ?? '').trim()
  if (!proof) die('dispute needs --proof "<the quoted line>" - no proof, no dispute')
  if (/\n/.test(proof)) die('--proof is ONE quoted line, not a chain of reasoning')
  if (row.source === 'scan' && /gitleaks/i.test(row.tool ?? '')) die('a gitleaks hit is never disputed here - if it is a false positive, add it to .scanloop/allowlist.yml with a reason and re-run scanloop')
  const hit = PROTECTED.find(([, re]) => re.test(row.issue))
  if (hit) die(`refused: this reads as a protected subject (${hit[0]}; keyword heuristic on the issue text). Fix it, or prove it with a failing test and resolve --test`)
  let line = null
  if (ground === 'A') {
    if (!row.code) die('Ground A needs a reviewer snippet; a scanner finding is anchored by the tool itself')
    const a = anchor(readLines(row.file), row.code, row.line)
    if (a) die(`Ground A refused: the snippet is in ${row.file} at line ${a.line}`)
  } else {
    const lines = readLines(row.file); const p = ws(proof)
    const idx = lines ? lines.findIndex((l) => ws(l).includes(p)) : -1
    if (p.length < 3 || idx < 0) die(`Ground B refused: "${proof}" is not a line in ${row.file} - quote it verbatim`)
    line = idx + 1
  }
  Object.assign(row, { status: 'disputed', dispute: { ground, proof, line } })
  row.history.push(`iteration ${currentIteration(run)}: disputed on Ground ${ground}`)
  save(run); console.log(`${row.id} disputed (Ground ${ground})`)
}

function recordCheck(run, name, cmd, exit, scope, source, durationMs, fp) {
  run.checks.push({ name, cmd, exit, scope: scope ?? null, source, durationMs: durationMs ?? null, fingerprint: fp ?? fingerprint(run), at: new Date().toISOString() })
}
function cmdCheck(pos, opt, runIt) {
  const run = load(); const name = pos[1]
  if (!name || !opt.cmd) die(`${runIt ? 'run' : 'check'} needs <name> --cmd "<command>"`)
  if (runIt) {
    const fp = fingerprint(run) // the code the check ran on - if the command edits files, the result is stale at once
    const t = execute(opt.cmd)
    recordCheck(run, name, opt.cmd, t.exit, opt.scope, 'ran', t.durationMs, fp); save(run)
    console.log(`check ${name}: exit ${t.exit} in ${(t.durationMs / 1000).toFixed(1)}s (ran by the runner)`)
  } else {
    if (!/^-?\d+$/.test(opt.exit ?? '')) die('check needs --exit <code> (or use `run` to execute it)')
    recordCheck(run, name, opt.cmd, +opt.exit, opt.scope, 'claimed'); save(run)
    console.log(`check ${name}: exit ${opt.exit} recorded (claimed - prefer \`run\`)`)
  }
}

function cmdSnapshot(opt) {
  const run = load(); const b = run.bundles.find((x) => x.id === opt.bundle)
  if (!b) die(`snapshot needs --bundle <id> (one of: ${run.bundles.map((x) => x.id).join(', ')})`)
  const hash = contentHash(b.files); const iter = currentIteration(run)
  run.snapshots ??= []
  if (!run.snapshots.some((s) => s.bundle === b.id && s.hash === hash)) run.snapshots.push({ bundle: b.id, hash, iteration: iter, at: new Date().toISOString() })
  save(run)
  console.log(hash)
  console.error(`snapshot of bundle ${b.id} (iteration ${iter}). Dispatch its reviewers now, then: add --bundle ${b.id} --snapshot ${hash} --file <reply.json>. Editing these files before the reply is added voids it.`)
}

// Refuse a report that did not scan exactly this code: same merge-base, same commit, same content.
function cmdScan(pos) {
  const run = load(); const path = pos[1]
  if (!path) die('scan needs the path to .scanloop/report.json')
  let rep; try { rep = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { die(`scan: cannot read ${path}: ${e.message}`) }
  if (!rep || typeof rep.tools !== 'object' || !Array.isArray(rep.findings) || typeof rep.verdict !== 'string') die('scan: report needs tools{}, findings[] and verdict')
  if (!/^[0-9a-f]{64}$/.test(String(rep.fingerprint))) die('scan: the report records no content fingerprint (written by a scan.mjs older than kit 1.2) - re-run scanloop')
  const outDir = rep.outDir == null ? null : String(rep.outDir)
  if (outDir !== null && (/^[/\\:]|^\.\.(\/|$)|[*?[\]]/.test(outDir))) die(`scan: report outDir "${outDir}" is not a plain folder inside the repo`)
  const short = (s) => String(s ?? 'none').slice(0, 7)
  if (rep.base?.mergeBase !== run.mergeBase) die(`scan: the report scanned against merge-base ${short(rep.base?.mergeBase)}, this run reviews against ${short(run.mergeBase)} - re-run scanloop with --base ${run.base}`)
  const head = git(['rev-parse', 'HEAD']).trim()
  if (rep.head?.sha !== head) die(`scan: the report scanned commit ${short(rep.head?.sha)}, HEAD is ${short(head)} - re-run scanloop on the current commit`)
  const now = fingerprint(run, outDir)
  if (rep.fingerprint !== now) die(`scan: the code changed after this scan (scanned ${rep.fingerprint.slice(0, 12)}, now ${now.slice(0, 12)}) - re-run scanloop`)
  const scan = { path: norm(path), at: new Date().toISOString(), fingerprint: rep.fingerprint, outDir, head, verdict: rep.verdict, complete: rep.complete !== false,
    required: Array.isArray(rep.required) ? rep.required : [], fullHistory: rep.fullHistory === true, tools: rep.tools }
  run.scans.push(scan)
  const ran = Object.entries(rep.tools).filter(([, t]) => t?.status === 'ran').map(([n]) => n)
  const seen = new Set(); let added = 0; let reopened = 0; let cleared = 0
  for (const f of rep.findings) {
    const ref = fileRef(f.file ?? ''); const key = [f.source, f.rule_id, ref.path].join('|')
    const cands = run.ledger.filter((r) => r.source === 'scan' && r.key === key && !seen.has(r.id))
    let row = cands.sort((a, b) => Math.abs((a.line ?? 0) - (ref.line ?? 0)) - Math.abs((b.line ?? 0) - (ref.line ?? 0)))[0]
    const severity = f.severity in SEV ? f.severity : 'major'
    if (!row) {
      row = { id: `S${run.nextId++}`, source: 'scan', key, tool: f.source, rule_id: f.rule_id, file: ref.path, line: ref.line, endLine: ref.line, anchored: !!ref.line,
        code: null, severity, issue: f.issue ?? '', fixes: f.fix ? [f.fix] : [], triage_hint: f.triage_hint ?? null, status: 'open', raised: currentIteration(run), history: [`scan ${scan.at}: reported by ${f.source}`] }
      run.ledger.push(row); added++
    } else {
      if (row.status === 'resolved') { row.status = 'open'; row.regressed = true; row.history.push(`scan ${scan.at}: still reported by ${f.source}`); reopened++ }
      Object.assign(row, { line: ref.line, endLine: ref.line, severity })
    }
    seen.add(row.id)
  }
  for (const r of run.ledger) if (r.source === 'scan' && r.status === 'open' && ran.includes(r.tool) && !seen.has(r.id)) {
    Object.assign(r, { status: 'resolved', how: `no longer reported by ${r.tool} (scan ${scan.at})` }); r.history.push(r.how); cleared++
  }
  save(run)
  console.log(`scan imported: verdict ${rep.verdict}, tools ${Object.entries(rep.tools).map(([n, t]) => `${n}=${t?.status}`).join(', ')}; ledger +${added} new, ${reopened} reopened, ${cleared} cleared by the rescan`)
}

function cmdAssign(pos, opt) {
  const run = load(); const f = norm(pos[1] ?? ''); const b = run.bundles.find((x) => x.id === opt.bundle)
  if (!f || !b) die('assign needs <file> --bundle <id>')
  if (!unassigned(run).includes(f)) die(`${f} is not an unassigned changed file`)
  b.files.push(f); save(run); console.log(`${f} added to bundle ${b.id} - re-review that bundle`)
}

function cmdEscalate(opt) {
  const run = load(); const to = opt.profile ?? (run.autoProfile.profile === 'thorough' ? 'thorough' : 'standard')
  if (!PROFILES[to] || PROFILES[to].maxIterations <= PROFILES[run.profile].maxIterations) die(`escalate goes up: quick -> standard -> thorough (now ${run.profile})`)
  if (Object.keys(run.iterations[currentIteration(run)]?.replies ?? {}).length) die('merge the open iteration before escalating')
  run.notes.push(`escalated ${run.profile} -> ${to} after iteration ${run.lastMerged}`)
  setProfile(run, to); save(run)
  console.log(`escalated to ${to}: next iteration ${currentIteration(run)} reviews every bundle; budget ${run.budget.maxIterations} iteration(s), ${run.budget.maxDispatches} dispatches`)
}

// ---------- release decision + report ----------
function releaseConditions(run) {
  const fp = fingerprint(run); const conds = []
  const add = (short, text, met, detail) => conds.push({ short, text, met, detail })
  const ex = exitState(run)
  const reviewDetail = [...ex.bundles.filter((b) => !b.clean).map((b) => `bundle ${b.id}: ${b.reasons.join('; ')}`), ...ex.runReasons]
  add('review exit condition', `review exit condition met for every bundle (${run.profile})`, ex.met, reviewDetail.join(' | '))
  const open = run.ledger.filter((r) => r.status === 'open' && SEV[r.severity] >= SEV.major)
  add('open blocking/major findings', 'no open blocking or major findings (reviewer or scanner)', !open.length, open.map((r) => r.id).join(', '))
  const scan = run.scans.at(-1)
  if (!scan) add('scanloop not run', 'scanloop report imported', false, 'no scan imported')
  else {
    const missingReq = scan.required.filter((t) => scan.tools[t]?.status !== 'ran')
    const ok = scan.verdict !== 'INCOMPLETE' && scan.complete && !missingReq.length
    add(`scanloop ${scan.verdict === 'INCOMPLETE' || !scan.complete ? 'INCOMPLETE' : 'required scanner did not run'}`, 'scanloop complete, every required scanner ran', ok,
      `verdict ${scan.verdict}${missingReq.length ? `; required but not run: ${missingReq.join(', ')}` : ''}`)
    const fresh = scan.fingerprint === fingerprint(run, scan.outDir)
    add('scan is stale', 'scanloop ran on the current code', fresh, fresh ? '' : 'code changed after the last scan - re-run scanloop')
  }
  const latest = {}; for (const c of run.checks) latest[c.name] = c
  const required = run.config.requiredChecks ?? [...new Set([...run.providedChecks, ...Object.keys(latest)])]
  for (const name of required) {
    const c = latest[name]
    const met = !!c && c.exit === 0 && c.fingerprint === fp
    const detail = !c ? 'never ran' : c.exit !== 0 ? `exit ${c.exit}` : c.fingerprint !== fp ? 'stale - code changed after it ran' : c.source === 'claimed' ? 'claimed, not run by the runner' : ''
    add(`${name} ${!c ? 'never ran' : c.exit !== 0 ? 'failed' : 'stale'}`, `required check "${name}" passed on the current code`, met, detail)
  }
  if (run.profile === 'thorough') {
    const hist = run.scans.some((s) => Object.entries(s.tools).some(([n, t]) => /gitleaks/i.test(n) && t?.status === 'ran' && (s.fullHistory || /history/i.test(n) || (t.command && !/--log-opts/.test(cmdText(t.command))))))
    add('full-history secret sweep missing', 'full-history gitleaks sweep ran', hist, hist ? '' : 'import a scanloop report whose gitleaks ran without --log-opts')
    const weak = run.ledger.filter((r) => r.source === 'review' && r.status === 'resolved' && SEV[r.severity] >= SEV.major && !(r.test && r.revertedExit))
    add('fix without revert-proof test', 'every blocking/major fix has a test that passes and failed with the fix reverted', !weak.length, weak.map((r) => r.id).join(', '))
  }
  const testRan = !!latest.test && latest.test.exit === 0
  const untested = !required.includes('test') && !testRan
  return { conds, untested, required, latest, fp }
}

function buildReport(run) {
  const S = []
  const sec = (title) => { const s = { title, lines: [] }; S.push(s); return s.lines }
  const { conds, untested, latest, fp } = releaseConditions(run)
  const ex = exitState(run); const bs = budgetState(run)
  // 1. Executed checks
  let L = sec('Executed checks')
  for (const c of Object.values(latest)) L.push(`${c.name}: \`${c.cmd}\` -> exit ${c.exit} (${c.source === 'ran' ? `ran by the runner, ${(c.durationMs / 1000).toFixed(1)}s` : 'claimed, not run by the runner'})${c.scope ? `; scope: ${c.scope}` : ''}${c.fingerprint !== fp ? ' [stale: code changed since]' : ''}`)
  const scan = run.scans.at(-1)
  if (scan) {
    L.push(`scanloop: verdict ${scan.verdict}${scan.complete ? '' : ' (incomplete)'}${scan.fullHistory ? ', full-history secret sweep' : ''} from ${scan.path}${scan.fingerprint !== fingerprint(run, scan.outDir) ? ' [stale: code changed since]' : ''}`)
    for (const [n, t] of Object.entries(scan.tools)) if (['ran', 'error'].includes(t?.status)) L.push(`  ${n} ${t.version ?? '(version unknown)'}: ${t.status}${t.command ? ` - \`${cmdText(t.command)}\`` : ''}`)
  }
  if (!L.length) L.push('none - no test, build, lint or scanner run was recorded')
  // 2. Review findings
  L = sec('Review findings')
  L.push(`profile ${run.profile}; iterations ${bs.itersUsed}/${run.budget.maxIterations}; reviewer dispatches ${bs.dispatchesUsed}/${run.budget.maxDispatches}${run.notes.length ? `; ${run.notes.join('; ')}` : ''}`)
  L.push('lens scores are reviewer confidence (1-5), not proof of correctness:')
  for (const b of ex.bundles) {
    const res = b.last ? run.iterations[b.last].result.bundles[b.id] : null
    L.push(`  bundle ${b.id}: ${res ? `iteration ${b.last} - ${Object.entries(res.scores).map(([l, s]) => `${l} ${s}`).join(', ')}` : 'not reviewed'}; ${b.clean ? 'panel found no blocking or major issues' : b.reasons.join('; ')}`)
  }
  const rows = (pred) => run.ledger.filter(pred)
  const list = (label, rs, fmt = fmtRow) => { L.push(`${label}:${rs.length ? '' : ' none'}`); for (const r of rs) L.push(`  ${fmt(r)}`) }
  list('confirmed and fixed', rows((r) => r.status === 'resolved'), (r) => `${fmtRow(r)} -> ${r.how}${r.test ? `; test \`${r.test.cmd}\` exit ${r.test.exit}` : ''}${r.revertedExit ? `; red with the fix reverted (exit ${r.revertedExit}, claimed)` : ''}`)
  list('unresolved', rows((r) => r.status === 'open' && SEV[r.severity] >= SEV.major))
  list('disputed', rows((r) => r.status === 'disputed'), (r) => `${fmtRow(r)} -> Ground ${r.dispute.ground}: "${r.dispute.proof}"${r.dispute.line ? ` (line ${r.dispute.line})` : ''}${r.reRaised ? `; raised again ${r.reRaised}x after the dispute` : ''}`)
  L.push(`pre-existing (not introduced by this change, never blocks):${run.preExisting.length ? '' : ' none'}`)
  for (const p of run.preExisting) L.push(`  ${p.file}${p.line ? `:${p.line}` : ''} - ${p.issue} (${p.reason})`)
  list('minor', rows((r) => r.status === 'open' && r.severity === 'minor'))
  // 3. Coverage gaps
  L = sec('Coverage gaps')
  const skipped = []; let reviewed = 0; let never = 0
  for (const b of run.bundles) {
    const st = ex.bundles.find((x) => x.id === b.id)
    const reps = st.last ? run.iterations[st.last].replies[b.id] : null
    for (const f of b.files) {
      if (!reps) { never++; continue }
      const sk = Object.entries(reps).filter(([, rep]) => rep.coverage[f] !== 'reviewed').map(([l, rep]) => `${l}: ${String(rep.coverage[f] ?? 'missing').replace(/^skipped:\s*/, '')}`)
      if (sk.length) skipped.push(`${f} (${sk.join('; ')})`); else reviewed++
    }
  }
  const total = run.bundles.reduce((n, b) => n + b.files.length, 0) + run.excluded.length
  L.push(`${total} files changed = ${reviewed} reviewed + ${skipped.length} skipped + ${run.excluded.length} excluded${never ? ` + ${never} never reviewed` : ''}`)
  for (const s of skipped) L.push(`skipped ${s}`)
  for (const e of run.excluded) L.push(`excluded ${e.path}: ${e.reason}`)
  for (const f of unassigned(run)) L.push(`changed after init and in no bundle: ${f}`)
  for (const b of ex.bundles) if (b.reasons.some((r) => r.startsWith('files changed'))) L.push(`bundle ${b.id} changed after its last review`)
  if (!scan) L.push('scanloop never ran: secrets, SAST and dependency CVEs were not checked')
  else for (const [n, t] of Object.entries(scan.tools)) if (!['ran'].includes(t?.status)) L.push(`scanner ${n}: ${t?.status ?? 'unknown'}`)
  const globs = ruleGlobs(); const noRules = {}
  for (const f of run.bundles.flatMap((b) => b.files)) if (!globs.some((re) => re.test(f))) { const e = extname(f) || '(no extension)'; noRules[e] = (noRules[e] ?? 0) + 1 }
  for (const [e, n] of Object.entries(noRules)) L.push(`${e}: ${n} file(s) with no file-rules section - reviewed on the Default rules only`)
  const unanch = rows((r) => r.anchored === false && r.status === 'open')
  if (unanch.length) L.push(`unanchored findings (snippet not found in the file): ${unanch.map((r) => r.id).join(', ')}`)
  if (!latest.test) L.push(`no test command ran${run.providedChecks.includes('test') ? '' : ' (the project provides none)'}`)
  for (const n of run.notes) L.push(n)
  // 4. Release decision
  L = sec('Release decision')
  for (const c of conds) L.push(`[${c.met ? 'met' : 'unmet'}] ${c.text}${c.detail ? ` - ${c.detail}` : ''}`)
  const unmet = conds.filter((c) => !c.met)
  L.push(unmet.length ? `Did not pass: ${unmet.map((c) => c.short).join('; ')}` : `Passed the configured checks${untested ? ` - untested: no test command ran${run.providedChecks.includes('test') ? '' : ' (the project provides none)'}` : ''}`)
  return { sections: S, passed: !unmet.length }
}

function cmdReport(opt) {
  const run = load(); const { sections } = buildReport(run)
  const head = `greploop report - ${run.profile} profile, ${run.base} (${run.mergeBase.slice(0, 7)}) .. ${git(['rev-parse', '--short', 'HEAD']).trim()}`
  const out = [opt.md ? `# ${head}` : head]
  for (const s of sections) {
    out.push('', opt.md ? `## ${s.title}` : `== ${s.title} ==`, '')
    for (const l of s.lines) out.push(opt.md ? (l.startsWith('  ') ? `  - ${l.trim()}` : `- ${l}`) : l)
  }
  console.log(out.join('\n'))
}

function cmdStatus() {
  const run = load(); const ex = exitState(run); const bs = budgetState(run)
  const mins = Math.round((Date.now() - Date.parse(run.createdAt)) / 60000)
  console.log(`${run.profile}: iteration ${bs.itersUsed}/${run.budget.maxIterations} merged, dispatches ${bs.dispatchesUsed}/${run.budget.maxDispatches}, ${mins} min elapsed (estimate ${run.budget.estimate})`)
  for (const b of ex.bundles) console.log(`bundle ${b.id}: ${b.clean ? 'CLEAN - the panel found no blocking or major issues' : `not clean - ${b.reasons.join('; ')}`}`)
  for (const r of ex.runReasons) console.log(`run: ${r}`)
  for (const r of run.ledger.filter((x) => x.status === 'open')) console.log(`open ${fmtRow(r)}`)
  const { conds } = releaseConditions(run)
  const unmet = conds.filter((c) => !c.met)
  console.log(`release: ${unmet.length ? `unmet - ${unmet.map((c) => c.short).join('; ')}` : 'every configured condition met'} (details: report)`)
  if (ex.met) { console.log('exit condition met'); process.exit(0) }
  if (bs.exhausted) {
    console.log(run.profile === 'quick' ? 'budget exhausted - escalate: review.mjs escalate' : `budget exhausted - STOP and report (${run.profile} cap reached)`)
    process.exit(2)
  }
  console.log('exit condition not met - fix, re-review, merge'); process.exit(1)
}

const USAGE = `usage: review.mjs <command>
  init --base <ref> [--profile quick|standard|thorough] [--bundles <file>] [--reset] [--force-size]
  snapshot --bundle <id>   (before dispatching a bundle's reviewers; prints the hash for add)
  add --bundle <id> --snapshot <hash> [--iter <n>] [--file <reply.json>] [--supplement]   (reply on stdin without --file)
  merge <iteration>
  resolve <id> --how "<what changed>" [--test "<cmd>"] [--reverted-exit <n>]
  dispute <id> --ground A|B --proof "<quoted line>"
  run <name> --cmd "<command>" [--scope "<what it covered>"]
  check <name> --cmd "<command>" --exit <code> [--scope "<what it covered>"]
  scan <path/to/.scanloop/report.json>
  assign <file> --bundle <id>
  escalate [--profile standard|thorough]
  status
  report [--md]`

const { pos, opt } = parseArgs(process.argv.slice(2))
const cmd = pos[0]
const MUTATING = new Set(['init', 'snapshot', 'add', 'merge', 'resolve', 'dispute', 'run', 'check', 'scan', 'assign', 'escalate'])
if (MUTATING.has(cmd)) lock()
switch (cmd) {
  case 'init': cmdInit(opt); break
  case 'snapshot': cmdSnapshot(opt); break
  case 'add': cmdAdd(opt); break
  case 'merge': cmdMerge(pos); break
  case 'resolve': cmdResolve(pos, opt); break
  case 'dispute': cmdDispute(pos, opt); break
  case 'run': cmdCheck(pos, opt, true); break
  case 'check': cmdCheck(pos, opt, false); break
  case 'scan': cmdScan(pos); break
  case 'assign': cmdAssign(pos, opt); break
  case 'escalate': cmdEscalate(opt); break
  case 'status': cmdStatus(); break
  case 'report': cmdReport(opt); break
  default: console.log(USAGE); process.exit(cmd ? 1 : 0)
}
