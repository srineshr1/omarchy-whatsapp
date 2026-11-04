import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PLUGIN_ID = 'io.github.ricky.whatsapp'
const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'omarchy', 'shell.json')

// Read at delivery time so pending alerts also respect a newly disabled channel.
// Keep the last valid settings while shell.json is being rewritten.
export function createAlertSettings(path = CONFIG_PATH) {
  let current = { notifications: true, sound: true }
  return () => {
    try {
      const config = JSON.parse(readFileSync(path, 'utf8'))
      const entries = Object.values(config?.bar?.layout || {}).filter(Array.isArray).flat()
      if (Array.isArray(config?.plugins)) entries.push(...config.plugins)
      const entry = entries.find((item) => (typeof item === 'string' ? item : item?.id) === PLUGIN_ID)
      current = {
        notifications: entry?.notifications !== 'Off' && entry?.notifications !== false,
        sound: entry?.notificationSound !== 'Off' && entry?.notificationSound !== false
      }
    } catch {
      // Missing or incomplete config must not reset an explicit mute.
    }
    return current
  }
}
