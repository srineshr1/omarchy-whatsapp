# Feature: Play, record and drop media in the WhatsApp panel

## Objective

Let the panel do with media what a phone does: play the voice notes that
arrive, record a voice note and send it, and take a file that is dropped on the
panel as the thing to send.

## Branch

`feature/audio-and-drop` (on top of `feature/media-upload`, which is on top of
the upstream `main`)

## Delivery Strategy

`ask-on-risk`

## Test Runner

`node --test` (daemon unit and integration tests), `bash tests/test_lifecycle.sh`,
`qmllint` against the installed shell, and the live panel.

---

## Specs

### S1: Hearing a voice note

verifica que pueda escuchar audios, sino implementa esta funcionalidad

- A voice note that arrives is downloaded like a picture is, and it can be
  played from where it sits in the conversation.
- The note says how long it is, and the button turns into a stop while it plays.
- A file that cannot be played says so instead of doing nothing.

### S2: Recording a voice note

tambien la posibilidad de enviar audios grabados en ese momento

- The panel can record, and what it records is sent as a voice note, the way a
  phone sends one: played in place, with no download.
- The recording is attached like any other file, so it goes with the
  conversation it was recorded in and can be thrown away.
- The recording is opus, because that is what a voice note is.

### S3: Dropping a file on the panel

y ya que puedo tomar capturas de pantalla poder arrastrar y soltar en el plugin
para poder enviar

- A file dropped on the panel becomes the attachment, the same way a file
  picked from the dialog does.
- A screenshot is a file, so it takes the same road.

### S4: What must not break

- Pictures still download and show as they did.
- Text messages are untouched.
- The daemon keeps speaking the same newline-delimited JSON.

### S5: What the README says has to be true

The README is the first thing a maintainer reads. Before this feature it said:

> Media is never downloaded — photos and voice notes show as `📷 Photo`,
> `🎤 Voice message`, and so on.

That sentence is false once the daemon downloads a voice note and the panel
plays it.

- The README describes how to play a voice note, how to record one and how to
  drop a file on the panel.
- The README does not claim that media is never downloaded.
- The README says where the media cache lives, because there is one now.

---

## Tasks

| ID | Specs | Route | Commit | Evidence |
|----|-------|-------|--------|----------|
| T1 | S1 | inline | 817e29b | `daemon/test/media.test.js`: a voice note is media the daemon can fetch, and it is written as an opus file. |
| T2 | S2 | inline | 817e29b | `daemon/test/sendmedia.test.js`: a recording goes out as a voice note, and the opus it becomes is a valid Ogg. |
| T3 | S3 | inline | 817e29b | `daemon/test/model.test.js`: a dropped url is the path of the file, and the file goes with the conversation it was dropped in. |
| T4 | S4 | inline | 58e5511, 97663e5 | The whole suite, qmllint and the live panel. |
| T5 | S5 | inline | 1106b8d | The README tells the truth about media. |
| T6 | S3, S4 | inline | 9f787be | A dropped file whose name holds a percent sign is still attached. |
| T7 | S2, S4 | inline | f9180a6 | A file that goes out does not stay behind. |
| T8 | S2 | inline | 65ad029 | The recording lands where only the user can read it. |
| T9 | S4 | inline | 5185627 | The comment above `statusGlyph` belongs to `statusGlyph`. |
| T10 | S1, S4 | inline | 4591e86 | A voice note that was sent shows a play button, not a label. |
| T11 | S4 | inline | c584dd3 | The staging executable says what it is. |
| T12 | S4 | inline | bfa2e4b | An acknowledgement only clears what it sent. |
| T13 | S2, S3 | inline | fd5743c | A file belongs to the conversation it was picked for. |
| T14 | S4 | inline | 44c845d | `daemon/test/model.test.js`: a message that is on its way is not sent twice, and the daemon still there keeps it there. |
| T15 | S2 | inline | 749bd2f | The recording is only written where the user alone can read it. |
| T16 | S4 | inline | 749bd2f | `daemon/test/model.test.js`: the message stays on its way while the daemon is there, and a failure frees the composer. |
| T17 | S4 | inline | eda26d1 | A staged copy stays inside the cache. |
| T18 | S4 | inline | 5b30962 | The daemon answers what actually happened. |
| T19 | S2, S3 | inline | 373d89e | The file goes with the conversation it was picked for. |
| T20 | S4 | inline | 9cc4c61 | The copies that were never sent are swept. |
| T21 | S4 | inline | a57060b | The text goes with the message, and only with it. |
| T22 | S2 | inline | d65d6e1 | The panel loads again, and the recorder says when it fails. |
| T23 | S4 | inline | 05772af | A send that never finishes says that nothing went out. |
| T24 | S4 | inline | 1126a3b | The deadline belonged to WhatsApp, not to the daemon. |

