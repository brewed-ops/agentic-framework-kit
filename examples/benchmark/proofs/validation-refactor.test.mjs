import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, raw } from './helpers.mjs'

test('notes over 500 characters are still rejected', async () => {
  const app = await startApp()
  try {
    const r = await raw(app.base, 'POST', '/notes', { body: JSON.stringify({ text: 'x'.repeat(501) }) })
    assert.equal(r.status, 400)
  } finally { await app.close() }
})
