import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { downloadContentFromMessage } from 'baileys'
import { mediaDir } from './paths.js'
import { logger } from './logger.js'

const MAX_BYTES = 12 * 1024 * 1024
// Videos are only fetched when the user asks to play one, so they get a
// larger cap than the media that downloads as soon as a chat opens.
const MAX_VIDEO_BYTES = 128 * 1024 * 1024
const MAX_PARALLEL = 2

const EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'video/3gpp': '3gp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm'
}

function safeId(id) {
  return String(id || 'media').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}

function extFor(mimetype) {
  const type = String(mimetype || '').split(';')[0].trim()
  return EXT[type] || (type.startsWith('video/') ? 'mp4' : 'jpg')
}

export function mediaPathFor(id, mimetype) {
  return join(mediaDir, `${safeId(id)}.${extFor(mimetype)}`)
}

// The message field that holds the downloaded file for a media kind.
export function pathField(kind) {
  if (kind === 'audio') return 'audioPath'
  if (kind === 'video') return 'videoPath'
  return 'imagePath'
}

export function existingMediaPath(message) {
  if (!message?.id || !message.media) return ''
  const current = message[pathField(message.media.kind)]
  if (current && existsSync(current)) return current
  const guessed = mediaPathFor(message.id, message.media.mimetype)
  return existsSync(guessed) ? guessed : ''
}

// Video messages carry a small inline JPEG preview. Writing it next to the
// media cache lets the panel show a poster without downloading the video.
export function writeVideoThumbnail(id, base64) {
  if (!id || !base64) return ''
  const target = join(mediaDir, `${safeId(id)}.thumb.jpg`)
  if (existsSync(target)) return target
  try {
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
    writeFileSync(target, Buffer.from(base64, 'base64'), { mode: 0o600 })
    return target
  } catch (err) {
    logger.debug({ err: String(err?.message || err), id }, 'media: thumbnail write failed')
    return ''
  }
}

function waType(media) {
  if (media.kind === 'sticker') return 'stickerMessage'
  if (media.kind === 'audio') return 'audioMessage'
  if (media.kind === 'video') return media.ptv ? 'ptvMessage' : 'videoMessage'
  return 'imageMessage'
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
  return {
    key: message.key,
    message: { [waType(media)]: body }
  }
}

export class MediaCache {
  constructor() {
    this.queue = []
    this.active = 0
    this.inFlight = new Set()
    this.onReady = null
    this.onFailed = null
    this.getSocket = () => null
  }

  // Videos only download when `fetch` is set (the user pressed play); for
  // everything else an already-cached file is picked up either way.
  enqueue(jid, message, { fetch = false } = {}) {
    if (!message?.id || !message.media) return
    const field = pathField(message.media.kind)
    const already = existingMediaPath(message)
    if (already) {
      if (message[field] !== already || fetch) {
        message[field] = already
        this.onReady?.(jid, message)
      }
      return
    }
    const isVideo = message.media.kind === 'video'
    if (isVideo && !fetch) return
    const limit = isVideo ? MAX_VIDEO_BYTES : MAX_BYTES
    if (message.media.fileLength && message.media.fileLength > limit) {
      if (fetch) this.onFailed?.(jid, message, 'too large to download here')
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
    const kind = media.kind === 'sticker' || media.kind === 'audio' || media.kind === 'video'
      ? media.kind
      : 'image'
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
        || refreshed?.message?.videoMessage
        || refreshed?.message?.ptvMessage
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
    let failure = null
    // Logout can remove the cache while an old media request is in flight.
    // Retry one ENOENT after recreating the directory; a second failure is a
    // genuine unavailable/expired attachment and is reported normally.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { unlinkSync(tmp) } catch { /* leftover */ }
      try {
        mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
        const stream = await this.pull(message)
        mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
        await pipeline(stream, createWriteStream(tmp, { mode: 0o600 }))
        mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
        renameSync(tmp, target)
        message[pathField(media.kind)] = target
        this.onReady?.(jid, message)
        return
      } catch (err) {
        failure = err
        if (err?.code !== 'ENOENT') break
      }
    }
    try { unlinkSync(tmp) } catch { /* leftover */ }
    logger.warn({ err: String(failure?.message || failure), id: message.id }, 'media: download failed')
    this.onFailed?.(jid, message, 'download failed')
  }
}
