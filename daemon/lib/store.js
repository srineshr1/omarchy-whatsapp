import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { storeFile } from './paths.js'
import { logger } from './logger.js'
import { isGroupJid, isIgnorableChat, prettyJid } from './message.js'
import { mergeMutePreferences, shouldNotifyChat } from './preferences.js'

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

// Pins used to be stored as booleans; now they carry the pin timestamp so
// several pins keep WhatsApp's order.
export function pinRank(value) {
  if (typeof value === 'number') return value > 0 ? value : 0
  return value ? 1 : 0
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
    /** @type {Set<string>} */
    this.addressBookKeys = new Set()
    /** @type {Map<string, string>} */
    this.aliases = new Map()
    /** Custom chat lists, in WhatsApp's order: [{ id, name }]. */
    this.lists = []
    /** @type {Map<string, Set<string>>} list id -> member JIDs (any alias form) */
    this.listMembers = new Map()
    /** @type {Set<string>} */
    this.favorites = new Set()
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
      for (const key of data.addressBookKeys || []) this.addressBookKeys.add(key)
      for (const [from, to] of Object.entries(data.aliases || {})) this.aliases.set(from, to)
      if (Array.isArray(data.lists)) this.lists = data.lists
      for (const [id, jids] of Object.entries(data.listMembers || {})) this.listMembers.set(id, new Set(jids))
      for (const jid of data.favorites || []) this.favorites.add(jid)
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
      addressBookKeys: [...this.addressBookKeys],
      aliases: Object.fromEntries(this.aliases),
      lists: this.lists,
      listMembers: Object.fromEntries([...this.listMembers].map(([id, set]) => [id, [...set]])),
      favorites: [...this.favorites]
    }
    const tmp = `${storeFile}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
      renameSync(tmp, storeFile)
    } catch (err) {
      logger.warn({ err }, 'store: snapshot write failed')
    }
  }

  rememberName(jid, name, isAddressBook = false) {
    if (!jid || !name) return false
    const key = this.canonicalJid(jid) || normalizeJid(jid)
    const clean = String(name).trim().replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    if (!key || !clean || isPlaceholderName(clean)) return false

    const hasAddressBookName = this.addressBookKeys.has(key)
    if (hasAddressBookName && !isAddressBook) return false

    const existing = this.names.get(key)
    if (existing === clean && (isAddressBook ? hasAddressBookName : !hasAddressBookName)) {
      this._applyName(key, clean)
      return false
    }

    if (isAddressBook) {
      this.addressBookKeys.add(key)
    }

    this.names.set(key, clean)
    const aliased = this.aliases.get(key)
    if (aliased) {
      const normAliased = normalizeJid(aliased)
      this.names.set(normAliased, clean)
      if (isAddressBook) this.addressBookKeys.add(normAliased)
      this._applyName(normAliased, clean)
    }
    this._applyName(key, clean)
    this.markDirty()
    return true
  }

  rememberContactName(jid, name) {
    return this.rememberName(jid, name, true)
  }

  rememberPushName(jid, name) {
    return this.rememberName(jid, name, false)
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
      mergeMutePreferences(chatP, chatS)
      chatP.archived = chatP.archived || chatS.archived
      chatP.pinned = Math.max(pinRank(chatP.pinned), pinRank(chatS.pinned))

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
      const prev = list[existing]
      const merged = { ...prev, ...message }
      // Receipts and our own send ack can race with Baileys' PENDING upsert.
      // Never let a later event rewind a tick (clock → sent → delivered → read).
      merged.status = Math.max(prev.status || 0, message.status || 0)
      list[existing] = merged
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
      if (!chat) continue
      const canonical = this.canonicalJid(chat.jid) || chat.jid
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const canonicalChat = this.chat(canonical)
      if (!shouldNotifyChat(canonicalChat)) continue
      total += Math.max(0, canonicalChat.unread || 0)
    }
    return total
  }

  // Canonical JIDs of every favourite and list member.
  _listedJids() {
    const listed = new Set()
    const add = (jid) => {
      if (!isIgnorableChat(jid)) listed.add(this.canonicalJid(jid) || normalizeJid(jid))
    }
    for (const set of this.listMembers.values()) for (const jid of set) add(jid)
    for (const jid of this.favorites) add(jid)
    return listed
  }

  sortedChats() {
    const listed = this._listedJids()
    const seen = new Set()
    const list = []
    for (const chat of this.chats.values()) {
      if (!chat) continue
      const canonical = this.canonicalJid(chat.jid) || chat.jid
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const canonicalChat = this.chat(canonical)
      // Pinned chats and list members stay listed even when quiet, as on the
      // phone; the panel's "All" tab still hides the quiet ones.
      if (canonicalChat.lastTs > 0 || canonicalChat.unread > 0 || pinRank(canonicalChat.pinned) > 0
        || listed.has(canonical)) {
        list.push(canonicalChat)
      }
    }
    // Pinned first, most recently pinned on top, like the phone.
    return list.sort((a, b) => {
      const pa = pinRank(a.pinned)
      const pb = pinRank(b.pinned)
      if (pa !== pb) return pb - pa
      return (b.lastTs || 0) - (a.lastTs || 0)
    })
  }

  _membership() {
    const members = new Map()
    for (const [id, set] of this.listMembers) {
      members.set(id, new Set([...set].map((jid) => this.canonicalJid(jid) || jid)))
    }
    const favorites = new Set([...this.favorites].map((jid) => this.canonicalJid(jid) || jid))
    return { members, favorites }
  }

  _decorate(chat, { members, favorites }) {
    const lists = []
    for (const list of this.lists) if (members.get(list.id)?.has(chat.jid)) lists.push(list.id)
    return { ...chat, pinned: pinRank(chat.pinned), favorite: favorites.has(chat.jid), lists }
  }

  /** A chat as the panel sees it: pin rank, favourite flag, and list ids. */
  publicChat(jid) {
    return this._decorate(this.chat(jid), this._membership())
  }

  chatList(limit = 40) {
    const membership = this._membership()
    return this.sortedChats().slice(0, Math.max(1, limit)).map((chat) => this._decorate(chat, membership))
  }

  /** Replace pins, favourites, and lists with a fresh app-state scan. */
  // A null part means that collection could not be read; keep what we have.
  // Returns the pinned and listed JIDs, so the caller can resolve names for
  // chats that only exist here because of that.
  applyAppState({ pins, favorites, labels, members }) {
    const pinnedJids = []
    if (pins) {
      const pinned = new Map()
      for (const [jid, ts] of pins) {
        if (ts <= 0 || isIgnorableChat(jid) || String(jid).endsWith('@status')) continue
        const key = this.canonicalJid(jid) || normalizeJid(jid)
        pinned.set(key, Math.max(pinned.get(key) || 0, ts))
      }
      for (const chat of this.chats.values()) {
        const next = pinned.get(this.canonicalJid(chat.jid) || chat.jid) || 0
        if (pinRank(chat.pinned) !== next) chat.pinned = next
      }
      for (const [key, ts] of pinned) {
        this.chat(key).pinned = ts
        pinnedJids.push(key)
      }
    }
    if (labels) {
      this.lists = labels
      this.listMembers = new Map([...members].filter(([id]) => labels.some((l) => l.id === id)))
    }
    if (favorites) this.favorites = new Set(favorites)
    const listed = this._listedJids()
    for (const jid of listed) this.chat(jid)
    this.markDirty()
    return [...new Set([...pinnedJids, ...listed])]
  }

  setListMembership(id, jid, member) {
    if (!this.listMembers.has(id)) this.listMembers.set(id, new Set())
    const set = this.listMembers.get(id)
    if (member) set.add(jid)
    else set.delete(jid)
    this.markDirty()
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
