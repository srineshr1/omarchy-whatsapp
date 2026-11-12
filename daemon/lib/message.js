import { getContentType, normalizeMessageContent, isJidGroup, isJidStatusBroadcast } from 'baileys'

// Glyphs stand in for media we do not download. They read the same in the bar
// panel and in a notification body.
const MEDIA_LABELS = {
  imageMessage: 'Photo',
  videoMessage: 'Video',
  audioMessage: 'Audio',
  documentMessage: 'Document',
  documentWithCaptionMessage: 'Document',
  stickerMessage: 'Sticker',
  contactMessage: 'Contact',
  contactsArrayMessage: 'Contacts',
  locationMessage: 'Location',
  liveLocationMessage: 'Live location',
  pollCreationMessage: 'Poll',
  pollCreationMessageV2: 'Poll',
  pollCreationMessageV3: 'Poll',
  productMessage: 'Product',
  paymentInviteMessage: 'Payment request',
  eventMessage: 'Event',
  ptvMessage: 'Video note'
}

// Nerd Font glyphs, not Unicode emoji: the bar and panel render in the shell's
// monospace font, which has the Nerd Font patch but no color emoji, so emoji
// land as tofu boxes.
const MEDIA_ICONS = {
  imageMessage: '\uf03e',
  videoMessage: '\uf03d',
  audioMessage: '\uf001',
  documentMessage: '\uf15c',
  documentWithCaptionMessage: '\uf15c',
  stickerMessage: '\uf118',
  contactMessage: '\uf007',
  contactsArrayMessage: '\uf0c0',
  locationMessage: '\uf041',
  liveLocationMessage: '\uf041',
  pollCreationMessage: '\uf080',
  pollCreationMessageV2: '\uf080',
  pollCreationMessageV3: '\uf080',
  productMessage: '\uf07a',
  paymentInviteMessage: '\uf155',
  eventMessage: '\uf073',
  ptvMessage: '\uf03d'
}

const VOICE_ICON = '\uf130'

// Message kinds that carry no user-visible content: keys rotating, receipts,
// history sync notifications, and app-state fanout.
const SILENT_TYPES = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'deviceSentMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'stickerSyncRmrMessage',
  'encReactionMessage'
])

function bytesToB64(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data).toString('base64')
  return ''
}

const MEDIA_KINDS = {
  imageMessage: { kind: 'image', mimetype: 'image/jpeg' },
  stickerMessage: { kind: 'sticker', mimetype: 'image/webp' },
  audioMessage: { kind: 'audio', mimetype: 'audio/ogg' },
  videoMessage: { kind: 'video', mimetype: 'video/mp4' },
  ptvMessage: { kind: 'video', mimetype: 'video/mp4' }
}

// Media payloads that can be decrypted later. Documents stay labels.
export function extractMedia(message) {
  const content = normalizeMessageContent(message)
  if (!content) return null
  const type = getContentType(content)
  const known = MEDIA_KINDS[type]
  if (!known) return null
  const node = content[type]
  if (!node || typeof node !== 'object') return null
  const mediaKey = bytesToB64(node.mediaKey)
  if (!mediaKey || !(node.directPath || node.url)) return null
  const fileLength = Number(node.fileLength || 0)
  return {
    kind: known.kind,
    ...(type === 'ptvMessage' ? { ptv: true } : {}),
    mimetype: node.mimetype || known.mimetype,
    mediaKey,
    directPath: node.directPath || '',
    url: node.url || '',
    fileEncSha256: bytesToB64(node.fileEncSha256),
    fileSha256: bytesToB64(node.fileSha256),
    fileLength,
    seconds: Number(node.seconds || 0),
    caption: typeof node.caption === 'string' ? node.caption : '',
    ...(known.kind === 'video' ? { thumbnail: bytesToB64(node.jpegThumbnail) } : {})
  }
}

export function isMediaPlaceholder(text) {
  return /^[\uf03e\uf118\uf03d]?\s*(Photo|Sticker|Video|Video note)?$/i.test(String(text || '').trim())
}

export function messageType(message) {
  const content = normalizeMessageContent(message)
  if (!content) return ''
  return getContentType(content) || ''
}

// Reactions arrive as protocol messages whose target is another message in
// the same chat. They are not standalone messages for the panel to render.
export function reactionDetails(message) {
  const rawContent = normalizeMessageContent(message)
  if (!rawContent) return null
  const content = unwrapMessage(rawContent) || rawContent
  if (getContentType(content) !== 'reactionMessage') return null
  const reaction = content.reactionMessage
  const key = reaction?.key
  if (!key?.id) return null
  return { id: key.id, text: typeof reaction.text === 'string' ? reaction.text : '' }
}

function unwrapMessage(content) {
  if (!content) return null
  let curr = content
  if (curr.viewOnceMessage?.message) curr = curr.viewOnceMessage.message
  if (curr.viewOnceMessageV2?.message) curr = curr.viewOnceMessageV2.message
  if (curr.viewOnceMessageV2Extension?.message) curr = curr.viewOnceMessageV2Extension.message
  if (curr.ephemeralMessage?.message) curr = curr.ephemeralMessage.message
  if (curr.documentWithCaptionMessage?.message) curr = curr.documentWithCaptionMessage.message
  if (curr.editedMessage?.message?.protocolMessage?.editedMessage) curr = curr.editedMessage.message.protocolMessage.editedMessage
  return curr
}