---

## Log

### L1 (2026-10-20)

User requested: "antes de enviar verifica que pueda escuchar audios, sino
implementa esta funcionalidad antes de enviar el pr" and, after that: "tambien la
posibilidad de enviar audios grabados en ese momento" and "y ya que puedo tomar
capturas de pantalla poder arrastrar y soltar en el plugin par poder enviar".

### L2 (2026-10-20)

Read the code before touching it. The plugin could not hear a voice note:

- `message.js` only extracted `imageMessage` and `stickerMessage`, so an
  `audioMessage` was never media the daemon could fetch.
- `media.js` only knew how to download a picture or a sticker.
- `Panel.qml` had no player at all: a voice note was the label
  "Voice message" and nothing else.

Measured what the machine can do before choosing:

- Qt's own player reads an opus file and plays it to the end
  (`MediaPlayer` with `AudioOutput`, `hasAudio: true`, the position reaches the
  duration), so the panel can play a voice note without another process.
- `paplay` also plays opus, but `pw-play` cannot find a target node here.
- The recorder works (`MediaRecorder.record()` and `stop()` write a file), but
  the backend cannot encode opus: `mediaFormat.isSupported(Opus, Encode)` is
  false, and the file Qt writes is an MP4 whatever the extension says. A phone
  only plays an opus voice note, so the recording is converted with ffmpeg,
  which is on the machine and encodes opus.
- There are microphones: two `alsa_input` sources through PipeWire.

So: the panel plays with Qt, records with Qt, and ffmpeg turns the recording
into the opus a voice note is.

### L3 (2026-10-20)

The three features, built test first:

- The daemon now extracts an `audioMessage` the way it extracts a picture, and
  downloads it as the opus a voice note is. `daemon/test/media.test.js` pins it.
- The panel plays a voice note where it sits, with its length next to it, and
  the button becomes a stop while it plays.
- The panel records, converts what it recorded into opus and attaches it, and a
  recording is marked as a voice note so the phone plays it in place.
- A file dropped on the panel becomes the attachment, the same way one picked
  from the dialog does.

### L4 (2026-10-20)

Two things the machine told us that the code could not:

- The daemon runs with `PrivateTmp=yes`, so it never saw a file picked in a
  terminal, dropped on the panel, or recorded there: the send failed with "file
  not found" for a file that was plainly there. A file on its way out is now
  copied into the directory both of them can see, and that copy is what is
  sent. `daemon/lib/staging.js` and `daemon/test/staging.test.js` pin it.
- `MediaPlayer` has no `stopped` signal in QML. The invalid assignment did not
  only warn: it failed the whole panel, so the plugin stopped opening at all.
  The state is a property, and that is what the code reads now.

### L5 (2026-10-20)

Verified against the real account, not only against the tests:

- A voice note sent to the account's own chat arrived as an `audioMessage`
  with its length, and the daemon downloaded it as an opus file.
- The panel shows it as a play button and `0:03`, next to the paperclip, the
  microphone and the send button.
- The same player, with the same file the daemon downloaded, plays it to the
  end: `hasAudio: true`, the position reaches the duration.
- Recording writes a file, and the conversion turns it into a valid
  Ogg/Opus, which is what a voice note is.
- 65 daemon tests, the lifecycle test and qmllint are green.

### L6 (2026-10-21)

