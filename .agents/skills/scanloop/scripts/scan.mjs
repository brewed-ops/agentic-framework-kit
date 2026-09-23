#!/usr/bin/env node
// scanloop runner - runs gitleaks, semgrep and osv-scanner on the current change, applies the
// allowlist, normalizes findings to greploop's shape and writes <out>/report.json.
// Node 18+, no dependencies. Usage:
//   node scan.mjs [--base <ref>] [--out <dir>] [--json] [--full-history]
// Exit: 0 CLEAN, 1 BLOCKING, 2 INCOMPLETE or usage error.
// Tool overrides (for tests or odd installs): SCANLOOP_GITLEAKS / SCANLOOP_SEMGREP / SCANLOOP_OSV
// hold either a JSON array ["exe", "arg", ...] or a single executable path (spaces allowed).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path'

const TOOLS = ['gitleaks', 'semgrep', 'osv-scanner']
const ENV_KEY = { gitleaks: 'SCANLOOP_GITLEAKS', semgrep: 'SCANLOOP_SEMGREP', 'osv-scanner': 'SCANLOOP_OSV' }
const VERSION_ARGS = { gitleaks: ['version'], semgrep: ['--version'], 'osv-scanner': ['--version'] }
const RAW = { gitleaks: 'gitleaks.json', semgrep: 'semgrep.json', 'osv-scanner': 'osv.json' }
const TIMEOUT_MS = 15 * 60 * 1000
const SEV = ['minor', 'major', 'blocking']

// Registry packs are the unpinned default; `semgrepConfigs` in config.json replaces them.
const BASE_PACKS = ['p/security-audit', 'p/secrets', 'p/owasp-top-ten']
const LANG_PACKS = {
  '.js': ['p/javascript'], '.mjs': ['p/javascript'], '.cjs': ['p/javascript'], '.jsx': ['p/javascript', 'p/react'],
  '.ts': ['p/typescript'], '.mts': ['p/typescript'], '.cts': ['p/typescript'], '.tsx': ['p/typescript', 'p/react'],
  '.py': ['p/python'], '.go': ['p/golang'], '.java': ['p/java'], '.kt': ['p/kotlin'], '.rb': ['p/ruby'],
  '.php': ['p/php'], '.cs': ['p/csharp'], '.rs': ['p/rust'], '.c': ['p/c'], '.h': ['p/c'],
}
const langPacksFor = (f) => (/^dockerfile/i.test(basename(f)) ? ['p/dockerfile'] : LANG_PACKS[extname(f).toLowerCase()])
// Lockfiles / manifests osv-scanner can read directly (package.json alone is not one of them).
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock',
  'requirements.txt', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'pdm.lock', 'go.mod', 'Cargo.lock',
  'Gemfile.lock', 'composer.lock', 'pom.xml', 'gradle.lockfile', 'packages.lock.json', 'mix.lock',
  'pubspec.lock', 'renv.lock', 'conan.lock'])
const FP_PATHS = [/(^|\/)[^/]*\.(test|spec)\.[^/]*$/, /(^|\/)__tests__\//, /(^|\/)fixtures\//, /(^|\/)[^/]*\.example[^/]*$/,
  /(^|\/)[^/]*\.sample[^/]*$/, /(^|\/)mocks\//, /(^|\/)vendor\//, /(^|\/)dist\//, /(^|\/)build\//]

// ---------- small helpers ----------
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const gitOk = (args, cwd) => { const r = git(args, cwd); return r.status === 0 ? r.stdout.trim() : null }
const toPosix = (p) => p.replace(/\\/g, '/')
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function usage(msg) {
  console.error(`scanloop: ${msg}\nusage: node scan.mjs [--base <ref>] [--out <dir>] [--json] [--full-history]`)
  process.exit(2)
}

function parseArgs(argv) {
  const o = { base: null, out: '.scanloop', json: false, fullHistory: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--full-history') o.fullHistory = true
    else if (a === '--base' || a === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) usage(`${a} needs a value`)
      o[a.slice(2)] = argv[++i]
    } else if (a === '-h' || a === '--help') usage('help')
    else usage(`unknown argument "${a}"`)
  }
  return o
}

