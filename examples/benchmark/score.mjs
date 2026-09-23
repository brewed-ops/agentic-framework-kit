// Scores reviewer replies against the answer key. Called by `node bench.mjs score [results-dir]`.
//
// results/<case>/<condition>.json   one reviewer reply (greploop JSON shape), e.g. single.json,
//                                   panel-correctness.json, panel-security.json, panel-quality.json
// results/judgments.json            one verdict per blocking/major finding and per minor that
//                                   names the seeded bug: { "<case>/<reply file>#<index>":
//                                   { "verdict": "seeded" | "real" | "false-alarm", "why": "..." } }
//
// A condition is the reply-file prefix: `single` (one reviewer, all lenses) or `panel` (the
// union of the three lens replies, as greploop merges them). Caught = a blocking or major
// finding judged "seeded". A seeded bug reported only as minor counts as NOT caught: the loop
// does not fix minors.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function score(dir, key) {
  const judgments = JSON.parse(readFileSync(join(dir, 'judgments.json'), 'utf8'))
  const conditions = {}
  const unjudged = []

  for (const name of Object.keys(key)) {
    const caseDir = join(dir, name)
    if (!existsSync(caseDir)) continue
    for (const file of readdirSync(caseDir).filter((f) => f.endsWith('.json')).sort()) {
      const cond = file.split(/[-.]/)[0]
      const c = (conditions[cond] ??= { cases: {}, dispatches: 0 })
      const k = (c.cases[name] ??= { caught: false, minorOnly: false, falseAlarms: new Set(), real: new Set() })
      c.dispatches++
      const reply = JSON.parse(readFileSync(join(caseDir, file), 'utf8'))
      reply.findings.forEach((f, i) => {
        const id = `${name}/${file}#${i}`
        const j = judgments[id]
        const serious = f.severity === 'blocking' || f.severity === 'major'
        if (!j) { if (serious) unjudged.push(id); return }
        if (j.verdict === 'seeded') { if (serious) k.caught = true; else k.minorOnly = true }
        // Deduped by verdict reason, the way greploop's merge collapses the same problem from 3 lenses.
        else if (serious && j.verdict === 'false-alarm') k.falseAlarms.add(j.why)
        else if (serious && j.verdict === 'real') k.real.add(j.why)
      })
    }
  }
  if (unjudged.length) {
    console.error(`unjudged blocking/major findings (add them to judgments.json):\n  ${unjudged.join('\n  ')}`)
    process.exit(1)
  }

  const bugs = Object.keys(key).filter((n) => key[n].kind === 'bug')
  const clean = Object.keys(key).filter((n) => key[n].kind === 'clean')
  console.log('| Condition | Reviewer runs | Seeded bugs caught | Seen only as minor | Missed | Clean changes passed | False alarms | Other real issues (distinct) |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const [cond, c] of Object.entries(conditions)) {
    const got = bugs.filter((n) => c.cases[n]?.caught)
    const minor = bugs.filter((n) => !c.cases[n]?.caught && c.cases[n]?.minorOnly)
    const missed = bugs.filter((n) => c.cases[n] && !c.cases[n].caught)
    const cleanPassed = clean.filter((n) => c.cases[n] && c.cases[n].falseAlarms.size === 0 && c.cases[n].real.size === 0)
    const fa = Object.values(c.cases).reduce((s, k) => s + k.falseAlarms.size, 0)
    const real = Object.values(c.cases).reduce((s, k) => s + k.real.size, 0)
    console.log(`| ${cond} | ${c.dispatches} | ${got.length}/${bugs.length} | ${minor.length} | ${missed.length ? missed.join(', ') : 'none'} | ${cleanPassed.length}/${clean.length} | ${fa} | ${real} |`)
  }
}
