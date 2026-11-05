import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The media cache of the tests is a temporary directory: the tests do not
// write in the cache of the user.
const mediaHome = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-media-'))
process.env.OMARCHY_WHATSAPP_MEDIA = mediaHome

const { Bus } = await import('../lib/server.js')
const { handleSendMedia } = await import('../lib/send.js')
const { discardStaged, stageOutgoing, sweepStaged, STALE_STAGE_MS } = await import('../lib/staging.js')

// The daemon is one process and the panel is another, and the only thing
// between them is a newline-delimited JSON frame on a unix socket. So the
// honest test of "the panel can send a file" is a frame in one end and a
// WhatsApp call out of the other.

function tempFile(name, bytes = 32) {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-sendmedia-'))
  const path = join(dir, name)
  writeFileSync(path, Buffer.alloc(bytes, 1))
  return path
}

function connect(socketPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect(socketPath)
    socket.once('connect', () => resolvePromise(socket))
    socket.once('error', rejectPromise)
  })
}

function readFrame(socket) {
  return new Promise((resolvePromise) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index === -1) return
      socket.off('data', onData)
      resolvePromise(JSON.parse(buffer.slice(0, index)))
    }
    socket.on('data', onData)
  })
}

async function withBus(onCommand, run) {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-bus-'))
  const socketPath = join(dir, 'bus.sock')
  const bus = new Bus(socketPath)
  bus.onCommand = onCommand
  await bus.listen()
  try {
    await run(socketPath)
  } finally {
    bus.close()
  }
}

test('a sendMedia frame reaches WhatsApp as an image', async () => {
  const path = tempFile('photo.png')
  const sent = []
  const sock = {
    async sendMessage(jid, content, options) {
      sent.push({ jid, content, options })
      return { key: { id: 'MSG1' }, message: { imageMessage: {} }, status: 1 }
    }
  }

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock,
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net', path, caption: 'look' }) + '\n')
      const frame = await answer
      socket.destroy()

      assert.equal(frame.t, 'ack')
      assert.equal(frame.ok, true)
      assert.equal(frame.jid, '123@s.whatsapp.net')
      assert.equal(sent.length, 1)
      assert.equal(sent[0].jid, '123@s.whatsapp.net')
      assert.deepEqual(sent[0].content, { image: { url: path }, mimetype: 'image/png', caption: 'look' })
    }
  )
})

test('a file that is not an image goes out as a document with its name', async () => {
  const path = tempFile('notes.pdf')
  const sent = []
  const sock = {
    async sendMessage(jid, content) {
      sent.push(content)
      return { key: { id: 'MSG2' }, message: { documentMessage: {} }, status: 1 }
    }
  }

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock,
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net', path }) + '\n')
      await answer
      socket.destroy()

      assert.deepEqual(sent[0], {
        document: { url: path },
        fileName: 'notes.pdf',
        mimetype: 'application/pdf'
      })
    }
  )
})

test('the sent message is handed on so the panel can show it', async () => {
  const path = tempFile('photo.png')
  const delivered = []
  const sock = {
    async sendMessage() {
      return { key: { id: 'MSG3' }, message: { imageMessage: {} }, status: 1 }
    }
  }

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock,
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: (jid, rawJid, sent) => delivered.push({ jid, rawJid, sent })
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net', path }) + '\n')
      await answer
      socket.destroy()

      assert.equal(delivered.length, 1)
      assert.equal(delivered[0].jid, '123@s.whatsapp.net')
      assert.equal(delivered[0].sent.key.id, 'MSG3')
    }
  )
})

test('a recording is sent as a voice note, and a file is not', async () => {
  const path = tempFile('voice.opus')
  const sent = []
  const sock = {
    async sendMessage(jid, content) {
      sent.push(content)
      return { key: { id: 'MSG4' }, message: { audioMessage: {} }, status: 1 }
    }
  }

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock,
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net', path, ptt: true }) + '\n')
      await answer
      socket.destroy()

      assert.equal(sent[0].ptt, true)
      assert.equal(sent[0].audio.url, path)
    }
  )
})

