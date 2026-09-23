import { createServer } from 'node:http'
import { createApp } from '../src/server.mjs'
import { createClient } from '../src/client.mjs'

// Starts the app on a random port; returns clients for alice and bob plus a close().
export async function startApp() {
  const server = createServer(createApp())
  await new Promise((resolve) => server.listen(0, resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    alice: createClient(base, 'token-alice'),
    bob: createClient(base, 'token-bob'),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function raw(base, method, path, { token = 'token-alice', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  })
  return { status: res.status, body: await res.json() }
}
