import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { storeFile } from './paths.js'
import { logger } from './logger.js'
import { isGroupJid, prettyJid } from './message.js'

const MAX_MESSAGES_PER_CHAT = 200
const MAX_CHATS = 300
const PERSIST_DEBOUNCE_MS = 2000

export function normalizeJid(jid) {
  if (!jid) return ''
  const [user, server] = String(jid).split('@')
  if (!user) return String(jid)
  const bare = user.split(':')[0]
  if (server === 'c.us') return `${bare}@s.whatsapp.net`
  return server ? `${bare}@${server}` : bare
}

export function isPlaceholderName(name) {
  if (!name) return true
  const value = String(name).trim()
  if (!value || value === 'Group' || value === 'Unknown') return true
  if (/^[+]?[\d\s-]{6,}$/.test(value)) return true
  return false
}

// In-memory chat/message state with a JSON snapshot on disk. Baileys ships no
// store since v6, and the panel needs something to render the instant it
// connects — before (or without) a fresh history sync.
export class Store {
  constructor() {
    /** @type {Map<string, object>} */
    this.chats = new Map()
    /** @type {Map<string, object[]>} */
    this.messages = new Map()
    /** @type {Map<string, string>} */
    this.names = new Map()
    /** @type {Map<string, string>} */
    this.aliases = new Map()
    this.me = null
    this._persistTimer = null
    this._dirty = false
  }

  canonicalJid(jid) {
    const key = normalizeJid(jid)
    if (!key) return ''
    const target = this.aliases.get(key)
    if (target) {
      const normTarget = normalizeJid(target)
      if (normTarget.endsWith('@s.whatsapp.net')) return normTarget
      if (key.endsWith('@s.whatsapp.net')) return key
      return normTarget || key
    }
    return key
  }

