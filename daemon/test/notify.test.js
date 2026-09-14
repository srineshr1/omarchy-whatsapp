import assert from 'node:assert/strict'
import test from 'node:test'

import { notificationArgs } from '../lib/notify.js'

const TITLE = 'Test sender'
const BODY = 'Test message'
const JID = 'test-chat@g.us'

function execTail(args) {
  const at = args.indexOf('--exec')
  return at === -1 ? [] : args.slice(at)
}

test('omarchy sender gets the headline and description before --exec', () => {
  const args = notificationArgs(TITLE, BODY, JID, true)
  const at = args.indexOf('--exec')

  assert.ok(at > 0, '--exec must be present')
  assert.ok(args.indexOf(TITLE) < at, 'headline must precede --exec')
  assert.ok(args.indexOf(BODY) < at, 'description must precede --exec')
})

test('the click command is separate words, never one quoted string', () => {
  const tail = execTail(notificationArgs(TITLE, BODY, JID, true))

  assert.equal(tail.length, 4)
  assert.equal(tail[1], 'bash')
  assert.match(tail[2], /bin\/omarchy-whatsapp-focus$/)
  assert.equal(tail[3], JID)
})

test('a headline that looks like a flag stays positional', () => {
  const args = notificationArgs('--exec', BODY, JID, true)

  assert.equal(args.lastIndexOf('--exec'), args.length - 4, 'the real delimiter comes last')
  assert.equal(args.at(-5), BODY, 'description keeps its slot')
  assert.equal(args.at(-6), '--exec', 'the headline is still a positional')
})

test('no jid means no click command', () => {
  const args = notificationArgs(TITLE, BODY, '', true)

  assert.equal(args.includes('--exec'), false)
  assert.deepEqual(args.slice(-2), [TITLE, BODY])
})

test('notify-send fallback takes no click command', () => {
  const args = notificationArgs(TITLE, BODY, JID, false)

  assert.equal(args.includes('--exec'), false)
  assert.deepEqual(args.slice(-2), [TITLE, BODY])
})
