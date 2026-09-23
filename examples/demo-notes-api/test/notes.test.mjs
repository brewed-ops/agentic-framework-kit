import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, raw } from './helpers.mjs'

test('a user can add and read back their note', async () => {
  const app = await startApp()
  try {
    const note = await app.alice.add('buy milk')
    assert.equal((await app.alice.get(note.id)).text, 'buy milk')
  } finally { await app.close() }
})

test('another user cannot read the note', async () => {
  const app = await startApp()
  try {
    const note = await app.alice.add('secret')
    const r = await raw(app.base, 'GET', `/notes/${note.id}`, { token: 'token-bob' })
    assert.equal(r.status, 404)
  } finally { await app.close() }
})

test('requests without a token are rejected', async () => {
  const app = await startApp()
  try {
    assert.equal((await raw(app.base, 'GET', '/notes', { token: null })).status, 401)
  } finally { await app.close() }
})

test('empty and too-long notes are rejected', async () => {
  const app = await startApp()
  try {
    assert.equal((await raw(app.base, 'POST', '/notes', { body: JSON.stringify({ text: '' }) })).status, 400)
    assert.equal((await raw(app.base, 'POST', '/notes', { body: JSON.stringify({ text: 'x'.repeat(501) }) })).status, 400)
  } finally { await app.close() }
})

test('invalid JSON is a 400, not a crash', async () => {
  const app = await startApp()
  try {
    assert.equal((await raw(app.base, 'POST', '/notes', { body: '{nope' })).status, 400)
    assert.equal((await raw(app.base, 'GET', '/notes')).status, 200)
  } finally { await app.close() }
})

test('list pages through only the caller\'s notes', async () => {
  const app = await startApp()
  try {
    for (let i = 1; i <= 5; i++) await app.alice.add(`a${i}`)
    await app.bob.add('b1')
    const p1 = (await raw(app.base, 'GET', '/notes?page=1&pageSize=2')).body
    const p3 = (await raw(app.base, 'GET', '/notes?page=3&pageSize=2')).body
    assert.deepEqual(p1.items.map((n) => n.text), ['a1', 'a2'])
    assert.deepEqual(p3.items.map((n) => n.text), ['a5'])
    assert.equal(p1.total, 5)
  } finally { await app.close() }
})
