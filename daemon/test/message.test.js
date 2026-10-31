import assert from 'node:assert/strict'
import test from 'node:test'

import { extractMedia, isMediaPlaceholder, messageText, reactionDetails } from '../lib/message.js'

test('retains the encrypted payload required to download a voice note', () => {
  const media = extractMedia({
    audioMessage: {
      mimetype: 'audio/ogg; codecs=opus',
      mediaKey: Buffer.from('voice-key'),
      directPath: '/v/t62.7118-24/example',
      fileLength: 42,
      seconds: 3,
      ptt: true
    }
  })

  assert.deepEqual(media, {
    kind: 'audio',
    mimetype: 'audio/ogg; codecs=opus',
    mediaKey: Buffer.from('voice-key').toString('base64'),
    directPath: '/v/t62.7118-24/example',
    url: '',
    fileEncSha256: '',
    fileSha256: '',
    fileLength: 42,
    seconds: 3,
    caption: ''
  })
})

test('keeps a video downloadable and carries its inline thumbnail', () => {
  const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const message = {
    videoMessage: {
      mimetype: 'video/mp4',
      mediaKey: Buffer.from('video-key'),
      directPath: '/v/t62.7161-24/example',
      fileLength: 2048,
      seconds: 12,
      jpegThumbnail: thumbnail
    }
  }
  const media = extractMedia(message)

  assert.equal(media.kind, 'video')
  assert.equal(media.mimetype, 'video/mp4')
  assert.equal(media.seconds, 12)
  assert.equal(media.thumbnail, thumbnail.toString('base64'))
  assert.equal(media.ptv, undefined)
  assert.ok(isMediaPlaceholder(messageText(message)))
})

test('treats a round video note as a video', () => {
  const media = extractMedia({
    ptvMessage: { mediaKey: Buffer.from('ptv-key'), directPath: '/v/example' }
  })

  assert.equal(media.kind, 'video')
  assert.equal(media.ptv, true)
  assert.equal(media.mimetype, 'video/mp4')
})

test('extracts the target and emoji from a reaction protocol message', () => {
  assert.deepEqual(reactionDetails({ reactionMessage: {
    key: { remoteJid: '555@s.whatsapp.net', id: 'target-1' },
    text: '👍'
  } }), { id: 'target-1', text: '👍' })
})
