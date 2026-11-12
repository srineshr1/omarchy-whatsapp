import { createWriteStream, existsSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { downloadContentFromMessage } from 'baileys'
import { mediaDir } from './paths.js'
import { logger } from './logger.js'

const MAX_BYTES = 12 * 1024 * 1024
const MAX_PARALLEL = 2

const EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  // A voice note from WhatsApp is opus in an ogg container.
  'audio/ogg': 'opus',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr'
}

function safeId(id) {
  return String(id || 'media').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

function extFor(mimetype) {
  return EXT[String(mimetype || '').split(';')[0].trim()] || 'jpg'
}

export function mediaPathFor(id, mimetype) {
  return join(mediaDir, `${safeId(id)}.${extFor(mimetype)}`)
}

export function existingMediaPath(message) {
  if (!message?.id || !message.media) return ''
  if (message.imagePath && existsSync(message.imagePath)) return message.imagePath
  const guessed = mediaPathFor(message.id, message.media.mimetype)
  return existsSync(guessed) ? guessed : ''
}

// The message the panel sees.
//
// The cache on disk is the truth about a media: one that finished
// downloading after the message was stored is still found there, so the
// panel gets its path instead of a label. The media itself and the retry
// content are not for the panel.
export function publicMessage(message) {
  if (!message) return message
  const { media: _ignored, retryMessage: _retryMessage, ...rest } = message
  if (!rest.imagePath) rest.imagePath = existingMediaPath(message)
  return rest
}

function toBuffer(value) {
  if (!value) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'base64')
  if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data)
  return null
}

function toWaMessage(message) {
  const media = message.media
  const body = {
    mediaKey: toBuffer(media.mediaKey),
    directPath: media.directPath || undefined,
    url: media.url || undefined,
    mimetype: media.mimetype,
    fileEncSha256: toBuffer(media.fileEncSha256) || undefined,
    fileSha256: toBuffer(media.fileSha256) || undefined,
    fileLength: media.fileLength || undefined
  }
  const node = media.kind === 'sticker'
    ? { stickerMessage: body }
    : (media.kind === 'audio' ? { audioMessage: body } : { imageMessage: body })
  return { key: message.key, message: node }
}

export class MediaCache {
  constructor() {
    this.queue = []
    this.active = 0
    this.inFlight = new Set()
    this.onReady = null
    this.getSocket = () => null
  }

  enqueue(jid, message) {
    if (!message?.id || !message.media) return
    if (message.media.fileLength && message.media.fileLength > MAX_BYTES) return
    const already = existingMediaPath(message)
    if (already) {
      if (message.imagePath !== already) {
        message.imagePath = already
        this.onReady?.(jid, message)
      }
      return
    }
    if (this.inFlight.has(message.id)) return
    this.inFlight.add(message.id)
    this.queue.push({ jid, message })
    this.pump()
  }

  pump() {
    while (this.active < MAX_PARALLEL && this.queue.length) {
      const job = this.queue.shift()
      this.active += 1
      this.download(job).finally(() => {
        this.active -= 1
        this.inFlight.delete(job.message.id)
        this.pump()
      })
    }
  }

  async pull(message) {
    const media = message.media
    const kind = media.kind === 'sticker' ? 'sticker' : (media.kind === 'audio' ? 'audio' : 'image')
    const opts = { options: { timeout: 20000 } }
    const first = {
      mediaKey: toBuffer(media.mediaKey),
      directPath: media.directPath || undefined
    }
    try {
      return await downloadContentFromMessage(first, kind, opts)
    } catch (err) {
      const sock = this.getSocket?.()
      if (!sock?.updateMediaMessage) throw err
      logger.info({ id: message.id }, 'media: refreshing expired link')
      const refreshed = await sock.updateMediaMessage(toWaMessage(message))
      const node = refreshed?.message?.imageMessage
        || refreshed?.message?.stickerMessage
        || refreshed?.message?.audioMessage
      if (node?.directPath) {
        media.directPath = node.directPath
        media.url = node.url || ''
      }
      return downloadContentFromMessage({
        mediaKey: toBuffer(node?.mediaKey || media.mediaKey),
        directPath: node?.directPath || media.directPath,
        url: node?.url
      }, kind, opts)
    }
  }

  async download({ jid, message }) {
    const media = message.media
    const target = mediaPathFor(message.id, media.mimetype)
    const tmp = `${target}.part`
    try {
      const stream = await this.pull(message)
      await pipeline(stream, createWriteStream(tmp, { mode: 0o600 }))
      renameSync(tmp, target)
      message.imagePath = target
      this.onReady?.(jid, message)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* leftover */ }
      logger.warn({ err: String(err?.message || err), id: message.id }, 'media: download failed')
    }
  }
}
