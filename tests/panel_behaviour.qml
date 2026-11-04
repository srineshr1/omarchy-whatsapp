import QtQuick
import Quickshell
import QtTest

// The panel is loaded here, in a shell of its own, and the decisions it makes
// are checked.
//
// A QML object that cannot be created takes the whole panel with it, and the
// warning that says so is the only trace, so the panel is loaded and the log
// is read. And the rules the panel follows -- what it does with the composer,
// with a message that is on its way, with an answer that is about another
// message -- live in the panel and nowhere else, so they are checked here
// too, on the panel itself.

ShellRoot {
  TestCase { id: probe; when: false }
  // The bar of the shell is not here, so the panel gets one that says what
  // the panel needs and nothing more.
  QtObject {
    id: barStub
    property color barForeground: "#cacccc"
    property color foreground: "#cacccc"
    property color urgent: "#ff5555"
    property string fontFamily: "sans-serif"
    function switchPanelFrom() { return false }
  }

  // The client of the panel is not here either. This one answers what the
  // panel asks, says what it was asked, and has the signals the panel listens
  // to.
  QtObject {
    id: clientStub
    signal sendAcknowledged(string jid, string id)
    signal commandFailed(string command, string message, string id)
    signal messageArrived(string jid, var message, var chat)
    signal messageStatusChanged(string jid, string messageId, int status)
    signal messageMedia(string jid, string messageId, string imagePath)
    signal messagesLoaded(string jid, var chat, var messages)
    signal focusRequested(string jid)
    signal pairCodeReceived(string code)

    property bool ready: true
    property bool signedIn: true
    property bool daemonOnline: true
    property bool needsLogin: false
    property bool pairingStopped: false
    property bool pendingLogin: false
    property bool hasQr: false
    property bool linkUp: true
    property int chatsEpoch: 0
    property int unread: 0
    property var chats: []
    property var lists: []
    property string qrPng: ""

    property int sends: 0
    property string lastText: ""

    function sendMessage(jid, text) { sends += 1; lastText = text; return "r" + sends }
    function sendMedia(jid, path, caption, ptt) { sends += 1; lastText = caption; return "r" + sends }
    function setTyping(jid, state) {}
    function markRead(jid) {}
    function loadMessages(jid, limit) {}
    function requestChats(limit) {}
    function refreshInbox(jid) {}
    function refresh(limit) {}
    function movePin(jid, delta) {}
    function setListMember(jid, listId, member) {}
    function startDaemon() {}
    function startLogin() {}
    function logout() {}
  }

  Loader {
    id: loader
    source: "PANEL_PATH"

    onLoaded: Qt.callLater(runChecks)

    function runChecks() {
      loader.item.bar = barStub
      loader.item.client = clientStub
      loader.item.activeJid = "chat@s.whatsapp.net"
      var composer = probe.findChild(loader.item, "messageComposer")

      var failures = []
      function check(name, ok) { if (!ok) failures.push(name) }

      // A message is handed over: the composer lets go of the text, and the
      // panel remembers what it sent.
      composer.text = "hello"
      loader.item.sendReply()
      check("the composer lets go of the text", composer.text === "")
      check("the panel remembers the text", loader.item.pendingSend && loader.item.pendingSend.text === "hello")
      check("the client was asked once", clientStub.sends === 1)

      // A message that is on its way is not sent again, and what the user
      // writes meanwhile is theirs.
      composer.text = "again"
      loader.item.sendReply()
      check("the message on its way is not sent again", clientStub.sends === 1)
      check("what was written stays", composer.text === "again")

      // An answer about another message says nothing about this one.
      clientStub.sendAcknowledged("chat@s.whatsapp.net", "another")
      check("an answer about another message changes nothing", composer.text === "again")
      check("the message on its way is still on its way", loader.item.pendingSend !== null)

      // The answer about the message that is on its way frees the composer.
      var sent = loader.item.pendingSend.id
      clientStub.sendAcknowledged("chat@s.whatsapp.net", sent)
      check("the message on its way is released", loader.item.pendingSend === null)
      check("what was written after it stays", composer.text === "again")

      // A refusal puts the caption back, so trying again does not mean
      // writing it all over again.
      composer.text = "caption"
      loader.item.sendReply()
      var refused = loader.item.pendingSend.id
      composer.text = ""
      clientStub.commandFailed("sendMedia", "the file was refused", refused)
      check("the caption comes back", composer.text === "caption")
      check("the refused message is released", loader.item.pendingSend === null)

      // A file picked for another conversation does not go to this one.
      loader.item.attachmentPath = "/tmp/picked.png"
      loader.item.attachmentChat = "other@s.whatsapp.net"
      composer.text = "with a file"
      var before = clientStub.sends
      loader.item.sendReply()
      check("a file of another conversation is not sent", clientStub.sends === before)
      check("the panel says so", loader.item.statusLine.indexOf("another conversation") !== -1)

      if (failures.length > 0) {
        console.log("PANEL_BEHAVIOUR_FAIL " + failures.join(" | "))
        Qt.exit(1)
      }
      console.log("PANEL_BEHAVIOUR_OK")
      Qt.exit(0)
    }
  }
}
