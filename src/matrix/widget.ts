import {
  WidgetApi, MatrixCapabilities, WidgetApiToWidgetAction, WidgetEventCapability, EventDirection,
  type INotifyCapabilitiesActionRequest, type IWidgetApiRequest,
} from 'matrix-widget-api'
import { createRoomWidgetClient, EventType, type MatrixClient, type ICapabilities } from 'matrix-js-sdk'
import type { WidgetParams } from './params'
import { SCRIPT_STATE_TYPES, WORLD_EVENT_TYPE } from './world'

/**
 * Matryoshka bootstrap, after element-call's src/widget.ts: the WidgetApi
 * speaks postMessage to the host client (Element Web, or our mock host) and
 * createRoomWidgetClient wraps it in a MatrixClient that proxies every
 * CS-API call through the host. Identity and encryption are the host's; this
 * client has no access token of its own.
 */
export async function initWidgetClient(p: WidgetParams): Promise<{ api: WidgetApi; client: MatrixClient }> {
  const api = new WidgetApi(p.widgetId, new URL(p.parentUrl).origin)
  // Log exactly what the host granted: a quietly-denied capability (easy
  // to do in a re-approval prompt after this widget asks for new ones)
  // presents as a silent hang - e.g. no m.call.member echo means the
  // session never learns its own membership and never starts.
  api.on(`action:${WidgetApiToWidgetAction.NotifyCapabilities}`, (raw: Event) => {
    const ev = raw as CustomEvent<INotifyCapabilitiesActionRequest>
    const { requested, approved } = ev.detail.data
    const denied = requested.filter(c => !approved.includes(c))
    console.log('[worldsync] capabilities approved:', approved)
    if (denied.length) console.warn('[worldsync] capabilities DENIED by the host:', denied)
  })
  // Element Web notifies widgets of client theme switches; with no
  // handler the transport error-replies AND throws an uncaught rejection
  // into the console each time. Worldsync has one look: ack and ignore.
  api.on(`action:${WidgetApiToWidgetAction.ThemeChange}`, (raw: Event) => {
    const ev = raw as CustomEvent<IWidgetApiRequest>
    ev.preventDefault()
    api.transport.reply(ev.detail, {})
  })
  api.requestCapability(MatrixCapabilities.AlwaysOnScreen)
  // MSC4039 media actions: the glTF scene GLB is uploaded/downloaded through
  // the host, since the widget has no access token for the media repo.
  api.requestCapability(MatrixCapabilities.MSC4039UploadFile)
  api.requestCapability(MatrixCapabilities.MSC4039DownloadFile)

  // Everything MatrixRTC membership management needs, plus the MSC3815
  // world state event that names the room's glTF scene: the m.call.member
  // state events (ours to write, everyone's to read), room basics for the
  // Room object to exist, and the encryption-key events MatrixRTC uses to
  // distribute per-participant media keys.
  const capabilities: ICapabilities = {
    sendState: [
      { eventType: EventType.GroupCallMemberPrefix },
      { eventType: WORLD_EVENT_TYPE, stateKey: '' },
    ],
    receiveState: [
      { eventType: EventType.GroupCallMemberPrefix },
      { eventType: WORLD_EVENT_TYPE },
      { eventType: EventType.RoomCreate },
      { eventType: EventType.RoomMember },
      { eventType: EventType.RoomEncryption },
    ],
    // RoomMessage: world scripts narrate their player's actions into the
    // room via world.say (chess announces moves). Sent as this user.
    sendEvent: [EventType.CallEncryptionKeysPrefix, EventType.RoomMessage],
    receiveEvent: [EventType.CallEncryptionKeysPrefix],
    sendDelayedEvents: true,
    updateDelayedEvents: true,
  }

  // The SCRIPT_STATE_TYPES capabilities for world.getStateEvents /
  // world.setStateEvent are deliberately absent above: they are
  // renegotiated lazily (requestScriptStateCapabilities below) the first
  // time a world script actually calls those APIs, so worlds that never
  // touch room state never ask the user for them.
  const client = createRoomWidgetClient(
    api, capabilities, p.roomId,
    {
      baseUrl: p.baseUrl,
      userId: p.userId,
      deviceId: p.deviceId,
      timelineSupport: true,
    },
    // Never auto-send ContentLoaded: widgets added with /addwidget get the
    // host default waitForIframeLoad=true, and such hosts treat an
    // unexpected ContentLoaded as a hard "Improper sequence" error (in the
    // PARENT frame's console) and never finish the handshake - the widget
    // then waits in startClient forever. Element-call passes false too.
    false,
  )
  await client.startClient()
  return { api, client }
}

/**
 * MSC2974 capability renegotiation for the script state APIs: request
 * send (our own MXID as state_key only) + receive for every type in
 * SCRIPT_STATE_TYPES. Called on a world script's FIRST
 * getStateEvents/setStateEvent call - Element prompts the user for
 * approval right then. On grant the host re-pushes the room's current
 * state for the newly readable types (update_state), so pre-existing
 * events land in the client without any extra backfill here. A DENIAL
 * still resolves (MSC2974 has no rejection path); it just leaves later
 * sends failing with a logged permission error and reads empty.
 */
export async function requestScriptStateCapabilities(api: WidgetApi, userId: string): Promise<void> {
  api.requestCapabilities(SCRIPT_STATE_TYPES.flatMap(t => [
    WidgetEventCapability.forStateEvent(EventDirection.Send, t, userId).raw,
    WidgetEventCapability.forStateEvent(EventDirection.Receive, t).raw,
  ]))
  await api.updateRequestedCapabilities()
}
