import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, raw } from './helpers.mjs'

test('since=<id> excludes the note with that id', async () => {
  const app = await startApp()
  try {
    await app.alice.add('first')   // id 1
    await app.alice.add('second')  // id 2
    const r = await raw(app.base, 'GET', '/notes?since=1')
    assert.deepEqual(r.body.items.map((n) => n.text), ['second'])
  } finally { await app.close() }
})