  load() {
    let raw
    try {
      raw = readFileSync(storeFile, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err }, 'store: unreadable snapshot, starting empty')
      return
    }
    try {
      const data = JSON.parse(raw)
      for (const chat of data.chats || []) if (chat?.jid) this.chats.set(chat.jid, chat)
      for (const [jid, list] of Object.entries(data.messages || {})) {
        if (Array.isArray(list)) this.messages.set(jid, list.slice(-MAX_MESSAGES_PER_CHAT))
      }
      for (const [jid, name] of Object.entries(data.names || {})) this.names.set(jid, name)
      for (const [from, to] of Object.entries(data.aliases || {})) this.aliases.set(from, to)
      this.me = data.me || null
      for (const list of this.messages.values()) {
        for (const message of list) {
          if (message.imagePath && !existsSync(message.imagePath)) message.imagePath = ''
        }
      }
      for (const [from, to] of this.aliases.entries()) {
        const primary = this.canonicalJid(from)
        const secondary = (primary === normalizeJid(from)) ? normalizeJid(to) : normalizeJid(from)
        if (primary && secondary && primary !== secondary) {
          this._mergeJids(primary, secondary)
        }
      }
      this.applyNamesToChats()
      for (const chat of this.chats.values()) {
        if (String(chat.jid).endsWith('@lid') && isPlaceholderName(chat.name)) {
          chat.name = prettyJid(chat.jid)
        }
      }
      logger.info({ chats: this.chats.size, names: this.names.size }, 'store: snapshot loaded')
    } catch (err) {
      logger.warn({ err }, 'store: corrupt snapshot, starting empty')
    }
  }

  markDirty() {
    this._dirty = true
    if (this._persistTimer) return
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      this.persist()
    }, PERSIST_DEBOUNCE_MS)
    this._persistTimer.unref?.()
  }

  persist() {
    if (!this._dirty) return
    this._dirty = false
    const chats = this.sortedChats().slice(0, MAX_CHATS)
    const messages = {}
    for (const chat of chats) {
      const list = this.messages.get(chat.jid)
      if (list?.length) messages[chat.jid] = list.slice(-MAX_MESSAGES_PER_CHAT)
    }
    const payload = {
      version: 2,
      me: this.me,
      chats,
      messages,
      names: Object.fromEntries(this.names),
      aliases: Object.fromEntries(this.aliases)
    }
    const tmp = `${storeFile}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
      renameSync(tmp, storeFile)
    } catch (err) {
      logger.warn({ err }, 'store: snapshot write failed')
    }
  }

  rememberName(jid, name) {
    if (!jid || !name) return false
    const key = this.canonicalJid(jid) || normalizeJid(jid)
    const clean = String(name).trim().replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    if (!key || !clean) return false

    const existing = this.names.get(key)
    if (existing === clean) {
      this._applyName(key, clean)
      return false
    }
    if (existing && !isPlaceholderName(existing) && isPlaceholderName(clean)) return false

    this.names.set(key, clean)
    const aliased = this.aliases.get(key)
    if (aliased) {
      const normAliased = normalizeJid(aliased)
      this.names.set(normAliased, clean)
      this._applyName(normAliased, clean)
    }
    this._applyName(key, clean)
    this.markDirty()
    return true
  }

  alias(a, b) {
    const left = normalizeJid(a)
    const right = normalizeJid(b)
    if (!left || !right || left === right) return false

    let primary = left
    let secondary = right
    if (right.endsWith('@s.whatsapp.net') && !left.endsWith('@s.whatsapp.net')) {
      primary = right
      secondary = left
    }

    const prevP = this.aliases.get(primary)
    const prevS = this.aliases.get(secondary)
    if (prevP === secondary && prevS === primary) {
      this._mergeJids(primary, secondary)
      return false
    }

    this.aliases.set(primary, secondary)
    this.aliases.set(secondary, primary)

    const nameP = this.lookupName(primary)
    const nameS = this.lookupName(secondary)
    const bestName = (!isPlaceholderName(nameP) ? nameP : nameS) || (!isPlaceholderName(nameS) ? nameS : '')
    if (bestName) {
      this.rememberName(primary, bestName)
      this.rememberName(secondary, bestName)
    }

    this._mergeJids(primary, secondary)
    this.markDirty()
    return true
  }

  _mergeJids(primary, secondary) {
    if (!primary || !secondary || primary === secondary) return

    const secondaryMsgs = this.messages.get(secondary)
    if (secondaryMsgs && secondaryMsgs.length > 0) {
      const primaryMsgs = this.messages.get(primary) || []
      const mergedMap = new Map()
      for (const m of primaryMsgs) mergedMap.set(m.id, m)
      for (const m of secondaryMsgs) {
        if (!mergedMap.has(m.id)) {
          mergedMap.set(m.id, m)
        } else {
          mergedMap.set(m.id, { ...mergedMap.get(m.id), ...m })
        }
      }
      const mergedList = [...mergedMap.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0))
      if (mergedList.length > MAX_MESSAGES_PER_CHAT) {
        mergedList.splice(0, mergedList.length - MAX_MESSAGES_PER_CHAT)
      }
      this.messages.set(primary, mergedList)
      this.messages.delete(secondary)
    }

    const chatS = this.chats.get(secondary)
    if (chatS) {
      const chatP = this.chat(primary)
      if ((chatS.lastTs || 0) > (chatP.lastTs || 0)) {
        chatP.lastTs = chatS.lastTs
        chatP.lastText = chatS.lastText
        chatP.lastFromMe = chatS.lastFromMe
        chatP.lastSender = chatS.lastSender
      }
      chatP.unread = Math.max(chatP.unread || 0, chatS.unread || 0)
      chatP.muted = chatP.muted || chatS.muted
      chatP.archived = chatP.archived || chatS.archived
      chatP.pinned = chatP.pinned || chatS.pinned

      if (isPlaceholderName(chatP.name) && !isPlaceholderName(chatS.name)) {
        chatP.name = chatS.name
      }

      this.chats.delete(secondary)
    }
  }

  lookupName(jid) {
    const key = this.canonicalJid(jid) || normalizeJid(jid)
    if (!key) return ''
    return this.names.get(key) || this.names.get(this.aliases.get(key) || '') || ''
  }

  displayName(jid) {
    return this.lookupName(jid) || prettyJid(jid)
  }

  _applyName(jid, name) {
    const key = this.canonicalJid(jid) || normalizeJid(jid)
    const chat = this.chats.get(key)
    if (!chat) return
    if (chat.nameLocked && !isPlaceholderName(chat.name)) return
    if (chat.name === name) return
    chat.name = name
    if (!isPlaceholderName(name)) chat.nameLocked = false
  }

  applyNamesToChats() {
    let changed = false
    for (const chat of this.chats.values()) {
      const resolved = this.lookupName(chat.jid)
      if (!resolved) continue
      if (chat.name === resolved) continue
      if (chat.nameLocked && !isPlaceholderName(chat.name)) continue
      chat.name = resolved
      changed = true
    }
    if (changed) this.markDirty()
    return changed
  }

  chat(jid) {
    const key = this.canonicalJid(jid) || normalizeJid(jid) || jid
    let chat = this.chats.get(key)
    if (!chat) {
      chat = {
        jid: key,
        name: this.displayName(key),
        isGroup: isGroupJid(key),
        unread: 0,
        muted: false,
        archived: false,
        pinned: false,
        lastTs: 0,
        lastText: '',
        lastFromMe: false,
        lastSender: ''
      }
      this.chats.set(key, chat)
      this.markDirty()
    } else if (isPlaceholderName(chat.name)) {
      const resolved = this.lookupName(key)
      if (resolved && resolved !== chat.name) chat.name = resolved
    }
    return chat
  }

  upsertMessage(jid, message) {
    const key = this.canonicalJid(jid) || normalizeJid(jid) || jid
    const list = this.messages.get(key) || []
    const existing = list.findIndex((m) => m.id === message.id)
    if (existing !== -1) {
      list[existing] = { ...list[existing], ...message }
    } else {
      list.push(message)
      list.sort((a, b) => (a.ts || 0) - (b.ts || 0))
      if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT)
    }
    this.messages.set(key, list)
    this.markDirty()
    return list
  }

  touchChat(jid, message) {
    const chat = this.chat(jid)
    if ((message.ts || 0) >= (chat.lastTs || 0)) {
      chat.lastTs = message.ts || 0
      chat.lastText = message.text
      chat.lastFromMe = !!message.fromMe
      chat.lastSender = message.senderName || ''
    }
    this.markDirty()
    return chat
  }

  setUnread(jid, count) {
    const key = this.canonicalJid(jid) || normalizeJid(jid) || jid
    const chat = this.chat(key)
    const next = Math.max(0, count | 0)
    chat.unread = next

    const aliased = this.aliases.get(key)
    if (aliased) {
      const altKey = normalizeJid(aliased)
      const altChat = this.chats.get(altKey)
      if (altChat) altChat.unread = next
    }
    this.markDirty()
    return chat
  }

  bumpUnread(jid) {
    const key = this.canonicalJid(jid) || normalizeJid(jid) || jid
    const chat = this.chat(key)
    const next = (chat.unread || 0) + 1
    chat.unread = next

    const aliased = this.aliases.get(key)
    if (aliased) {
      const altKey = normalizeJid(aliased)
      const altChat = this.chats.get(altKey)
      if (altChat) altChat.unread = next
    }
    this.markDirty()
    return chat
  }

  totalUnread() {
    let total = 0
    const seen = new Set()
    for (const chat of this.chats.values()) {
      if (!chat || chat.muted) continue
      const canonical = this.canonicalJid(chat.jid) || chat.jid
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const canonicalChat = this.chat(canonical)
      total += Math.max(0, canonicalChat.unread || 0)
    }
    return total
  }

  sortedChats() {
    const seen = new Set()
    const list = []
    for (const chat of this.chats.values()) {
      if (!chat) continue
      const canonical = this.canonicalJid(chat.jid) || chat.jid
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const canonicalChat = this.chat(canonical)
      if (canonicalChat.lastTs > 0 || canonicalChat.unread > 0) {
        list.push(canonicalChat)
      }
    }
    return list.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
      return (b.lastTs || 0) - (a.lastTs || 0)
    })
  }

  chatList(limit = 40) {
    return this.sortedChats().slice(0, Math.max(1, limit))
  }

  messageList(jid, limit = 60) {
    const key = this.canonicalJid(jid) || normalizeJid(jid) || jid
    const list = this.messages.get(key) || []
    return list.slice(-Math.max(1, limit))
  }

  findMessage(jid, id) {
    if (!id) return null
    const key = this.canonicalJid(jid) || normalizeJid(jid) || jid
    const list = this.messages.get(key)
    const found = list?.find((m) => m.id === id)
    if (found) return found

    for (const l of this.messages.values()) {
      const f = l.find((m) => m.id === id)
      if (f) return f
    }
    return null
  }

  clear() {
    this.chats.clear()
    this.messages.clear()
    this.names.clear()
    this.aliases.clear()
    this.me = null
    this._dirty = true
    this.persist()
  }
}

