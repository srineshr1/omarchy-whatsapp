import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  USyncQuery,
  USyncUser
} from 'baileys'
import QRCode from 'qrcode'

import { authDir, ensureDirs, mediaDir, pidFile, qrPngFileFor, qrTxtFile, socketPath, stateDir } from './lib/paths.js'
import { logger, waLogger } from './lib/logger.js'
import { Store, normalizeJid } from './lib/store.js'
import { Notifier } from './lib/notify.js'
import { Bus } from './lib/server.js'
import { extractImage, isGroupJid, isIgnorableChat, isSilent, messageText, messageType, prettyJid } from './lib/message.js'
import { existingMediaPath, MediaCache } from './lib/media.js'

const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 60000
// WhatsApp hands out a batch of ~6 QR refs and then closes the socket with 408.
// That is the normal rhythm of pairing, not a failure, so the next batch is one
// quick reconnect away rather than an exponential backoff.
const PAIRING_RETRY_MS = 1500
// 515 means "handshake done, reconnect now" and arrives right after a successful
// scan. Waiting here would stall the login the user just completed.
const RESTART_RETRY_MS = 250
// Pairing does not run forever. Without this the daemon regenerates a QR every
// 20s for as long as it is enabled, hammering WhatsApp's pairing endpoint for an
// account that may never be linked.
const PAIRING_WINDOW_MS = Math.max(
  15000,
  Number(process.env.OMARCHY_WHATSAPP_PAIRING_WINDOW_MS) || 5 * 60 * 1000
)
const MAX_QR_PER_PAIRING = 32
const PRINT_QR = process.env.OMARCHY_WHATSAPP_PRINT_QR === '1'

// Messages predating this run are backlog, not news: they were already
// notified by the phone, so replaying them as toasts on every daemon start
// would be noise.
const startedAt = Math.floor(Date.now() / 1000)

const store = new Store()
const notifier = new Notifier()
const media = new MediaCache()
const bus = new Bus(socketPath)

let sock = null
let connection = 'idle'
let qrVersion = 0
let hasQr = false
let currentQrPng = ''
// Pairing window bookkeeping, plus the live creds so a 401 can be told apart
// from "this pairing attempt was rejected".
let pairingStartedAt = 0
let qrCount = 0
let pairingStopped = true
let pairingWanted = false
let creds = null
let needsLogin = false
let lastError = ''
let reconnectAttempts = 0
let reconnectTimer = null
let connecting = false
let stopping = false
let connectGen = 0
let chatsFlushTimer = null
let lastStateJson = ''
let resolvingNames = false
const groupNames = new Map()
const wantedChats = new Set()

// Baileys timestamps arrive as number | Long | string depending on where in the
// protocol they came from.
function toTs(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return Math.floor(value)
  if (typeof value === 'string') return Math.floor(Number(value) || 0)
  if (typeof value.toNumber === 'function') return Math.floor(value.toNumber())
  if (typeof value.low === 'number') return Math.floor(value.low)
  return 0
}

function isLinked() {
  return !!(creds?.registered || creds?.me?.id || store.me?.id)
}

function state() {
  return {
    t: 'state',
    connection,
    needsLogin,
    hasQr,
    qrVersion,
    qrPng: hasQr ? currentQrPng : '',
    pairingStopped,
    linked: isLinked(),
    me: store.me,
    unread: store.totalUnread(),
    lastError,
    daemonPid: process.pid
  }
}

function snapshot() {
  return { ...state(), t: 'state', chats: store.chatList(60) }
}

function pushState() {
  const next = state()
  const key = JSON.stringify(next)
  if (key === lastStateJson) return
  lastStateJson = key
  bus.broadcast(next)
}

function pushChats(limit = 60) {
  bus.broadcast({ t: 'chats', chats: store.chatList(limit), unread: store.totalUnread() })
}

