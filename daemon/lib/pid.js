import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

function realpathOrSelf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// The pid file lives under XDG_STATE_HOME, so it survives a reboot, and by then
// the pid in it can belong to any unrelated process of the user. A pid only
// counts as a leftover daemon when that process is running this very script.
// The launcher starts it as `node index.js` from the daemon directory, so the
// script argument is resolved against the process's own working directory.
export function isDaemonProcess(pid, script, procRoot = '/proc') {
  let argv
  let cwd
  try {
    argv = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0')
    cwd = readlinkSync(join(procRoot, String(pid), 'cwd'))
  } catch {
    // Gone, or not ours to inspect.
    return false
  }

  const target = realpathOrSelf(script)
  return argv.slice(1).some((arg) => arg !== '' && realpathOrSelf(resolve(cwd, arg)) === target)
}
