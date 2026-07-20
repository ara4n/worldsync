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

/** Upload an asset and merge it into the room's world state event (a
 * scene upload must not clobber script_url, and vice versa). */
export async function uploadWorldAsset(
  api: WidgetApi, client: MatrixClient, roomId: string, file: File, kind: 'scene' | 'script',
): Promise<string> {
  const { content_uri } = await api.uploadFile(file)
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

export async function fetchWorldAsset(api: WidgetApi, mxc: string): Promise<ArrayBuffer> {
  const { file } = await api.downloadFile(mxc)
  return await new Response(file as BodyInit).arrayBuffer()
}
