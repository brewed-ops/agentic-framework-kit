// In-memory notes store. Notes belong to one owner.
const MAX_TEXT = 500

export function createStore() {
  const notes = new Map()
  let nextId = 1

  function create(owner, text) {
    if (typeof text !== 'string' || !text.trim()) throw new StoreError(400, 'text is required')
    if (text.length > MAX_TEXT) throw new StoreError(400, `text is longer than ${MAX_TEXT} characters`)
    const note = { id: String(nextId++), owner, text, createdAt: new Date().toISOString() }
    notes.set(note.id, note)
    return note
  }

  // page is 1-based.
  function list(owner, { page = 1, pageSize = 20 } = {}) {
    const mine = [...notes.values()].filter((n) => n.owner === owner)
    const start = (page - 1) * pageSize
    return { items: mine.slice(start, start + pageSize), total: mine.length, page, pageSize }
  }

  function get(id) {
    return notes.get(id) ?? null
  }

  function remove(id) {
    return notes.delete(id)
  }

  return { create, list, get, remove }
}

export class StoreError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
