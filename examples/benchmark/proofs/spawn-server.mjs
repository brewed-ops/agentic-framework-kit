// Runs src/server.mjs in a child process, so a crash kills the child and not the test runner.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

async function freePort() {
  const srv = createServer()
  await new Promise((resolve) => srv.listen(0, resolve))
  const { port } = srv.address()
  await new Promise((resolve) => srv.close(resolve))
  return port
}

export async function spawnServer(env = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = false
  child.on('exit', () => { exited = true })
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('notes api')) resolve() })
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)))
  })
  return {
    base: `http://127.0.0.1:${port}`,
    alive: () => !exited,
    stop: () => { if (!exited) child.kill() },
  }
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