// Flatten a Baileys message into the single preview line the panel and the
// notification both want. Media becomes "<icon> Photo" or "<icon> caption".
export function messageText(message) {
  const rawContent = normalizeMessageContent(message)
  if (!rawContent) return ''
  const content = unwrapMessage(rawContent) || rawContent

  if (typeof content.conversation === 'string' && content.conversation) return content.conversation
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text

  const type = getContentType(content)
  if (!type) return ''

  if (type === 'reactionMessage') {
    const emoji = content.reactionMessage?.text || ''
    return emoji ? `Reacted ${emoji}` : 'Removed a reaction'
  }

  // Interactive / Business / Bot messages
  if (type === 'interactiveMessage') {
    const body = content.interactiveMessage?.body?.text
    const header = content.interactiveMessage?.header?.title
    const title = header ? `${header}\n${body || ''}` : body
    if (title) return title.trim()
  }

  if (type === 'templateMessage') {
    const tmpl = content.templateMessage?.hydratedTemplate || content.templateMessage?.fourRowTemplate
    const text = tmpl?.hydratedContentText || tmpl?.contentText || tmpl?.hydratedTitleText || tmpl?.title
    if (text) return text.trim()
  }

  if (type === 'buttonsMessage') {
    const text = content.buttonsMessage?.contentText || content.buttonsMessage?.caption || content.buttonsMessage?.text
    if (text) return text.trim()
  }

  if (type === 'listMessage') {
    const text = content.listMessage?.description || content.listMessage?.title
    if (text) return text.trim()
  }

  if (type === 'interactiveResponseMessage') {
    const text = content.interactiveResponseMessage?.body?.text || content.interactiveResponseMessage?.nativeFlowResponseMessage?.name
    if (text) return text.trim()
  }

  if (type === 'templateButtonReplyMessage') {
    const text = content.templateButtonReplyMessage?.selectedDisplayText || content.templateButtonReplyMessage?.selectedId
    if (text) return text.trim()
  }

  if (type === 'buttonsResponseMessage') {
    const text = content.buttonsResponseMessage?.selectedDisplayText || content.buttonsResponseMessage?.selectedButtonId
    if (text) return text.trim()
  }

  if (type === 'listResponseMessage') {
    const text = content.listResponseMessage?.title || content.listResponseMessage?.singleSelectReply?.selectedRowId
    if (text) return text.trim()
  }

  if (type === 'documentWithCaptionMessage') {
    const inner = content.documentWithCaptionMessage?.message?.documentMessage
    const caption = inner?.caption || inner?.title || inner?.fileName
    return prefixed('documentMessage', caption)
  }

  const node = content[type]
  if (node && typeof node === 'object') {
    const caption = node.caption || node.title || node.fileName || node.displayName || node.name
    if (typeof caption === 'string' && caption) return prefixed(type, caption)
    if (type === 'audioMessage' && node.ptt) return `${VOICE_ICON} Voice message`
    if (type === 'pollCreationMessage' || type === 'pollCreationMessageV2' || type === 'pollCreationMessageV3') {
      return prefixed(type, node.name)
    }
  }

  if (MEDIA_LABELS[type]) return prefixed(type, '')
  if (SILENT_TYPES.has(type)) return ''
  return ''
}

function prefixed(type, text) {
  const icon = MEDIA_ICONS[type] || ''
  const label = text || MEDIA_LABELS[type] || ''
  if (!label) return icon
  return icon ? `${icon} ${label}` : label
}

// True when the message is bookkeeping the user never sees, so it must not
// bump a chat's preview line, unread count, or fire a notification.
export function isSilent(message) {
  const rawContent = normalizeMessageContent(message)
  if (!rawContent) return true
  const content = unwrapMessage(rawContent) || rawContent
  const type = getContentType(content)
  if (!type) return true
  if (SILENT_TYPES.has(type)) return true
  return messageText(message) === ''
}

export function isGroupJid(jid) {
  return isJidGroup(jid) === true
}

// Status updates and newsletter/channel traffic are noise for a bar widget.
export function isIgnorableChat(jid) {
  if (!jid) return true
  if (isJidStatusBroadcast(jid)) return true
  if (jid.endsWith('@newsletter')) return true
  if (jid === 'status@broadcast') return true
  return false
}

// `1234567890@s.whatsapp.net` -> `+1234567890`, so an unknown sender still
// shows something dialable instead of a raw jid.
export function prettyJid(jid) {
  if (!jid) return ''
  const [userPart, server] = String(jid).split('@')
  const user = (userPart || '').split(':')[0]
  if (!user) return String(jid)
  if (isGroupJid(jid) || server === 'g.us') return 'Group'
  // Linked-ID chats are not phone numbers; prefixing "+" just looks like garbage.
  if (server === 'lid') return user
  return /^\d{6,}$/.test(user) ? `+${user}` : user
}
