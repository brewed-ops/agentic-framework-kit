import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createStore, StoreError } from './store.mjs'

// token -> user. A real app would read these from a database.
const TOKENS = { 'token-alice': 'alice', 'token-bob': 'bob' }

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new StoreError(400, 'body is not valid JSON')) }
    })
    req.on('error', reject)
  })
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function createApp(store = createStore()) {
  return async function handle(req, res) {
    try {
      const user = TOKENS[(req.headers.authorization ?? '').replace(/^Bearer /, '')]
      if (!user) return send(res, 401, { error: 'unauthorized' })

      const url = new URL(req.url, 'http://localhost')
      const idMatch = url.pathname.match(/^\/notes\/([^/]+)$/)

      if (req.method === 'GET' && url.pathname === '/notes') {
        const page = positiveInt(url.searchParams.get('page'), 1)
        const pageSize = positiveInt(url.searchParams.get('pageSize'), 20)
        return send(res, 200, store.list(user, { page, pageSize }))
      }
      if (req.method === 'POST' && url.pathname === '/notes') {
        const body = await readJson(req)
        return send(res, 201, store.create(user, body.text))
      }
      if (req.method === 'GET' && idMatch) {
        const note = store.get(idMatch[1])
        if (!note || note.owner !== user) return send(res, 404, { error: 'not found' })
        return send(res, 200, note)
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      if (err instanceof StoreError) return send(res, err.status, { error: err.message })
      console.error(err)
      return send(res, 500, { error: 'internal error' })
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000)
  createServer(createApp()).listen(port, () => console.log(`notes api on :${port}`))
}
