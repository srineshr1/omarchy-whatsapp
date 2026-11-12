import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'

// The media that leaves this machine, kept apart from the media that comes in:
// messages-media.js reads what arrives, this file decides what goes out.
//
// Everything here is pure enough to test without WhatsApp: the daemon calls
// prepareUpload() on a path the user picked, and mediaMessageFor() turns that
// into the shape Baileys sends.

// WhatsApp's own cap for a document. A photo is sent as it is, so the same
// limit applies to everything this plugin can send.
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

// The same limit, said the way a person reads it.
export const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.3gp': 'video/3gpp',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.opus': 'audio/ogg; codecs=opus',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheet.sheet'
}

const DEFAULT_MIMETYPE = 'application/octet-stream'

// Which WhatsApp kind a file goes out as. Anything that is not a picture or a
// video is a document: WhatsApp shows those with their own name, which is what
// the user wants for "a file".
export function mediaKindFor(mimetype) {
  const type = String(mimetype || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  // A voice note stays a voice note: WhatsApp plays it in place, and a
  // document would arrive as a file to download.
  if (type.startsWith('audio/')) return 'audio'
  return 'document'
}

// The mime type of a file, from its extension. The name is what the user sees
// on their disk, so this is the only thing that can say what a file is.
export function mimetypeFor(filename) {
  const extension = extname(String(filename || '')).toLowerCase()
  return MIME_TYPES[extension] || DEFAULT_MIMETYPE
}

// The name that travels with the file. Only the last part of the path goes:
// the name is shown on the other end, and a path would say more about this
// machine than the person on the other end needs to know.
export function displayNameFor(filename) {
  const name = basename(String(filename || ''))
  // Control characters would travel inside the name and render as nothing.
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '')
  return cleaned.length > 0 ? cleaned : 'file'
}

// Everything the daemon needs to send one file: where it is, what WhatsApp
// should call it, and what kind of message it becomes.
//
// The size is what the file actually weighs on disk, measured here so that no
// caller can claim a different one.
export function prepareUpload(path) {
  const target = String(path || '')
  if (!target) throw new Error('send-media: no file given')

  let info
  try {
    info = statSync(target)
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(`send-media: file not found: ${target}`)
    throw new Error(`send-media: cannot read ${target}: ${err?.message || err}`)
  }
  // A directory, a device or a pipe is not a file to send, and its size says
  // nothing about what would be uploaded.
  if (!info.isFile()) throw new Error(`send-media: not a file: ${target}`)
  const size = info.size

  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(`send-media: file is too large (${MAX_UPLOAD_MB} MB max): ${target}`)
  }

  const fileName = displayNameFor(target)
  const mimetype = mimetypeFor(fileName)
  return {
    path: target,
    kind: mediaKindFor(mimetype),
    mimetype,
    fileName,
    size
  }
}

// The message Baileys sends for one prepared upload.
//
// The mime type sits at the top level, not inside the media object: Baileys
// reads it from there when it builds the WhatsApp message. The file name does
// too, but only a document carries one: a picture is a picture, and a video
// is a video, while a document arrives as a file with a name of its own.
export function mediaMessageFor(upload, caption, options = {}) {
  const message = {}
  const media = { url: upload.path }

  if (upload.kind === 'image') {
    message.image = media
    message.mimetype = upload.mimetype
  } else if (upload.kind === 'audio') {
    message.audio = media
    message.fileName = upload.fileName
    message.mimetype = upload.mimetype
    // A recording is played in place, the way a voice note is; a music file is
    // not. Only the sender knows which one it is.
    if (options.ptt === true) message.ptt = true
  } else if (upload.kind === 'video') {
    message.video = media
    message.mimetype = upload.mimetype
  } else {
    message.document = media
    message.fileName = upload.fileName
    message.mimetype = upload.mimetype
  }

  const text = String(caption || '').trim()
  if (text) message.caption = text

  return message
}
