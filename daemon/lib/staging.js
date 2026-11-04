import { copyFileSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { mediaDir } from './paths.js'
import { MAX_UPLOAD_BYTES } from './outgoing.js'

// The daemon runs with a private /tmp, so a file the user picked in a
// terminal, dropped on the panel or recorded there cannot be read by the
// process that has to send it. The file is copied into the daemon's own
// directory first, which both can see.
//
// The copy is what is sent, so the file the user picked is still the file
// that goes out, with its own name.

// How long a copy that was never sent is kept before it is swept.
export const STALE_STAGE_MS = 60 * 60 * 1000

let staged = 0

export function stageOutgoing(source, wanted, options = {}) {
  // The name is what the copy on disk is called, so it is a name and never a
  // place: a name with a path in it cannot put the copy outside the cache.
  const name = basename(wanted ? String(wanted) : String(source || ''))
  if (!name || name === '.' || name === '..') throw new Error('stage: no file given')

  // Only a file is copied. A device or a pipe would copy for ever, or fill
  // the disk, and neither is a file the user picked.
  const info = statSync(source)
  if (!info.isFile()) throw new Error('stage: not a file')
  // The size is checked before the copy: a file the daemon would refuse is
  // not written to the cache first.
  if (info.size > MAX_UPLOAD_BYTES) throw new Error(`stage: file is too large (${MAX_UPLOAD_BYTES} bytes max)`)

  // Each staged file gets its own directory, so the name that travels is the
  // name the user gave it and two files of the same name never land on each
  // other. The clock alone is not enough: two files staged in the same
  // millisecond would collide, and the stager runs as its own process for
  // every file, so the counter starts at zero every time. The process does
  // the rest: two processes are never the same one.
  staged += 1
  const target = join(mediaDir, 'outgoing', `${Date.now()}-${process.pid}-${staged}`, name)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  copyFileSync(source, target)

  // A recording is a temporary: once the copy is there, the original has
  // nothing left to do. A file the user picked is not a temporary, so it is
  // only removed when the caller says so.
  if (options.removeSource === true) {
    try {
      unlinkSync(source)
    } catch {
      // Already gone is the outcome that was asked for.
    }
  }

  return target
}

// The copy has done its job once the message went out: WhatsApp has the file
// now, and a retry re-sends what the server already holds.
//
// Only a staged copy is removed. A file the user picked lives in their own
// directories and is theirs to keep, so it is never touched.
export function discardStaged(path) {
  // The path is resolved first: a path that walks back out of the cache with
  // parent-directory segments does not pass the test below.
  const target = resolve(String(path || ''))
  const stagingRoot = resolve(join(mediaDir, 'outgoing'))
  if (!target.startsWith(stagingRoot + sep)) return false

  try {
    unlinkSync(target)
  } catch (err) {
    // Already gone is the outcome that was asked for, not a failure.
    if (err?.code !== 'ENOENT') return false
  }

  // The directory was made for that one file, so it can go with it.
  try {
    rmdirSync(dirname(target))
  } catch {
    // Not empty, or already gone: nothing left to clean up.
  }
  return true
}

// The copies that were never sent: a file the user took back, a send that
// failed, a staging that never reached the daemon. They are swept after a
// while, so the cache does not keep copies of the user's files for ever.
export function sweepStaged(olderThanMs = STALE_STAGE_MS) {
  const root = join(mediaDir, 'outgoing')
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    // Nothing has been staged yet.
    return 0
  }

  const now = Date.now()
  let removed = 0
  for (const entry of entries) {
    const target = join(root, entry.name)
    try {
      const info = statSync(target)
      if (now - info.mtimeMs < olderThanMs) continue
      if (entry.isDirectory()) {
        for (const file of readdirSync(target)) unlinkSync(join(target, file))
        rmdirSync(target)
      } else {
        unlinkSync(target)
      }
      removed += 1
    } catch {
      // It is gone already, or it is not ours to remove.
    }
  }
  return removed
}
