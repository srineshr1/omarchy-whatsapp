import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

// The media cache of the tests is a temporary directory: the tests do not
// write in the cache of the user, and they do not sweep it either.
const mediaHome = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-media-'))
process.env.OMARCHY_WHATSAPP_MEDIA = mediaHome

const { discardStaged, stageOutgoing, sweepStaged } = await import('../lib/staging.js')
const { MAX_UPLOAD_BYTES } = await import('../lib/outgoing.js')
const { mediaDir } = await import('../lib/paths.js')

// The daemon cannot read the user's /tmp, so a file that is going out is
// copied into the directory both of them can see.

// The panel has no other way to attach a file: it runs this executable.
const HERE = dirname(new URL(import.meta.url).pathname)
const STAGER = join(HERE, '..', '..', 'bin', 'omarchy-whatsapp-stage.mjs')

function runStage(args, env = {}) {
  return execFileSync(STAGER, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  }).trim()
}

test('a file is staged where the daemon can read it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'voice.opus')
  writeFileSync(source, Buffer.from('a recording'))

  const staged = stageOutgoing(source)

  assert.notEqual(staged, source)
  assert.equal(readFileSync(staged, 'utf8'), 'a recording')
  assert.match(staged, /voice\.opus$/)
})

test('two files with the same name do not land on each other', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  // Two different files that happen to share a name.
  const one = join(dir, 'a', 'photo.png')
  const two = join(dir, 'b', 'photo.png')
  mkdirSync(join(dir, 'a'), { recursive: true })
  mkdirSync(join(dir, 'b'), { recursive: true })
  writeFileSync(one, Buffer.from('one'))
  writeFileSync(two, Buffer.from('two'))

  const first = stageOutgoing(one)
  const second = stageOutgoing(two)

  assert.notEqual(first, second)
  assert.equal(readFileSync(first, 'utf8'), 'one')
  assert.equal(readFileSync(second, 'utf8'), 'two')
})

test('the file that goes out keeps the name the user gave it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'informe.pdf')
  writeFileSync(source, Buffer.from('un informe'))

  const staged = stageOutgoing(source)

  // The name that travels is the name the user gave it, not one with a
  // timestamp glued to it.
  assert.equal(basename(staged), 'informe.pdf')
  assert.equal(readFileSync(staged, 'utf8'), 'un informe')
})

test('a file can be given the name it should arrive with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'recording.m4a')
  writeFileSync(source, Buffer.from('una grabacion'))

  const staged = stageOutgoing(source, 'voice-note.opus')

  assert.equal(basename(staged), 'voice-note.opus')
  assert.equal(readFileSync(staged, 'utf8'), 'una grabacion')
})

test('a file that is not there is refused', () => {
  assert.throws(() => stageOutgoing('/definitely/not/here.png'), /ENOENT|no such file/i)
})

test('a staged file is removed once it has gone out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  const staged = stageOutgoing(source)
  assert.equal(existsSync(staged), true)

  // The copy was made for one message and nothing else needs it.
  assert.equal(discardStaged(staged), true)
  assert.equal(existsSync(staged), false)
})

test('a file that was never staged is never removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  // The user picked this file: it lives in their own directories and is
  // theirs to keep.
  assert.equal(discardStaged(source), false)
  assert.equal(existsSync(source), true)
})

test('removing a file that is already gone is not a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  const staged = stageOutgoing(source)
  assert.equal(discardStaged(staged), true)
  assert.equal(discardStaged(staged), true)
})

test('a path that walks out of the cache is never removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const outside = join(dir, 'keep.txt')
  writeFileSync(outside, Buffer.from('not for the cache'))

  // The path starts inside the cache and steps back out of it.
  const sneaky = join(mediaDir, 'outgoing', '..', '..', '..', '..', '..', '..', outside)
  assert.equal(discardStaged(sneaky), false)
  assert.equal(existsSync(outside), true)
})

test('a temporary is removed once it has been copied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'recording.m4a')
  writeFileSync(source, Buffer.from('una grabacion'))

  // A recording is a temporary: the copy is what travels, and the original
  // has nothing left to do once it is there.
  const staged = stageOutgoing(source, 'voice-note.opus', { removeSource: true })

  assert.equal(existsSync(staged), true)
  assert.equal(existsSync(source), false)
})

test('a file that is not a temporary stays where it is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  stageOutgoing(source)

  // The user picked this file: it is theirs, and it stays theirs.
  assert.equal(existsSync(source), true)
})

test('a name with a path in it stays a name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  // The name is what the copy on disk is called, so it can never name a
  // place outside the cache.
  const staged = stageOutgoing(source, '../../elsewhere/passwd')

  assert.equal(basename(staged), 'passwd')
  assert.equal(dirname(dirname(staged)).endsWith(`${sep}outgoing`), true)
})

test('the copy lands in a directory of its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  const staged = stageOutgoing(source)

  // The stager runs as its own process for every file, so the directory has
  // to carry something that differs between two processes: two panels
  // staging at the same moment would otherwise land on each other.
  assert.ok(staged.includes(String(process.pid)))
})

test('a file that is too large is not copied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'huge.bin')
  writeFileSync(source, Buffer.alloc(MAX_UPLOAD_BYTES + 1))

  // The copy is made before the daemon looks at it, so the size is checked
  // here too.
  assert.throws(() => stageOutgoing(source), /too large/i)
})

test('the executable the panel runs stages a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  const staged = runStage([source, 'photo.png'])

  assert.match(staged, /photo\.png$/)
  assert.equal(readFileSync(staged, 'utf8'), 'a photo')
})

test('the executable does not need the runtime to guess the module type', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  // Node 20 has no module detection at all, so a file that relies on it
  // breaks there: the executable says what it is.
  const staged = runStage([source, 'photo.png'], {
    NODE_OPTIONS: '--no-experimental-detect-module'
  })

  assert.match(staged, /photo\.png$/)
})

test('the executable takes a temporary away with its copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'recording.m4a')
  writeFileSync(source, Buffer.from('una grabacion'))

  const staged = runStage([source, 'voice-note.opus', '--remove-source'])

  assert.match(staged, /voice-note\.opus$/)
  assert.equal(existsSync(staged), true)
  assert.equal(existsSync(source), false)
})

test('the copies that were never sent are swept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const source = join(dir, 'photo.png')
  writeFileSync(source, Buffer.from('a photo'))

  const staged = stageOutgoing(source)
  // A file the user took back, or a send that never happened, leaves a copy
  // behind. It is swept once it is old enough.
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(dirname(staged), old, old)

  sweepStaged()

  assert.equal(existsSync(staged), false)
})

test('a device or a pipe is not copied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-stage-'))
  const fifo = join(dir, 'pipe')
  // A pipe has no size and the copy of it would never end.
  execFileSync('mkfifo', [fifo])

  const result = spawnSync(STAGER, [fifo], { encoding: 'utf8', env: process.env, timeout: 1000 })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'omarchy-whatsapp-stage: stage: not a file\n')
  assert.equal(existsSync(fifo), true)
})
