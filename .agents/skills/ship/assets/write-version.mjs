// Writes <outDir>/version.json = {"commit", "builtAt"} so "what is live?" has a factual answer.
// Wire as "postbuild": "node scripts/write-version.mjs"  (outDir defaults to dist).
import { execSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2] ?? 'dist'
if (!existsSync(outDir)) {
  console.error(`write-version: ${outDir}/ does not exist - run it after the build`)
  process.exit(1)
}
const commit = execSync('git rev-parse HEAD').toString().trim()
writeFileSync(join(outDir, 'version.json'), JSON.stringify({ commit, builtAt: new Date().toISOString() }) + '\n')
console.log(`write-version: ${outDir}/version.json -> ${commit.slice(0, 7)}`)