function pushChatsSoon() {
  if (chatsFlushTimer) return
  chatsFlushTimer = setTimeout(() => {
    chatsFlushTimer = null
    pushChats()
  }, 300)
  chatsFlushTimer.unref?.()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function senderNameFor(chatJid, message) {
  if (message.key?.fromMe) return store.me?.name || 'You'
  const participant = message.key?.participant || message.participant
  if (isGroupJid(chatJid) && participant) {
    return store.lookupName(participant)
      || store.lookupName(message.key?.participantPn)
      || message.pushName
      || prettyJid(participant)
  }
  return store.lookupName(chatJid) || message.pushName || prettyJid(chatJid)
}

function learnAliasesFromMessage(raw) {
  const key = raw?.key || {}
  if (key.remoteJid && (key.remoteJidAlt || key.senderPn)) {
    store.alias(key.remoteJid, key.remoteJidAlt || key.senderPn)
  }
  if (key.senderLid && key.senderPn) store.alias(key.senderLid, key.senderPn)
  if (key.participant && key.participantPn) store.alias(key.participant, key.participantPn)
  if (key.participantLid && key.participantPn) store.alias(key.participantLid, key.participantPn)
}

// Convert a raw Baileys message into the flat shape the panel renders and the
// store persists.
function publicMessage(message) {
  if (!message) return message
  const { media: _ignored, ...rest } = message
  return rest
}

function flatten(chatJid, message) {
  const ts = toTs(message.messageTimestamp)
  const image = extractImage(message.message)
  const id = message.key?.id || `${ts}-${Math.random().toString(36).slice(2, 8)}`
  const flat = {
    id,
    ts,
    fromMe: !!message.key?.fromMe,
    text: image ? (image.caption || messageText(message.message)) : messageText(message.message),
    type: messageType(message.message),
    senderName: senderNameFor(chatJid, message),
    senderJid: message.key?.participant ? jidNormalizedUser(message.key.participant) : '',
    status: typeof message.status === 'number' ? message.status : 0,
    key: {
      remoteJid: message.key?.remoteJid || chatJid,
      id: message.key?.id || '',
      fromMe: !!message.key?.fromMe,
      participant: message.key?.participant || undefined
    }
  }
  if (image) {
    const { caption, ...payload } = image
    flat.media = payload
    flat.imagePath = existingMediaPath({ id, media: payload, imagePath: '' })
  }
  return flat
}

async function resolveGroupName(jid) {
  if (!isGroupJid(jid) || groupNames.has(jid) || !sock) return
  groupNames.set(jid, true)
  try {
    const metadata = await sock.groupMetadata(jid)
    if (metadata?.subject) {
      store.rememberName(jid, metadata.subject)
      pushChats()
    }
  } catch (err) {
    logger.debug({ err, jid }, 'group metadata lookup failed')
  }
}

function ingest(chatJid, raw, { live }) {
  if (isIgnorableChat(chatJid)) return null
  if (isSilent(raw.message)) return null

  learnAliasesFromMessage(raw)
  const canonicalTarget = store.canonicalJid(chatJid) || chatJid

  const message = flatten(canonicalTarget, raw)
  if (!message.ts) message.ts = Math.floor(Date.now() / 1000)

  const existed = !!store.findMessage(canonicalTarget, message.id)

  store.upsertMessage(canonicalTarget, message)
  const chat = store.touchChat(canonicalTarget, message)

  if (!chat.isGroup && !raw.key?.fromMe && raw.pushName) {
    store.rememberName(canonicalTarget, raw.pushName)
  }

  const participant = raw.key?.participant || raw.participant
  if (chat.isGroup && !raw.key?.fromMe && participant && raw.pushName) {
    store.rememberName(participant, raw.pushName)
  }

  resolveGroupName(canonicalTarget)

  if (message.fromMe) {
    store.setUnread(canonicalTarget, 0)
  } else if (live && !existed) {
    const currentUnread = chat.unread || 0
    const now = Date.now()
    if (currentUnread === 0) {
      store.setUnread(canonicalTarget, 1)
    } else if (currentUnread === 1 && chat.lastUnreadSync && (now - chat.lastUnreadSync < 5000)) {
      // chats.update or metadata sync already set unread to 1 for this incoming message
      store.setUnread(canonicalTarget, 1)
    } else {
      store.bumpUnread(canonicalTarget)
    }
    chat.lastUnreadSync = now

    if (message.ts >= startedAt) {
      const title = chat.isGroup ? (chat.name || 'Group') : (message.senderName || chat.name)
      const body = chat.isGroup ? `${message.senderName}: ${message.text}` : message.text
      notifier.queue({ jid: canonicalTarget, title, body, muted: !!chat.muted })
    }
  }

  const chatKey = normalizeJid(canonicalTarget)
  if (message.media && !message.imagePath && (live || wantedChats.has(chatKey) || wantedChats.has(canonicalTarget))) {
    media.enqueue(canonicalTarget, message)
  }
  return { message, canonicalTarget }
}

function applyChatMetadata(rawChats) {
  let unreadChanged = false
  for (const raw of rawChats || []) {
    const jid = raw?.id
    if (!jid || isIgnorableChat(jid)) continue
    const canonical = store.canonicalJid(jid) || normalizeJid(jid) || jid
    if (raw.pnJid) store.alias(canonical, raw.pnJid)
    if (raw.lidJid) store.alias(canonical, raw.lidJid)
    const chat = store.chat(canonical)
    if (raw.name) store.rememberName(canonical, raw.name)

    if (raw.unreadCount !== undefined && raw.unreadCount !== null) {
      let count = 0
      if (typeof raw.unreadCount === 'number') {
        // In WhatsApp protocol, unreadCount = -1 means "marked as unread" on another device
        count = raw.unreadCount < 0 ? 1 : raw.unreadCount
      }
      if (chat.unread !== count) {
        store.setUnread(canonical, count)
        unreadChanged = true
      }
      chat.lastUnreadSync = Date.now()
    } else if (raw.unread === true || raw.markedUnread === true) {
      if (chat.unread === 0) {
        store.setUnread(canonical, 1)
        unreadChanged = true
      }
      chat.lastUnreadSync = Date.now()
    } else if (raw.unread === false || raw.read === true) {
      if (chat.unread !== 0) {
        store.setUnread(canonical, 0)
        unreadChanged = true
      }
      chat.lastUnreadSync = Date.now()
    }

    if (raw.conversationTimestamp !== undefined) {
      const ts = toTs(raw.conversationTimestamp)
      if (ts > (chat.lastTs || 0)) chat.lastTs = ts
    }
    if (raw.archived !== undefined) chat.archived = !!raw.archived
    if (raw.pinned !== undefined) chat.pinned = !!raw.pinned
    if (raw.muteEndTime !== undefined) {
      const until = toTs(raw.muteEndTime)
      chat.muted = until > Math.floor(Date.now() / 1000)
    }
  }
  store.applyNamesToChats()
  store.markDirty()
  return unreadChanged
}

function asLidJid(value) {
  if (!value) return ''
  const raw = String(value)
  if (raw.includes('@')) return normalizeJid(raw)
  return `${raw}@lid`
}

async function resolveContactLids() {
  if (!sock || connection !== 'open' || resolvingNames) return
  resolvingNames = true
  try {
    const phones = [...store.names.keys()].filter((jid) => jid.endsWith('@s.whatsapp.net'))
    for (let i = 0; i < phones.length; i += 25) {
      if (!sock || connection !== 'open') return
      try {
        const rows = await sock.onWhatsApp(...phones.slice(i, i + 25))
        for (const row of rows || []) {
          if (row?.jid && row?.lid) store.alias(row.jid, asLidJid(row.lid))
        }
      } catch (err) {
        logger.debug({ err }, 'contact lid lookup failed')
        break
      }
    }

    const unknownLids = store.sortedChats()
      .filter((chat) => chat.jid.endsWith('@lid') && !store.lookupName(chat.jid))
      .slice(0, 50)
    if (unknownLids.length) {
      try {
        const query = new USyncQuery().withContactProtocol().withLIDProtocol()
        for (const chat of unknownLids) {
          query.withUser(new USyncUser().withLid(chat.jid).withId(chat.jid))
        }
        const result = await sock.executeUSyncQuery(query)
        for (const row of result?.list || []) {
          const lid = asLidJid(row.lid || (String(row.id || '').endsWith('@lid') ? row.id : ''))
          const pn = String(row.id || '').endsWith('@s.whatsapp.net') ? row.id : ''
          if (lid && pn) store.alias(lid, pn)
        }
      } catch (err) {
        logger.debug({ err }, 'lid usync failed')
      }
    }

    if (store.applyNamesToChats()) {
      logger.info({ names: store.names.size, aliases: store.aliases.size }, 'resolved contact names')
      pushChats()
    }
  } finally {
    resolvingNames = false
  }
}

function applyContacts(contacts) {
  for (const contact of contacts || []) {
    if (!contact?.id && !contact?.lid && !contact?.jid) continue
    const ids = [contact.id, contact.lid, contact.jid].filter(Boolean).map((id) => normalizeJid(id) || id)
    for (let i = 1; i < ids.length; i++) store.alias(ids[0], ids[i])
    const name = contact.name || contact.verifiedName || contact.notify
    if (!name) continue
    for (const id of ids) store.rememberName(id, name)
  }
  store.applyNamesToChats()
}

// Open a pairing window. Every QR the daemon shows is counted against it, so an
// unlinked account cannot keep the pairing endpoint busy indefinitely.
function startPairing(reason) {
  pairingWanted = true
  pairingStopped = false
  pairingStartedAt = Date.now()
  qrCount = 0
  logger.info({ reason }, 'pairing: window open')
}

// Stop refreshing and drop the QR rather than leave an expired code on screen
// pretending to be scannable. Login in the panel or `omarchy-whatsapp login`
// both reopen the window.
function stopPairing() {
  const shown = qrCount
  pairingWanted = false
  pairingStopped = true
  pairingStartedAt = 0
  qrCount = 0
  connectGen += 1
  connecting = false
  cancelReconnect()
  clearQr()
  connection = 'idle'
  needsLogin = true
  logger.info({ qrCount: shown }, 'pairing: no scan within the window, pausing QR refresh')
  pushState()
  destroySocket('pairing paused')
}

async function writeQr(qr) {
  if (pairingStopped) return
  if (pairingStartedAt === 0) startPairing('first qr')

  qrCount += 1
  if (qrCount > MAX_QR_PER_PAIRING || Date.now() - pairingStartedAt > PAIRING_WINDOW_MS) {
    stopPairing()
    return
  }

  const version = qrVersion + 1
  const target = qrPngFileFor(version)
  try {
    await QRCode.toFile(target, qr, { margin: 2, width: 512, color: { dark: '#000000ff', light: '#ffffffff' } })
    // A readable QR is a linkable account, so keep it owner-only even though
    // the state directory is already 0700.
    chmodSync(target, 0o600)
    const terminal = await QRCode.toString(qr, { type: 'terminal', small: true })
    writeFileSync(qrTxtFile, terminal, { mode: 0o600 })
    if (PRINT_QR) process.stdout.write(`\n${terminal}\n`)

    const previous = currentQrPng
    currentQrPng = target
    hasQr = true
    qrVersion = version
    connection = 'qr'
    needsLogin = true
    pushState()
    if (previous && previous !== target) removeFile(previous)
    logger.info('login: scan the QR from the WhatsApp bar panel or run `omarchy-whatsapp login`')
  } catch (err) {
    logger.error({ err }, 'login: could not render QR')
  }
}

function removeFile(path) {
  try {
    unlinkSync(path)
  } catch {
    // Nothing to clear.
  }
}

function clearQr() {
  hasQr = false
  if (currentQrPng) removeFile(currentQrPng)
  currentQrPng = ''
  removeFile(qrTxtFile)
}

function cancelReconnect() {
  if (!reconnectTimer) return
  clearTimeout(reconnectTimer)
  reconnectTimer = null
}

function destroySocket(reason) {
  const old = sock
  sock = null
  if (!old) return
  try {
    old.ev?.removeAllListeners?.()
  } catch {
    // Already gone.
  }
  try {
    old.end(reason ? new Error(reason) : undefined)
  } catch {
    // Already closed.
  }
  try {
    old.ws?.close?.()
  } catch {
    // Already closed.
  }
}

// `delayOverride` covers the disconnects that are part of normal operation
// (QR batch ended, post-pair restart). Those must not consume the backoff
// budget reserved for genuine network trouble.
function scheduleReconnect(delayOverride, options) {
  if (stopping || reconnectTimer || connecting) return
  if (pairingStopped && !isLinked()) return
  const countsAsFailure = !options || options.countsAsFailure !== false
  const delay = delayOverride !== undefined
    ? delayOverride
    : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempts, 5))
  if (countsAsFailure) reconnectAttempts += 1
  logger.info({ delay, reason: options?.reason || 'failure' }, 'connection: reconnecting')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect().catch((err) => {
      logger.error({ err }, 'connection: reconnect failed')
      scheduleReconnect()
    })
  }, delay)
  reconnectTimer.unref?.()
}

