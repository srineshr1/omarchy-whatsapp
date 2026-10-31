import assert from 'node:assert/strict'
import test from 'node:test'

import { reactionDetails } from '../lib/message.js'

test('extracts the target and emoji from a reaction protocol message', () => {
  assert.deepEqual(reactionDetails({ reactionMessage: {
    key: { remoteJid: '555@s.whatsapp.net', id: 'target-1' },
    text: '👍'
  } }), { id: 'target-1', text: '👍' })
})
