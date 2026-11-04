import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtMultimedia
import Quickshell
import Quickshell.Wayland
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// The WhatsApp surface: chat list, conversation, inline reply, and the QR
// pairing screen. Loaded by BarWidget.qml, which injects `bar`, `anchorItem`,
// `hostWidget`, and the shared `client`.
Panel {
  id: root
  moduleName: "io.github.ricky.whatsapp"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var client: null
  property string pluginDir: ""

  // "chats" | "chat"; the login screen replaces both while unlinked.
  property string view: "chats"
  property string activeJid: ""
  property var activeChat: null
  property var messages: []
  property int cursorIndex: 0
  property string statusLine: ""
  readonly property bool notificationsEnabled: root.setting("notifications", "On") !== "Off"
    && root.setting("notifications", "On") !== false
  readonly property bool notificationSoundEnabled: root.setting("notificationSound", "On") !== "Off"
    && root.setting("notificationSound", "On") !== false
  readonly property bool alertsEnabled: notificationsEnabled || notificationSoundEnabled
  readonly property bool notificationUpdatePending: notificationUpdater.running
  property string notificationTarget: "On"

  function toggleNotifications() {
    if (notificationUpdater.running) return
    root.notificationTarget = root.alertsEnabled ? "Off" : "On"
    notificationUpdater.running = true
  }

  // Use the host CLI so settings persist and reload on every monitor. The
  // fixed shell program accepts only the internally selected On/Off argument.
  Process {
    id: notificationUpdater
    command: ["sh", "-c",
      'omarchy bar set io.github.ricky.whatsapp notifications "$1" && '
        + 'omarchy bar set io.github.ricky.whatsapp notificationSound "$1"',
      "whatsapp-notifications", root.notificationTarget]
    onExited: function (exitCode, exitStatus) {
      if (exitCode !== 0 || exitStatus !== 0)
        root.statusLine = "Could not update notification settings"
    }
  }
  // What is waiting for the daemon to accept, and what to put back if it does
  // not: { jid, text, path }.
  property var pendingSend: null
  // The voice note being played, if any, so its button can show a stop.
  property string playingMessageId: ""
  // A recording in progress, and where it is being written.
  property bool recording: false
  property string recordingPath: ""
  // The conversation the recording was made in: it goes with that one, and
  // the copy is made long after the recording stopped.
  property string recordingChat: ""
  // Where a recording is written. The runtime directory belongs to the user
  // alone and is wiped at logout, which /tmp is not: anything in /tmp can be
  // read by every user on the machine. There is no fallback on purpose: a
  // private voice recording is not worth writing where everyone can read it.
  readonly property string recordingDir: Model.recordingDirectory(Quickshell.env("XDG_RUNTIME_DIR"))
  // True between asking the recorder to stop and the file being finished.
  property bool waitingForRecording: false
  // The staging requests, one at a time: the staging process reads the file
  // and the name it is given, so two requests in flight would mix them up.
  property var stagingQueue: []
  // The colour the drop surface tints itself with.
  readonly property color dropTint: bar ? bar.urgent : Commons.Color.accent
  property bool pinToLatest: true
  property bool logoutConfirmOpen: false
  property bool refreshing: false
  property string peekImagePath: ""
  // Which chat list tab is showing: "all", "unread", "favorites", "groups",
  // or "list:<id>" for one of the user's own WhatsApp lists.
  property string activeList: "all"
  // List picker (l): which chat it edits and where its cursor is.
  property bool listPickerOpen: false
  property string listPickerJid: ""
  property int listPickerIndex: 0
  readonly property var customLists: root.client ? (root.client.lists || []) : []
  readonly property bool peekActive: peekImagePath.length > 0

  readonly property var chats: client ? client.chats : []
  readonly property bool daemonOnline: client ? client.daemonOnline : false
  readonly property bool needsLogin: client ? client.needsLogin === true : false
  readonly property bool pairingPaused: client ? client.pairingStopped === true : false
  readonly property bool hasQr: client ? client.hasQr === true : false
  readonly property bool linked: client ? client.signedIn : false
  readonly property bool showLogin: needsLogin
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
  // Popup content must use the theme foreground. barForeground can switch to
  // a wallpaper-contrast color when the bar is transparent, which may be dark
  // even though the popup surface remains dark.
  readonly property color foreground: root.bar ? root.bar.foreground : Commons.Color.foreground
  readonly property color secondaryForeground: Qt.darker(root.foreground, 1.5)
  readonly property int chatLimit: root.setting("chatLimit", 40)
  readonly property int messageLimit: root.setting("messageLimit", 60)

  function open() { root.controller.show() }
  function close() { root.controller.hide() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  function chatAt(index) {
    var list = root.visibleChats
    if (index < 0 || index >= list.length) return null
    return list[index]
  }

  // WhatsApp's own filter row: the built-in filters, then the user's lists.
  readonly property var listTabs: {
    var tabs = [
      { id: "all", name: "All" },
      { id: "unread", name: "Unread" },
      { id: "favorites", name: "Favourites" },
      { id: "groups", name: "Groups" }
    ]
    var custom = root.client ? (root.client.lists || []) : []
    for (var i = 0; i < custom.length; i++)
      tabs.push({ id: "list:" + custom[i].id, name: custom[i].name })
    return tabs
  }

  readonly property int activeListIndex: {
    for (var i = 0; i < root.listTabs.length; i++)
      if (root.listTabs[i].id === root.activeList) return i
    return 0
  }

  function chatInList(chat, listId) {
    if (!chat) return false
    if (listId === "unread") return (chat.unread || 0) > 0
    if (listId === "favorites") return chat.favorite === true
    if (listId === "groups") return chat.isGroup === true
    if (listId.indexOf("list:") === 0)
      return (chat.lists || []).indexOf(listId.slice(5)) !== -1
    // "All": list members the daemon only knows from app state have no
    // messages yet; keep them out unless pinned.
    return (chat.lastTs || 0) > 0 || (chat.unread || 0) > 0 || (chat.pinned || 0) > 0
  }

  readonly property var visibleChats: {
    var epoch = root.client ? root.client.chatsEpoch : 0
    var list = root.chats || []
    if (epoch < 0) return []
    var listId = root.listTabs[root.activeListIndex].id
    list = list.filter(function (chat) { return root.chatInList(chat, listId) })
    return list.slice(0, Math.max(1, root.chatLimit))
  }

  onVisibleChatsChanged: {
    var count = root.visibleChats.length
    if (root.cursorIndex > count - 1) root.cursorIndex = Math.max(0, count - 1)
  }

  function selectList(index) {
    var count = root.listTabs.length
    if (count === 0) return
    var next = ((index % count) + count) % count
    root.activeList = root.listTabs[next].id
    root.cursorIndex = 0
    chatList.positionViewAtBeginning()
    listStrip.positionViewAtIndex(next, ListView.Contain)
  }

  function cycleList(direction) {
    root.selectList(root.activeListIndex + direction)
  }

  // Point the panel at a chat without touching read state. Used by the focus
  // broadcast: a notification must not clear the unread badge before the panel
  // is actually on screen. onOpenedChanged marks it read once it is.
  function prepareChat(jid) {
    if (!jid || !root.client) return
    root.activeJid = jid
    root.activeChat = null
    root.messages = []
    root.pinToLatest = true
    root.view = "chat"
    root.client.loadMessages(jid, root.messageLimit)
  }

  // User-initiated open: marks the chat read and puts the cursor in the reply box.
  function selectChat(jid) {
    root.prepareChat(jid)
    // A file picked for one conversation must not travel to another: it goes
    // with the chat it was picked for.
    if (root.attachmentChat !== jid) root.clearAttachment()
    if (!root.client) return
    root.client.markRead(jid)
    Qt.callLater(function () { composer.forceActiveFocus() })
  }

  function back() {
    root.view = "chats"
    root.activeJid = ""
    root.activeChat = null
    root.messages = []
    composer.text = ""
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  function requestLogout() {
    logoutConfirm.selectedIndex = 1
    root.logoutConfirmOpen = true
    Qt.callLater(function () { logoutConfirm.forceActiveFocus() })
  }

  function cancelLogout() {
    root.logoutConfirmOpen = false
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  function confirmLogout() {
    root.logoutConfirmOpen = false
    if (root.client) root.client.logout()
    root.back()
    root.statusLine = ""
  }

  function moveCursor(delta) {
    if (root.view !== "chats") return
    var count = root.visibleChats.length
    if (count === 0) return
    var next = root.cursorIndex + delta
    if (next < 0) next = 0
    if (next > count - 1) next = count - 1
    root.cursorIndex = next
    chatList.positionViewAtIndex(next, ListView.Contain)
  }

  // Shift+Up/Down: move the pinned chat under the cursor within the pinned
  // group. The order is kept by the daemon and only affects this panel.
  function movePinnedChat(delta) {
    if (root.view !== "chats" || !root.client) return
    var chat = root.chatAt(root.cursorIndex)
    var target = root.chatAt(root.cursorIndex + delta)
    if (!chat || !target || (chat.pinned || 0) <= 0 || (target.pinned || 0) <= 0) return
    if (!root.client.movePin(chat.jid, delta)) return
    root.cursorIndex = root.cursorIndex + delta
    chatList.positionViewAtIndex(root.cursorIndex, ListView.Contain)
  }

  function openListPicker() {
    if (root.view !== "chats") return
    var chat = root.chatAt(root.cursorIndex)
    if (!chat) return
    if (root.customLists.length === 0) {
      root.statusLine = "No lists yet; create one on your phone"
      return
    }
    root.listPickerJid = chat.jid
    root.listPickerIndex = 0
    root.listPickerOpen = true
    Qt.callLater(function () { listPicker.forceActiveFocus() })
  }

  function closeListPicker() {
    root.listPickerOpen = false
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  function pickerChat() {
    var list = root.chats || []
    for (var i = 0; i < list.length; i++)
      if (list[i].jid === root.listPickerJid) return list[i]
    return null
  }

  function toggleListMembership(index) {
    var list = root.customLists[index]
    var chat = root.pickerChat()
    if (!list || !chat || !root.client) return
    var member = (chat.lists || []).indexOf(list.id) !== -1
    root.statusLine = (member ? "Removing from " : "Adding to ") + list.name + "\u2026"
    if (!root.client.setListMember(chat.jid, list.id, !member)) root.statusLine = "Daemon offline"
  }

  function activateCursor() {
    if (root.view !== "chats") return
    var chat = root.chatAt(root.cursorIndex)
    if (chat) root.selectChat(chat.jid)
  }

  function sendReply() {
    var text = composer.text
    var path = root.attachmentPath
    // A file on its own is a message too: the text is its caption.
    if ((!text || !text.trim().length) && !path) return
    // A file goes with the conversation it was picked for, and the
    // conversation can change without the panel choosing it: the daemon can
    // point the panel at another chat. So it is checked again here.
    if (path && Model.attachmentChatFor(root.attachmentChat, root.activeJid).length === 0) {
      root.statusLine = "The file goes with another conversation"
      return
    }
    // A message that is still on its way is not sent again: the answer for
    // the first one is what clears the composer, and a second one would
    // deliver the message twice.
    if (!Model.canSendNow(root.pendingSend)) return
    if (!root.client || !root.client.ready) {
      root.statusLine = "Not connected to WhatsApp"
      return
    }

    var sent = ""
    if (path) sent = root.client.sendMedia(root.activeJid, path, text, root.attachmentIsVoice)
    else sent = root.client.sendMessage(root.activeJid, text)

    if (sent) {
      // The composer lets go of the text as soon as the message is handed
      // over: what the user types while it is on its way is the next
      // message, and the text that went out must not go out again with it.
      composer.text = ""
      // The composer keeps what was typed until the daemon says the message
      // went out: a file it refuses must not cost the caption either.
      root.pendingSend = { id: sent, jid: root.activeJid, text: text, path: path }
      root.statusLine = ""
      typingTimer.stop()
      root.client.setTyping(root.activeJid, "paused")
      sendWatchdog.restart()
    }
  }

  // ---- attaching a file --------------------------------------------------
  //
  // The platform's own file dialog picks it, and the name of what was picked
  // sits above the composer until it is sent or taken back.
  property string attachmentPath: ""
  property string attachmentName: ""
  // A recording is a voice note; a file the user picked is a file.
  property bool attachmentIsVoice: false
  // The conversation the file was picked for.
  property string attachmentChat: ""

  function clearAttachment() {
    root.attachmentPath = ""
    root.attachmentName = ""
    root.attachmentChat = ""
    root.attachmentIsVoice = false
  }

  // A file becomes the attachment, whatever route it arrived by: the dialog, a
  // drop on the panel, or a recording.
  //
  // The conversation it was picked for comes with it: the user can pick a
  // file and change conversation while it is being copied, and the file goes
  // with the conversation it was picked for, or nowhere.
  function attachFile(path, chat, voice) {
    if (!path || path.length === 0) return
    var belongs = Model.attachmentChatFor(chat, root.activeJid)
    if (belongs.length === 0) {
      root.statusLine = "The file was picked for another conversation"
      return
    }
    root.attachmentPath = path
    root.attachmentName = path.split("/").pop()
    root.attachmentChat = belongs
    // A recording is a voice note; a file the user picked is a file. It
    // changes with the attachment, never apart from it.
    root.attachmentIsVoice = voice === true
  }

  // Staging a file: the name it travels with, whether it is a voice note and
  // the conversation it was picked for belong to the request, not to the last
  // one. A temporary says so too, so the copy takes it away once it is there.
  function stageFile(path, name, voice, temporary, chat) {
    root.stagingQueue = root.stagingQueue.concat([
      { path: path, name: name || "", voice: voice === true, temporary: temporary === true, chat: chat || "" }
    ])
    root.startStaging()
  }

  function startStaging() {
    if (stager.running || root.stagingQueue.length === 0) return
    var request = root.stagingQueue[0]
    stager.source = request.path
    stager.name = request.name
    stager.temporary = request.temporary
    stager.running = true
  }

  // The message on its way is given up on: the composer is free again, and
  // what is in it stays.
  function releasePendingSend() {
    if (!root.pendingSend) return
    root.pendingSend = null
    sendWatchdog.stop()
  }

  // A voice note is played where it sits. A second press stops it.
  function toggleAudio(message) {
    if (!message || !message.imagePath) return
    if (root.playingMessageId === message.id) {
      player.stop()
      root.playingMessageId = ""
      return
    }
    player.source = Qt.resolvedUrl("file://" + message.imagePath)
    player.play()
    root.playingMessageId = message.id
  }

  function startRecording() {
    if (root.recording) return
    // A recording is a private thing: it is only written where the user
    // alone can read it.
    if (root.recordingDir.length === 0) {
      root.statusLine = "There is no private directory to record into"
      return
    }
    // Every recording gets a name of its own: there is one panel per monitor,
    // and two of them recording at the same time must not write over each
    // other.
    var path = root.recordingDir + "/omarchy-whatsapp-voice-"
      + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".m4a"
    recorder.outputLocation = "file://" + path
    recorder.record()
    root.recording = true
    root.recordingPath = path
    // The conversation the recording is made in: the copy is made long after
    // the recording stopped, and it goes with this one.
    root.recordingChat = root.activeJid
  }

  // A phone plays a voice note in place, and WhatsApp only takes opus for
  // that. Qt cannot write opus here, so the recording is converted before it
  // is attached; without the converter the recording goes as a file.
  function stopRecording() {
    if (!root.recording) return
    root.recording = false
    // The file has to be finished writing before it is converted, so the
    // conversion waits for the recorder to stop.
    root.waitingForRecording = true
    recorder.stop()
  }

  function convertRecording() {
    var source = root.recordingPath
    var target = source.replace(/\.m4a$/, "") + ".opus"
    converter.source = source
    converter.target = target
    converter.running = true
  }

  // A temporary the panel made goes away with the panel's own hands.
  function discardRecording(path) {
    if (!path || path.length === 0) return
    cleaner.path = path
    cleaner.running = true
  }

  FileDialog {
    id: fileDialog
    title: "Send a file"
    onAccepted: {
      var url = String(selectedFile || "")
      if (url.length === 0) return
      // The decoding lives in the model, where it is tested: a name with a
      // stray percent sign must not take the dialog down with it.
      var path = Model.filePathFromUrl(url)
      if (path.length === 0) return
      // The conversation the file is picked for is the one that is open now.
      root.stageFile(path, "", false, false, root.activeJid)
    }
  }

  function openWebClient() {
    webLauncher.running = true
  }

  function finishRefresh() {
    refreshWatchdog.stop()
    root.refreshing = false
    if (root.statusLine === "Refreshing\u2026") root.statusLine = ""
  }

  function refreshChats() {
    if (!root.client || root.showLogin || root.refreshing) return
    if (!root.client.linkUp) {
      root.statusLine = "Daemon offline"
      return
    }
    root.refreshing = true
    root.statusLine = "Refreshing\u2026"
    var ok = root.client.refreshInbox(
      root.view === "chat" ? root.activeJid : "",
      root.chatLimit,
      root.messageLimit
    )
    if (!ok) {
      root.refreshing = false
      root.statusLine = "Not connected"
      return
    }
    refreshWatchdog.restart()
  }

  function patchMessage(messageId, fields) {
    var list = root.messages.slice()
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === messageId) {
        var next = Object.assign({}, list[i], fields)
        if (fields.status !== undefined)
          next.status = Math.max(list[i].status || 0, fields.status || 0)
        list[i] = next
        var atEnd = messageList.atYEnd || root.pinToLatest
        var y = messageList.contentY
        root.messages = list
        Qt.callLater(function () {
          if (atEnd) {
            root.pinToLatest = true
            messageList.positionViewAtEnd()
          } else {
            messageList.contentY = y
          }
        })
        return true
      }
    }
    return false
  }

  function appendMessage(message) {
    if (!message) return
    if (root.patchMessage(message.id, message)) return
    var list = root.messages.slice()
    list.push(message)
    root.pinToLatest = true
    root.messages = list
    Qt.callLater(function () { messageList.positionViewAtEnd() })
  }

  onOpenedChanged: {
    if (!root.opened) return
    root.statusLine = ""
    if (root.client) {
      root.client.refresh()
      root.client.requestChats(root.chatLimit)
      if (root.view === "chat" && root.activeJid) {
        root.client.loadMessages(root.activeJid, root.messageLimit)
        root.client.markRead(root.activeJid)
        Qt.callLater(function () { composer.forceActiveFocus() })
      }
    }
  }

  Connections {
    target: root.client
    enabled: root.client !== null

    function onMessagesLoaded(jid, chat, messages) {
      if (jid !== root.activeJid) return
      root.activeChat = chat
      root.pinToLatest = true
      root.messages = messages || []
      Qt.callLater(function () { messageList.positionViewAtEnd() })
      if (root.refreshing) root.finishRefresh()
    }

    function onChatsChanged() {
      if (root.refreshing && root.view !== "chat") root.finishRefresh()
      if (/^(Adding to|Removing from)/.test(root.statusLine)) root.statusLine = ""
    }

    function onMessageArrived(jid, message, chat) {
      if (jid !== root.activeJid) return
      if (chat) root.activeChat = chat
      root.appendMessage(message)
      // The conversation is on screen, so the message is read the moment it
      // lands rather than sitting as an unread the user has already seen.
      if (root.opened && root.client && root.client.ready) root.client.markRead(jid)
    }

    function onSendAcknowledged(jid, id) {
      // The daemon took the message: now the composer can let go of it.
      // Only the message that was acknowledged: an answer for another one
      // says nothing about what is in the composer now.
      if (!root.pendingSend || root.pendingSend.id !== id) return
      // The text went with the message as soon as it was handed over, so
      // what is in the composer now is the next message and it stays. Only
      // the file that went out goes with it, and only if it is still there.
      if (root.attachmentPath === root.pendingSend.path) root.clearAttachment()
      root.releasePendingSend()
    }

    function onLinkUpChanged() {
      // The daemon went away: the message that was on its way did not go
      // out, and the composer is free again. What is in it stays.
      if (!root.client || root.client.linkUp) return
      root.releasePendingSend()
    }

    function onMessageStatusChanged(jid, messageId, status) {
      // Receipt JIDs are often a LID or device-suffixed form that does not
      // equal activeJid. Apply by message id in the open thread.
      root.patchMessage(messageId, { status: status })
    }

    function onMessageMedia(jid, messageId, imagePath) {
      if (jid !== root.activeJid || !imagePath) return
      root.patchMessage(messageId, { imagePath: imagePath })
    }

    function onCommandFailed(command, message, id) {
      if (command === "send" || command === "sendMedia" || command === "listMember") root.statusLine = message
      // The daemon refused it: the caption goes back, so trying again does
      // not mean typing it all again. It does not go over what was typed
      // since, and the file stays where it is: it can be tried again.
      if (Model.failureFreesSend(command, root.pendingSend, id)) {
        composer.text = Model.restoredAfterFailure(composer.text, root.pendingSend.text)
        root.releasePendingSend()
      }
      if (command === "refresh") {
        root.refreshing = false
        refreshWatchdog.stop()
        if (message && message.indexOf("unknown command") !== -1 && root.client) {
          root.client.requestChats(root.chatLimit)
          if (root.view === "chat" && root.activeJid)
            root.client.loadMessages(root.activeJid, root.messageLimit)
          root.statusLine = ""
          return
        }
        root.statusLine = message || "Refresh failed"
      }
    }
  }

  // The voice note being played.
  AudioOutput {
    id: playbackOutput
    volume: 0.9
  }

  MediaPlayer {
    id: player
    audioOutput: playbackOutput
    // The player has no stopped signal: the state is a property, and the note
    // that was playing is over when it goes back to stopped.
    onPlaybackStateChanged: {
      if (playbackState === MediaPlayer.StoppedState && root.playingMessageId !== "") {
        root.playingMessageId = ""
      }
    }
    onErrorOccurred: function (error, errorString) {
      root.playingMessageId = ""
      root.statusLine = "Could not play the voice note: " + errorString
    }
  }

  // The recording, and the microphone it comes from.
  //
  // The session has no way of saying that it failed: it only says when the
  // things plugged into it change. The recorder is the one that knows, and it
  // says it here.
  CaptureSession {
    id: captureSession
    audioInput: AudioInput {}
    recorder: MediaRecorder {
      id: recorder
      outputLocation: ""
      onErrorOccurred: function (error, errorString) {
        // A microphone that is absent, busy or refused ends up here.
        root.recording = false
        root.waitingForRecording = false
        root.statusLine = "The recording failed: " + errorString
      }
      // The recorder has no "state" signal: the state is a property, and it
      // is called recorderState.
      onRecorderStateChanged: {
        // The error is sometimes only on the property.
        if (recorder.error !== MediaRecorder.NoError) {
          root.recording = false
          root.waitingForRecording = false
          root.statusLine = "The recording failed: " + recorder.errorString
          return
        }
        if (recorderState !== MediaRecorder.StoppedState) return
        if (!root.waitingForRecording) return
        root.waitingForRecording = false
        root.convertRecording()
      }
    }
  }

  // The daemon runs with a private /tmp, so a file that is going out is
  // copied where it can read it before it is sent.
  Process {
    id: stager
    property string source: ""
    property string name: ""
    // A temporary goes away with its copy: the copy is what travels.
    property bool temporary: false
    property var argv: {
      var list = [root.pluginDir + "/bin/omarchy-whatsapp-stage.mjs", stager.source, stager.name]
      if (stager.temporary) list.push("--remove-source")
      return list
    }
    command: stager.argv
    stdout: SplitParser {
      onRead: function (data) {
        var path = String(data || "").trim()
        var request = root.stagingQueue.length > 0 ? root.stagingQueue[0] : null
        if (path.length === 0 || !request) return
        root.attachFile(path, request.chat, request.voice)
      }
    }
    onExited: function (exitCode) {
      if (root.stagingQueue.length > 0) root.stagingQueue = root.stagingQueue.slice(1)
      if (exitCode !== 0) root.statusLine = "Could not read the file to send"
      root.startStaging()
    }
  }

  // Opus, because that is what a voice note is.
  Process {
    id: converter
    property string source: ""
    property string target: ""
    command: ["ffmpeg", "-y", "-loglevel", "error", "-i", converter.source, "-c:a", "libopus", "-b:a", "32k", converter.target]
    onExited: function (exitCode) {
      if (exitCode === 0) {
        // The converted note is a temporary: the copy that travels replaces
        // it. The recording it came from has nothing left to do either.
        root.stageFile(converter.target, "voice-note.opus", true, true, root.recordingChat)
        root.discardRecording(converter.source)
        root.statusLine = ""
        return
      }
      // Without opus the recording is not a voice note: WhatsApp plays a voice
      // note in place and this one would not play at all. It goes as a file,
      // and the person sending it is told that is what happened.
      root.stageFile(converter.source, "voice-note.m4a", false, true, root.recordingChat)
      root.statusLine = "The recording could not be turned into a voice note; it goes as a file"
    }
  }

  // The raw recording is a temporary the panel made, so the panel is the one
  // that takes it away.
  Process {
    id: cleaner
    property string path: ""
    command: ["rm", "-f", cleaner.path]
  }

  Process {
    id: linkLauncher
    property string targetUrl: ""
    command: ["xdg-open", targetUrl]
    function open(url) {
      targetUrl = url
      running = true
    }
  }

  Process {
    id: webLauncher
    command: [root.pluginDir + "/bin/omarchy-whatsapp-open", root.setting("webAppUrl", "https://web.whatsapp.com")]
  }

  Process {
    id: daemonStarter
    command: ["systemctl", "--user", "start", "omarchy-whatsapp.service"]
    onExited: function (exitCode) {
      if (exitCode !== 0 && root.client) root.client.startDaemon()
    }
  }

  // Coalesces keystrokes into one "composing" presence, then one "paused" a
  // few seconds after the user stops.
  Timer {
    id: typingTimer
    interval: 3000
    repeat: false
    onTriggered: if (root.client && root.activeJid) root.client.setTyping(root.activeJid, "paused")
  }

  // The daemon always answers, but it can take a while: a file of sixteen
  // megabytes goes up on a connection that is not always quick. The message
  // stays on its way until the answer arrives, so it is not sent twice. If
  // the daemon is gone, the message did not go out and the composer is free
  // again.
  Timer {
    id: sendWatchdog
    // How often the panel says the message is still on its way. It is not a
    // deadline: nothing is given up on when it passes.
    interval: 30000
    repeat: false
    onTriggered: {
      if (root.client && Model.daemonStillThere(root.client.linkUp)) {
        // The daemon is still there: the upload is probably still running.
        root.statusLine = "The message is still on its way"
        sendWatchdog.restart()
        return
      }
      root.releasePendingSend()
      // The daemon is not answering at all, and it is the one that sends.
      // It has to be started again for anything else to go out.
      root.statusLine = "The daemon is not answering; it has to be started again"
    }
  }

  Timer {
    id: refreshWatchdog
    interval: 8000
    repeat: false
    onTriggered: root.finishRefresh()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Composer, logout confirm, and image peek own keys while they are up.
      blocked: composer.activeFocus || root.logoutConfirmOpen || root.peekActive || root.listPickerOpen

      onCloseRequested: {
        if (root.peekActive) root.peekImagePath = ""
        else if (root.logoutConfirmOpen) root.cancelLogout()
        else if (root.view === "chat") root.back()
        else root.close()
      }
      // Tab walks the chat lists, like the filter chips in WhatsApp.
      onTabRequested: function (direction) {
        if (root.view === "chats" && !root.showLogin) root.cycleList(direction)
        else root.switchPanel(direction)
      }
      onMoveRequested: function (dx, dy) { root.moveCursor(dy) }
      onActivateRequested: root.activateCursor()
      onTextKey: function (text) {
        if (text === "r" || text === "R") root.refreshChats()
      }

      // PanelKeyCatcher reports Shift+Up/Down as plain Up/Down and takes "l"
      // as "move right", so these are shortcuts, which run before item key
      // handling.
      Shortcut {
        sequences: ["Shift+Up", "Shift+K"]
        enabled: root.opened && root.view === "chats" && !keyCatcher.blocked
        onActivated: root.movePinnedChat(-1)
      }
      Shortcut {
        sequences: ["Shift+Down", "Shift+J"]
        enabled: root.opened && root.view === "chats" && !keyCatcher.blocked
        onActivated: root.movePinnedChat(1)
      }
      Shortcut {
        sequence: "L"
        enabled: root.opened && root.view === "chats" && !keyCatcher.blocked
        onActivated: root.openListPicker()
      }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        // ── Header ───────────────────────────────────────────────────────
        Item {
          width: parent.width
          implicitHeight: Math.max(headerText.implicitHeight, backButton.height, headerActions.implicitHeight)

          Rectangle {
            id: backButton
            visible: root.view === "chat"
            width: Style.space(26)
            height: Style.space(26)
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            radius: 0
            color: backMouse.containsMouse
              ? Style.hoverFillFor(root.foreground, root.bar ? root.bar.urgent : Commons.Color.accent)
              : Style.normalFillFor(root.foreground, Commons.Color.accent)
            border.color: root.foreground
            border.width: 1

            Text {
              anchors.centerIn: parent
              text: "\uf060"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.icon
            }

            MouseArea {
              id: backMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.back()
            }
          }

          Column {
            id: headerText
            anchors.left: backButton.visible ? backButton.right : parent.left
            anchors.leftMargin: backButton.visible ? Style.space(8) : 0
            anchors.verticalCenter: parent.verticalCenter
            anchors.right: headerActions.left
            anchors.rightMargin: Style.space(8)
            spacing: Style.space(1)

            Text {
              width: parent.width
              text: root.view === "chat"
                ? Model.chatTitle(root.activeChat || { jid: root.activeJid, name: "" })
                : "WhatsApp"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
              elide: Text.ElideRight
            }

            Text {
              width: parent.width
              text: {
                if (root.statusLine.length > 0) return root.statusLine
                if (root.view === "chat") return ""
                if (root.needsLogin) return root.hasQr ? "Scan the QR code" : ""
                var unread = root.client ? root.client.unread : 0
                return unread > 0 ? unread + " unread" : ""
              }
              visible: text.length > 0
              color: root.statusLine.length > 0 ? (root.bar ? root.bar.urgent : Commons.Color.urgent) : root.secondaryForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          Row {
            id: headerActions
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            PanelActionButton {
              objectName: "notificationBell"
              iconText: root.alertsEnabled ? "\uf0f3" : "\uf1f6"
              tooltipText: root.alertsEnabled ? "Mute notifications and sound" : "Enable notifications and sound"
              enabled: !root.notificationUpdatePending
              focusable: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.toggleNotifications()
            }

            PanelActionButton {
              visible: !root.showLogin
              iconText: "\uf021"
              tooltipText: root.view === "chat" ? "Refresh this conversation" : "Refresh chats"
              enabled: root.linked && !root.refreshing
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.refreshChats()
            }

            PanelActionButton {
              iconText: "\uf24d"
              tooltipText: "Open the full WhatsApp Web client"
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: {
                root.openWebClient()
                root.close()
              }
            }

            PanelActionButton {
              visible: !root.showLogin && root.view === "chats"
              iconText: "\uf011"
              tooltipText: "Log out of WhatsApp"
              foreground: root.foreground
              hoverColor: root.bar ? root.bar.urgent : Commons.Color.urgent
              fontFamily: root.fontFamily
              onClicked: root.requestLogout()
            }
          }
        }

        PanelSeparator { foreground: root.foreground }

        // ── Login ────────────────────────────────────────────────────────
        Column {
          width: parent.width
          spacing: Style.space(8)
          visible: root.showLogin

          Image {
            id: qrImage
            visible: root.hasQr && qrImage.status === Image.Ready
            width: Math.min(parent.width, Style.space(220))
            height: width
            anchors.horizontalCenter: parent.horizontalCenter
            fillMode: Image.PreserveAspectFit
            source: root.hasQr && root.client && root.client.qrPng
              ? Qt.resolvedUrl("file://" + root.client.qrPng)
              : ""
          }

          Text {
            width: parent.width
            visible: root.hasQr
            horizontalAlignment: Text.AlignHCenter
            text: "WhatsApp \u2192 Linked devices \u2192 Link a device"
            color: root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            width: parent.width
            visible: !root.hasQr && root.client && root.client.pendingLogin
            horizontalAlignment: Text.AlignHCenter
            text: "Getting QR code\u2026"
            color: root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Button {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: !root.hasQr
            text: "Login"
            foreground: root.foreground
            fontFamily: root.fontFamily
            bordered: true
            onClicked: {
              if (!root.daemonOnline) daemonStarter.running = true
              if (root.client) root.client.startLogin()
            }
          }
        }

        // ── Chat list ────────────────────────────────────────────────────
        Column {
          width: parent.width
          spacing: Style.space(4)
          visible: !root.showLogin && root.view === "chats"

          ListView {
            id: listStrip
            width: parent.width
            height: Style.space(24)
            orientation: ListView.Horizontal
            spacing: Style.space(4)
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentWidth > width
            model: root.listTabs
            currentIndex: root.activeListIndex

            delegate: Rectangle {
              id: listChip
              required property var modelData
              required property int index
              readonly property bool active: listChip.index === root.activeListIndex

              width: chipLabel.implicitWidth + Style.space(16)
              height: ListView.view.height
              radius: height / 2
              color: listChip.active
                ? Style.selectedFillFor(root.foreground, root.bar ? root.bar.urgent : Commons.Color.accent)
                : chipMouse.containsMouse
                  ? Style.hoverFillFor(root.foreground, root.bar ? root.bar.urgent : Commons.Color.accent)
                  : Style.normalFillFor(root.foreground, Commons.Color.accent)
              border.color: listChip.active ? (root.bar ? root.bar.urgent : Commons.Color.accent) : "transparent"
              border.width: 1

              Text {
                id: chipLabel
                anchors.centerIn: parent
                text: listChip.modelData.name
                color: listChip.active ? root.foreground : root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: listChip.active
              }

              MouseArea {
                id: chipMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.selectList(listChip.index)
              }
            }
          }

          Text {
            width: parent.width
            visible: root.visibleChats.length === 0
            text: root.activeListIndex === 0 ? "No conversations yet." : "No chats in this list."
            color: root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          ListView {
            id: chatList
            width: parent.width
            visible: root.visibleChats.length > 0
            height: Math.min(contentHeight, Style.space(300))
            model: root.visibleChats
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentHeight > height
            currentIndex: root.cursorIndex
            spacing: Style.space(1)
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            delegate: Item {
              id: chatSlot
              required property var modelData
              required property int index

              // The last pinned chat carries a divider below it, outside the
              // row so the cursor highlight never covers it.
              readonly property bool lastPinned: {
                if ((chatSlot.modelData.pinned || 0) <= 0) return false
                var next = root.visibleChats[chatSlot.index + 1]
                return next !== undefined && (next.pinned || 0) <= 0
              }

              width: ListView.view.width
              height: chatRow.height + (chatSlot.lastPinned ? pinDivider.height + Style.space(6) : 0)

              PanelSeparator {
                id: pinDivider
                visible: chatSlot.lastPinned
                anchors.bottom: parent.bottom
                anchors.bottomMargin: Style.space(2)
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(8)
                width: undefined
                foreground: root.foreground
                strength: 0.25
              }

              CursorSurface {
                id: chatRow
                readonly property var modelData: chatSlot.modelData
                readonly property int index: chatSlot.index

                width: parent.width
                implicitHeight: rowText.implicitHeight + Style.space(10)
                height: implicitHeight
                foreground: root.foreground
                accent: root.bar ? root.bar.urgent : Commons.Color.accent
                hasCursor: root.cursorIndex === chatRow.index

                Column {
                  id: rowText
                  anchors.left: parent.left
                  anchors.right: rowMeta.left
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.space(8)
                  anchors.rightMargin: Style.space(6)
                  spacing: Style.space(1)

                  Text {
                    width: parent.width
                    text: Model.chatTitle(chatRow.modelData)
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: (chatRow.modelData.unread || 0) > 0
                    elide: Text.ElideRight
                  }

                  Text {
                    width: parent.width
                    text: Model.truncate(Model.chatPreview(chatRow.modelData), 64)
                    color: root.secondaryForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }

                Column {
                  id: rowMeta
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.rightMargin: Style.space(8)
                  spacing: Style.space(2)
                  width: Math.max(badge.implicitWidth, stamp.implicitWidth)

                  Text {
                    id: stamp
                    anchors.right: parent.right
                    text: {
                      var stampText = Model.chatTimestamp(chatRow.modelData.lastTs)
                      if ((chatRow.modelData.pinned || 0) <= 0) return stampText
                      return stampText.length > 0 ? stampText + " \uf08d" : "\uf08d"
                    }
                    color: root.secondaryForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  Rectangle {
                    id: badge
                    anchors.right: parent.right
                    visible: (chatRow.modelData.unread || 0) > 0
                    implicitWidth: badgeLabel.implicitWidth + Style.space(8)
                    implicitHeight: badgeLabel.implicitHeight + Style.space(2)
                    width: implicitWidth
                    height: implicitHeight
                    radius: height / 2
                    color: root.bar ? root.bar.urgent : Commons.Color.urgent

                    Text {
                      id: badgeLabel
                      anchors.centerIn: parent
                      text: Model.badgeText(chatRow.modelData.unread)
                      color: Commons.Color.background
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                    }
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onContainsMouseChanged: if (containsMouse) root.cursorIndex = chatRow.index
                  onClicked: root.selectChat(chatRow.modelData.jid)
                }
              }
            }
          }
        }

        // ── Key hints ────────────────────────────────────────────────────
        Text {
          width: parent.width
          visible: !root.showLogin && root.view === "chats"
          horizontalAlignment: Text.AlignHCenter
          text: "tab lists \u00b7 \u21e7\u2191\u2193 reorder pins \u00b7 l edit lists \u00b7 r refresh"
          color: root.secondaryForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        // ── Conversation ─────────────────────────────────────────────────
        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: !root.showLogin && root.view === "chat"

          ListView {
            id: messageList
            width: parent.width
            height: Style.space(300)
            model: root.messages
            clip: true
            spacing: Style.space(4)
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            onMovementEnded: root.pinToLatest = atYEnd
            onContentHeightChanged: if (root.pinToLatest) Qt.callLater(function () { messageList.positionViewAtEnd() })

            delegate: Column {
              id: messageRow
              required property var modelData
              required property int index

              width: ListView.view.width
              spacing: Style.space(3)

              readonly property var previous: messageRow.index > 0 ? root.messages[messageRow.index - 1] : null
              readonly property bool showDay: !messageRow.previous
                || !Model.sameDay(messageRow.previous.ts, messageRow.modelData.ts)

              Text {
                width: parent.width
                visible: messageRow.showDay
                horizontalAlignment: Text.AlignHCenter
                text: Model.dayLabel(messageRow.modelData.ts)
                color: root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Item {
                id: bubbleRow
                width: parent.width
                implicitHeight: bubble.height
                height: implicitHeight

                readonly property real pad: Style.space(8)
                // Each label's width comes from its own natural (unwrapped)
                // implicitWidth, and the bubble from those labels. Anchoring the
                // content to both bubble edges instead would make the bubble's
                // width depend on content that depends on the bubble: a binding
                // loop, which collapses every bubble to a few pixels.
                readonly property real maxInner: Math.max(Style.space(60), bubbleRow.width * 0.82 - bubbleRow.pad * 2)
                readonly property bool hasImage: messageRow.modelData.mediaKind !== "audio"
                  && String(messageRow.modelData.imagePath || "").length > 0
                // A voice note that made it to the disk can be played here.
                readonly property bool hasAudio: messageRow.modelData.mediaKind === "audio"
                  && String(messageRow.modelData.imagePath || "").length > 0
                readonly property bool showBody: {
                  var text = messageRow.modelData.text || ""
                  if (!text.length) return false
                  if (bubbleRow.hasImage && Model.isPhotoPlaceholder(text)) return false
                  // A voice note shows its button and its length instead.
                  if (bubbleRow.hasAudio) return false
                  return true
                }
                readonly property bool showSender: !messageRow.modelData.fromMe
                  && root.activeChat !== null
                  && root.activeChat.isGroup === true

                Rectangle {
                  id: bubble
                  width: bubbleContent.width + bubbleRow.pad * 2
                  height: bubbleContent.implicitHeight + bubbleRow.pad
                  anchors.right: messageRow.modelData.fromMe ? parent.right : undefined
                  anchors.left: messageRow.modelData.fromMe ? undefined : parent.left
                  radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(6)
                  color: messageRow.modelData.fromMe
                    ? Style.selectedFillFor(root.foreground, root.bar ? root.bar.urgent : Commons.Color.accent)
                    : Style.normalFillFor(root.foreground, Commons.Color.accent)

                  Column {
                    id: bubbleContent
                    x: bubbleRow.pad
                    y: bubbleRow.pad / 2
                    spacing: Style.space(1)
                    width: Math.max(
                      bubbleRow.showSender ? senderLabel.width : 0,
                      bubbleRow.hasImage ? photo.width : 0,
                      bubbleRow.hasAudio ? audioRow.width : 0,
                      bodyLabel.visible ? bodyLabel.width : 0,
                      Math.min(metaLabel.implicitWidth, bubbleRow.maxInner))

                    Text {
                      id: senderLabel
                      visible: bubbleRow.showSender
                      width: Math.min(implicitWidth, bubbleRow.maxInner)
                      text: messageRow.modelData.senderName || ""
                      color: root.bar ? root.bar.urgent : Commons.Color.accent
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                      elide: Text.ElideRight
                    }

                    Image {
                      id: photo
                      visible: bubbleRow.hasImage && photo.status !== Image.Error
                      width: Math.min(bubbleRow.maxInner, Style.space(220))
                      height: photo.sourceSize.height > 0
                        ? Math.min(Style.space(200), photo.sourceSize.height * (width / Math.max(1, photo.sourceSize.width)))
                        : Style.space(140)
                      fillMode: Image.PreserveAspectFit
                      asynchronous: true
                      cache: true
                      source: bubbleRow.hasImage
                        ? Qt.resolvedUrl("file://" + messageRow.modelData.imagePath)
                        : ""

                      MouseArea {
                        id: photoMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.peekImagePath = messageRow.modelData.imagePath

                        Rectangle {
                          anchors.fill: parent
                          color: photoMouse.containsMouse ? "#20ffffff" : "transparent"
                          radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(4)

                          Text {
                            anchors.centerIn: parent
                            visible: photoMouse.containsMouse
                            text: "\uf00e"
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.title
                            color: "#ffffff"
                          }
                        }
                      }
                    }

                    // A voice note: a button to play it, and how long it is.
                    Row {
                      id: audioRow
                      visible: bubbleRow.hasAudio
                      spacing: Style.space(6)
                      height: Math.max(audioButton.height, audioLength.implicitHeight)

                      Rectangle {
                        id: audioButton
                        width: Style.space(22)
                        height: width
                        radius: width / 2
                        color: root.playingMessageId === messageRow.modelData.id
                          ? (root.bar ? root.bar.urgent : Commons.Color.accent)
                          : "transparent"
                        border.color: root.foreground
                        border.width: 1

                        Text {
                          anchors.centerIn: parent
                          text: root.playingMessageId === messageRow.modelData.id ? "\uf04d" : "\uf04b"
                          color: root.playingMessageId === messageRow.modelData.id
                            ? (root.bar ? root.bar.barForeground : Commons.Color.background)
                            : root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                        }

                        TapHandler {
                          onTapped: root.toggleAudio(messageRow.modelData)
                        }
                      }

                      Text {
                        id: audioLength
                        text: Model.formatDuration(messageRow.modelData.mediaSeconds)
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                        // The row is a positioner: it places its children, so
                        // this one must not ask for anchors as well.
                        verticalAlignment: Text.AlignVCenter
                      }
                    }

                    Text {
                      id: bodyLabel
                      visible: bubbleRow.showBody
                      width: Math.min(implicitWidth, bubbleRow.maxInner)
                      textFormat: Text.StyledText
                      text: Model.formatMessageText(messageRow.modelData.text, root.bar ? root.bar.urgent : Commons.Color.accent)
                      color: root.foreground
                      linkColor: root.bar ? root.bar.urgent : Commons.Color.accent
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      wrapMode: Text.Wrap
                      onLinkActivated: function (link) {
                        if (link) {
                          if (!Qt.openUrlExternally(link)) linkLauncher.open(link)
                        }
                      }

                      MouseArea {
                        anchors.fill: parent
                        acceptedButtons: Qt.NoButton
                        hoverEnabled: true
                        cursorShape: bodyLabel.hoveredLink.length > 0 ? Qt.PointingHandCursor : Qt.IBeamCursor
                      }
                    }

                    Text {
                      id: metaLabel
                      width: parent.width
                      horizontalAlignment: Text.AlignRight
                      text: {
                        var stampText = Model.messageTimestamp(messageRow.modelData.ts)
                        if (!messageRow.modelData.fromMe) return stampText
                        return stampText + " " + Model.statusGlyph(messageRow.modelData.status)
                      }
                      color: messageRow.modelData.fromMe && Model.statusIsRead(messageRow.modelData.status)
                        ? (root.bar ? root.bar.urgent : Commons.Color.accent)
                        : root.secondaryForeground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                }
              }
            }
          }

          Text {
            width: parent.width
            visible: root.messages.length === 0
            text: "No messages loaded yet."
            color: root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          // ── Inline reply ───────────────────────────────────────────────
          //
          // What is about to be sent, so it can be seen and taken back.
          Rectangle {
            id: attachmentChip
            visible: root.attachmentPath.length > 0
            width: attachmentRow.implicitWidth + Style.space(12)
            height: attachmentRow.implicitHeight + Style.space(6)
            radius: Style.cornerRadius
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: composerRow.top
            anchors.bottomMargin: Style.space(4)

            Row {
              id: attachmentRow
              anchors.centerIn: parent
              spacing: Style.space(6)

              Text {
                text: root.attachmentName
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideMiddle
              }
              Text {
                text: "\u00d7"
                color: root.secondaryForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            TapHandler {
              onTapped: root.clearAttachment()
            }
          }

          Item {
            id: composerRow
            width: parent.width
            implicitHeight: Math.max(composer.implicitHeight, sendButton.implicitHeight)

            TextField {
              id: composer
              objectName: "messageComposer"
              anchors.left: parent.left
              anchors.right: attachButton.left
              anchors.rightMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
              foreground: root.foreground
              accent: root.bar ? root.bar.urgent : Commons.Color.accent
              placeholderText: root.linked ? "Reply\u2026" : "Not connected"
              enabled: root.linked
              onAccepted: root.sendReply()
              onTextChanged: {
                if (!root.client || !root.activeJid || !text.length) return
                if (!typingTimer.running) root.client.setTyping(root.activeJid, "composing")
                typingTimer.restart()
              }
              Keys.onEscapePressed: function (event) {
                if (composer.text.length > 0) composer.text = ""
                else root.back()
                event.accepted = true
              }
            }

            PanelActionButton {
              id: attachButton
              anchors.right: recordButton.left
              anchors.rightMargin: Style.space(4)
              anchors.verticalCenter: parent.verticalCenter
              iconText: "\uf0c6"
              tooltipText: "Attach an image or a file"
              enabled: root.linked
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: fileDialog.open()
            }

            // Record a voice note, right here. A second press stops it and
            // attaches what was recorded.
            PanelActionButton {
              id: recordButton
              anchors.right: sendButton.left
              anchors.rightMargin: Style.space(4)
              anchors.verticalCenter: parent.verticalCenter
              iconText: root.recording ? "\uf04d" : "\uf130"
              tooltipText: root.recording ? "Stop recording" : "Record a voice note"
              enabled: root.linked
              foreground: root.recording ? (root.bar ? root.bar.urgent : Commons.Color.accent) : root.foreground
              fontFamily: root.fontFamily
              onClicked: {
                if (root.recording) root.stopRecording()
                else root.startRecording()
              }
            }

            PanelActionButton {
              id: sendButton
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              iconText: "\uf1d8"
              tooltipText: "Send"
              // A message that is still on its way is not sent twice.
              enabled: root.linked && Model.canSendNow(root.pendingSend)
                && (composer.text.trim().length > 0 || root.attachmentPath.length > 0)
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.sendReply()
            }
          }
        }
      }

      // ── List picker (l) ────────────────────────────────────────────────
      // A screenshot, a picture, a file: dropped anywhere on the panel, it
      // becomes the attachment. It sits beside the content rather than inside
      // it, because a positioner refuses anchors on its children.
      DropArea {
        id: dropArea
        anchors.fill: parent
        keys: ["text/uri-list"]
        onDropped: function (drop) {
          if (!drop.hasUrls || drop.urls.length === 0) return
          // The decoding lives in the model, where it is tested: a name with a
          // stray percent sign must not take the panel down with it.
          var path = Model.filePathFromUrl(String(drop.urls[0]))
          if (path.length === 0) return
          // The conversation the file is dropped in is the one that is open
          // now.
          root.stageFile(path, "", false, false, root.activeJid)
        }

        Rectangle {
          anchors.fill: parent
          visible: dropArea.containsDrag
          // Qt.rgba takes three numbers and an alpha, not a colour and an
          // alpha, so the colour is taken apart first.
          color: Qt.rgba(dropTint.r, dropTint.g, dropTint.b, 0.08)
          border.color: dropTint
          border.width: 2
          radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(6)
        }
      }

      Rectangle {
        id: listPicker
        visible: root.listPickerOpen
        anchors.fill: parent
        z: 10
        color: Qt.rgba(Commons.Color.background.r, Commons.Color.background.g, Commons.Color.background.b, 0.94)
        focus: root.listPickerOpen

        Keys.onPressed: function (event) {
          var count = root.customLists.length
          if (event.key === Qt.Key_Escape || event.text === "l" || event.text === "q") {
            root.closeListPicker()
          } else if (event.key === Qt.Key_Down || event.text === "j") {
            root.listPickerIndex = Math.min(count - 1, root.listPickerIndex + 1)
          } else if (event.key === Qt.Key_Up || event.text === "k") {
            root.listPickerIndex = Math.max(0, root.listPickerIndex - 1)
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space) {
            root.toggleListMembership(root.listPickerIndex)
          } else {
            return
          }
          event.accepted = true
        }

        MouseArea { anchors.fill: parent; onClicked: root.closeListPicker() }

        Column {
          anchors.centerIn: parent
          width: Math.min(parent.width - Style.space(40), Style.space(260))
          spacing: Style.space(4)

          Text {
            width: parent.width
            text: {
              var chat = root.pickerChat()
              return "Lists for " + (chat ? Model.chatTitle(chat) : "")
            }
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
            elide: Text.ElideRight
          }

          Repeater {
            model: root.customLists

            CursorSurface {
              id: pickerRow
              required property var modelData
              required property int index
              readonly property bool member: {
                var chat = root.pickerChat()
                return chat !== null && (chat.lists || []).indexOf(pickerRow.modelData.id) !== -1
              }

              width: parent.width
              height: pickerLabel.implicitHeight + Style.space(10)
              foreground: root.foreground
              accent: root.bar ? root.bar.urgent : Commons.Color.accent
              hasCursor: root.listPickerIndex === pickerRow.index

              Text {
                id: pickerLabel
                anchors.left: parent.left
                anchors.leftMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                text: (pickerRow.member ? "\uf14a  " : "\uf096  ") + pickerRow.modelData.name
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (containsMouse) root.listPickerIndex = pickerRow.index
                onClicked: root.toggleListMembership(pickerRow.index)
              }
            }
          }

          Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: "\u21b5 toggle  \u00b7  esc done"
            color: root.secondaryForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }

      ConfirmDialog {
        id: logoutConfirm
        anchors.fill: parent
        opened: root.logoutConfirmOpen
        z: 10
        focus: opened
        message: "Log out and unlink this device?"
        confirmText: "Log out"
        foreground: root.foreground
        fontFamily: root.fontFamily
        onCanceled: root.cancelLogout()
        onConfirmed: root.confirmLogout()

        Keys.onPressed: function (event) {
          if (handleKey(event)) event.accepted = true
        }
      }
    }
  }

  // ── Desktop Screen-Centered Image Peek Window ───────────────────────
  PanelWindow {
    id: imagePeekOverlay
    visible: root.peekActive
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "omarchy-whatsapp-peek"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.peekActive ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None

    onVisibleChanged: {
      if (visible) {
        Qt.callLater(function () { peekKeyCatcher.forceActiveFocus() })
      }
    }

    Rectangle {
      anchors.fill: parent
      color: Qt.rgba(0, 0, 0, 0.82)

      MouseArea {
        anchors.fill: parent
        onClicked: root.peekImagePath = ""
      }
    }

    Item {
      id: peekKeyCatcher
      anchors.fill: parent
      focus: root.peekActive

      Keys.onEscapePressed: function (event) {
        root.peekImagePath = ""
        event.accepted = true
      }

      Item {
        anchors.centerIn: parent
        width: Math.min(parent.width * 0.85, Style.space(950))
        height: Math.min(parent.height * 0.85, Style.space(850))

        Image {
          id: peekImage
          anchors.centerIn: parent
          width: Math.min(parent.width, sourceSize.width > 0 ? sourceSize.width : parent.width)
          height: Math.min(parent.height, sourceSize.height > 0 ? sourceSize.height : parent.height)
          fillMode: Image.PreserveAspectFit
          asynchronous: true
          source: root.peekActive ? Qt.resolvedUrl("file://" + root.peekImagePath) : ""

          MouseArea {
            anchors.fill: parent
            onClicked: function (event) { event.accepted = true }
          }
        }
      }
    }
  }
}