async function connect() {
  if (connecting || stopping) return
  if (!isLinked() && !pairingWanted) {
    needsLogin = true
    pairingStopped = true
    connection = 'idle'
    pushState()
    return
  }

  connecting = true
  connectGen += 1
  const gen = connectGen
  lastError = ''
  if (!isLinked()) {
    connection = 'connecting'
    pushState()
  }

  try {
    destroySocket('replaced')
    await sleep(400)
    if (stopping || gen !== connectGen) {
      if (gen === connectGen) connecting = false
      return
    }

    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir)
    creds = authState.creds
    if (!isLinked() && !pairingWanted) {
      needsLogin = true
      pairingStopped = true
      connection = 'idle'
      connecting = false
      pushState()
      return
    }

    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))
    if (stopping || gen !== connectGen) {
      if (gen === connectGen) connecting = false
      return
    }

    sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, waLogger)
      },
      logger: waLogger,
      // The phone keeps pushing its own notifications while this device stays
      // "offline", so the user never loses phone alerts by linking Omarchy.
      markOnlineOnConnect: false,
      browser: Browsers.ubuntu('Omarchy'),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      fireInitQueries: true,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      // Link previews and media thumbnails are never rendered here.
      shouldSyncHistoryMessage: () => true
    })
    const thisSocket = sock

    sock.ev.on('creds.update', (update) => {
      if (sock !== thisSocket) return
      saveCreds(update)
      creds = { ...creds, ...update }
    })

    sock.ev.on('connection.update', (update) => {
      if (sock !== thisSocket) return
      const { connection: next, lastDisconnect, qr } = update
      if (qr) writeQr(qr)

      if (next === 'open') {
        connecting = false
        connection = 'open'
        needsLogin = false
        pairingWanted = false
        pairingStopped = false
        pairingStartedAt = 0
        qrCount = 0
        reconnectAttempts = 0
        lastError = ''
        clearQr()
        const user = thisSocket.user
        store.me = user
          ? { id: jidNormalizedUser(user.id), name: user.name || user.verifiedName || prettyJid(user.id) }
          : store.me
        if (user?.lid && user?.id) store.alias(user.id, user.lid)
        store.markDirty()
        logger.info({ me: store.me?.id }, 'connection: open')
        pushState()
        pushChats()
        setTimeout(() => {
          resolveContactLids().catch((err) => logger.debug({ err }, 'contact resolve failed'))
        }, 1500).unref?.()
        return
      }

      if (next === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        lastError = lastDisconnect?.error?.message || ''
        connecting = false
        if (sock === thisSocket) sock = null

        if (statusCode === DisconnectReason.loggedOut) {
          // 401 means two very different things. If this device was actually
          // paired, the phone unlinked it and the credentials are dead. If it
          // was never paired, the server merely rejected this pairing attempt —
          // wiping there would throw away the chat cache for nothing.
          if (creds?.registered) {
            logger.warn('connection: device unlinked from the phone, clearing credentials')
            wipeAuth()
            creds = null
            needsLogin = true
            pairingWanted = false
            pairingStopped = true
            connection = 'idle'
            clearQr()
            pushState()
            pushChats()
          } else if (pairingWanted && !pairingStopped) {
            logger.warn('connection: pairing attempt rejected, retrying')
            needsLogin = true
            pushState()
            scheduleReconnect(PAIRING_RETRY_MS, { reason: 'pairing rejected', countsAsFailure: false })
          } else {
            needsLogin = true
            connection = 'idle'
            pushState()
          }
          return
        }

        if (pairingStopped && !isLinked()) {
          // Stay 'idle' rather than 'close': nothing is retrying, so reporting a
          // closed connection would read as a fault instead of a paused pairing.
          connection = 'idle'
          pushState()
          return
        }

        // Both of these are routine, not faults.
        if (statusCode === DisconnectReason.restartRequired) {
          logger.info('connection: restart required, reconnecting immediately')
          scheduleReconnect(RESTART_RETRY_MS, { reason: 'restart required', countsAsFailure: false })
          return
        }

        if (needsLogin && pairingWanted && statusCode === DisconnectReason.timedOut) {
          // Baileys uses 408 for both "QR refs ended" and "connection lost";
          // while unlinked and mid-pairing it is always the former.
          logger.info('connection: QR batch ended, requesting a fresh one')
          scheduleReconnect(PAIRING_RETRY_MS, { reason: 'qr batch ended', countsAsFailure: false })
          return
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          logger.warn('connection: session replaced, waiting before retry')
          scheduleReconnect(8000, { reason: 'session replaced' })
          return
        }

        logger.warn({ statusCode, lastError }, 'connection: closed')
        scheduleReconnect()
      }
    })

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
      if (sock !== thisSocket) return
      applyContacts(contacts)
      applyChatMetadata(chats)
      for (const raw of messages || []) {
        const jid = raw?.key?.remoteJid
        if (jid) ingest(jid, raw, { live: false })
      }
      logger.info({ chats: chats?.length || 0, messages: messages?.length || 0, isLatest }, 'history sync')
      for (const [jid, list] of store.messages) {
        if (!wantedChats.has(jid) && !wantedChats.has(normalizeJid(jid))) continue
        for (const message of list) {
          if (message.media && !existingMediaPath(message)) media.enqueue(jid, message)
        }
      }
      pushChatsSoon()
    })

    sock.ev.on('chats.upsert', (chats) => {
      if (sock !== thisSocket) return
      applyChatMetadata(chats)
      pushChatsSoon()
    })

    sock.ev.on('chats.update', (updates) => {
      if (sock !== thisSocket) return
      const before = store.totalUnread()
      const unreadChanged = applyChatMetadata(updates)
      pushChatsSoon()
      if (unreadChanged || store.totalUnread() !== before) pushState()
    })

    sock.ev.on('chats.delete', (jids) => {
      if (sock !== thisSocket) return
      for (const jid of jids || []) {
        store.chats.delete(jid)
        store.messages.delete(jid)
      }
      store.markDirty()
      pushChatsSoon()
    })

    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      if (sock !== thisSocket) return
      if (lid && jid) {
        store.alias(lid, jid)
        store.applyNamesToChats()
        pushChatsSoon()
      }
    })

    sock.ev.on('contacts.upsert', (contacts) => {
      if (sock !== thisSocket) return
      applyContacts(contacts)
      pushChatsSoon()
    })

    sock.ev.on('contacts.update', (contacts) => {
      if (sock !== thisSocket) return
      applyContacts(contacts)
      pushChatsSoon()
    })

    sock.ev.on('groups.update', (updates) => {
      if (sock !== thisSocket) return
      for (const update of updates || []) {
        if (update?.id && update.subject) store.rememberName(update.id, update.subject)
      }
      pushChatsSoon()
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (sock !== thisSocket) return
      const live = type === 'notify'
      const before = store.totalUnread()
      for (const raw of messages || []) {
        const jid = raw?.key?.remoteJid
        if (!jid) continue
        const result = ingest(jid, raw, { live })
        if (!result) continue
        const { message, canonicalTarget } = result
        const existed = !!store.findMessage(canonicalTarget, raw?.key?.id)
        if (!live && existed) continue
        if (!live) continue
        bus.broadcast({
          t: 'message',
          jid: canonicalTarget,
          message: publicMessage(message),
          chat: store.chat(canonicalTarget),
          unread: store.totalUnread()
        })
      }
      const unreadChanged = store.totalUnread() !== before
      pushChatsSoon()
      if (unreadChanged) pushState()
    })

    sock.ev.on('messages.update', (updates) => {
      if (sock !== thisSocket) return
      const before = store.totalUnread()
      let unreadCleared = false
      for (const update of updates || []) {
        const jid = update?.key?.remoteJid || update?.remoteJid
        if (!jid) continue
        const canonical = store.canonicalJid(jid) || normalizeJid(jid) || jid

        const u = update.update || update
        if (u.readTimestamp || u.status === 3 || u.status === 4 || u.type === 'read-self') {
          store.setUnread(canonical, 0)
          unreadCleared = true
        }

        const id = update?.key?.id || update?.id
        if (!id) continue
        const found = store.findMessage(canonical, id)
        if (!found) continue
        const status = typeof u.status === 'number' ? u.status : (u.readTimestamp ? 4 : 0)
        if (!status || status < (found.status || 0)) continue
        found.status = status
        store.markDirty()
        bus.broadcast({ t: 'messageStatus', jid: found.key?.remoteJid || canonical, id, status })
      }
      if (unreadCleared || store.totalUnread() !== before) {
        pushChatsSoon()
        pushState()
      }
    })

    sock.ev.on('message-receipt.update', (updates) => {
      if (sock !== thisSocket) return
      const before = store.totalUnread()
      let unreadCleared = false
      for (const update of updates || []) {
        const jid = update?.key?.remoteJid
        if (!jid) continue
        const canonical = store.canonicalJid(jid) || normalizeJid(jid) || jid

        const receipt = update.receipt || {}
        const receiptType = receipt.receiptType || receipt.type
        const isReadReceipt = receipt.readTimestamp || receiptType === 'read' || receiptType === 'read-self'

        if (isReadReceipt) {
          store.setUnread(canonical, 0)
          unreadCleared = true
        }

        const id = update?.key?.id
        if (!id) continue
        const found = store.findMessage(canonical, id)
        if (!found) continue
        const next = receipt.readTimestamp ? 4 : (receipt.receiptTimestamp ? 3 : 0)
        if (!next || next < (found.status || 0)) continue
        found.status = next
        store.markDirty()
        bus.broadcast({ t: 'messageStatus', jid: found.key?.remoteJid || canonical, id, status: next })
      }
      if (unreadCleared || store.totalUnread() !== before) {
        pushChatsSoon()
        pushState()
      }
    })
  } catch (err) {
    if (gen !== connectGen) return
    connecting = false
    lastError = String(err?.message || err)
    logger.error({ err }, 'connection: setup failed')
    pushState()
    scheduleReconnect()
  }
}

