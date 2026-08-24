const HAS_OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

// Current epoch timestamps are ~1.8e9 in seconds and ~1.8e12 in
// milliseconds. Keeping the cutoff well above the seconds form lets us accept
// both shapes emitted by WhatsApp history and app-state syncs.
const MILLIS_TIMESTAMP_CUTOFF = 10_000_000_000

export function normalizeMuteEndTime(value) {
  if (value === null || value === undefined) return null

  let number
  if (typeof value === 'number') number = value
  else if (typeof value === 'bigint' || typeof value === 'string') number = Number(value)
  else if (typeof value.toNumber === 'function') number = value.toNumber()
  else if (typeof value.low === 'number' && typeof value.high === 'number') {
    const bits = (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0)
    number = Number(value.unsigned ? bits : BigInt.asIntN(64, bits))
  }

  return Number.isFinite(number) ? Math.trunc(number) : null
}

function muteEndTimeMs(value) {
  const end = normalizeMuteEndTime(value)
  if (end === null || end <= 0) return end
  return end < MILLIS_TIMESTAMP_CUTOFF ? end * 1000 : end
}

// WhatsApp represents "Always" with -1. Timed mute values have appeared as
// both Unix seconds and Unix milliseconds, depending on which sync supplied
// the chat, so compare both safely. Old snapshots only stored `muted`; retain
// that as a backwards-compatible fallback until fresh metadata arrives.
export function isChatMuted(chat, nowMs = Date.now()) {
  if (!chat) return false
  if (!HAS_OWN(chat, 'muteEndTime')) return chat.muted === true

  const end = normalizeMuteEndTime(chat.muteEndTime)
  if (end === -1) return true
  if (end === null || end <= 0) return false
  return muteEndTimeMs(end) > nowMs
}

export function shouldNotifyChat(chat, nowMs = Date.now()) {
  return !!chat && chat.archived !== true && !isChatMuted(chat, nowMs)
}

/** Milliseconds until a timed mute ends, or null if not a future timed mute. */
export function muteExpiryDelayMs(chat, nowMs = Date.now()) {
  if (!chat || !HAS_OWN(chat, 'muteEndTime')) return null
  const end = normalizeMuteEndTime(chat.muteEndTime)
  if (end === null || end <= 0 || end === -1) return null
  const remaining = muteEndTimeMs(end) - nowMs
  return remaining > 0 ? remaining : 0
}

// When aliasing LID/PN twins, keep the stronger mute: Always wins, else the
// later deadline, else a legacy muted boolean.
export function mergeMutePreferences(primary, secondary, nowMs = Date.now()) {
  if (!primary) return
  if (!secondary) {
    primary.muted = isChatMuted(primary, nowMs)
    return
  }

  const primaryEnd = HAS_OWN(primary, 'muteEndTime') ? normalizeMuteEndTime(primary.muteEndTime) : null
  const secondaryEnd = HAS_OWN(secondary, 'muteEndTime') ? normalizeMuteEndTime(secondary.muteEndTime) : null

  if (primaryEnd === -1 || secondaryEnd === -1) {
    primary.muteEndTime = -1
    primary.muted = true
    return
  }

  const primaryMs = primaryEnd && primaryEnd > 0 ? muteEndTimeMs(primaryEnd) : 0
  const secondaryMs = secondaryEnd && secondaryEnd > 0 ? muteEndTimeMs(secondaryEnd) : 0

  if (secondaryMs > primaryMs) {
    primary.muteEndTime = secondaryEnd
  } else if (!HAS_OWN(primary, 'muteEndTime') && secondaryMs <= 0 && isChatMuted(secondary, nowMs)) {
    // Secondary only has a legacy muted flag.
    if (HAS_OWN(secondary, 'muteEndTime')) primary.muteEndTime = secondaryEnd
    else {
      delete primary.muteEndTime
      primary.muted = true
      return
    }
  }

  primary.muted = isChatMuted(primary, nowMs)
}

// Apply only fields present in a partial Baileys chat update. Keeping the raw
// mute deadline lets timed mutes expire locally without waiting for another
// app-state event from the phone.
export function applyChatNotificationPreferences(chat, update, nowMs = Date.now()) {
  let changed = false

  if (update.archived !== undefined) {
    const archived = update.archived === true
    if (chat.archived !== archived) changed = true
    chat.archived = archived
  }

  if (update.muteEndTime !== undefined) {
    const muteEndTime = normalizeMuteEndTime(update.muteEndTime)
    if (!HAS_OWN(chat, 'muteEndTime') || chat.muteEndTime !== muteEndTime) changed = true
    chat.muteEndTime = muteEndTime

    const muted = isChatMuted(chat, nowMs)
    if (chat.muted !== muted) changed = true
    chat.muted = muted
  }

  return changed
}