The feature was green, so the rest was making it true. Reading the code
against the machine found four things:

- The README still said "Media is never downloaded — photos and voice notes
  show as `📷 Photo`, `🎤 Voice message`". That sentence became false the
  moment the daemon started downloading a voice note. T5.
- The drop handler called `decodeURIComponent` on the dropped URL with nothing
  around it. A file whose name holds a percent sign (`100%.png`) makes that
  call throw, and the drop is lost with the panel's handler broken. The file
  dialog had the same problem and did guard it; the drop did not. The
  decoding belongs in the Qt-free model, where it can be tested. T6.
- Every file that went out was copied into the media cache and left there.
  The cache already held 104 of them, and nothing ever removed one. T7.
- The recording landed in `/tmp` with a fixed name: two panels (one per
  monitor) recording at once wrote over each other, and `/tmp` is readable by
  every user on the machine. T8.

And one that is only a comment: the note about the Baileys status enum had
been left above `formatDuration` instead of above `statusGlyph`, which is the
function it describes. T9.

### L7 (2026-10-21)

The user recorded a voice note and said a bug happened. The recording itself
was fine — it went out as a real voice note (`ptt: true`, opus, 2 seconds) —
but the panel showed it as the plain label "🎤 Voice message" instead of a play
button. A screenshot of the panel showed three voice notes: the one that
arrived played (`▶ 0:03`), and the two that were sent did not.

The machine said why:

- The file was on disk the whole time: `~/.cache/omarchy-whatsapp/media/
  3EB093129A277272641E43.opus`, 10540 bytes, a valid Ogg/Opus.
- The stored message had no path: `imagePath` was empty.
- The panel draws a play button only when the message has a path, so an empty
  path is a label.

The path was lost in a race:

- The daemon sends the message, and the media cache starts downloading it.
- WhatsApp echoes the message back, and the echo is ingested **before** the
  download finishes. That copy knows no path, because there was no path yet.
- `store.upsertMessage` merges the echo over the stored message, and the
  empty path overwrote the good one.
- When the download finished, the cache wrote the path into the copy it held,
  which was no longer the copy the store held. The path went nowhere.

T10 fixes it in three places: the path is written where the message lives
when the download finishes, a copy that arrives without a path cannot take
the known one away, and the cache on disk is consulted before a message is
handed to the panel — the disk is the truth about a media, the store is only
a copy of it.

The panel was checked after the fix: the voice note that was sent shows
`▶ 0:02` with its own length, the same as the one that arrived.

### L8 (2026-10-21)

The native review ran over the whole branch with four lenses and a refuter.
The refuter corroborated two findings and left one undecided, and the two
corroborated ones said the same thing from two lenses.

**The acknowledgement wiped what the user wrote next.** The panel emptied the
composer when the daemon answered, and it matched the answer by chat, so any
answer for that chat emptied the composer at that moment. The answer for a
message that is still travelling arrives after the upload resolves, so text
typed in the meantime, or a file picked for the next message, were destroyed
without a word and without a way back. Two lenses found it on their own.

The fix: every request carries an id, the answer is matched to the request it
belongs to, and only what still belongs to that message goes with it. What was
typed or picked since is the user's and stays. The rules live in `Model.js`,
where node can run them, and the daemon already answered with the id of the
request. T12.

**The staging executable guessed what it was.** `bin/omarchy-whatsapp-stage`
had no extension and used module syntax, so Node had to guess whether it was
a module or a script. The guess lands on the wrong side on Node 20, where the
guess does not exist at all, and it is the only route the panel has to a file.
The refuter could not decide how bad it was, because the Node of the target
was not in the evidence; the part it did confirm is that nothing in the
candidate ever ran that executable: the tests covered the library behind it
and the CLI that imports it in-process.

The fix: the extension says it is a module, and the test runs the executable
itself. T11.

The correction went in its own worktree, on its own branch
(`fix/review-corrections`), and was merged into the branch of the feature.

### L9 (2026-10-21)

The second review ran over the corrected branch and found four things, three
of them the same thing seen from three angles.

