import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateHome = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-test-'))
process.env.XDG_STATE_HOME = stateHome
process.env.OMARCHY_WHATSAPP_LOG_LEVEL = 'silent'

const { ensureDirs } = await import('../lib/paths.js')
const { Store } = await import('../lib/store.js')
ensureDirs()

test.after(() => rmSync(stateHome, { recursive: true, force: true }))

function makeStore() {
  const store = new Store()
  test.after(() => {
    if (store._persistTimer) clearTimeout(store._persistTimer)
  })
  return store
}

test('unread total excludes muted and archived chats but includes expired mutes', () => {
  const store = makeStore()

  store.setUnread('active@s.whatsapp.net', 2)

  const muted = store.setUnread('muted@s.whatsapp.net', 4)
  muted.muteEndTime = -1
  muted.muted = true

  const archived = store.setUnread('archived@s.whatsapp.net', 8)
  archived.archived = true

  const expired = store.setUnread('expired@s.whatsapp.net', 16)
  expired.muteEndTime = 1
  expired.muted = true

  assert.equal(store.totalUnread(), 18)
})

test('alias merge preserves an active mute from the secondary chat', () => {
  const store = makeStore()
  const lid = store.chat('123@lid')
  lid.muteEndTime = -1
  lid.muted = true

  store.alias('123@lid', '555@s.whatsapp.net')

  const canonical = store.chat('555@s.whatsapp.net')
  assert.equal(canonical.muteEndTime, -1)
  assert.equal(canonical.muted, true)
})

test('alias merge prefers Always mute over a shorter primary timed mute', () => {
  const store = makeStore()
  const phone = store.chat('555@s.whatsapp.net')
  phone.muteEndTime = Math.floor(Date.now() / 1000) + 60
  phone.muted = true

  const lid = store.chat('123@lid')
  lid.muteEndTime = -1
  lid.muted = true

  store.alias('123@lid', '555@s.whatsapp.net')

  const canonical = store.chat('555@s.whatsapp.net')
  assert.equal(canonical.muteEndTime, -1)
  assert.equal(canonical.muted, true)
})

test('routes a known phone-number chat through its LID alias', () => {
  const store = makeStore()
  store.alias('15550001111@s.whatsapp.net', '123456789012345@lid')

  assert.equal(store.canonicalJid('123456789012345@lid'), '15550001111@s.whatsapp.net')
  assert.equal(store.routingJid('15550001111@s.whatsapp.net'), '123456789012345@lid')
  assert.equal(store.routingJid('123456789012345@lid'), '123456789012345@lid')
})

test('leaves groups and unmapped phone-number chats unchanged', () => {
  const store = makeStore()

  assert.equal(store.routingJid('120363123456789@g.us'), '120363123456789@g.us')
  assert.equal(store.routingJid('5218111111111@s.whatsapp.net'), '5218111111111@s.whatsapp.net')
})

test('returns the original protocol message for a retry', () => {
  const store = makeStore()
  const jid = '123456789012345@lid'
  const content = { extendedTextMessage: { text: 'hello' } }

  store.upsertMessage(jid, {
    id: 'message-1',
    fromMe: true,
    text: 'hello',
    type: 'extendedTextMessage'
  })
  assert.equal(store.rememberRetryMessage(jid, 'message-1', content), true)
  assert.deepEqual(store.retryMessage({ remoteJid: jid, id: 'message-1' }), content)
})

test('persists retry content across daemon restarts', () => {
  const jid = '123456789012345@lid'
  const content = { extendedTextMessage: { text: 'survives restart' } }
  const first = makeStore()
  first.upsertMessage(jid, {
    id: 'persistent-message',
    fromMe: true,
    text: 'survives restart',
    type: 'extendedTextMessage'
  })
  first.chat(jid).lastTs = 1
  first.rememberRetryMessage(jid, 'persistent-message', content)
  first.persist()

  const restored = makeStore()
  restored.load()
  assert.deepEqual(
    restored.retryMessage({ remoteJid: jid, id: 'persistent-message' }),
    content
  )
})

test('reconstructs sent text from snapshots created before retry storage', () => {
  const store = makeStore()
  const jid = '5218111111111@s.whatsapp.net'

  store.upsertMessage(jid, {
    id: 'message-2',
    fromMe: true,
    text: 'older message',
    type: 'extendedTextMessage'
  })

  assert.deepEqual(
    store.retryMessage({ remoteJid: jid, id: 'message-2' }),
    { extendedTextMessage: { text: 'older message' } }
  )
})

test('does not retry incoming or non-text messages without original content', () => {
  const store = makeStore()
  const jid = '5218111111111@s.whatsapp.net'
  store.upsertMessage(jid, {
    id: 'incoming',
    fromMe: false,
    text: 'hello',
    type: 'extendedTextMessage'
  })
  store.upsertMessage(jid, {
    id: 'photo',
    fromMe: true,
    text: 'Photo',
    type: 'imageMessage'
  })

  assert.equal(store.retryMessage({ remoteJid: jid, id: 'incoming' }), undefined)
  assert.equal(store.retryMessage({ remoteJid: jid, id: 'photo' }), undefined)
})
