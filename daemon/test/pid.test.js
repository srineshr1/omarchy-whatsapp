import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isDaemonProcess } from '../lib/pid.js'

// A fake /proc: each pid gets a NUL-separated cmdline and a cwd symlink.
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omarchy-whatsapp-pid-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const daemonDir = join(root, 'plugin', 'daemon')
  const otherDir = join(root, 'elsewhere')
  mkdirSync(daemonDir, { recursive: true })
  mkdirSync(otherDir, { recursive: true })
  writeFileSync(join(daemonDir, 'index.js'), '')
  writeFileSync(join(otherDir, 'index.js'), '')

  const proc = join(root, 'proc')
  const addProcess = (pid, argv, cwd) => {
    mkdirSync(join(proc, String(pid)), { recursive: true })
    writeFileSync(join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0')
    symlinkSync(cwd, join(proc, String(pid), 'cwd'))
  }

  return { proc, daemonDir, otherDir, script: join(daemonDir, 'index.js'), addProcess }
}

test('recognizes the daemon as started by the launcher', (t) => {
  const f = fixture(t)
  f.addProcess(1722, ['/usr/bin/node', 'index.js'], f.daemonDir)
  assert.equal(isDaemonProcess(1722, f.script, f.proc), true)
})

test('recognizes the daemon started by absolute path, with node flags', (t) => {
  const f = fixture(t)
  f.addProcess(1722, ['/usr/bin/node', '--enable-source-maps', f.script], f.otherDir)
  assert.equal(isDaemonProcess(1722, f.script, f.proc), true)
})

test('ignores an unrelated process that reused the pid after a reboot', (t) => {
  const f = fixture(t)
  f.addProcess(1731, ['/usr/bin/python', '/usr/bin/uwsm', 'app-daemon'], f.otherDir)
  assert.equal(isDaemonProcess(1731, f.script, f.proc), false)
})

test('ignores another node program called index.js', (t) => {
  const f = fixture(t)
  f.addProcess(1731, ['/usr/bin/node', 'index.js'], f.otherDir)
  assert.equal(isDaemonProcess(1731, f.script, f.proc), false)
})

test('ignores a process sitting in the daemon directory that is not the daemon', (t) => {
  const f = fixture(t)
  f.addProcess(1731, ['/bin/bash'], f.daemonDir)
  assert.equal(isDaemonProcess(1731, f.script, f.proc), false)
})

test('treats a pid that no longer exists as not a daemon', (t) => {
  const f = fixture(t)
  assert.equal(isDaemonProcess(4242, f.script, f.proc), false)
})
