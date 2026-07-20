import { WidgetApi, MatrixCapabilities } from 'matrix-widget-api'
import { createRoomWidgetClient, EventType, type MatrixClient, type ICapabilities } from 'matrix-js-sdk'
import type { WidgetParams } from './params'

/**
 * Matryoshka bootstrap, after element-call's src/widget.ts: the WidgetApi
 * speaks postMessage to the host client (Element Web, or our mock host) and
 * createRoomWidgetClient wraps it in a MatrixClient that proxies every
 * CS-API call through the host. Identity and encryption are the host's; this
 * client has no access token of its own.
 */
export async function initWidgetClient(p: WidgetParams): Promise<{ api: WidgetApi; client: MatrixClient }> {
  const api = new WidgetApi(p.widgetId, new URL(p.parentUrl).origin)
  api.requestCapability(MatrixCapabilities.AlwaysOnScreen)

  // Everything MatrixRTC membership management needs, and nothing else:
  // the m.call.member state events (ours to write, everyone's to read),
  // room basics for the Room object to exist, and the encryption-key
  // events MatrixRTC uses to distribute per-participant media keys.
  const capabilities: ICapabilities = {
    sendState: [{ eventType: EventType.GroupCallMemberPrefix }],
    receiveState: [
      { eventType: EventType.GroupCallMemberPrefix },
      { eventType: EventType.RoomCreate },
      { eventType: EventType.RoomMember },
      { eventType: EventType.RoomEncryption },
    ],
    sendEvent: [EventType.CallEncryptionKeysPrefix],
    receiveEvent: [EventType.CallEncryptionKeysPrefix],
    sendDelayedEvents: true,
    updateDelayedEvents: true,
  }

  const client = createRoomWidgetClient(
    api, capabilities, p.roomId,
    {
      baseUrl: p.baseUrl,
      userId: p.userId,
      deviceId: p.deviceId,
      timelineSupport: true,
    },
    true, // sendContentLoaded
  )
  await client.startClient()
  return { api, client }
}
