# Feature: Send images and files from the WhatsApp bar panel

## Objective

Let the minimal version of the plugin upload images and files and send them: pick a
file in the panel, send it to the open conversation, and see it land as a WhatsApp
message.

## Branch

`feature/media-upload` (fork: `statick88/omarchy-whatsapp`, cloned at
`~/Projects/omarchy-whatsapp`)

## Delivery Strategy

`ask-on-risk`

## Test Runner

`node --test` (daemon unit and integration tests), `bash tests/test_lifecycle.sh`
(shell helpers), a live end-to-end send against the linked account, and `qmllint`
against the installed shell for the QML side.

---

## Specs

### S1: Sending media

In the minimal version I want to be able to upload images and files and send them.

- The panel's reply box gains an attach action: pick a file, it shows as an
  attachment, and sending delivers it to the open conversation.
- Images go out as images, anything else as a document, and a typed message
  travels with the file as its caption.
- The file that was picked is the file that is sent, with its own name.

### S2: Where the work happens

Crea un fork del repo oficial, clona el fork en Projects y trabaja sobre el con
esta funcionalidad.

- The upstream repository is `srineshr1/omarchy-whatsapp`.
- The fork is `statick88/omarchy-whatsapp`, cloned into `~/Projects/omarchy-whatsapp`.
- Every change lands in that clone, on a feature branch, not in the installed copy.

### S3: Proving it works

realiza Pruebas funcionales, TDD, e2e, de integracion

- Unit tests for the pure media logic: which kind a file is, the mime type, the
  size limit, the name that travels with it.
- Integration tests for the daemon: a request over the socket ends in a send.
- An end-to-end test: a real file reaches the real WhatsApp account.
- Functional tests: the CLI sends a file; the panel offers the action.

### S4: The workflow around it

creas con oddd y validas con rddd

- The work is tracked in this document, one task per behaviour.
- Each behaviour is written test first: the test fails, then the code makes it pass.
- The result is validated with a native review before it is delivered.

### S5: What must not break

- Text messages keep working exactly as before.
- The daemon keeps speaking the same newline-delimited JSON, so the bar panels on
  every monitor stay in sync.
- A file that cannot be sent says why, instead of failing silently.
- The plugin still validates and still installs from a source checkout.

---

## Tasks

| ID | Specs | Route | Commit | Evidence |
|----|-------|-------|--------|----------|
| T1 | S1, S3 | inline | a646456 | RED first: 16 unit tests failed with no module, then GREEN: 16 pass. The pure media logic in `daemon/lib/outgoing.js`. |
| T2 | S1, S3 | inline | a646456 | RED first: the integration test could not import `lib/send.js`, then GREEN: 6 tests over a real unix socket with a fake WhatsApp. |
| T3 | S1, S3 | inline | a646456 | `omarchy-whatsapp-ctl send-media <jid> <file> [caption]`. |
| T4 | S1, S5 | inline | 720e8ed | The paperclip, the file dialog, the chip, and the caption rule. qmllint clean. |
| T5 | S3 | inline | manual | End to end against the linked account: an image and a document both arrived. |
| T6 | S2, S4, S5 | inline | e174a20 | The README, this document, and the native review of the branch. |

---

## Log

### L1 (2026-10-20)

User requested: "muy bien ahora vamos a centrarnos en el plugin de whatsapp quiero
en la version minima poder subir imagnees, archivos y poder enviarlos, crea un fork
del repo oficial, clona el fork en Projects y trabaja sobre el con esta
funcionalidad, realiza Pruebas funcionales, TDD, e2e, de integracion, creas con oddd
y validas con rddd"

### L2 (2026-10-20)

Read the upstream plugin before designing anything:

- The daemon is Node + Baileys. It already downloads incoming images and stickers
  into a media cache; nothing sent media out yet.
- The daemon speaks NDJSON over a unix socket. The QML side sends
  `{ t: "send", jid, text }`; a new command has to fit the same shape.
- `sock.sendMessage(jid, { image: { url } })` is the Baileys call. `getStream`
  falls through to `createReadStream(item.url)` for a local path, so a path on disk
  is enough, no upload of bytes needed.
- A document needs its name and mime type at the message level, not inside the
  media object: `prepareWAMessageMedia` reads `uploadData.fileName`.
- Images need a thumbnail; Baileys computes one with `sharp`, which it depends on,
  so the image path works on a plain `npm install`.
- The panel's compose area is a `TextField` plus a send button in `Panel.qml`, and
  the socket client is `WhatsAppClient.qml`.

Fork created (`statick88/omarchy-whatsapp`) and cloned to
`~/Projects/omarchy-whatsapp`; branch `feature/media-upload`. The account is
linked and the daemon is running, so a real send can be tested against it.

### L3 (2026-10-20)

T1 and T2 done, both test first.

- `daemon/lib/outgoing.js` decides what a file becomes: its kind, the mime
  type from the extension, the name that travels with it, and whether WhatsApp
  would take it at all. Sixteen unit tests, written before the module existed.
- `daemon/lib/send.js` holds the command. It takes the socket and the store
  from the caller, which is what lets the command be driven over a real socket
  with a fake WhatsApp on the other end. Six integration tests that way.
- The daemon grew one command, `sendMedia`, and the block that shows a sent
  message in every panel was lifted into `deliverOutgoing`, so a file and a
  text arrive the same way. Text sending is otherwise untouched.

### L4 (2026-10-20)

T3 and T4 done.

- The CLI gained `send-media`.
- The panel gained a paperclip next to the reply box. It opens the platform's
  own file dialog, the name of what was picked shows under the box, and
  clicking that name takes the file back. A file on its own is a message: the
  text that was typed travels as its caption.
- A file the daemon refuses says why in the panel's status line, the same way
  a text message that cannot be sent already does.

### L5 (2026-10-20)

T5 done: the end-to-end test, against the real linked account.

- The daemon of this fork ran against the same credentials the service uses,
  so the session was the user's own.
- An image was sent to the account's own chat: it arrived as an
  `imageMessage`, with the caption, acknowledged by the server.
- A text file was sent the same way: it arrived as a `documentMessage` named
  `wa-test.txt`.
- Both messages show up in the conversation the daemon keeps.
- The service daemon was put back afterwards, and the account is linked and
  open again.
