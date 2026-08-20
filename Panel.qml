import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Wayland
import Quickshell.Io
import qs.Commons
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
  property bool pinToLatest: true
  property bool logoutConfirmOpen: false
  property bool refreshing: false
  property string peekImagePath: ""
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
  readonly property color foreground: root.bar ? root.bar.foreground : Color.foreground
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

  readonly property var visibleChats: {
    var epoch = root.client ? root.client.chatsEpoch : 0
    var list = root.chats || []
    if (epoch < 0) return []
    return list.slice(0, Math.max(1, root.chatLimit))
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

  function activateCursor() {
    if (root.view !== "chats") return
    var chat = root.chatAt(root.cursorIndex)
    if (chat) root.selectChat(chat.jid)
  }

  function sendReply() {
    var text = composer.text
    if (!text || !text.trim().length) return
    if (!root.client || !root.client.ready) {
      root.statusLine = "Not connected to WhatsApp"
      return
    }
    if (root.client.sendMessage(root.activeJid, text)) {
      composer.text = ""
      root.statusLine = ""
      typingTimer.stop()
      root.client.setTyping(root.activeJid, "paused")
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
    }

    function onMessageArrived(jid, message, chat) {
      if (jid !== root.activeJid) return
      if (chat) root.activeChat = chat
      root.appendMessage(message)
      // The conversation is on screen, so the message is read the moment it
      // lands rather than sitting as an unread the user has already seen.
      if (root.opened && root.client && root.client.ready) root.client.markRead(jid)
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

    function onCommandFailed(command, message) {
      if (command === "send") root.statusLine = message
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
      blocked: composer.activeFocus || root.logoutConfirmOpen || root.peekActive

      onCloseRequested: {
        if (root.peekActive) root.peekImagePath = ""
        else if (root.logoutConfirmOpen) root.cancelLogout()
        else if (root.view === "chat") root.back()
        else root.close()
      }
      onTabRequested: function (direction) { root.switchPanel(direction) }
      onMoveRequested: function (dx, dy) { root.moveCursor(dy) }
      onActivateRequested: root.activateCursor()
      onTextKey: function (text) {
        if (text === "r" || text === "R") root.refreshChats()
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
              ? Style.hoverFillFor(root.foreground, root.bar ? root.bar.urgent : Color.accent)
              : Style.normalFillFor(root.foreground, Color.accent)
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
              color: root.statusLine.length > 0 ? (root.bar ? root.bar.urgent : Color.urgent) : root.secondaryForeground
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
              hoverColor: root.bar ? root.bar.urgent : Color.urgent
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

          Text {
            width: parent.width
            visible: root.visibleChats.length === 0
            text: "No conversations yet."
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

            delegate: CursorSurface {
              id: chatRow
              required property var modelData
              required property int index

              width: ListView.view.width
              implicitHeight: rowText.implicitHeight + Style.space(10)
              height: implicitHeight
              foreground: root.foreground
              accent: root.bar ? root.bar.urgent : Color.accent
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
                  text: Model.chatTimestamp(chatRow.modelData.lastTs)
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
                  color: root.bar ? root.bar.urgent : Color.urgent

                  Text {
                    id: badgeLabel
                    anchors.centerIn: parent
                    text: Model.badgeText(chatRow.modelData.unread)
                    color: Color.background
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
                readonly property bool hasImage: messageRow.modelData.imagePath
                  && String(messageRow.modelData.imagePath).length > 0
                readonly property bool showBody: {
                  var text = messageRow.modelData.text || ""
                  if (!text.length) return false
                  if (bubbleRow.hasImage && Model.isPhotoPlaceholder(text)) return false
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
                    ? Style.selectedFillFor(root.foreground, root.bar ? root.bar.urgent : Color.accent)
                    : Style.normalFillFor(root.foreground, Color.accent)

                  Column {
                    id: bubbleContent
                    x: bubbleRow.pad
                    y: bubbleRow.pad / 2
                    spacing: Style.space(1)
                    width: Math.max(
                      bubbleRow.showSender ? senderLabel.width : 0,
                      bubbleRow.hasImage ? photo.width : 0,
                      bodyLabel.visible ? bodyLabel.width : 0,
                      Math.min(metaLabel.implicitWidth, bubbleRow.maxInner))

                    Text {
                      id: senderLabel
                      visible: bubbleRow.showSender
                      width: Math.min(implicitWidth, bubbleRow.maxInner)
                      text: messageRow.modelData.senderName || ""
                      color: root.bar ? root.bar.urgent : Color.accent
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

                    Text {
                      id: bodyLabel
                      visible: bubbleRow.showBody
                      width: Math.min(implicitWidth, bubbleRow.maxInner)
                      textFormat: Text.StyledText
                      text: Model.formatMessageText(messageRow.modelData.text, root.bar ? root.bar.urgent : Color.accent)
                      color: root.foreground
                      linkColor: root.bar ? root.bar.urgent : Color.accent
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
                        ? (root.bar ? root.bar.urgent : Color.accent)
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
          Item {
            width: parent.width
            implicitHeight: Math.max(composer.implicitHeight, sendButton.implicitHeight)

            TextField {
              id: composer
              anchors.left: parent.left
              anchors.right: sendButton.left
              anchors.rightMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
              foreground: root.foreground
              accent: root.bar ? root.bar.urgent : Color.accent
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
              id: sendButton
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              iconText: "\uf1d8"
              tooltipText: "Send"
              enabled: root.linked && composer.text.trim().length > 0
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.sendReply()
            }
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
