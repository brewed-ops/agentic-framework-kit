import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp } from './helpers.mjs'

test('client.all() still returns every note', async () => {
  const app = await startApp()
  try {
    for (let i = 1; i <= 3; i++) await app.alice.add(`n${i}`)
    assert.equal((await app.alice.all()).length, 3)
  } finally { await app.close() }
})
