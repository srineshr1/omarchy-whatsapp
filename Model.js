.pragma library

// Formatting helpers shared by BarWidget.qml and Panel.qml. Kept free of QML
// types so both can import it as a plain library.

function badgeText(count) {
  var n = Math.max(0, count | 0)
  if (n === 0) return ""
  return n > 99 ? "99+" : String(n)
}

function truncate(text, limit) {
  var value = String(text === undefined || text === null ? "" : text)
  var max = limit || 60
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "\u2026"
}

// Collapse newlines so a multi-line message still occupies one preview row.
function oneLine(text) {
  return String(text === undefined || text === null ? "" : text).replace(/\s*\n+\s*/g, " \u00b7 ").trim()
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// WhatsApp's own scheme: time today, "Yesterday", weekday this week, date beyond.
function chatTimestamp(seconds) {
  if (!seconds) return ""
  var date = new Date(seconds * 1000)
  var now = new Date()
  var today = startOfDay(now)
  var stamp = startOfDay(date)
  var dayMs = 86400000

  if (stamp === today) return Qt.formatTime(date, "HH:mm")
  if (stamp === today - dayMs) return "Yesterday"
  if (today - stamp < 6 * dayMs) return Qt.formatDateTime(date, "ddd")
  if (date.getFullYear() === now.getFullYear()) return Qt.formatDateTime(date, "d MMM")
  return Qt.formatDateTime(date, "d MMM yyyy")
}

function messageTimestamp(seconds) {
  if (!seconds) return ""
  return Qt.formatTime(new Date(seconds * 1000), "HH:mm")
}

// Day separators inside a conversation.
function dayLabel(seconds) {
  if (!seconds) return ""
  var date = new Date(seconds * 1000)
  var today = startOfDay(new Date())
  var stamp = startOfDay(date)
  if (stamp === today) return "Today"
  if (stamp === today - 86400000) return "Yesterday"
  return Qt.formatDateTime(date, "ddd d MMM")
}

function sameDay(a, b) {
  if (!a || !b) return false
  return startOfDay(new Date(a * 1000)) === startOfDay(new Date(b * 1000))
}

function isPhotoPlaceholder(text) {
  return /^[\uf03e\uf118]?\s*(Photo|Sticker)?$/i.test(String(text || "").trim())
}

// The path of a file the user picked or dropped.
//
// A name with a stray percent sign is not a broken escape sequence, so the
// decoder must not be allowed to throw: a file called "100%.png" is a real
// file and has to travel as itself.
function filePathFromUrl(url) {
  var value = String(url || "")
  if (value.indexOf("file://") !== 0) return ""
  var raw = value.slice("file://".length)
  try {
    return decodeURIComponent(raw)
  } catch (err) {
    return raw
  }
}

// The text that goes back into the composer when a message could not go out.
//
// The caption comes back, unless something else was typed in the meantime,
// which is the user's and stays.
function restoredAfterFailure(current, sent) {
  return String(current || "").length === 0 ? String(sent || "") : String(current || "")
}

// The conversation a picked file belongs to.
//
// A file picked for a conversation the user has left does not attach
// anywhere: it goes with the conversation it was picked for, or nowhere.
function attachmentChatFor(pickedChat, activeChat) {
  return pickedChat === activeChat ? pickedChat : ""
}

// Whether a message can go out now.
//
// A message that is still on its way is not sent again: the answer for the
// first one is what clears the composer, and a second one would deliver the
// message twice.
function canSendNow(pending) {
  return !pending
}

// Where a recording is written.
//
// The runtime directory belongs to the user alone and is wiped at logout.
// There is no fallback on purpose: a private voice recording is not worth
// writing where every user on the machine can read it.
function recordingDirectory(runtimeDir) {
  return String(runtimeDir || "")
}

// Whether the daemon is still there.
//
// The daemon is: the upload is probably still running, and the message is
// not sent again. The daemon is gone: the message did not go out.
function daemonStillThere(linkUp) {
  return linkUp === true
}

// Whether a failure frees the composer.
//
// The failure has to be about the message that is on its way: another
// command failing says nothing about it. A failure without an id is about
// the message that is the only one on its way.
function failureFreesSend(command, pending, id) {
  if (!pending) return false
  if (command !== "send" && command !== "sendMedia") return false
  return pending.id === id || id === ""
}

function chatTitle(chat) {
  if (!chat) return ""
  return chat.name || prettyJid(chat.jid)
}

function prettyJid(jid) {
  if (!jid) return ""
  var parts = String(jid).split("@")
  var user = parts[0].split(":")[0]
  var server = parts.length > 1 ? parts[1] : ""
  if (!user) return String(jid)
  if (server === "g.us") return "Group"
  if (server === "lid") return user
  return /^\d{6,}$/.test(user) ? "+" + user : user
}

// The preview line under a chat name: "You: ..." for outgoing, "Name: ..." in
// groups, bare text in a one-to-one chat.
function chatPreview(chat) {
  if (!chat) return ""
  var text = oneLine(chat.lastText)
  if (!text) return "No messages yet"
  if (chat.lastFromMe) return "You: " + text
  if (chat.isGroup && chat.lastSender) return chat.lastSender + ": " + text
  return text
}

// How long a voice note is, the way a phone writes it.
function formatDuration(seconds) {
  var total = Math.max(0, Math.floor(Number(seconds) || 0))
  var minutes = Math.floor(total / 60)
  var rest = total % 60
  return minutes + ":" + (rest < 10 ? "0" + rest : String(rest))
}

// Baileys status enum: 1 pending, 2 server ack, 3 delivered, 4 read, 5 played.
// Two nf-fa-check glyphs, not nf-fa-check-double: that codepoint is a copy
// icon in a lot of Nerd Fonts, so "delivered" was rendering as one tick.
function statusGlyph(status) {
  switch (status | 0) {
    case 0:
    case 1: return "\uf017"
    case 2: return "\uf00c"
    case 3:
    case 4:
    case 5: return "\uf00c\uf00c"
    default: return ""
  }
}

function statusIsRead(status) {
  return (status | 0) >= 4
}

function connectionLabel(state, needsLogin, daemonOnline, pairingStopped) {
  if (needsLogin) {
    if (state === "qr") return "Scan QR"
    if (pairingStopped) return "Not linked"
    if (state === "connecting") return "Starting login\u2026"
    return "Not linked"
  }
  if (!daemonOnline) return "Offline"
  if (state === "open") return "Connected"
  return "Connected"
}

function isReady(state, needsLogin, daemonOnline) {
  return needsLogin !== true && (state === "open" || daemonOnline === true)
}

function escapeHtml(str) {
  if (!str) return ""
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

var WEB_TLDS = {
  "com": true, "net": true, "org": true, "app": true, "io": true, "dev": true, "ai": true, "co": true,
  "tr": true, "xyz": true, "me": true, "tv": true, "info": true, "store": true, "shop": true, "online": true,
  "site": true, "tech": true, "link": true, "live": true, "page": true, "space": true, "top": true, "club": true,
  "digital": true, "edu": true, "gov": true, "mil": true, "cc": true, "to": true, "is": true, "so": true,
  "st": true, "ly": true, "de": true, "fr": true, "uk": true, "us": true, "ca": true, "eu": true, "ch": true,
  "nl": true, "ru": true, "it": true, "es": true, "se": true, "no": true, "fi": true, "dk": true, "cz": true,
  "pl": true, "at": true, "be": true, "gr": true, "hu": true, "ro": true, "bg": true, "rs": true, "hr": true,
  "si": true, "sk": true, "ua": true, "by": true, "kz": true, "uz": true, "lt": true, "lv": true, "ee": true,
  "mx": true, "ar": true, "cl": true, "pe": true, "ve": true, "za": true, "eg": true, "sa": true, "ae": true,
  "il": true, "qa": true, "kw": true, "bh": true, "om": true, "jo": true, "lb": true, "ma": true, "dz": true,
  "tn": true, "ng": true, "ke": true, "gh": true, "tz": true, "ug": true, "et": true, "pk": true, "bd": true,
  "lk": true, "np": true, "mm": true, "th": true, "ph": true, "my": true, "sg": true, "id": true, "vn": true,
  "kr": true, "jp": true, "cn": true, "tw": true, "hk": true, "au": true, "nz": true
}

function isWebUrl(urlStr) {
  if (/^https?:\/\//i.test(urlStr) || /^www\./i.test(urlStr) || /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(urlStr)) {
    return true
  }
  if (urlStr.indexOf("/") !== -1 || urlStr.indexOf(":") !== -1) return true
  var parts = urlStr.toLowerCase().split(".")
  if (parts.length < 2) return false
  var tld = parts[parts.length - 1]
  if (WEB_TLDS[tld]) return true
  return parts.length >= 3 && /^[a-z]{2,63}$/.test(tld)
}

function formatMessageText(text, linkColor) {
  if (!text) return ""
  var raw = String(text)
  var color = linkColor || "#4fc3f7"

  // WhatsApp document attachments start with \uf15c icon. Protect document filename header.
  var docPrefix = ""
  var bodyToFormat = raw
  if (/^\uf15c\s*/.test(raw)) {
    var firstLineEnd = raw.indexOf("\n")
    if (firstLineEnd === -1) {
      return escapeHtml(raw)
    } else {
      docPrefix = escapeHtml(raw.slice(0, firstLineEnd)) + "<br/>"
      bodyToFormat = raw.slice(firstLineEnd + 1)
    }
  }

  var urlRegex = /(https?:\/\/[^\s<]+|www\.[^\s<]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}(?::\d+)?(?:\/[^\s<]*)?)/gi
  var result = ""
  var lastIndex = 0
  var match

  while ((match = urlRegex.exec(bodyToFormat)) !== null) {
    var url = match[0]
    var matchIndex = match.index

    // Check unicode word boundary before match
    if (matchIndex > 0 && /[\p{L}\p{N}_@-]/u.test(bodyToFormat[matchIndex - 1]) && !/^https?:\/\//i.test(url)) {
      continue
    }

    if (!isWebUrl(url)) continue

    if (matchIndex > lastIndex) {
      result += escapeHtml(bodyToFormat.slice(lastIndex, matchIndex)).replace(/\n/g, "<br/>")
    }

    var cleanUrl = url
    var trailing = ""
    var puncMatch = /[.,;!?)]+$/.exec(url)
    if (puncMatch) {
      trailing = puncMatch[0]
      cleanUrl = url.slice(0, url.length - trailing.length)
    }

    var href = cleanUrl
    if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleanUrl)) {
      href = "mailto:" + cleanUrl
    } else if (!/^https?:\/\//i.test(cleanUrl)) {
      href = "https://" + cleanUrl
    }

    result += '<a href="' + escapeHtml(href) + '"><font color="' + color + '"><u>' + escapeHtml(cleanUrl) + '</u></font></a>'
    if (trailing) {
      result += escapeHtml(trailing).replace(/\n/g, "<br/>")
    }

    lastIndex = matchIndex + url.length
  }

  if (lastIndex < bodyToFormat.length) {
    result += escapeHtml(bodyToFormat.slice(lastIndex)).replace(/\n/g, "<br/>")
  }

  return docPrefix + result
}