test('a request without a file is refused and says why', async () => {
  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock: { async sendMessage() { throw new Error('should not send') } },
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net' }) + '\n')
      const frame = await answer
      socket.destroy()

      assert.equal(frame.t, 'error')
      assert.match(frame.message, /file/i)
    }
  )
})

test('a file that is not there is refused with the reason', async () => {
  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock: { async sendMessage() { throw new Error('should not send') } },
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net', path: '/definitely/not/here.png' }) + '\n')
      const frame = await answer
      socket.destroy()

      assert.equal(frame.t, 'error')
      assert.match(frame.message, /not found/i)
    }
  )
})

test('nothing is sent while WhatsApp is not connected', async () => {
  const path = tempFile('photo.png')
  let sends = 0

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock: { async sendMessage() { sends += 1 } },
      connection: 'connecting',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net', path }) + '\n')
      const frame = await answer
      socket.destroy()

      assert.equal(frame.t, 'error')
      assert.match(frame.message, /not connected/i)
      assert.equal(sends, 0)
    }
  )
})

test('the copy that went out does not stay behind', async () => {
  const source = tempFile('photo.png')
  // The copy the daemon reads is the one that travels.
  const staged = stageOutgoing(source)

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock: {
        async sendMessage() {
          return { key: { id: 'MSG5' }, message: { imageMessage: {} }, status: 1 }
        }
      },
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net', path: staged }) + '\n')
      await answer
      socket.destroy()
    }
  )

  // The file is on WhatsApp's servers now, and the copy the daemon made for
  // it has no reason to stay.
  assert.equal(existsSync(staged), false)
})

test('a copy that could not go out stays, so it can be tried again', async () => {
  const source = tempFile('photo.png')
  const staged = stageOutgoing(source)
  let reconnected = false

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock: {
        async sendMessage() {
          throw new Error('the network said no')
        }
      },
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {},
      reconnect: () => { reconnected = true }
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', jid: '123@s.whatsapp.net', path: staged }) + '\n')
      const frame = await answer
      socket.destroy()

      // The panel waits for an answer, and it always gets one.
      assert.equal(frame.t, 'error')
      assert.equal(frame.for, 'sendMedia')
    }
  )

  // The panel puts the file back in front of the user, so the copy it needs
  // has to still be there.
  assert.equal(existsSync(staged), true)
  // And the daemon asks for a new connection, so the upload that failed does
  // not keep it from doing anything else.
  assert.equal(reconnected, true)
  discardStaged(staged)
})

test('the acknowledgement carries the id of the request', async () => {
  const path = tempFile('photo.png')
  const sock = {
    async sendMessage() {
      return { key: { id: 'MSG9' }, message: { imageMessage: {} }, status: 1 }
    }
  }

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock,
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', id: 'r7', jid: '123@s.whatsapp.net', path }) + '\n')
      const frame = await answer
      socket.destroy()

      // The panel matches the answer to the request it belongs to, so the
      // answer has to say which request it is.
      assert.equal(frame.t, 'ack')
      assert.equal(frame.id, 'r7')
    }
  )
})

test('a message that did not go out is not acknowledged', async () => {
  const path = tempFile('photo.png')
  const sock = {
    async sendMessage() {
      // Nothing was delivered: the panel has to know, or it clears the
      // caption and the file for a message that never left.
      return null
    }
  }

  await withBus(
    (payload, reply) => handleSendMedia(payload, reply, {
      sock,
      connection: 'open',
      store: { routingJid: (jid) => jid },
      deliver: () => {}
    }),
    async (socketPath) => {
      const socket = await connect(socketPath)
      const answer = readFrame(socket)
      socket.write(JSON.stringify({ t: 'sendMedia', id: 'r8', jid: '123@s.whatsapp.net', path }) + '\n')
      const frame = await answer
      socket.destroy()

      assert.equal(frame.t, 'error')
      assert.equal(frame.for, 'sendMedia')
      assert.equal(frame.id, 'r8')
    }
  )
})



