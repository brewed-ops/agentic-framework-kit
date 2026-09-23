import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, raw } from './helpers.mjs'

test('a user cannot delete another user\'s note', async () => {
  const app = await startApp()
  try {
    const note = await app.alice.add('mine')
    const r = await raw(app.base, 'DELETE', `/notes/${note.id}`, { token: 'token-bob' })
    assert.equal(r.status, 404)
    assert.equal((await app.alice.get(note.id)).text, 'mine')
  } finally { await app.close() }
})
