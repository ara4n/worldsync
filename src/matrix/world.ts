import type { MatrixClient } from 'matrix-js-sdk'
import type { WidgetApi } from 'matrix-widget-api'

/**
 * MSC3815 (Third Room worlds): the org.matrix.msc3815.world state event
 * names the room's glTF scene by mxc URL. We read/write the scene_url
 * field (plus a thirdroom-compatible `scene` asset object on write); the
 * GLB itself lives in the Matrix media repo, moved through the widget
 * driver's MSC4039 upload/download actions since the widget has no access
 * token of its own.
 */
export const WORLD_EVENT_TYPE = 'org.matrix.msc3815.world'

function worldContent(client: MatrixClient, roomId: string): Record<string, unknown> {
  const ev = client.getRoom(roomId)?.currentState.getStateEvents(WORLD_EVENT_TYPE, '')
  return (ev?.getContent() as Record<string, unknown> | undefined) ?? {}
}

const mxcField = (c: Record<string, unknown>, key: string): string | null => {
  const url = c[key]
  return typeof url === 'string' && url.startsWith('mxc://') ? url : null
}

export const readWorldSceneUrl = (client: MatrixClient, roomId: string): string | null =>
  mxcField(worldContent(client, roomId), 'scene_url')

export const readWorldScriptUrl = (client: MatrixClient, roomId: string): string | null =>
  mxcField(worldContent(client, roomId), 'script_url')

/** Extract scene_url/script_url from a raw world event content object. */
export const worldUrls = (content: Record<string, unknown>) => ({
  sceneUrl: mxcField(content, 'scene_url'),
  scriptUrl: mxcField(content, 'script_url'),
})

const MIME = { scene: 'model/gltf-binary', script: 'text/javascript' }

// MSC4039 media actions only answer after the host has moved the whole
// blob to/from the homeserver, so the transport's default 10s reply window
// (right for state sends and other small actions) guarantees "Request
// timed out" for any scene beyond a few MB on a home connection. Hold the
// window open while media is in flight and restore it when the last
// concurrent transfer lands, so small actions keep fast failure detection.
// (timeoutSeconds is read when a request is SENT, so requests already in
// flight keep the window they started with.)
const MEDIA_TIMEOUT_S = 300
let mediaOps = 0
let idleTimeoutS = 10
async function withMediaTimeout<T>(api: WidgetApi, op: () => Promise<T>): Promise<T> {
  if (mediaOps++ === 0) {
    idleTimeoutS = api.transport.timeoutSeconds
    api.transport.timeoutSeconds = MEDIA_TIMEOUT_S
  }
  try {
    return await op()
  } finally {
    if (--mediaOps === 0) api.transport.timeoutSeconds = idleTimeoutS
  }
}

/** Upload an asset and merge it into the room's world state event (a
 * scene upload must not clobber script_url, and vice versa). */
export async function uploadWorldAsset(
  api: WidgetApi, client: MatrixClient, roomId: string, file: File, kind: 'scene' | 'script',
): Promise<string> {
  // Upload a MEMORY-BACKED copy, never the <input> File itself: that File
  // is backed by its on-disk path, and Chromium's read grant for the path
  // belongs to THIS renderer process only. After the postMessage hop the
  // host's process (Element Desktop especially) gets net::ERR_ACCESS_DENIED
  // trying to read it, and the upload leaves with an empty body. Reading
  // the bytes here (where the grant is valid) and re-wrapping as a Blob
  // makes them travel by value.
  const blob = new Blob([await file.arrayBuffer()], { type: file.type || MIME[kind] })
  const { content_uri } = await withMediaTimeout(api, () => api.uploadFile(blob))
  const sendState = client.sendStateEvent.bind(client) as
    (roomId: string, type: string, content: unknown, stateKey: string) => Promise<unknown>
  const patch: Record<string, unknown> = kind === 'scene'
    ? {
        scene_url: content_uri,
        scene: {
          version: 1,
          name: file.name,
          url: content_uri,
          asset_type: 'm.world.scene',
          info: { mimetype: 'model/gltf-binary', size: file.size },
        },
      }
    : { script_url: content_uri }
  await sendState(roomId, WORLD_EVENT_TYPE, { ...worldContent(client, roomId), ...patch }, '')
  return content_uri
}

/** The homeserver's media upload cap, via the host (null = unknown). */
export async function mediaUploadLimit(api: WidgetApi): Promise<number | null> {
  try {
    const cfg = await api.getMediaConfig()
    const n = cfg['m.upload.size']
    return typeof n === 'number' ? n : null
  } catch {
    return null // hosts without MSC4039 media config; find out the hard way
  }
}

export async function fetchWorldAsset(api: WidgetApi, mxc: string): Promise<ArrayBuffer> {
  const { file } = await withMediaTimeout(api, () => api.downloadFile(mxc))
  return await new Response(file as BodyInit).arrayBuffer()
}
