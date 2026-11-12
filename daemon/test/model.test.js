import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Model.js is a QML library, so node cannot import it as a module. Its
// functions are plain JavaScript, though: the pragma line is what a QML
// library needs and a JavaScript parser does not, so it goes and the rest is
// evaluated as it would be in the shell.
const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, '../../Model.js'), 'utf8').replace(/^\.pragma library\s*$/m, '')
const model = new Function(`${source}\nreturn { formatDuration, filePathFromUrl, restoredAfterFailure, attachmentChatFor, canSendNow, recordingDirectory, daemonStillThere, failureFreesSend }`)()

test('a voice note is written the way a phone writes it', () => {
  assert.equal(model.formatDuration(0), '0:00')
  assert.equal(model.formatDuration(7), '0:07')
  assert.equal(model.formatDuration(12), '0:12')
  assert.equal(model.formatDuration(65), '1:05')
  assert.equal(model.formatDuration(3600), '60:00')
})

test('a length that is not a number is not a length', () => {
  assert.equal(model.formatDuration(undefined), '0:00')
  assert.equal(model.formatDuration(null), '0:00')
  assert.equal(model.formatDuration('abc'), '0:00')
  assert.equal(model.formatDuration(-5), '0:00')
})

test('a file url is the path of the file', () => {
  assert.equal(model.filePathFromUrl('file:///home/user/photo.png'), '/home/user/photo.png')
  assert.equal(model.filePathFromUrl('file:///home/user/my%20photo.png'), '/home/user/my photo.png')
})

test('a name with a stray percent sign is still a name', () => {
  // decodeURIComponent throws on a broken escape sequence, and a file called
  // "100%.png" is a real file, not a broken one.
  assert.equal(model.filePathFromUrl('file:///home/user/100%.png'), '/home/user/100%.png')
  assert.equal(model.filePathFromUrl('file:///home/user/100%2.png'), '/home/user/100%2.png')
})

test('a url that is not a file is not a path', () => {
  assert.equal(model.filePathFromUrl(''), '')
  assert.equal(model.filePathFromUrl('https://example.com/photo.png'), '')
  assert.equal(model.filePathFromUrl(undefined), '')
})

test('a caption comes back when nothing else was typed', () => {
  assert.equal(model.restoredAfterFailure('', 'the caption'), 'the caption')
  // What the user typed is not replaced by the caption that failed.
  assert.equal(model.restoredAfterFailure('new text', 'the caption'), 'new text')
})

test('a file belongs to the conversation it was picked for', () => {
  assert.equal(model.attachmentChatFor('a@s.whatsapp.net', 'a@s.whatsapp.net'), 'a@s.whatsapp.net')
  // The user changed conversation while the file was being copied: the file
  // goes with the conversation it was picked for, or nowhere.
  assert.equal(model.attachmentChatFor('a@s.whatsapp.net', 'b@s.whatsapp.net'), '')
  assert.equal(model.attachmentChatFor('', ''), '')
})

test('a message that is on its way is not sent twice', () => {
  assert.equal(model.canSendNow(null), true)
  assert.equal(model.canSendNow(undefined), true)
  assert.equal(model.canSendNow({ id: 'r1', jid: 'a@s.whatsapp.net' }), false)
})

test('a recording is only written where the user alone can read it', () => {
  // The runtime directory belongs to the user and is wiped at logout.
  assert.equal(model.recordingDirectory('/run/user/1000'), '/run/user/1000')
  // There is no fallback: a private voice recording is not worth writing
  // where every user on the machine can read it.
  assert.equal(model.recordingDirectory(''), '')
  assert.equal(model.recordingDirectory(undefined), '')
})

test('the daemon is still there, or it is not', () => {
  // The daemon is there: the upload is probably still running.
  assert.equal(model.daemonStillThere(true), true)
  // The daemon is gone: the message did not go out.
  assert.equal(model.daemonStillThere(false), false)
})

test('a failure frees the composer only when it is about the message', () => {
  const pending = { id: 'r1', jid: 'a@s.whatsapp.net' }
  assert.equal(model.failureFreesSend('sendMedia', pending, 'r1'), true)
  // A failure about another message says nothing about this one.
  assert.equal(model.failureFreesSend('sendMedia', pending, 'r2'), false)
  // Another command failing says nothing about it either.
  assert.equal(model.failureFreesSend('refresh', pending, 'r1'), false)
  // A failure without an id is about the message that is the only one on its
  // way.
  assert.equal(model.failureFreesSend('sendMedia', pending, ''), true)
  // Nothing on its way, nothing to free.
  assert.equal(model.failureFreesSend('sendMedia', null, 'r1'), false)
})
