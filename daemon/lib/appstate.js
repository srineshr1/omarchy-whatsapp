import {
  aesDecrypt,
  downloadExternalPatch,
  extractSyncdPatches,
  hkdf,
  proto,
  S_WHATSAPP_NET
} from 'baileys'

// Pins, favourites, and chat lists live in WhatsApp's app-state ("syncd")
// collections. Baileys only replays them once, at first link, and even then
// drops pin updates for chats that were not in the same history batch. So the
// daemon reads the collections itself: a full snapshot plus trailing patches,
// decoded read-only. Baileys' own version bookkeeping is never touched.
//
// Decoding is per record, not per collection: old snapshots carry records
// sealed with keys this device never received, and Baileys' decoder gives up
// on the whole collection at the first one. Those records are skipped.
export const LIST_COLLECTIONS = ['regular_high', 'regular', 'regular_low']

const MAX_ROUNDS = 20
const ListType = proto.SyncActionValue.LabelEditAction.ListType
const REMOVE = proto.SyncdMutation.SyncdOperation.REMOVE

async function decodeRecords(mutations, getKey, onMutation) {
  const keyCache = new Map()
  let skipped = 0
  for (const entry of mutations) {
    const operation = 'operation' in entry ? entry.operation : 0
    const record = 'record' in entry && entry.record ? entry.record : entry
    try {
      const keyId = Buffer.from(record.keyId.id).toString('base64')
      if (!keyCache.has(keyId)) {
        const stored = await getKey(keyId)
        keyCache.set(keyId, stored
          ? (await hkdf(stored.keyData, 160, { info: 'WhatsApp Mutation Keys' })).slice(32, 64)
          : null)
      }
      const valueKey = keyCache.get(keyId)
      if (!valueKey) { skipped++; continue }
      const blob = Buffer.from(record.value.blob)
      const action = proto.SyncActionData.decode(aesDecrypt(blob.slice(0, -32), valueKey))
      onMutation({
        syncAction: action,
        index: JSON.parse(Buffer.from(action.index).toString()),
        removed: operation === REMOVE
      })
    } catch {
      skipped++
    }
  }
  return skipped
}

async function readCollection(sock, name, getKey, onMutation) {
  let version = 0
  let skipped = 0
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const result = await sock.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'w:sync:app:state', type: 'set' },
      content: [{
        tag: 'sync',
        attrs: {},
        content: [{
          tag: 'collection',
          attrs: { name, version: String(version), return_snapshot: String(!version) }
        }]
      }]
    })
    const decoded = (await extractSyncdPatches(result))[name]
    if (!decoded) break
    const { patches, hasMorePatches, snapshot } = decoded
    if (snapshot) {
      version = toNum(snapshot.version?.version)
      skipped += await decodeRecords(snapshot.records || [], getKey, onMutation)
    }
    for (const patch of patches) {
      const mutations = patch.mutations || []
      if (patch.externalMutations) mutations.push(...(await downloadExternalPatch(patch.externalMutations)).mutations)
      skipped += await decodeRecords(mutations, getKey, onMutation)
      version = Math.max(version, toNum(patch.version?.version))
    }
    if (!hasMorePatches) break
  }
  return skipped
}

function toNum(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  if (typeof value.toNumber === 'function') return value.toNumber()
  return Number(value) || 0
}

/**
 * @returns {Promise<{ pins: Map<string, number>|null, favorites: string[]|null,
 *   labels: object[]|null, members: Map<string, Set<string>> }>}
 */
export async function scanAppState(sock, keys, logger) {
  const getKey = async (id) => (await keys.get('app-state-sync-key', [id]))[id]
  const pins = new Map()
  const labels = new Map()
  const members = new Map()
  let favorites = null
  let order = null

  const onMutation = ({ syncAction, index, removed }) => {
    const value = syncAction?.value
    if (!value || !Array.isArray(index)) return
    const [type, a, b] = index
    if (value.pinAction) {
      pins.set(a, !removed && value.pinAction.pinned ? toNum(value.timestamp) || 1 : 0)
    } else if (value.labelEditAction) {
      const edit = value.labelEditAction
      labels.set(String(a), {
        id: String(a),
        name: edit.name || '',
        type: edit.type || 0,
        orderIndex: edit.orderIndex ?? null,
        isActive: edit.isActive !== false,
        deleted: edit.deleted === true
      })
    } else if (value.labelAssociationAction && type === 'label_jid') {
      const id = String(a)
      if (!members.has(id)) members.set(id, new Set())
      if (!removed && value.labelAssociationAction.labeled) members.get(id).add(b)
      else members.get(id).delete(b)
    } else if (value.favoritesAction) {
      favorites = (value.favoritesAction.favorites || []).map((f) => f.id).filter(Boolean)
    } else if (value.labelReorderingAction) {
      order = (value.labelReorderingAction.sortedLabelIds || []).map(String)
    }
  }

  // A collection that could not be read leaves its part of the result null,
  // so the caller keeps what it had instead of wiping it.
  const ok = new Set()
  for (const name of LIST_COLLECTIONS) {
    try {
      const skipped = await readCollection(sock, name, getKey, onMutation)
      if (skipped) logger?.debug({ name, skipped }, 'appstate: skipped undecryptable records')
      ok.add(name)
    } catch (err) {
      logger?.warn({ err: err?.message, name }, 'appstate: collection scan failed')
    }
  }

  const rank = new Map((order || []).map((id, i) => [id, i]))
  const visible = [...labels.values()]
    .filter((l) => !l.deleted && l.isActive && l.name)
    .filter((l) => l.type === ListType.CUSTOM || l.type === ListType.PREDEFINED || l.type === ListType.NONE)
    .sort((x, y) => {
      const rx = rank.has(x.id) ? rank.get(x.id) : (x.orderIndex ?? 1e6)
      const ry = rank.has(y.id) ? rank.get(y.id) : (y.orderIndex ?? 1e6)
      return rx - ry || x.name.localeCompare(y.name)
    })
    .map(({ id, name }) => ({ id, name }))

  // Some clients model Favourites as a list rather than a favoritesAction.
  if (!favorites) {
    const fav = [...labels.values()].find((l) => l.type === ListType.FAVORITES && !l.deleted)
    if (fav && members.has(fav.id)) favorites = [...members.get(fav.id)]
  }

  const listsOk = ok.has('regular') && ok.has('regular_high')
  return {
    pins: ok.has('regular_low') ? pins : null,
    favorites: listsOk ? favorites || [] : null,
    labels: listsOk ? visible : null,
    members
  }
}
