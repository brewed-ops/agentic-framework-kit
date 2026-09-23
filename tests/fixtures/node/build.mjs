// The whole "build": copy the source into dist/. postbuild then stamps dist/version.json.
import { mkdirSync, copyFileSync, rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist')
copyFileSync('sum.mjs', 'dist/sum.mjs')
console.log('build: dist/sum.mjs')
