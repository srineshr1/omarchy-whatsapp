import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyChatNotificationPreferences,
  isChatMuted,
  mergeMutePreferences,
  muteExpiryDelayMs,
  normalizeMuteEndTime,
  shouldNotifyChat
} from '../lib/preferences.js'

const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = NOW_MS / 1000

test('recognizes WhatsApp Always mutes', () => {
  assert.equal(isChatMuted({ muteEndTime: -1, muted: false }, NOW_MS), true)
  assert.equal(isChatMuted({ muteEndTime: { toNumber: () => -1 } }, NOW_MS), true)
})

test('supports timed mute deadlines in seconds and milliseconds', () => {
  assert.equal(isChatMuted({ muteEndTime: NOW_SECONDS + 60 }, NOW_MS), true)
  assert.equal(isChatMuted({ muteEndTime: NOW_SECONDS - 60 }, NOW_MS), false)
  assert.equal(isChatMuted({ muteEndTime: NOW_MS + 60_000 }, NOW_MS), true)
  assert.equal(isChatMuted({ muteEndTime: NOW_MS - 60_000 }, NOW_MS), false)
})

test('uses legacy muted state only when a snapshot has no deadline', () => {
  assert.equal(isChatMuted({ muted: true }, NOW_MS), true)
  assert.equal(isChatMuted({ muted: true, muteEndTime: null }, NOW_MS), false)
})

test('applies partial archive and mute updates without resetting absent fields', () => {
  const chat = { archived: true, muted: false }

  applyChatNotificationPreferences(chat, { muteEndTime: NOW_MS + 60_000 }, NOW_MS)
  assert.deepEqual(chat, { archived: true, muted: true, muteEndTime: NOW_MS + 60_000 })

  applyChatNotificationPreferences(chat, { archived: false }, NOW_MS)
  assert.equal(chat.archived, false)
  assert.equal(chat.muteEndTime, NOW_MS + 60_000)

  applyChatNotificationPreferences(chat, { muteEndTime: null }, NOW_MS)
  assert.equal(chat.muted, false)
  assert.equal(chat.muteEndTime, null)
})

test('suppresses notifications for either archived or muted chats', () => {
  assert.equal(shouldNotifyChat({ archived: true, muted: false }, NOW_MS), false)
  assert.equal(shouldNotifyChat({ archived: false, muteEndTime: -1 }, NOW_MS), false)
  assert.equal(shouldNotifyChat({ archived: false, muteEndTime: NOW_SECONDS - 1 }, NOW_MS), true)
})

test('normalizes protobuf Long-style mute timestamps', () => {
  assert.equal(normalizeMuteEndTime({ low: -1, high: -1, unsigned: false }), -1)
})

test('muteExpiryDelayMs returns remaining ms for timed mutes only', () => {
  assert.equal(muteExpiryDelayMs({ muteEndTime: -1 }, NOW_MS), null)
  assert.equal(muteExpiryDelayMs({ muted: true }, NOW_MS), null)
  assert.equal(muteExpiryDelayMs({ muteEndTime: NOW_SECONDS + 60 }, NOW_MS), 60_000)
  assert.equal(muteExpiryDelayMs({ muteEndTime: NOW_SECONDS - 60 }, NOW_MS), 0)
})

test('mergeMutePreferences keeps Always over a shorter timed mute', () => {
  const primary = { muteEndTime: NOW_SECONDS + 60, muted: true }
  const secondary = { muteEndTime: -1, muted: true }
  mergeMutePreferences(primary, secondary, NOW_MS)
  assert.equal(primary.muteEndTime, -1)
  assert.equal(primary.muted, true)
})
