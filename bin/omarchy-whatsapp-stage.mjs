#!/usr/bin/env node
// Copies a file into the directory the daemon can read, and prints where it
// landed. The daemon runs with a private /tmp, so a file picked in the panel
// or recorded there has to be moved before it can be sent. Only regular
// files are accepted; devices and named pipes are rejected before copying.
//
// --remove-source says the file is a temporary: it goes away once the copy is
// there. A file the user picked is never removed.

import { stageOutgoing } from '../daemon/lib/staging.js'

const args = process.argv.slice(2)
const source = args[0]
const wanted = args[1] && !args[1].startsWith('--') ? args[1] : ''
const removeSource = args.includes('--remove-source')

if (!source) {
  process.stderr.write('omarchy-whatsapp-stage: a file is required\n')
  process.exit(1)
}

try {
  process.stdout.write(stageOutgoing(source, wanted, { removeSource }) + '\n')
} catch (err) {
  process.stderr.write(`omarchy-whatsapp-stage: ${err?.message || err}\n`)
  process.exit(1)
}