function wipeAuth() {
  try {
    rmSync(authDir, { recursive: true, force: true })
  } catch (err) {
    logger.warn({ err }, 'auth: wipe failed')
  }
  ensureDirs()
  store.clear()
  groupNames.clear()
  try {
    rmSync(mediaDir, { recursive: true, force: true })
  } catch {
    // Cache may already be gone.
  }
}

// Mark a chat read on this device and across the account, then drop any toast
// still waiting in the coalesce window.
async function markRead(jid) {
  notifier.cancel(jid)
  store.setUnread(jid, 0)
  pushChats()
  pushState()
  if (!sock || connection !== 'open' || connecting) return

  const list = store.messages.get(jid) || []
  const unreadKeys = list.filter((m) => !m.fromMe).slice(-20).map((m) => m.key).filter((k) => k?.id)
  if (unreadKeys.length) {
    try {
      await sock.readMessages(unreadKeys)
    } catch (err) {
      logger.debug({ err, jid }, 'read receipts failed')
    }
  }

  const newest = list[list.length - 1]
  if (newest?.key?.id) {
    try {
      await sock.chatModify(
        { markRead: true, lastMessages: [{ key: newest.key, messageTimestamp: newest.ts }] },
        jid
      )
    } catch (err) {
      logger.debug({ err, jid }, 'chatModify markRead failed')
    }
  }
}

