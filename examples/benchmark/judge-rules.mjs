// Writes results/judgments.json: one verdict per blocking/major finding (and per minor that names
// the seeded bug). Verdicts are the maintainer's, made by reading each finding against the code;
// they are written as rules by file + line here so every call is visible and re-checkable.
// seeded      = the finding describes the planted defect (answer-key.json)
// real        = a true problem that was not planted (checked against the code; see `why`)
// false-alarm = the problem described is not in the code
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'results')

// [case, file-path prefix, first line, verdict, why]. First matching rule wins.
const RULES = [
  ['since-filter', 'src/store.mjs', 19, 'seeded', '>= keeps the note whose id is `since`; proofs/since-filter.test.mjs fails on it'],
  ['since-filter', 'test/notes.test.mjs', 0, 'real', 'the added test uses bob\'s id as the boundary, so it passes with >= and > alike (own tests pass before and after the reference fix)'],
  ['since-filter', 'src/server.mjs', 41, 'real', 'since=abc becomes 0 and returns every note with 200; AGENTS.md says a bad request returns a 4xx (page/pageSize already fall back the same way)'],
  ['delete-endpoint', 'src/server.mjs', 52, 'seeded', 'no owner check before store.remove; proofs/delete-endpoint.test.mjs fails on it'],
  ['delete-endpoint', 'test/notes.test.mjs', 0, 'real', 'only the owner\'s own delete is tested; no cross-user case'],
  ['update-endpoint', 'src/server.mjs', 55, 'seeded', 'JSON.parse and store.update run in the end callback outside try/catch; proofs/update-endpoint.test.mjs shows the process dies'],
  ['update-endpoint', 'src/server.mjs', 56, 'seeded', 'same defect, anchored one line lower'],
  ['update-endpoint', 'src/server.mjs', 57, 'seeded', 'same defect, anchored two lines lower'],
  ['update-endpoint', 'test/notes.test.mjs', 0, 'real', 'only the happy path is tested; no bad-body or cross-user PATCH case'],
  ['list-field-rename', 'src/store.mjs', 20, 'seeded', 'items renamed to notes; proofs/list-field-rename.test.mjs shows client.all() throws'],
  ['list-field-rename', 'src/client.mjs', 21, 'seeded', 'the broken caller of the same defect'],
  ['list-field-rename', 'test/notes.test.mjs', 0, 'real', 'the contract assertions were rewritten to the new field and nothing tests client.all()'],
  ['persist-to-disk', 'src/server.mjs', 45, 'seeded', '201 sent before the unawaited save; the answer key names both halves'],
  ['persist-to-disk', 'src/server.mjs', 46, 'seeded', 'store.save() neither awaited nor caught; proofs/persist-to-disk.test.mjs shows the process dies'],
  ['persist-to-disk', 'src/store.mjs', 38, 'real', 'overlapping writeFile calls on one path: Node documents repeated fsPromises.writeFile without waiting as unsafe'],
  ['persist-to-disk', 'src/store.mjs', 40, 'real', 'same overlapping-write problem, anchored on the writeFile line'],
  ['persist-to-disk', 'src/store.mjs', 10, 'real', 'an empty or corrupt file throws at boot; a non-numeric id makes nextId NaN (Math.max with NaN is NaN)'],
  ['persist-to-disk', 'src/store.mjs', 34, 'real', 'remove() changes memory without a save, so a later delete path would come back after restart (no caller today)'],
  ['persist-to-disk', 'test/notes.test.mjs', 0, 'real', 'the new test calls the store directly; the HTTP save path and a failed save are untested'],
  ['validation-refactor', 'src/store.mjs', 4, 'seeded', 'validateText drops the 500-character check; proofs/validation-refactor.test.mjs fails on it'],
  ['validation-refactor', 'test/notes.test.mjs', 0, 'seeded', 'the too-long assertion was edited out - the second half of the planted defect'],
  ['health-endpoint', 'src/server.mjs', 32, 'real', 'NOT PLANTED: moving new URL() above the auth check turns an unauthenticated `GET //` from 401 into 500 - confirmed with a raw-socket probe on main (401) and change (500)'],
]

const judgments = {}
for (const c of readdirSync(DIR).filter((d) => statSync(join(DIR, d)).isDirectory())) {
  for (const f of readdirSync(join(DIR, c))) {
    const reply = JSON.parse(readFileSync(join(DIR, c, f), 'utf8'))
    reply.findings.forEach((x, i) => {
      const [path, line] = [x.file.split(':')[0], Number(x.file.split(':')[1]?.split('-')[0] ?? 0)]
      const rule = RULES.find(([rc, rp, rl]) => rc === c && path === rp && (rl === 0 || rl === line))
      const serious = x.severity === 'blocking' || x.severity === 'major'
      if (rule && (serious || rule[3] === 'seeded')) judgments[`${c}/${f}#${i}`] = { verdict: rule[3], why: rule[4] }
    })
  }
}
writeFileSync(join(DIR, 'judgments.json'), JSON.stringify(judgments, null, 2) + '\n')
console.log(`${Object.keys(judgments).length} judgments written`)