test('a delivery failure keeps the staged copy available with an error reply', async () => {
  const staged = stageOutgoing(tempFile('photo.png'))
  let sends = 0
  try {
    await withBus(
      (payload, reply) => handleSendMedia(payload, reply, {
        sock: { async sendMessage() { sends += 1; return { key: { id: 'MSG1' } } } },
        connection: 'open',
        store: { routingJid: (jid) => jid },
        deliver: () => { throw new Error('delivery failed') }
      }),
      async (socketPath) => {
        const socket = await connect(socketPath)
        const answer = readFrame(socket)
        socket.write(JSON.stringify({ t: 'sendMedia', id: 'failure-1', jid: '123@s.whatsapp.net', path: staged }) + '\n')
        assert.deepEqual(await answer, { t: 'error', for: 'sendMedia', id: 'failure-1', message: 'delivery failed' })
        socket.destroy()
      }
    )
    assert.equal(sends, 1)
    assert.equal(existsSync(staged), true)
  } finally {
    discardStaged(staged)
  }
})


for (const [outcome, copies] of [['ack', 1], ['error', 1], ['error', 2]]) {
  test(`stale sweep preserves ${copies} active upload(s) until ${outcome}`, async () => {
    const staged = stageOutgoing(tempFile('slow.png'))
    const old = new Date(Date.now() - STALE_STAGE_MS * 2)
    utimesSync(dirname(staged), old, old)
    const pending = []
    let started
    const ready = new Promise((resolve) => { started = resolve })
    let delivered = 0
    let reconnected = 0
    const clients = []
    try {
      await withBus(
        (payload, reply) => handleSendMedia(payload, reply, {
          sock: { sendMessage() {
            const result = new Promise((resolve, reject) => pending.push({ resolve, reject }))
            if (pending.length === copies) started()
            return result
          } },
          connection: 'open',
          store: { routingJid: (jid) => jid },
          deliver: () => { delivered += 1 },
          reconnect: () => { reconnected += 1 }
        }),
        async (socketPath) => {
          const answers = []
          for (let i = 0; i < copies; i += 1) {
            const socket = await connect(socketPath)
            clients.push(socket)
            answers.push(readFrame(socket))
            socket.write(JSON.stringify({ t: 'sendMedia', id: 'slow-' + i, jid: '123@s.whatsapp.net', path: staged }) + '\n')
          }
          await ready
          assert.equal(sweepStaged(), 0)
          assert.equal(existsSync(staged), true)
          for (let i = 0; i < copies; i += 1) {
            if (outcome === 'ack') pending[i].resolve({ key: { id: 'sent' } })
            else pending[i].reject(new Error('upload failed'))
            assert.deepEqual(await answers[i], outcome === 'ack'
              ? { t: 'ack', id: 'slow-' + i, ok: true, jid: '123@s.whatsapp.net' }
              : { t: 'error', for: 'sendMedia', id: 'slow-' + i, message: 'upload failed' })
            if (i + 1 < copies) {
              assert.equal(sweepStaged(), 0)
              assert.equal(existsSync(staged), true)
            }
          }
          assert.equal(pending.length, copies)
          assert.equal(delivered, outcome === 'ack' ? 1 : 0)
          assert.equal(reconnected, outcome === 'error' ? copies : 0)
          assert.equal(existsSync(staged), outcome === 'error')
          assert.equal(sweepStaged(), outcome === 'error' ? 1 : 0)
          assert.equal(existsSync(staged), false)
        }
      )
    } finally {
      for (const request of pending) request.resolve({ key: { id: 'cleanup' } })
      for (const socket of clients) socket.destroy()
      discardStaged(staged)
    }
  })
}