async function refreshMissingImages(jid, list) {
  if (!sock || connection !== 'open') return
  if (typeof sock.requestPlaceholderResend !== 'function') return
  const missing = list.filter((message) => (
    (message.type === 'imageMessage' || message.type === 'stickerMessage')
    && !message.media
    && message.key?.id
  ))
  for (const message of missing.slice(-12)) {
    try {
      await sock.requestPlaceholderResend(message.key)
    } catch (err) {
      logger.debug({ err, id: message.id }, 'media: placeholder resend failed')
    }
  }
}

async function handleCommand(payload, reply) {
  const { t, id } = payload
  switch (t) {
    case 'hello':
      reply(snapshot())
      return

    case 'ping':
      reply({ t: 'pong', id })
      return

    case 'chats':
      reply({ t: 'chats', chats: store.chatList(payload.limit || 60), unread: store.totalUnread() })
      return

    case 'messages':
      if (!payload.jid) throw new Error('messages: jid required')
      {
        const canonical = store.canonicalJid(payload.jid) || payload.jid
        const list = store.messageList(canonical, payload.limit || 60)
        wantedChats.add(canonical)
        wantedChats.add(normalizeJid(payload.jid))
        reply({
          t: 'messages',
          jid: payload.jid,
          chat: store.chat(canonical),
          messages: list.map(publicMessage)
        })
        for (const message of list) {
          if (message.media && !existingMediaPath(message)) media.enqueue(canonical, message)
        }
        refreshMissingImages(canonical, list).catch((err) => {
          logger.debug({ err, jid: canonical }, 'media: history refresh failed')
        })
      }
      return

    case 'send': {
      const rawJid = payload.jid
      const text = String(payload.text || '')
      if (!rawJid) throw new Error('send: jid required')
      if (!text.trim()) throw new Error('send: empty message')
      if (!sock || connection !== 'open') throw new Error('send: not connected to WhatsApp')

      const canonical = store.canonicalJid(rawJid) || rawJid
      const options = {}
      if (payload.quoted) {
        const list = store.messages.get(canonical) || []
        const quoted = list.find((m) => m.id === payload.quoted)
        if (quoted?.key) options.quoted = { key: quoted.key, message: { conversation: quoted.text } }
      }

      const sent = await sock.sendMessage(rawJid, { text }, options)
      if (sent) {
        const res = ingest(rawJid, sent, { live: false })
        if (res) {
          const { message, canonicalTarget } = res
          bus.broadcast({ t: 'message', jid: rawJid, message: publicMessage(message), chat: store.chat(canonicalTarget), unread: store.totalUnread() })
          pushChats()
        }
      }
      reply({ t: 'ack', id, ok: true, jid: rawJid })
      return
    }

    case 'read':
      if (!payload.jid) throw new Error('read: jid required')
      await markRead(payload.jid)
      reply({ t: 'ack', id, ok: true, jid: payload.jid })
      return

    case 'typing': {
      if (!payload.jid || !sock || connection !== 'open') {
        reply({ t: 'ack', id, ok: false })
        return
      }
      const presence = payload.state === 'paused' ? 'paused' : 'composing'
      try {
        await sock.sendPresenceUpdate(presence, payload.jid)
      } catch (err) {
        logger.debug({ err }, 'presence update failed')
      }
      reply({ t: 'ack', id, ok: true })
      return
    }

    // Notification clicks land here: the daemon is already the fan-out point to
    // every bar panel, so it tells them which chat to open.
    case 'focus':
      if (!payload.jid) throw new Error('focus: jid required')
      bus.broadcast({ t: 'focus', jid: payload.jid })
      reply({ t: 'ack', id, ok: true, jid: payload.jid })
      return

    case 'pair': {
      const phone = String(payload.phone || '').replace(/[^\d]/g, '')
      if (!phone) throw new Error('pair: phone number required')
      if (!sock) throw new Error('pair: socket not ready')
      const code = await sock.requestPairingCode(phone)
      reply({ t: 'pairCode', id, code })
      return
    }

    case 'login':
      if (isLinked() && connection === 'open') {
        reply({ t: 'ack', id, ok: true, already: true })
        return
      }
      reconnectAttempts = 0
      cancelReconnect()
      startPairing('user login')
      connecting = false
      await connect()
      reply({ t: 'ack', id, ok: true })
      return

    case 'reconnect':
      reconnectAttempts = 0
      cancelReconnect()
      if (!isLinked()) startPairing('manual reconnect')
      connecting = false
      await connect()
      reply({ t: 'ack', id, ok: true })
      return

    case 'logout':
      try {
        await sock?.logout()
      } catch (err) {
        logger.debug({ err }, 'logout call failed, clearing local state anyway')
      }
      cancelReconnect()
      destroySocket('logout')
      wipeAuth()
      creds = null
      needsLogin = true
      pairingWanted = false
      pairingStopped = true
      connection = 'idle'
      connecting = false
      clearQr()
      pushState()
      pushChats()
      reply({ t: 'ack', id, ok: true })
      return

    default:
      reply({ t: 'error', for: String(t || ''), id, message: `unknown command: ${t}` })
  }
}