**The file went to the conversation the user was in, not the one it was picked
for.** The conversation was stamped on the attachment when the copy finished,
not when the file was picked: the copy takes a moment, the user can change
conversation in the meantime, and the file was sent to the wrong one. The
recording had the same window, wider, because its copy is made after the
conversion. The spec says the file goes with the conversation it was picked
for, and the README says the same.

The fix: the conversation is taken when the file is picked and travels with
the request, and a file whose conversation the user has left does not attach
anywhere. T13.

**A message that was still on its way could be sent again.** The composer
used to be emptied as soon as the message was handed to the daemon, so a
second `Enter` found it empty and sent nothing. Now the composer waits for
the answer, so a second `Enter` sent the message again and the person on the
other end got it twice.

The fix: a message that is still on its way is not sent again, and the answer
for the first one is what clears the composer. If the daemon never answers,
the composer is free again after a while and what is in it stays. T14.

Every rule of the two fixes lives in `Model.js`, where node runs it, and each
one was proved by taking the fix out and watching the test fail for the
behaviour it covers.

### L10 (2026-10-21)

The third review found three more things, and the refuter could not settle a
fourth.

**The recording fell back to a directory everyone can read.** The runtime
directory is where a recording belongs, but the code fell back to `/tmp` when
it was not there, and `/tmp` is readable by every user on the machine. The
comment right above it said so. There is no fallback now: without a private
directory there is no recording, and the panel says so. T15.

**A slow upload became a second message.** The wait for the answer had a
deadline of thirty seconds, and a file of sixteen megabytes on a slow
connection takes longer than that. The deadline declared the message not
sent, freed the composer and said so, so the user sent it again and the
person on the other end got two copies. The message stays on its way until
the answer arrives; only the daemon going away frees the composer, and the
panel hears that when the socket drops. T16.

**A failure without an id never freed the composer**, so a refused message
held it for the whole deadline. The refuter could not settle it, because the
code that builds the error frame was not in the evidence it could see: that
frame does carry the id of the request, and a failure without one is about
the message that is the only one on its way. T16.

The three rules went in `Model.js` too, and each was proved by taking the fix
out and watching the test fail for the behaviour it covers.

### L11 (2026-10-21)

The fourth review approved the candidate. Its thirty-seven findings are all
advisory, but a few of them are real, and a pull request that goes to a
public repository is read by people who were not here for the story.

**The name that travels was joined into the path of the copy on disk as it
came**, so a name with a path in it put the copy outside the cache, and the
deletion that follows a successful send was guarded by a plain prefix test
that such a path passes. The name is a name and never a place now, the path
is resolved before it is checked, the size is looked at before the copy is
made, and the directory of the copy carries the process that made it: the
stager runs as its own process for every file, so the counter started at zero
every time. T17.

**A media send was acknowledged whether or not anything went out**, so the
panel cleared the caption and the file for a message that never left.
Nothing went out is now an answer the panel can act on. The command line
tool sent its requests without an id, so a failure raised on its behalf
could not be told apart from the panel's own message. T18.

**The conversation was checked when the file was attached and when the user
changed conversation, but not when the file goes out**, and the daemon can
point the panel at another chat without the panel choosing it. It is checked
again before the file goes. A microphone that is absent or busy said nothing
at all: the panel waited for a recording that never started. T19.

**A file the user took back, a send that failed and a staging that never
reached the daemon all left a copy of the file in the cache**, and nothing
ever removed one. They are swept after an hour. The README said three places
where the logout removes four. T20.

Two findings were checked against the machine and did not hold: the staging
queue was never stuck (two files in a row were staged, one after the other,
and the flag of the process is cleared when it ends), and the message the
panel sees is now tested where it lives.

### L12 (2026-10-21)

The change was read once more, this time with the eyes of someone who has to
maintain it, and three things came out of it.

**The composer waited for the answer before it let go of the text, and the
answer took the text away only when the composer still held exactly what was
sent.** With anything else in it, the text that had already been delivered
stayed in the composer and the next message carried it again. A user who
cleared the composer and wrote the same thing again had it taken away. The
composer lets go of the text as soon as the message is handed over now, the
way it always did, and the answer has no business touching the text: what the
user types while the message is on its way is the next message. T21.

