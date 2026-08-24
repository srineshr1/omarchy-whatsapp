import { readFileSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

const PLUGIN_ID = 'io.github.ricky.whatsapp'
const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'omarchy',
  'shell.json'
)
const CONFIG_DIR = dirname(CONFIG_PATH)
const CONFIG_NAME = basename(CONFIG_PATH)

function entryId(entry) {
  return typeof entry === 'string' ? entry : entry?.id
}

// A partially-written config should not stop a live daemon. The next file event
// will see the completed file and apply the new plugin state.
export function isPluginEnabled() {
  let config
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return true
  }

  const sections = config?.bar?.layout || {}
  for (const entries of Object.values(sections)) {
    if (Array.isArray(entries) && entries.some((entry) => entryId(entry) === PLUGIN_ID)) return true
  }

  return Array.isArray(config?.plugins)
    && config.plugins.some((entry) => entryId(entry) === PLUGIN_ID)
}

// Watch the directory rather than only the file: the shell may replace
// shell.json atomically, which would otherwise detach a file-only watcher.
export function watchPluginState(onDisabled) {
  let closed = false
  let debounceTimer = null
  let watcher = null

  const check = () => {
    if (!closed && !isPluginEnabled()) onDisabled()
  }

  try {
    watcher = watch(CONFIG_DIR, { persistent: false }, (_event, name) => {
      if (name && String(name) !== CONFIG_NAME) return
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(check, 100)
      debounceTimer.unref?.()
    })
  } catch {
    // The config directory normally exists on an Omarchy session. If it does
    // not, startup proceeds and a later service start will check again.
  }

  check()

  return () => {
    closed = true
    clearTimeout(debounceTimer)
    watcher?.close()
  }
}
