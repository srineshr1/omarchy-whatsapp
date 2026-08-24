import assert from 'node:assert/strict'
import test from 'node:test'

import { Store } from '../lib/store.js'

test('unread total excludes muted and archived chats but includes expired mutes', () => {
  const store = new Store()

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
  const store = new Store()
  const lid = store.chat('123@lid')
  lid.muteEndTime = -1
  lid.muted = true

  store.alias('123@lid', '555@s.whatsapp.net')

  const canonical = store.chat('555@s.whatsapp.net')
  assert.equal(canonical.muteEndTime, -1)
  assert.equal(canonical.muted, true)
})

test('alias merge prefers Always mute over a shorter primary timed mute', () => {
  const store = new Store()
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