// Find an executable on PATH (Windows: .exe/.com only - .cmd/.bat shims cannot be spawned without a shell).
function which(cmd) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.com'] : ['']
  const isFile = (p) => exts.map((e) => p + e).find((q) => existsSync(q) && !/\.(cmd|bat)$/i.test(q) &&
    (process.platform !== 'win32' || /\.(exe|com)$/i.test(q)))
  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) return isFile(resolve(cmd)) ?? null
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const hit = isFile(join(dir, cmd))
    if (hit) return hit
  }
  return null
}

// Returns [exe, ...prefixArgs] or null when not found.
function resolveTool(tool) {
  const raw = process.env[ENV_KEY[tool]]
  let argv = [tool]
  if (raw && raw.trim()) {
    if (raw.trim().startsWith('[')) {
      try { argv = JSON.parse(raw) } catch { return { error: `${ENV_KEY[tool]} is not a valid JSON array` } }
      if (!Array.isArray(argv) || !argv.length || !argv.every((x) => typeof x === 'string'))
        return { error: `${ENV_KEY[tool]} must be a JSON array of strings` }
    } else argv = [raw.trim()]
  }
  const exe = which(argv[0])
  return exe ? { argv: [exe, ...argv.slice(1)] } : { missing: true }
}

function run(argv, cwd) {
  return new Promise((done) => {
    let out = '', err = ''
    let child
    try { child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true }) } catch (e) { return done({ code: null, spawnError: e.message, out, err }) }
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout.on('data', (d) => { if (out.length < 4e6) out += d })
    child.stderr.on('data', (d) => { if (err.length < 4e6) err += d })
    child.on('error', (e) => { clearTimeout(timer); done({ code: null, spawnError: e.message, out, err }) })
    child.on('close', (code, signal) => { clearTimeout(timer); done({ code, signal, out, err }) })
  })
}

