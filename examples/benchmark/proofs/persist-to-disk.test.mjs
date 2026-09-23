import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnServer, wait } from './spawn-server.mjs'

test('a failed save does not take the server down', async () => {
  // A path inside a folder that does not exist: every save fails.
  const srv = await spawnServer({ NOTES_FILE: join(tmpdir(), 'no-such-dir-greploop-bench', 'notes.json') })
  try {
    const auth = { authorization: 'Bearer token-alice' }
    await fetch(`${srv.base}/notes`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x' }) }).catch(() => {})
    await wait(300)
    assert.ok(srv.alive(), 'server process died on a failed save')
  } finally { srv.stop() }
})
