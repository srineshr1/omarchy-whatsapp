import assert from 'node:assert/strict'
import test from 'node:test'

import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractMedia, isPhotoPlaceholder } from '../lib/message.js'

// The media cache of the tests is a temporary directory: the tests do not
// write in the cache of the user.
const mediaHome = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-media-'))
process.env.OMARCHY_WHATSAPP_MEDIA = mediaHome

const { mediaPathFor, publicMessage } = await import('../lib/media.js')

// A voice note is media too: the daemon can fetch it and the panel can play
// it. Until this existed, a voice note was a label and nothing else.

test('a voice note is media the daemon can fetch', () => {
  const media = extractMedia({
    audioMessage: {
      mediaKey: Buffer.from('a-key'),
      directPath: '/direct/path',
      mimetype: 'audio/ogg; codecs=opus',
      fileLength: 1234,
      ptt: true,
      seconds: 7
    }
  })

  assert.equal(media.kind, 'audio')
  assert.equal(media.mimetype, 'audio/ogg; codecs=opus')
  assert.equal(media.ptt, true)
  assert.equal(media.seconds, 7)
  assert.equal(media.fileLength, 1234)
  assert.equal(media.mediaKey, Buffer.from('a-key').toString('base64'))
})

test('a picture is still a picture, and a sticker still a sticker', () => {
  const image = extractMedia({
    imageMessage: {
      mediaKey: Buffer.from('a-key'),
      directPath: '/direct/path',
      mimetype: 'image/jpeg'
    }
  })
  assert.equal(image.kind, 'image')
  assert.equal(image.mimetype, 'image/jpeg')

  const sticker = extractMedia({
    stickerMessage: {
      mediaKey: Buffer.from('a-key'),
      directPath: '/direct/path',
      mimetype: 'image/webp'
    }
  })
  assert.equal(sticker.kind, 'sticker')
})

test('a message with no media is not media', () => {
  assert.equal(extractMedia({ conversation: 'hello' }), null)
  assert.equal(extractMedia({}), null)
  assert.equal(extractMedia(null), null)
})

test('media without a key cannot be fetched', () => {
  assert.equal(extractMedia({ imageMessage: { directPath: '/direct/path' } }), null)
})

test('a voice note is written as an opus file', () => {
  assert.match(mediaPathFor('abc', 'audio/ogg; codecs=opus'), /\.opus$/)
  assert.match(mediaPathFor('abc', 'audio/mpeg'), /\.mp3$/)
  assert.match(mediaPathFor('abc', 'audio/mp4'), /\.m4a$/)
})

test('a voice note is not a photo placeholder', () => {
  assert.equal(isPhotoPlaceholder('Voice message'), false)
})

test('a media that is on disk reaches the panel with its path', () => {
  const id = 'TESTMEDIA0001'
  const path = mediaPathFor(id, 'audio/ogg; codecs=opus')
  writeFileSync(path, Buffer.from('a voice note'))

  try {
    const message = publicMessage({
      id,
      ts: 1,
      type: 'audioMessage',
      media: { kind: 'audio', mimetype: 'audio/ogg; codecs=opus' }
    })

    // The cache on disk is the truth about a media: one that finished
    // downloading after the message was stored is still found there.
    assert.equal(message.imagePath, path)
    // The media itself is not for the panel.
    assert.equal(message.media, undefined)
  } finally {
    unlinkSync(path)
  }
})