const firstLine = (s) => (s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''

// ---------- allowlist ----------
function unquote(v) {
  v = v.trim()
  if (/^"/.test(v)) { const m = v.match(/^"((?:[^"\\]|\\.)*)"/); return m ? m[1].replace(/\\(.)/g, '$1') : v }
  if (/^'/.test(v)) { const m = v.match(/^'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : v }
  return v.replace(/\s+#.*$/, '').trim()
}

// Parses exactly this shape (no YAML library):
//   suppressions:
//     - tool: semgrep
//       path: "a/b.ts"
//       ...
function parseAllowlistYaml(text) {
  const entries = []
  let cur = null, seenHeader = false
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (/^suppressions:\s*(#.*)?$/.test(line)) { seenHeader = true; continue }
    if (/^suppressions:\s*\[\s*\]\s*$/.test(line)) { seenHeader = true; continue }
    const m = line.match(/^\s*(-\s+)?([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!seenHeader || !m || (!m[1] && (!cur || !/^\s/.test(line)))) throw new Error(`line ${i + 1}: cannot parse "${line.trim()}"`)
    if (m[1]) entries.push((cur = {}))
    cur[m[2]] = unquote(m[3])
  }
  if (!seenHeader && entries.length === 0 && text.trim()) throw new Error('missing "suppressions:" header')
  return entries
}

function loadAllowlist(dir) {
  const entries = [], problems = []
  const yml = join(dir, 'allowlist.yml'), json = join(dir, 'allowlist.json')
  const add = (list, source) => list.forEach((e, i) => entries.push({ ...e, _source: `${source}#${i + 1}` }))
  if (existsSync(yml)) {
    try { add(parseAllowlistYaml(readFileSync(yml, 'utf8')), '.scanloop/allowlist.yml') } catch (e) {
      problems.push({ source: '.scanloop/allowlist.yml', problem: 'invalid', detail: `file not parsed, nothing suppressed: ${e.message}` })
    }
  }
  if (existsSync(json)) {
    try {
      const j = JSON.parse(readFileSync(json, 'utf8'))
      const list = Array.isArray(j) ? j : j.suppressions
      if (!Array.isArray(list)) throw new Error('expected an array or {"suppressions": [...]}')
      add(list, '.scanloop/allowlist.json')
    } catch (e) {
      problems.push({ source: '.scanloop/allowlist.json', problem: 'invalid', detail: `file not parsed, nothing suppressed: ${e.message}` })
    }
  }
  const today = localDate(), active = []
  for (const e of entries) {
    const entry = { tool: e.tool, path: e.path, rule: e.rule, reason: e.reason, expires: e.expires, source: e._source }
    const missing = ['tool', 'path', 'rule', 'reason', 'expires'].filter((k) => typeof e[k] !== 'string' || !e[k].trim())
    const badDate = !missing.includes('expires') && !(/^\d{4}-\d{2}-\d{2}$/.test(e.expires) && !isNaN(Date.parse(e.expires)))
    if (missing.length || badDate || !TOOLS.includes(e.tool)) {
      const why = missing.length ? `missing ${missing.join(', ')}` : badDate ? `expires "${e.expires}" is not YYYY-MM-DD` : `unknown tool "${e.tool}"`
      problems.push({ ...entry, problem: 'invalid', detail: `${why} - not applied; re-triage this finding` })
    } else if (e.expires < today) {
      problems.push({ ...entry, problem: 'expired', detail: `review date ${e.expires} has passed - not applied; re-triage and renew or remove` })
    } else active.push({ ...entry, suppressed: 0, re: globToRegex(toPosix(e.path)) })
  }
  return { active, problems }
}

function globToRegex(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// ---------- normalizers ----------
function demote(f) {
  if (f.source === 'gitleaks') return f
  const hit = FP_PATHS.find((re) => re.test(f.path))
  if (!hit) return f
  const reason = f.path.match(hit)[0].replace(/^\//, '')
  return { ...f, severity: SEV[Math.max(0, SEV.indexOf(f.severity) - 1)], triage_hint: `likely-fp:path matches ${reason}` }
}

function normGitleaks(json) {
  if (!Array.isArray(json)) throw new Error('expected a JSON array')
  const seen = new Set()
  return json.flatMap((l) => {
    const path = toPosix(l.File || ''), key = `${l.RuleID}|${path}|${l.StartLine}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ source: 'gitleaks', rule_id: l.RuleID, severity: 'blocking', path, line: l.StartLine,
      issue: `${l.Description || 'secret detected'}${l.Commit ? ` (commit ${String(l.Commit).slice(0, 8)})` : ''} - value redacted`,
      fix: 'remove the secret from the code, rotate it (it is in git history), load it from env or a secret store' }]
  })
}

function normSemgrep(json) {
  if (!json || !Array.isArray(json.results)) throw new Error('no "results" array')
  const map = { ERROR: 'blocking', CRITICAL: 'blocking', HIGH: 'blocking', WARNING: 'major', MEDIUM: 'major', INFO: 'minor', LOW: 'minor' }
  return json.results.map((r) => {
    const ex = r.extra || {}
    let severity = map[String(ex.severity || '').toUpperCase()] || 'major'
    if (severity === 'blocking' && String(ex.metadata?.confidence || '').toUpperCase() === 'LOW') severity = 'major'
    return { source: 'semgrep', rule_id: r.check_id, severity, path: toPosix(r.path || ''), line: r.start?.line,
      issue: String(ex.message || r.check_id).replace(/\s+/g, ' ').trim().slice(0, 400),
      fix: 'triage: confirm not a false positive, then fix the flagged pattern (or add a reasoned allowlist entry)' }
  })
}

function cvssBucket(score) {
  if (score >= 7) return 'blocking'
  if (score >= 4) return 'major'
  return 'minor'
}
const TEXT_SEV = { CRITICAL: 9, HIGH: 7.5, MODERATE: 5, MEDIUM: 5, LOW: 2 }

function normOsv(json, root) {
  if (!json || (json.results !== undefined && !Array.isArray(json.results))) throw new Error('no "results" array')
  const out = []
  for (const res of json.results || []) {
    let path = toPosix(res.source?.path || '')
    if (isAbsolute(path) || /^[A-Za-z]:\//.test(path)) path = toPosix(relative(root, path))
    for (const pkg of res.packages || []) {
      const p = pkg.package || {}
      const vulns = new Map((pkg.vulnerabilities || []).map((v) => [v.id, v]))
      const groups = pkg.groups?.length ? pkg.groups : [...vulns.keys()].map((id) => ({ ids: [id] }))
      for (const g of groups) {
        const ids = g.ids || []
        const v = vulns.get(ids[0]) || {}
        let score = parseFloat(g.max_severity)
        if (isNaN(score)) score = TEXT_SEV[String(v.database_specific?.severity || '').toUpperCase()] ?? NaN
        let severity = isNaN(score) ? 'major' : cvssBucket(score)
        const dev = (pkg.dependency_groups || pkg.depGroups || []).includes('dev')
        if (dev && severity === 'blocking') severity = 'major'
        out.push({ source: 'osv-scanner', rule_id: ids[0] || 'unknown', severity, path, line: null,
          issue: `${p.name}@${p.version} (${p.ecosystem})${v.summary ? `: ${v.summary}` : ''}${isNaN(score) ? ' [no CVSS score]' : ` [CVSS ${score}]`}${ids.length > 1 ? ` aka ${ids.slice(1).join(', ')}` : ''}${dev ? ' [dev dependency]' : ''}`,
          fix: `upgrade ${p.name} to a fixed version; triage: confirm the vulnerable API is actually imported` })
      }
    }
  }
  return out
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  const root = gitOk(['rev-parse', '--show-toplevel'], process.cwd())
  if (!root) usage('not inside a git repository')
  const outDir = resolve(root, opts.out)
  const cfgDir = join(root, '.scanloop')

  // Delete this run's previous outputs first, so a stale report can never pass for this run's result.
  mkdirSync(outDir, { recursive: true })
  for (const f of ['report.json', 'report.json.tmp', ...Object.values(RAW)]) rmSync(join(outDir, f), { force: true })

  // Config
  let config = {}
  const cfgFile = join(cfgDir, 'config.json')
  if (existsSync(cfgFile)) {
    try { config = JSON.parse(readFileSync(cfgFile, 'utf8')) } catch (e) { usage(`.scanloop/config.json is not valid JSON: ${e.message}`) }
    if (config.required && (!Array.isArray(config.required) || config.required.some((t) => !TOOLS.includes(t))))
      usage(`.scanloop/config.json "required" must be a list of ${TOOLS.join(', ')}`)
    if (config.semgrepConfigs && (!Array.isArray(config.semgrepConfigs) || !config.semgrepConfigs.length))
      usage('.scanloop/config.json "semgrepConfigs" must be a non-empty list')
  }
  const requiredConfigured = config.required || TOOLS

  // Base
  let baseRef = opts.base
  if (!baseRef) {
    const head = gitOk(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)
    const candidates = []
    if (head) candidates.push(head.replace(/^origin\//, ''), head)
    candidates.push('main', 'master', 'develop')
    baseRef = candidates.find((r) => gitOk(['rev-parse', '--verify', '--quiet', `${r}^{commit}`], root))
    if (!baseRef) usage('could not resolve a base branch (no origin/HEAD, main, master or develop) - pass --base <ref>')
  }
  const baseSha = gitOk(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], root)
  if (!baseSha) usage(`base "${baseRef}" is not a commit`)
  const headSha = gitOk(['rev-parse', 'HEAD'], root)
  const mergeBase = gitOk(['merge-base', baseSha, 'HEAD'], root)
  if (!headSha || !mergeBase) usage(`no common history between ${baseRef} and HEAD`)
  if (mergeBase === headSha && !opts.fullHistory)
    usage(`nothing to scan: HEAD has no commits beyond ${baseRef} - commit the change, pass --base <ref>, or use --full-history`)

  const diff = git(['diff', '--name-only', '-z', '--diff-filter=d', `${mergeBase}...HEAD`], root)
  if (diff.status !== 0) usage(`git diff failed: ${diff.stderr.trim()}`)
  const changed = diff.stdout.split('\0').filter(Boolean).map(toPosix)
  const status = gitOk(['status', '--porcelain', '--untracked-files=no'], root) ?? ''
  const dirty = status.length > 0
  const notes = []
  if (dirty) notes.push('working tree has uncommitted changes to tracked files: gitleaks only scans commits, and semgrep runs without --baseline-commit (it aborts on a dirty tree), so pre-existing findings in changed files are included. Commit the change first for a clean diff-only scan.')

  // Scope per tool
  const semgrepFiles = changed.filter((f) => langPacksFor(f) && existsSync(join(root, f)))
  const lockfiles = changed.filter((f) => LOCKFILES.has(basename(f)))
  if (!lockfiles.length && changed.some((f) => basename(f) === 'package.json'))
    notes.push('package.json changed without a lockfile change - osv-scanner needs the lockfile, so dependencies were not checked')
  const semgrepConfigs = config.semgrepConfigs ||
    [...new Set([...BASE_PACKS, ...semgrepFiles.flatMap((f) => langPacksFor(f))])]
  const isRegistry = (c) => /^(p|r|s)\/|^https?:\/\/|^auto$/.test(c)
  const applicable = {
    gitleaks: true,
    semgrep: semgrepFiles.length > 0,
    'osv-scanner': lockfiles.length > 0,
  }
  const required = requiredConfigured.filter((t) => applicable[t])

  const raw = (t) => join(outDir, RAW[t])
  // Commands run from the repo root; keep paths relative there so the report never records a home folder.
  const relOut = toPosix(relative(root, outDir))
  const rawArg = (t) => (relOut && !relOut.startsWith('..') && !isAbsolute(relOut) ? `${relOut}/${RAW[t]}` : raw(t))
  const commands = {
    gitleaks: ['git', '--no-banner', '--redact', '--report-format', 'json', '--report-path', rawArg('gitleaks'),
      ...(opts.fullHistory ? [] : [`--log-opts=${mergeBase}..HEAD`]), '.'],
    semgrep: ['scan', '--metrics=off', '--disable-version-check', ...semgrepConfigs.flatMap((c) => ['--config', c]),
      ...(dirty ? [] : ['--baseline-commit', mergeBase]), '--json', '--output', rawArg('semgrep'), '--', ...semgrepFiles],
    'osv-scanner': ['scan', 'source', ...lockfiles.flatMap((f) => ['-L', f]), ...(config.osvOffline ? ['--offline', '--download-offline-databases'] : []),
      '--format', 'json', '--output-file', rawArg('osv-scanner')],
  }
  const normalize = { gitleaks: normGitleaks, semgrep: normSemgrep, 'osv-scanner': (j) => normOsv(j, root) }

  const tools = {}
  const findingsByTool = {}
  await Promise.all(TOOLS.map(async (t) => {
    const r = { status: null, required: required.includes(t), version: null, command: null, exitCode: null, reason: null, findings: 0 }
    tools[t] = r
    const resolved = resolveTool(t)
    if (resolved.error) { r.status = 'error'; r.reason = resolved.error; return }
    if (resolved.missing) {
      r.status = applicable[t] ? 'missing' : 'not-applicable'
      r.reason = applicable[t] ? `${t} not found on PATH` : `${notApplicableWhy(t)} (${t} is also not installed)`
      return
    }
    const v = await run([...resolved.argv, ...VERSION_ARGS[t]], root)
    r.version = firstLine(v.out) || firstLine(v.err) || null
    if (!applicable[t]) { r.status = 'not-applicable'; r.reason = notApplicableWhy(t); return }
    if (t === 'semgrep') {
      r.configs = semgrepConfigs
      r.pinned = semgrepConfigs.every((c) => !isRegistry(c))
      if (!r.pinned) notes.push('semgrep used registry packs, which change over time - results are not pinned; vendor the rules and set semgrepConfigs to pin them')
      r.baseline = dirty ? null : mergeBase
      const absent = semgrepConfigs.filter((c) => !isRegistry(c) && !existsSync(resolve(root, c)))
      if (absent.length) { r.status = 'error'; r.reason = `semgrep config not found: ${absent.join(', ')}`; return }
    }
    const argv = [...resolved.argv, ...commands[t]]
    // Record absolute executable paths by file name only: a shared report must not carry the home folder.
    r.command = argv.map((a, i) => (i < resolved.argv.length && isAbsolute(a) ? basename(a) : a))
    const started = Date.now()
    const res = await run(argv, root)
    r.durationMs = Date.now() - started
    r.exitCode = res.code
    let tail = firstLine(res.err.split(/\r?\n/).filter((l) => /error|fatal|fail/i.test(l)).join('\n')) || firstLine(res.err)
    // semgrep --json puts fatal errors in the output file, not stderr.
    try { tail = firstLine(JSON.parse(readFileSync(raw(t), 'utf8')).errors?.find((e) => e.level === 'error')?.message) || tail } catch { /* no output */ }
    if (res.spawnError) { r.status = 'error'; r.reason = `could not start: ${res.spawnError}`; return }
    if (res.code === null) { r.status = 'error'; r.reason = `killed (${res.signal || 'timeout'})`; return }
    // osv-scanner exits 128 when the lockfile holds no packages: a real, empty result.
    if (t === 'osv-scanner' && res.code === 128) { r.status = 'ran'; r.reason = 'no packages found in the lockfile'; findingsByTool[t] = []; return }
    if (res.code >= 2) { r.status = 'error'; r.reason = `exit ${res.code}${tail ? `: ${tail.slice(0, 300)}` : ''}`; return }
    let json
    try { json = JSON.parse(readFileSync(raw(t), 'utf8')) } catch (e) {
      r.status = 'error'; r.reason = `no parseable output (${existsSync(raw(t)) ? 'bad JSON' : 'report file absent'})${tail ? `: ${tail.slice(0, 300)}` : ''}`; return
    }
    let list
    try { list = normalize[t](json) } catch (e) { r.status = 'error'; r.reason = `unexpected output shape: ${e.message}`; return }
    if (res.code === 1 && list.length === 0) { r.status = 'error'; r.reason = 'exit 1 but no findings in the output - the tool failed'; return }
    if (t === 'semgrep' && Array.isArray(json.errors) && json.errors.length) {
      r.warnings = json.errors.length
      notes.push(`semgrep reported ${json.errors.length} non-fatal error(s) (e.g. a file it could not parse) - see ${RAW.semgrep}`)
    }
    r.status = 'ran'
    findingsByTool[t] = list
  }))

  function notApplicableWhy(t) {
    if (t === 'semgrep') return 'no changed files in a language semgrep has packs for'
    if (t === 'osv-scanner') return 'no manifest or lockfile changed'
    return 'not applicable'
  }

  // Allowlist, then demotion, then shape
  const { active, problems } = loadAllowlist(cfgDir)
  const findings = []
  let suppressedTotal = 0
  for (const t of TOOLS) {
    for (const f of findingsByTool[t] || []) {
      const hit = active.find((e) => e.tool === f.source && e.rule === f.rule_id && e.re.test(f.path))
      if (hit) { hit.suppressed++; suppressedTotal++; continue }
      const d = demote({ ...f, triage_hint: 'in-scope' })
      findings.push({ source: d.source, rule_id: d.rule_id, severity: d.severity, file: d.line ? `${d.path}:${d.line}` : d.path,
        issue: d.issue, triage_hint: d.triage_hint, fix: d.fix })
      tools[t].findings++
    }
  }
  findings.sort((a, b) => SEV.indexOf(b.severity) - SEV.indexOf(a.severity) || a.file.localeCompare(b.file))
  for (const p of problems) notes.push(`allowlist ${p.problem}: ${p.source}${p.rule ? ` (${p.tool} ${p.rule} on ${p.path})` : ''} - ${p.detail}`)

  const counts = { blocking: 0, major: 0, minor: 0 }
  for (const f of findings) counts[f.severity]++
  const incompleteTools = required.filter((t) => tools[t].status === 'missing' || tools[t].status === 'error')
  const anyRan = TOOLS.some((t) => tools[t].status === 'ran')
  const complete = incompleteTools.length === 0 && anyRan
  const verdict = !complete ? 'INCOMPLETE' : counts.blocking + counts.major > 0 ? 'BLOCKING' : 'CLEAN'
  if (!anyRan) notes.push('SCAN NOT PERFORMED: no scanner ran')

  const report = {
    schema: 1,
    verdict,
    complete,
    startedAt,
    finishedAt: new Date().toISOString(),
    base: { ref: baseRef, sha: baseSha, mergeBase },
    head: { sha: headSha, branch: gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], root) },
    dirty,
    fullHistory: opts.fullHistory,
    changedFiles: changed,
    required,
    requiredConfigured,
    incompleteBecause: incompleteTools.map((t) => `${t}: ${tools[t].status} - ${tools[t].reason}`),
    tools,
    counts,
    findings,
    suppressed: {
      total: suppressedTotal,
      byEntry: active.map(({ re, ...e }) => e),
    },
    allowlistProblems: problems,
    notes,
  }
  const tmp = join(outDir, 'report.json.tmp')
  writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n')
  renameSync(tmp, join(outDir, 'report.json'))

  const log = opts.json ? (s) => process.stderr.write(s + '\n') : (s) => console.log(s)
  log(`scanloop ${verdict} - base ${baseRef} (${mergeBase.slice(0, 8)}) .. HEAD (${headSha.slice(0, 8)}), ${changed.length} changed file(s)`)
  for (const t of TOOLS) {
    const x = tools[t]
    log(`  ${t.padEnd(12)} ${x.status.padEnd(15)}${x.required ? ' required' : '         '}  ${x.version || '-'}${x.reason ? `  (${x.reason})` : ''}`)
  }
  log(`  findings: ${counts.blocking} blocking, ${counts.major} major, ${counts.minor} minor; ${suppressedTotal} suppressed by allowlist`)
  for (const f of findings) log(`  [${f.severity}] ${f.source} ${f.rule_id} ${f.file} - ${f.issue.slice(0, 220)} (${f.triage_hint})`)
  for (const n of notes) log(`  note: ${n}`)
  if (verdict === 'INCOMPLETE') log(`  INCOMPLETE is not clean: ${report.incompleteBecause.join('; ') || 'no scanner ran'}`)
  else if (verdict === 'BLOCKING') log(`  handoff: ${counts.blocking} blocking + ${counts.major} major passed to greploop`)
  else log('  clean - all required scanners ran, no blocking or major findings')
  log(`  report: ${toPosix(relative(root, join(outDir, 'report.json')))}`)
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = verdict === 'CLEAN' ? 0 : verdict === 'BLOCKING' ? 1 : 2
}

main().catch((e) => { console.error(`scanloop: internal error: ${e.stack || e.message}`); process.exit(2) })
