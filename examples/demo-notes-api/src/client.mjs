// Small client for the notes API. Other tools import this; keep it in step with server.mjs.
export function createClient(baseUrl, token) {
  async function call(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error}`)
    return data
  }

  return {
    add: (text) => call('POST', '/notes', { text }),
    get: (id) => call('GET', `/notes/${encodeURIComponent(id)}`),
    // Returns every note by walking the pages.
    async all() {
      const out = []
      for (let page = 1; ; page++) {
        const { items, total } = await call('GET', `/notes?page=${page}&pageSize=50`)
        out.push(...items)
        if (!items.length || out.length >= total) return out
      }
    },
  }
}
