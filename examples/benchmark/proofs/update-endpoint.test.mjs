import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnServer, wait } from './spawn-server.mjs'

test('a bad PATCH body is a 400 and the server keeps running', async () => {
  const srv = await spawnServer()
  try {
    const auth = { authorization: 'Bearer token-alice' }
    const created = await (await fetch(`${srv.base}/notes`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x' }) })).json()
    const status = await fetch(`${srv.base}/notes/${created.id}`, { method: 'PATCH', headers: auth, body: '{nope' })
      .then((r) => r.status, () => 'connection dropped')
    await wait(200)
    assert.equal(status, 400)
    assert.ok(srv.alive(), 'server process died')
  } finally { srv.stop() }
})
