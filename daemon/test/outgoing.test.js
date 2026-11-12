import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_UPLOAD_BYTES,
  displayNameFor,
  mediaKindFor,
  mediaMessageFor,
  mimetypeFor,
  prepareUpload,
  MAX_UPLOAD_MB
} from '../lib/outgoing.js'

function tempFile(name, bytes = 16) {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-upload-'))
  const path = join(dir, name)
  writeFileSync(path, Buffer.alloc(bytes, 1))
  return path
}

test('an image goes out as an image', () => {
  assert.equal(mediaKindFor('image/png'), 'image')
  assert.equal(mediaKindFor('image/jpeg'), 'image')
  assert.equal(mediaKindFor('image/webp'), 'image')
})

test('a video goes out as a video', () => {
  assert.equal(mediaKindFor('video/mp4'), 'video')
  assert.equal(mediaKindFor('video/3gpp'), 'video')
})

test('a voice note goes out as a voice note', () => {
  assert.equal(mediaKindFor('audio/ogg; codecs=opus'), 'audio')
  assert.equal(mediaKindFor('audio/mpeg'), 'audio')
})

test('everything else goes out as a document', () => {
  assert.equal(mediaKindFor('application/pdf'), 'document')
  assert.equal(mediaKindFor('text/plain'), 'document')
  assert.equal(mediaKindFor(''), 'document')
  assert.equal(mediaKindFor(undefined), 'document')
})

test('the mime type comes from the extension', () => {
  assert.equal(mimetypeFor('photo.png'), 'image/png')
  assert.equal(mimetypeFor('photo.JPG'), 'image/jpeg')
  assert.equal(mimetypeFor('clip.mp4'), 'video/mp4')
  assert.equal(mimetypeFor('notes.pdf'), 'application/pdf')
  assert.equal(mimetypeFor('sheet.csv'), 'text/csv')
  assert.equal(mimetypeFor('archive.zip'), 'application/zip')
})

test('an unknown extension is a plain document', () => {
  assert.equal(mimetypeFor('mystery.qqq'), 'application/octet-stream')
  assert.equal(mimetypeFor('noextension'), 'application/octet-stream')
  assert.equal(mimetypeFor(''), 'application/octet-stream')
})

test('the name that travels is the file name alone', () => {
  assert.equal(displayNameFor('/home/someone/Pictures/photo.png'), 'photo.png')
  assert.equal(displayNameFor('photo.png'), 'photo.png')
})

test('a name cannot carry a path or control characters away', () => {
  assert.equal(displayNameFor('../../etc/passwd'), 'passwd')
  assert.equal(displayNameFor('weird\u0000name.png'), 'weirdname.png')
  assert.equal(displayNameFor(''), 'file')
})

test('a file that is not there is refused with a clear reason', () => {
  assert.throws(() => prepareUpload('/definitely/not/here.png'), /not found/i)
})

test('a file over the size limit is refused with the limit in the reason', () => {
  const path = tempFile('big.bin', 8)
  // A sparse file: over the limit as a file, almost nothing on the disk.
  truncateSync(path, MAX_UPLOAD_BYTES + 1)
  assert.throws(() => prepareUpload(path), /too large/i)
  // The message says the limit the daemon enforces, not a number of its own.
  assert.throws(() => prepareUpload(path), new RegExp(`${MAX_UPLOAD_MB} MB`))
})

test('a file at the size limit is allowed', () => {
  const path = tempFile('exact.bin', 8)
  truncateSync(path, MAX_UPLOAD_BYTES)
  const upload = prepareUpload(path)
  assert.equal(upload.size, MAX_UPLOAD_BYTES)
  assert.equal(upload.kind, 'document')
})

test('a directory is not a file to send', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-upload-'))
  assert.throws(() => prepareUpload(dir), /not a file/i)
})

test('a prepared upload knows its kind, name, mime type and size', () => {
  const path = tempFile('photo.png', 4)
  const upload = prepareUpload(path)
  assert.equal(upload.path, path)
  assert.equal(upload.kind, 'image')
  assert.equal(upload.mimetype, 'image/png')
  assert.equal(upload.fileName, 'photo.png')
  assert.equal(upload.size, 4)
})

test('the image payload carries the path and the mime type', () => {
  const upload = { path: '/tmp/photo.png', kind: 'image', mimetype: 'image/png', fileName: 'photo.png', size: 10 }
  const message = mediaMessageFor(upload)
  assert.deepEqual(message, { image: { url: '/tmp/photo.png' }, mimetype: 'image/png' })
})

test('the document payload carries the name, which is what WhatsApp shows for a file', () => {
  const upload = { path: '/tmp/notes.pdf', kind: 'document', mimetype: 'application/pdf', fileName: 'notes.pdf', size: 10 }
  const message = mediaMessageFor(upload)
  assert.deepEqual(message, {
    document: { url: '/tmp/notes.pdf' },
    fileName: 'notes.pdf',
    mimetype: 'application/pdf'
  })
})

test('the voice note payload carries the path, the mime type and the name', () => {
  const upload = { path: '/tmp/voice.opus', kind: 'audio', mimetype: 'audio/ogg; codecs=opus', fileName: 'voice.opus', size: 10 }
  const message = mediaMessageFor(upload)
  assert.deepEqual(message, {
    audio: { url: '/tmp/voice.opus' },
    fileName: 'voice.opus',
    mimetype: 'audio/ogg; codecs=opus'
  })
})

test('a recording is marked as a voice note, and a music file is not', () => {
  const upload = { path: '/tmp/voice.opus', kind: 'audio', mimetype: 'audio/ogg; codecs=opus', fileName: 'voice.opus', size: 10 }
  assert.equal('ptt' in mediaMessageFor(upload, '', { ptt: true }), true)
  assert.equal('ptt' in mediaMessageFor(upload, '', { ptt: false }), false)
  assert.equal('ptt' in mediaMessageFor(upload), false)
})

test('the video payload carries the path and the mime type', () => {
  const upload = { path: '/tmp/clip.mp4', kind: 'video', mimetype: 'video/mp4', fileName: 'clip.mp4', size: 10 }
  const message = mediaMessageFor(upload)
  assert.deepEqual(message, { video: { url: '/tmp/clip.mp4' }, mimetype: 'video/mp4' })
})

test('a caption travels with the file when there is one', () => {
  const upload = { path: '/tmp/photo.png', kind: 'image', mimetype: 'image/png', fileName: 'photo.png', size: 10 }
  const message = mediaMessageFor(upload, 'look at this')
  assert.equal(message.caption, 'look at this')
})

test('an empty caption is left out rather than sent as an empty line', () => {
  const upload = { path: '/tmp/photo.png', kind: 'image', mimetype: 'image/png', fileName: 'photo.png', size: 10 }
  assert.equal('caption' in mediaMessageFor(upload, ''), false)
  assert.equal('caption' in mediaMessageFor(upload, '   '), false)
  assert.equal('caption' in mediaMessageFor(upload), false)
})
