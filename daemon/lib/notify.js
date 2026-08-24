import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'

// nf-fa-whatsapp. Omarchy's notification service renders this through the
// `omarchy-glyph` hint, matching the bar widget's icon.
const GLYPH = '\uf232'

// Messages arrive in bursts. Holding a chat's notification briefly lets a
// three-message burst land as one toast instead of three stacked ones.
const COALESCE_MS = 1200

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const focusPath = join(pluginRoot, 'bin', 'omarchy-whatsapp-focus')

function hasCommand(name) {
  const dirs = (process.env.PATH || '').split(':').filter(Boolean)
  return dirs.some((dir) => existsSync(join(dir, name)))
}

const useOmarchy = hasCommand('omarchy-notification-send')
const canNotify = useOmarchy || hasCommand('notify-send')
const soundPlayer = ['paplay', 'pw-play', 'canberra-gtk-play'].find((name) => hasCommand(name))
const soundFile = [
  '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga',
  '/usr/share/sounds/freedesktop/stereo/message.oga'
].find((path) => existsSync(path))

// Single-quote for `sh -c`: the shell hint is executed as a command string, so
// a jid is escaped even though jids never legitimately contain a quote.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export class Notifier {
  constructor() {
    this.enabled = canNotify && process.env.OMARCHY_WHATSAPP_NO_NOTIFY !== '1'
    /** @type {Map<string, {title: string, lines: string[], timer: NodeJS.Timeout}>} */
    this.pending = new Map()
    if (!canNotify) logger.warn('notify: no notify-send on PATH, notifications disabled')
  }

  // Called once per incoming message. Preference checks happen at flush so a
  // message that auto-unarchives within the coalesce window can still alert.
  // Pass shouldNotify as a live predicate over store state.
  queue({ jid, title, body, shouldNotify }) {
    if (!this.enabled) return
    const entry = this.pending.get(jid)
    if (entry) {
      entry.title = title
      entry.lines.push(body)
      if (shouldNotify) entry.shouldNotify = shouldNotify
      return
    }
    const fresh = { title, lines: [body], timer: null, shouldNotify }
    fresh.timer = setTimeout(() => this.flush(jid), COALESCE_MS)
    fresh.timer.unref?.()
    this.pending.set(jid, fresh)
  }

  flush(jid) {
    const entry = this.pending.get(jid)
    if (!entry) return
    this.pending.delete(jid)
    clearTimeout(entry.timer)

    if (typeof entry.shouldNotify === 'function' && !entry.shouldNotify()) return

    const body = entry.lines.length > 1
      ? `${entry.lines[entry.lines.length - 1]}\n(+${entry.lines.length - 1} more)`
      : entry.lines[0]
    this.send(entry.title, body, jid)
    this.playSound()
  }

  playSound() {
    if (process.env.OMARCHY_WHATSAPP_NO_SOUND === '1') return
    if (!soundPlayer || !soundFile) return
    const args = soundPlayer === 'canberra-gtk-play' ? ['-f', soundFile] : [soundFile]
    try {
      const child = spawn(soundPlayer, args, { stdio: 'ignore', detached: true })
      child.on('error', (err) => logger.debug({ err }, 'notify: sound failed'))
      child.unref()
    } catch (err) {
      logger.debug({ err }, 'notify: sound threw')
    }
  }

  // Drop everything still buffered — used when the user opens the chat before
  // the coalesce window closes, so reading a chat cancels its pending toast.
  cancel(jid) {
    const entry = this.pending.get(jid)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(jid)
  }

  cancelAll() {
    for (const jid of [...this.pending.keys()]) this.cancel(jid)
  }

  send(title, body, jid) {
    if (!this.enabled) return
    // Clicking the toast opens the bar panel on the originating chat.
    const openCommand = jid
      ? `bash ${shellQuote(focusPath)} ${shellQuote(jid)}`
      : ''
    const args = useOmarchy
      ? [
        '--app-name', 'WhatsApp',
        '-u', 'normal',
        '-g', GLYPH,
        ...(openCommand ? ['--exec', openCommand] : []),
        title,
        body
      ]
      : ['-a', 'WhatsApp', '-u', 'normal', `--hint=string:omarchy-glyph:${GLYPH}`, title, body]

    const command = useOmarchy ? 'omarchy-notification-send' : 'notify-send'
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.on('error', (err) => logger.warn({ err }, 'notify: spawn failed'))
      child.unref()
    } catch (err) {
      logger.warn({ err }, 'notify: spawn threw')
    }
  }
}
