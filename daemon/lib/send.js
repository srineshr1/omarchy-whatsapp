import { mediaMessageFor, prepareUpload } from './outgoing.js'
import { discardStaged, retainStaged } from './staging.js'
import { logger } from './logger.js'

// One file, one WhatsApp message.
//
// The daemon owns the socket, the store and the fan-out to the panels; this
// module owns the decision of what a picked file becomes, so it can be tested
// without a WhatsApp connection: the caller hands over the socket and the
// store, and gets back the same answer the panel would show.
export async function handleSendMedia(payload, reply, deps) {
  const { sock, connection, store, deliver } = deps
  const { id, jid: rawJid } = payload || {}

  if (!rawJid) throw new Error('send-media: jid required')
  const path = String((payload && payload.path) || '')
  if (!path) throw new Error('send-media: file required')
  if (!sock || connection !== 'open') throw new Error('send-media: not connected to WhatsApp')

  // Refuses a file that is not there, and one WhatsApp would not take.
  const upload = prepareUpload(path)
  // A recording is played in place, the way a voice note is; a file the user
  // picked is a file.
  const message = mediaMessageFor(upload, payload.caption, { ptt: payload.ptt === true })

  const routingJid = store.routingJid(rawJid) || rawJid

  const releaseStaged = retainStaged(upload.path)
  let sent
  try {
    // The upload has a deadline of its own: WhatsApp does not let a request
    // hang for ever, so this wait ends one way or another. A deadline here
    // would be a second opinion that can disagree with it, and the file
    // could still go out after the daemon had said it did not.
    sent = await sock.sendMessage(routingJid, message, {})
  } catch (err) {
    // The upload is stuck. The panel is told that nothing went out, so it
    // puts the caption and the file back, and the daemon asks WhatsApp for a
    // new connection: the stuck upload goes with the connection that carried
    // it, and the daemon can do something else.
    logger.warn({ err: String(err?.message || err), id }, 'media: the upload failed')
    reply({ t: 'error', for: 'sendMedia', id, message: err?.message || 'the message was not sent' })
    deps.reconnect?.()
    return
  } finally {
    // No asynchronous work follows the upload; cleanup cannot interleave
    // with the synchronous delivery/acknowledgement below.
    releaseStaged()
  }

  // Nothing went out: the panel is told so, because it would otherwise clear
  // the caption and the file for a message that never left.
  if (!sent) {
    reply({ t: 'error', for: 'sendMedia', id, message: 'the message was not sent' })
    return
  }

  // The panel learns about the message the same way it learns about any other:
  // through the shared fan-out, so every monitor shows it.
  deliver(routingJid, rawJid, sent)

  reply({ t: 'ack', id, ok: true, jid: rawJid })

  // The copy the daemon made for this message has done its job: WhatsApp has
  // the file now. It goes after the answer, so that a failure in between does
  // not leave the panel holding an attachment that is not there any more. A
  // file that could not go out stays where it is, so it can be tried again
  // without the user picking it all over again.
  discardStaged(upload.path)
}
