import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAlertSettings } from '../lib/alert-settings.js'

const id = 'io.github.ricky.whatsapp'

test('reads independent alert toggles and hot reloads without losing valid settings on partial writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-alerts-'))
  const path = join(dir, 'shell.json')
  const read = createAlertSettings(path)
  const save = (entry) => writeFileSync(path, JSON.stringify({ bar: { layout: { right: [entry] } } }))
  try {
    assert.deepEqual(read(), { notifications: true, sound: true })
    save({ id, notifications: 'Off', notificationSound: 'On' })
    assert.deepEqual(read(), { notifications: false, sound: true })
    save({ id, notifications: 'On', notificationSound: 'Off' })
    assert.deepEqual(read(), { notifications: true, sound: false })
    save({ id, notifications: 'Off', notificationSound: 'Off' })
    assert.deepEqual(read(), { notifications: false, sound: false })
    writeFileSync(path, '{')
    assert.deepEqual(read(), { notifications: false, sound: false })
    save(id)
    assert.deepEqual(read(), { notifications: true, sound: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
