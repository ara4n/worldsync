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

export function readWorldSceneUrl(client: MatrixClient, roomId: string): string | null {
  const ev = client.getRoom(roomId)?.currentState.getStateEvents(WORLD_EVENT_TYPE, '')
  const url = (ev?.getContent() as { scene_url?: unknown } | undefined)?.scene_url
  return typeof url === 'string' && url.startsWith('mxc://') ? url : null
}

/** Upload a GLB and point the room's world state event at it. */
export async function uploadWorldScene(
  api: WidgetApi, client: MatrixClient, roomId: string, file: File,
): Promise<string> {
  const { content_uri } = await api.uploadFile(file)
  const sendState = client.sendStateEvent.bind(client) as
    (roomId: string, type: string, content: unknown, stateKey: string) => Promise<unknown>
  await sendState(roomId, WORLD_EVENT_TYPE, {
    scene_url: content_uri,
    scene: {
      version: 1,
      name: file.name,
      url: content_uri,
      asset_type: 'm.world.scene',
      info: { mimetype: 'model/gltf-binary', size: file.size },
    },
  }, '')
  return content_uri
}

export async function fetchWorldScene(api: WidgetApi, mxc: string): Promise<ArrayBuffer> {
  const { file } = await api.downloadFile(mxc)
  return await new Response(file as BodyInit).arrayBuffer()
}
