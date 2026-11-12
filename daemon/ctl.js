#!/usr/bin/env node
// Thin NDJSON client for the daemon socket. No dependencies, so it works before
// `npm install` has ever run in daemon/.

import net from 'node:net'
import { resolve } from 'node:path'
import { socketPath } from './lib/paths.js'
import { stageOutgoing } from './lib/staging.js'

const [command, ...args] = process.argv.slice(2)

// Every request that waits for an answer carries an id, so the answer can be
// matched to it: a failure without one would be about somebody else's
// message.
let requestSeq = 0

function requestId() {
  requestSeq += 1
  return `cli-${process.pid}-${Date.now()}-${requestSeq}`
}

const USAGE = `Usage: omarchy-whatsapp-ctl <command> [args]

  status                 connection state, linked account, unread count
  chats [limit]          most recent chats as JSON
  refresh [jid] [limit]  resync chats from WhatsApp, then dump the list
  messages <jid> [limit] a chat's recent messages as JSON
  send <jid> <text...>   send a text message
  send-media <jid> <file> [caption...]  send an image or a file
  read <jid>             mark a chat read
  focus <jid>            select that chat in every open bar panel
  login                  start QR pairing (stops after 5 minutes)
  pair <phone>           request an 8-digit pairing code instead of a QR
  reconnect              drop the socket and reconnect
  logout                 unlink this device and clear local credentials
  ping                   check the daemon is alive
`

if (!command || command === '-h' || command === '--help') {
  process.stdout.write(USAGE)
  process.exit(command ? 0 : 1)
}

function buildRequest() {
  switch (command) {
    case 'status':
      return { t: 'hello' }
    case 'ping':
      return { t: 'ping' }
    case 'chats':
      return { t: 'chats', limit: Number(args[0]) || 40 }
    case 'refresh':
      return { t: 'refresh', jid: args[0] || undefined, limit: Number(args[1]) || 40 }
    case 'messages':
      if (!args[0]) fail('messages: jid required')
      return { t: 'messages', jid: args[0], limit: Number(args[1]) || 60 }
    case 'send':
      if (args.length < 2) fail('send: jid and text required')
      return { t: 'send', jid: args[0], text: args.slice(1).join(' '), id: requestId() }
    case 'send-media': {
      if (args.length < 2) fail('send-media: jid and file required')
      // The daemon is another process with its own working directory, so a
      // relative path would name a file over there instead of the one named
      // here. It is resolved before it crosses the socket, and then copied
      // where the daemon can read it: it runs with a private /tmp and would
      // not see a file the user picked in their own shell.
      let staged
      try {
        staged = stageOutgoing(resolve(args[1]))
      } catch (err) {
        fail(`send-media: ${err?.message || err}`)
      }
      return {
        t: 'sendMedia',
        jid: args[0],
        path: staged,
        caption: args.slice(2).join(' '),
        id: requestId()
      }
    }
    case 'read':
      if (!args[0]) fail('read: jid required')
      return { t: 'read', jid: args[0] }
    case 'focus':
      if (!args[0]) fail('focus: jid required')
      return { t: 'focus', jid: args[0] }
    case 'login':
      return { t: 'login' }
    case 'pair':
      if (!args[0]) fail('pair: phone number required')
      return { t: 'pair', phone: args[0] }
    case 'reconnect':
      return { t: 'reconnect' }
    case 'logout':
      return { t: 'logout' }
    default:
      fail(`unknown command: ${command}\n\n${USAGE}`)
  }
}

function fail(message) {
  process.stderr.write(`omarchy-whatsapp-ctl: ${message}\n`)
  process.exit(1)
}

const request = buildRequest()
const socket = net.connect(socketPath)
let buffer = ''
let settled = false

const timeout = setTimeout(() => {
  if (settled) return
  settled = true
  socket.destroy()
  fail('timed out waiting for the daemon')
}, 15000)

socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line) continue

    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      continue
    }

    // Every client gets a `state` push on connect. For `status` that *is* the
    // answer; for anything else it is noise to skip.
    if (payload.t === 'state' && command !== 'status') continue

    settled = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    socket.end()
    process.exit(payload.t === 'error' || payload.ok === false ? 1 : 0)
  }
})

socket.on('error', (err) => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    fail('daemon is not running. Start it with: systemctl --user start omarchy-whatsapp')
  }
  fail(String(err.message || err))
})

socket.on('close', () => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  fail('daemon closed the connection without answering')
})