**The voice mark of an attachment was set outside the attachment.** A pick
that did not apply, because it was for another conversation, still changed
the mark of the attachment that was there. The mark travels with the
attachment now. T21.

**A property of the staging process was written and never read.** It is gone.
T21.

Two things were left for later, and they are not from this change: the text
path of the daemon answers that a message went out even when nothing was
delivered, which is how the daemon has always answered, and the vocabulary
of the mime types is written in three places.

### L13 (2026-10-21)

The user said it did not work, and the panel was indeed broken: it did not
open at all. The log of the shell said why, in one line, twenty-five times:

```
Panel.qml[647:5]: Cannot assign to non-existent property "onErrorOccurred"
```

**The capture session was given a handler for a signal it does not have.**
QMediaCaptureSession says when the things plugged into it change, and nothing
else: it has no `errorOccurred`, no `error` and no `state`. The recorder is the
one that knows, and it says it there. And a QML object that cannot be created
takes the whole panel with it, so the panel did not open at all.

**The verification had a hole, and it is the interesting part of this.** The
warning was there all along: qmllint reported it ("no matching signal found
for handler"), and the check compared the NUMBER of warnings before and after
the change, which said nothing about what they said. And qmllint does not
check the signals of `Panel.qml` at all: it checks the files whose types it
can resolve, and it says nothing about this one. A handler that does not
exist, in a file made of a hundred of them, was invisible.

So the panel is now loaded in a shell of its own by
`tests/test_panel_runtime.sh`, which reads the log. It fails when the panel
does not load, and it fails when the panel loads with a warning. The test was
proved both ways: it fails with the broken panel and passes with the fixed
one.

One more thing the machine said: the shell of Omarchy does not recompile the
QML of a plugin when it reloads it. The file on disk was right and the shell
kept serving the old one, warning and all, until the shell was restarted
(`omarchy-restart-shell`). T22.

### L14 (2026-10-21)

The review of the final candidate found one thing, and it was the opposite of
the one before: the wait for the answer had no deadline.

**The daemon waited for the upload of a file without a limit.** An upload that
stops moving and never says so leaves the panel waiting for an answer that
is not coming, and the panel cannot send anything else: not a message, not a
file, nothing. The watchdog in the panel said that the message was still on
its way and kept saying it, but it never let go, because letting go is what
sends the message twice.

The wait has a deadline now, in the daemon, where the answer belongs: when it
passes, the panel is told that nothing went out and puts the caption and the
file back, and the daemon asks WhatsApp for a new connection so the stuck
upload goes with the one that carried it. T23.

Both ways of losing were closed at once, because they are the same door seen
from two sides: the panel does not let go of a message that may be on its
way, and the daemon always answers, one way or another.

### L15 (2026-10-21)

The deadline that T23 put in the daemon was wrong, and the review said so with
the reason in front of it.

**A deadline in the daemon is a second opinion that can disagree with the one
WhatsApp already has.** The upload of a file of sixteen megabytes on a slow
connection takes its time, and sixty seconds can pass while the upload is
still on its way. The daemon would say that nothing went out while the file
went out anyway, and the panel, which believed it, would send it again: the
other end would get it twice.

The deadline was taken out. The wait ends when WhatsApp says so, one way or
the other: the upload has a timeout of its own (`timeoutMs` in the request
that uploads the media), and the relay of a text has one too (`waitForMessage`
in the socket, which the daemon's own log shows expiring). The daemon waits
for that answer and tells the panel which one it was. T24.

**The panel says what to do when the daemon does not answer at all**: it is
the one that sends, so it has to be started again for anything else to go
out.

What the review could not see, because it is not in the diff, is that the
deadline it asked for was already there. The evidence is in
`daemon/node_modules/baileys`: the upload asks for a timeout, and the relay
of a text waits with one. A change made to answer a finding can be worse
than the finding when the finding rests on something the diff does not
show.
