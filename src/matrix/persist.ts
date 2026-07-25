import { Encoder } from 'cbor-x'
import type { MatrixClient } from 'matrix-js-sdk'
import type { WidgetApi } from 'matrix-widget-api'
import type { BootEntity } from '../types'
import { fetchWorldAsset, uploadBlob } from './world'

/**
 * World persistence: OFF by default - a room's world is ephemeral, dying
 * with its last session, unless someone flips the persist toggle. When on,
 * the root peer periodically writes the SETTLED sim state into the
 * org.worldsync.checkpoint state event as a semantic dump (bodies, props,
 * kv table) rather than raw Rapier snapshot bytes, which are neither
 * cross-peer stable nor version-stable (HANDOVER, hunt chapter 9). The
 * dump rides INLINE in the event content while it fits; past the inline
 * budget it is CBOR-encoded into the media repo and the event carries just
 * the mxc pointer. The persist flag lives in the same event, so one
 * capability pair covers everything and turning persistence off clears the
 * checkpoint with it (ephemerality leaves nothing behind).
 *
 * Restore happens on the peer that ROOTS a fresh tick grid (nobody to
 * calibrate against): it replays the dump as a boot seam, so any peer that
 * raced the join folds the identical restore. A peer that adopted a
 * running grid never restores - the live world it booted from is newer
 * than any checkpoint.
 */
export const CHECKPOINT_EVENT_TYPE = 'org.worldsync.checkpoint'

// Inline budget for the entity dump inside the state event content. The
// federation cap is 64KiB for the whole event PDU (content plus envelope
// and signatures), so stay comfortably under it.
const INLINE_LIMIT = 48_000

export interface CheckpointDump { tick: number; entities: BootEntity[] }

// same codec settings as the wire (self-describing plain maps)
const cbor = new Encoder({ useRecords: false })

const content = (client: MatrixClient, roomId: string): Record<string, unknown> => {
  const ev = client.getRoom(roomId)?.currentState.getStateEvents(CHECKPOINT_EVENT_TYPE, '')
  return (ev?.getContent() as Record<string, unknown> | undefined) ?? {}
}

export const readPersist = (client: MatrixClient, roomId: string): boolean =>
  content(client, roomId).persist === true

const sendState = (client: MatrixClient, roomId: string, c: unknown) =>
  (client.sendStateEvent.bind(client) as
    (roomId: string, type: string, content: unknown, stateKey: string) => Promise<unknown>)(
    roomId, CHECKPOINT_EVENT_TYPE, c, '')

/** Toggle persistence. ON preserves any existing checkpoint; OFF clears
 * the event whole - not-persistent means no world data left behind. */
export const setPersist = (client: MatrixClient, roomId: string, on: boolean): Promise<unknown> =>
  sendState(client, roomId, on ? { ...content(client, roomId), persist: true } : {})

export async function loadCheckpoint(
  api: WidgetApi, client: MatrixClient, roomId: string,
): Promise<CheckpointDump | null> {
  const c = content(client, roomId)
  const tick = typeof c.tick === 'number' ? c.tick : 0
  if (Array.isArray(c.entities)) return { tick, entities: c.entities as BootEntity[] }
  if (typeof c.url === 'string' && c.url.startsWith('mxc://')) {
    const dump = cbor.decode(new Uint8Array(await fetchWorldAsset(api, c.url))) as CheckpointDump
    return Array.isArray(dump?.entities) ? dump : null
  }
  return null
}

/** Write a checkpoint: inline while it fits, else a CBOR blob in the media
 * repo with a pointer event. Returns a description for the log line. */
export async function writeCheckpoint(
  api: WidgetApi, client: MatrixClient, roomId: string, dump: CheckpointDump,
): Promise<string> {
  const inline = JSON.stringify(dump.entities).length
  const base = { persist: true, version: 1, tick: dump.tick }
  if (inline <= INLINE_LIMIT) {
    await sendState(client, roomId, { ...base, entities: dump.entities })
    return `inline, ${(inline / 1024).toFixed(1)}kB`
  }
  const bytes = cbor.encode(dump) as Uint8Array
  const url = await uploadBlob(api, bytes, 'application/cbor')
  await sendState(client, roomId, { ...base, url, size: bytes.length })
  return `${(bytes.length / 1024).toFixed(1)}kB, over the inline budget: ${url}`
}
