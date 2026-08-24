import QtQuick
import Quickshell
import Quickshell.Io

// NDJSON client for the omarchy-whatsapp daemon over a unix socket.
//
// One instance lives in each BarWidget (so one per monitor). The daemon accepts
// several clients and fans every event out to all of them, which keeps the bar
// panels on separate screens in sync without any cross-window plumbing.
Item {
  id: root

  // Absolute path to the plugin directory, injected by BarWidget so the client
  // can start the daemon without guessing where it was installed.
  property string pluginDir: ""
  property string socketPath: ""
  property bool autostartDaemon: true

  readonly property string defaultSocketPath: {
    var runtime = Quickshell.env("XDG_RUNTIME_DIR")
    return (runtime && runtime.length > 0 ? runtime : "/tmp") + "/omarchy-whatsapp.sock"
  }
  readonly property string effectiveSocketPath: socketPath && socketPath.length > 0 ? socketPath : defaultSocketPath

  // Live state mirrored from the daemon's `state` frames.
  property bool daemonOnline: false
  property string connectionState: "unknown"
  property bool needsLogin: false
  property bool linked: false
  property bool hasQr: false
  // The daemon pauses QR refresh after its pairing window closes rather than
  // leave an expired code on screen.
  property bool pairingStopped: false
  property int qrVersion: 0
  property string qrPng: ""
  property int unread: 0
  property var me: null
  property string lastError: ""
  property var chats: []
  property int chatsEpoch: 0
  property string lastSocketError: ""
  property bool pendingLogin: false

  // Whether the daemon is actually reachable.
  //
  // `Socket.connected` cannot answer this: it reads back `true` while a connect
  // is still pending, so a socket that never reaches the daemon still looks
  // connected. Only the connectionStateChanged signal and inbound frames are
  // trustworthy, so liveness is tracked here instead.
  property bool linkUp: false
  property double lastFrameMs: 0

  readonly property bool signedIn: linked === true || (needsLogin !== true && (me !== null || (chats && chats.length > 0)))
  readonly property bool ready: signedIn && connectionState === "open"

  signal messagesLoaded(string jid, var chat, var messages)
  signal messageArrived(string jid, var message, var chat)
  signal messageStatusChanged(string jid, string messageId, int status)
  signal messageMedia(string jid, string messageId, string imagePath)
  signal focusRequested(string jid)
  signal commandFailed(string command, string message)
  signal pairCodeReceived(string code)
  signal sendAcknowledged(string jid)

  function request(payload) {
    var socket = socketLoader.item
    if (!socket || !root.linkUp) return false
    socket.write(JSON.stringify(payload) + "\n")
    socket.flush()
    return true
  }

  function startLogin() {
    root.pendingLogin = true
    if (!root.linkUp) {
      root.startDaemon()
      return false
    }
    return request({ t: "login" })
  }

  function refresh() { request({ t: "hello" }) }
  function requestChats(limit) { request({ t: "chats", limit: limit || 60 }) }
  function loadMessages(jid, limit) { request({ t: "messages", jid: jid, limit: limit || 60 }) }
  function refreshInbox(jid, chatLimit, messageLimit) {
    var payload = { t: "refresh", limit: chatLimit || 60 }
    if (jid) {
      payload.jid = jid
      payload.messageLimit = messageLimit || 60
    }
    return request(payload)
  }
  function markRead(jid) { request({ t: "read", jid: jid }) }
  function reconnectWhatsApp() { request({ t: "reconnect" }) }
  function logout() { request({ t: "logout" }) }
  function requestPairCode(phone) { request({ t: "pair", phone: phone }) }
  function setTyping(jid, state) { request({ t: "typing", jid: jid, state: state }) }

  function setChats(list) {
    root.chats = list || []
    root.chatsEpoch = root.chatsEpoch + 1
  }

  function upsertChatPreview(chat) {
    if (!chat || !chat.jid) return
    var list = (root.chats || []).slice()
    var i = -1
    for (var n = 0; n < list.length; n++) {
      if (list[n] && list[n].jid === chat.jid) {
        i = n
        break
      }
    }
    if (i >= 0) list[i] = chat
    else list.push(chat)
    list.sort(function (a, b) {
      var aPin = a && a.pinned
      var bPin = b && b.pinned
      if (!!bPin !== !!aPin) return bPin ? 1 : -1
      return (b.lastTs || 0) - (a.lastTs || 0)
    })
    root.setChats(list)
  }

  function sendMessage(jid, text, quotedId) {
    if (!jid || !text || !text.length) return false
    var payload = { t: "send", jid: jid, text: text }
    if (quotedId) payload.quoted = quotedId
    return request(payload)
  }

  property bool setupTried: false

  function startDaemon() {
    if (!pluginDir || pluginDir.length === 0) return
    if (!root.setupTried) {
      root.setupTried = true
      setupRunner.running = true
      return
    }
    daemonStarter.running = true
  }

  // Rebuild the socket from scratch.
  //
  // Toggling `Socket.connected` false→true does not work: the disconnect is
  // applied asynchronously, so the reconnect request is swallowed and the socket
  // stays down forever. Destroying and recreating the object through the Loader
  // gives a fresh QLocalSocket on every attempt.
  function reconnectSocket() {
    socketLoader.active = false
    socketLoader.active = true
  }

  function handleConnectionState(connectedNow) {
    if (!socketLoader.active) return
    if (connectedNow) {
      root.lastSocketError = ""
      root.linkUp = true
      root.daemonOnline = true
      root.retryCount = 0
      root.lastFrameMs = Date.now()
      retryTimer.stop()
      root.refresh()
      if (root.pendingLogin) {
        root.pendingLogin = false
        root.request({ t: "login" })
      }
    } else {
      root.linkUp = false
      // A brief socket blip is not "logged out". Retry quietly.
      retryTimer.start()
    }
  }

  function handleSocketError(error) {
    if (!socketLoader.active) return
    root.linkUp = false
    root.lastSocketError = String(error)
    retryTimer.start()
  }

  function handleLine(line) {
    if (!line || !line.length) return
    root.lastFrameMs = Date.now()
    root.linkUp = true
    try {
      root.handleFrame(JSON.parse(line))
    } catch (e) {
      console.warn("omarchy-whatsapp: unparseable frame from daemon:", e)
    }
  }

  function handleFrame(frame) {
    switch (frame.t) {
      case "state":
        root.daemonOnline = true
        root.connectionState = frame.connection || "unknown"
        root.needsLogin = frame.needsLogin === true
        root.linked = frame.linked === true
        root.hasQr = frame.hasQr === true
        root.pairingStopped = frame.pairingStopped === true
        // Path before version: anything reacting to the version bump must
        // already see the matching file.
        root.qrPng = frame.qrPng || ""
        root.qrVersion = frame.qrVersion || 0
        root.unread = frame.unread || 0
        root.me = frame.me || null
        root.lastError = frame.lastError || ""
        if (frame.chats !== undefined) root.setChats(frame.chats || [])
        if (root.linked) root.pendingLogin = false
        break

      case "chats":
        root.setChats(frame.chats || [])
        if (frame.unread !== undefined) root.unread = frame.unread || 0
        break

      case "messages":
        root.messagesLoaded(frame.jid || "", frame.chat || null, frame.messages || [])
        break

      case "message":
        if (frame.unread !== undefined) root.unread = frame.unread || 0
        if (frame.chat) root.upsertChatPreview(frame.chat)
        root.messageArrived(frame.jid || "", frame.message || null, frame.chat || null)
        break

      case "messageStatus":
        root.messageStatusChanged(frame.jid || "", frame.id || "", frame.status || 0)
        break

      case "messageMedia":
        root.messageMedia(frame.jid || "", frame.id || "", frame.imagePath || "")
        break

      case "focus":
        root.focusRequested(frame.jid || "")
        break

      case "pairCode":
        root.pairCodeReceived(frame.code || "")
        break

      case "ack":
        if (frame.jid) root.sendAcknowledged(frame.jid)
        break

      case "error":
        root.commandFailed(frame.for || "", frame.message || "Unknown daemon error")
        break

      case "pong":
        root.daemonOnline = true
        break
    }
  }

  Component {
    id: socketComponent

    Socket {
      path: root.effectiveSocketPath
      connected: true

      parser: SplitParser {
        splitMarker: "\n"
        onRead: function (line) { root.handleLine(line) }
      }

      onConnectionStateChanged: root.handleConnectionState(connected)
      onError: function (error) { root.handleSocketError(error) }
    }
  }

  Loader {
    id: socketLoader
    active: true
    sourceComponent: socketComponent
  }

  // Reconnect loop. Also the daemon autostart hook: a few consecutive failures
  // are treated as "not running" and trigger one launch attempt.
  property int retryCount: 0

  function reset() {
    root.linkUp = false
    root.daemonOnline = false
    root.reconnectSocket()
    retryTimer.start()
  }

  Timer {
    id: retryTimer
    // Capped at 8s: the daemon is a local service, so a long backoff only makes
    // the bar look broken for longer after a restart.
    interval: Math.min(8000, 1200 + root.retryCount * 1000)
    repeat: true
    running: false
    onTriggered: {
      if (root.linkUp) {
        retryTimer.stop()
        return
      }
      root.retryCount += 1
      if (root.retryCount >= 4) root.daemonOnline = false
      if (root.autostartDaemon && root.retryCount === 3) root.startDaemon()
      root.reconnectSocket()
    }
  }

  // A daemon that is wedged rather than gone keeps the socket open while sending
  // nothing. Ping periodically and rebuild the link if the silence gets long.
  Timer {
    id: livenessTimer
    interval: 20000
    repeat: true
    running: true
    onTriggered: {
      if (!root.linkUp) return
      if (root.lastFrameMs > 0 && Date.now() - root.lastFrameMs > 65000) {
        root.reset()
        return
      }
      root.request({ t: "ping" })
    }
  }

  Process {
    id: setupRunner
    command: [root.pluginDir + "/bin/omarchy-whatsapp-setup"]
    onExited: function () { daemonStarter.running = true }
  }

  Process {
    id: daemonStarter
    command: ["systemctl", "--user", "start", "omarchy-whatsapp.service"]
    onExited: function (exitCode) {
      // No unit installed (or it failed): fall back to launching the script.
      if (exitCode !== 0) fallbackStarter.running = true
    }
  }

  Process {
    id: fallbackStarter
    command: ["setsid", root.pluginDir + "/bin/omarchy-whatsapp-daemon"]
  }

  // Always arm the loop: it stops itself as soon as the link is confirmed up.
  // Plugin disable is handled by the daemon watching shell.json — do not stop
  // the shared user service from Component.onDestruction (fires on every bar
  // rebuild / monitor teardown, not only on disable).
  Component.onCompleted: retryTimer.start()
}
