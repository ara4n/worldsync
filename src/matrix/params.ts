/**
 * Widget URL parameters, following element-call's matryoshka convention: the
 * host client (Element Web) substitutes the $-templated values when it
 * instantiates the widget iframe, e.g.
 *   ?widgetId=$matrix_widget_id&userId=$matrix_user_id
 *    &deviceId=$org.matrix.msc3819.matrix_device_id
 *    &baseUrl=$org.matrix.msc4039.matrix_base_url&roomId=$matrix_room_id
 * We are a widget iff widgetId AND parentUrl are present; identity comes
 * entirely from these params (the host owns the real Matrix session).
 */
export interface WidgetParams {
  widgetId: string
  parentUrl: string
  roomId: string
  userId: string
  deviceId: string
  baseUrl: string
  /** dev-loop escape hatch: BroadcastChannel transport instead of LiveKit */
  mockTransport: boolean
}

export function widgetParams(): WidgetParams | null {
  // Fragment first (Element Web puts widget params after #), then query.
  const search = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const get = (k: string) => hash.get(k) ?? search.get(k)
  const widgetId = get('widgetId')
  const parentUrl = get('parentUrl')
  if (!widgetId || !parentUrl) return null
  const need = (k: string) => {
    const v = get(k)
    if (!v) throw new Error(`widget mode: missing required param ${k}`)
    return v
  }
  return {
    widgetId,
    parentUrl,
    roomId: need('roomId'),
    userId: need('userId'),
    deviceId: need('deviceId'),
    baseUrl: need('baseUrl'),
    mockTransport: get('mockTransport') === '1',
  }
}