function shutdown(signal) {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'shutting down')
  cancelReconnect()
  notifier.cancelAll()
  store.persist()
  bus.close()
  destroySocket('shutdown')
  setTimeout(() => process.exit(0), 200).unref?.()
}

// A killed daemon leaves versioned QR images behind. They are useless to the
// next run and each one can link the account, so clear them at startup.
function purgeStaleQrFiles() {
  try {
    for (const name of readdirSync(stateDir)) {
      if (/^qr\.\d+\.png$/.test(name)) removeFile(join(stateDir, name))
    }
  } catch (err) {
    logger.debug({ err }, 'startup: could not purge stale QR files')
  }
}

function claimPid() {
  let displaced = false
  try {
    const old = Number(readFileSync(pidFile, 'utf8'))
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0)
        logger.warn({ pid: old }, 'startup: stopping leftover daemon that would fight this session')
        process.kill(old, 'SIGTERM')
        displaced = true
      } catch {
        // Already gone.
      }
    }
  } catch {
    // No pid file yet.
  }
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 })
  return displaced
}

async function main() {
  ensureDirs()
  if (claimPid()) await sleep(1500)
  purgeStaleQrFiles()
  store.load()

  media.getSocket = () => sock
  media.onReady = (jid, message) => {
    store.markDirty()
    bus.broadcast({ t: 'messageMedia', jid, id: message.id, imagePath: message.imagePath || '' })
  }

  bus.snapshot = snapshot
  bus.onCommand = handleCommand
  try {
    await bus.listen()
  } catch (err) {
    if (err.code === 'EALREADYRUNNING') {
      logger.error(err.message)
      process.exit(3)
    }
    throw err
  }

  try {
    const { state: authState } = await useMultiFileAuthState(authDir)
    creds = authState.creds
  } catch (err) {
    logger.warn({ err }, 'startup: could not read auth state')
  }

  needsLogin = !isLinked()
  pairingWanted = false
  pairingStopped = needsLogin
  connection = needsLogin ? 'idle' : 'connecting'
  pushState()

  // The window is otherwise only tested when the next QR arrives, and WhatsApp's
  // first ref lives for a minute, so the pause would land late.
  const pairingWatchdog = setInterval(() => {
    if (stopping || pairingStopped || !pairingWanted) return
    if (!needsLogin || connection === 'open') return
    if (pairingStartedAt === 0) return
    if (Date.now() - pairingStartedAt > PAIRING_WINDOW_MS) stopPairing()
  }, 5000)
  pairingWatchdog.unref?.()

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal))
  process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'))
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'))

  if (!needsLogin) await connect()
}

main().catch((err) => {
  logger.error({ err }, 'daemon failed to start')
  process.exit(1)
})
