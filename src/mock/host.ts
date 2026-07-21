import {
  ClientWidgetApi, Widget, WidgetDriver, WidgetApiToWidgetAction,
  type Capability, type IRoomEvent, type ISendEventDetails, type ISendDelayedEventDetails,
  type IOpenIDUpdate, type SimpleObservable, type IGetMediaConfigResult, OpenIDRequestState,
} from 'matrix-widget-api'

/**
 * A mock matryoshka host: everything a real Element Web provides to the
 * worldsync widget, minus an actual homeserver. The widget runs the real
 * matrix-widget-api + matrix-js-sdk RoomWidgetClient + MatrixRTC membership
 * code; only this driver behind them is fake. Room state lives in memory and
 * is replicated to every open tab on this origin via a BroadcastChannel, so
 * two tabs mesh exactly like the classic demo. The LiveKit SFU is faked the
 * same way (the widget uses its BroadcastChannel transport in mock mode).
 */

const qs = new URLSearchParams(location.search)
const room = qs.get('room') ?? 'default'
const roomId = `!${room}:mock.localhost`
const userId = `@u${Math.random().toString(36).slice(2, 8)}:mock.localhost`
const deviceId = `MOCK${Math.random().toString(36).slice(2, 6).toUpperCase()}`

type StateKey = string // `${eventType}|${stateKey}`
interface HostSync { t: 'state'; ev: IRoomEvent }
interface HostSyncReq { t: 'sync-req'; from: string }
interface HostSyncRes { t: 'sync-res'; to: string; events: IRoomEvent[]; files?: [string, ArrayBuffer][] }
/** mock media repo gossip: uploaded bytes replicated to every tab */
interface HostFile { t: 'file'; uri: string; bytes: ArrayBuffer }

class MockDriver extends WidgetDriver {
  state = new Map<StateKey, IRoomEvent>()
  files = new Map<string, ArrayBuffer>()
  private ch = new BroadcastChannel(`worldsync-mockstate-${room}`)
  private api: ClientWidgetApi | null = null
  private delayed = new Map<string, { eventType: string; content: unknown; stateKey?: string | null }>()
  private nDelay = 0
  private nEvent = 0
  private nFile = 0

  constructor() {
    super()
    this.ch.onmessage = ev => {
      const m = ev.data as HostSync | HostSyncReq | HostSyncRes | HostFile
      if (m.t === 'state') this.apply(m.ev, false)
      else if (m.t === 'sync-req') {
        this.ch.postMessage({ t: 'sync-res', to: m.from, events: [...this.state.values()], files: [...this.files] })
      } else if (m.t === 'sync-res' && m.to === userId) {
        for (const e of m.events) this.apply(e, false)
        for (const [uri, bytes] of m.files ?? []) this.files.set(uri, bytes)
      } else if (m.t === 'file') this.files.set(m.uri, m.bytes)
    }
    this.ch.postMessage({ t: 'sync-req', from: userId } satisfies HostSyncReq)
    // The room must minimally exist: a create event (local; newest-wins is
    // harmless) and our join membership, which MUST be gossiped: MatrixRTC
    // ignores call memberships of users who are not room members.
    this.apply(this.mkEvent('m.room.create', { creator: userId }, ''), false)
    this.apply(this.mkEvent('m.room.member', { membership: 'join' }, userId), true)
  }

  attach(api: ClientWidgetApi) { this.api = api }

  private mkEvent(eventType: string, content: unknown, stateKey?: string | null): IRoomEvent {
    return {
      room_id: roomId,
      event_id: `$mock-${userId}-${this.nEvent++}`,
      origin_server_ts: Date.now(),
      sender: userId,
      type: eventType,
      content: content as Record<string, unknown>,
      state_key: stateKey ?? undefined,
      unsigned: {},
    } as IRoomEvent
  }

  /** store + (optionally) gossip + push into our widget */
  private apply(ev: IRoomEvent, gossip: boolean) {
    if (ev.state_key !== undefined) {
      const key = `${ev.type}|${ev.state_key}`
      const prev = this.state.get(key)
      if (prev && prev.origin_server_ts > ev.origin_server_ts) return
      this.state.set(key, ev)
    }
    if (gossip) this.ch.postMessage({ t: 'state', ev } satisfies HostSync)
    if (this.api) {
      // Deferred: when the widget itself sent this event, its send request
      // must resolve before the echo arrives (like a real /sync round trip),
      // or the RoomWidgetClient drops the echo as an in-flight duplicate.
      const api = this.api
      setTimeout(() => {
        void api.feedEvent(ev, roomId).catch(e => console.error('mockhost feedEvent failed:', e))
        if (ev.state_key !== undefined) {
          void api.feedStateUpdate(ev).catch(e => console.error('mockhost feedStateUpdate failed:', e))
        }
      }, 0)
    }
  }

  validateCapabilities(requested: Set<Capability>): Promise<Set<Capability>> {
    return Promise.resolve(requested) // mock host grants everything
  }

  sendEvent(eventType: string, content: unknown, stateKey?: string | null): Promise<ISendEventDetails> {
    const ev = this.mkEvent(eventType, content, stateKey)
    this.apply(ev, true)
    return Promise.resolve({ roomId, eventId: ev.event_id })
  }

  // MatrixRTC uses server-side delayed leave events as a dead-man's switch.
  // The mock equivalent: accept them, and if the tab dies the membership is
  // pruned by the other tabs' presence logic instead, so 'send' on request
  // is the only action that must actually apply.
  sendDelayedEvent(
    _delay: number | null, _parentDelayId: string | null,
    eventType: string, content: unknown, stateKey?: string | null,
  ): Promise<ISendDelayedEventDetails> {
    const delayId = `mockdelay-${this.nDelay++}`
    this.delayed.set(delayId, { eventType, content, stateKey })
    return Promise.resolve({ roomId, delayId })
  }

  cancelScheduledDelayedEvent(delayId: string): Promise<void> {
    this.delayed.delete(delayId)
    return Promise.resolve()
  }

  restartScheduledDelayedEvent(_delayId: string): Promise<void> {
    return Promise.resolve() // nothing times out in the mock; restart is moot
  }

  sendScheduledDelayedEvent(delayId: string): Promise<void> {
    const d = this.delayed.get(delayId)
    if (d) this.apply(this.mkEvent(d.eventType, d.content, d.stateKey), true)
    this.delayed.delete(delayId)
    return Promise.resolve()
  }

  readRoomState(_roomId: string, eventType: string, stateKey: string | undefined): Promise<IRoomEvent[]> {
    const out: IRoomEvent[] = []
    for (const [key, ev] of this.state) {
      const [t, k] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
      if (t === eventType && (stateKey === undefined || k === stateKey)) out.push(ev)
    }
    return Promise.resolve(out)
  }

  readStateEvents(eventType: string, stateKey: string | undefined, _limit: number): Promise<IRoomEvent[]> {
    return this.readRoomState(roomId, eventType, stateKey)
  }

  readRoomEvents(): Promise<IRoomEvent[]> { return Promise.resolve([]) }

  // MSC4039 media repo, in-memory: uploads are gossiped to every tab so a
  // peer's widget can download a scene its neighbour uploaded.
  getMediaConfig(): Promise<IGetMediaConfigResult> {
    return Promise.resolve({ 'm.upload.size': 100 * 1024 * 1024 })
  }

  async uploadFile(file: XMLHttpRequestBodyInit): Promise<{ contentUri: string }> {
    const bytes = await new Response(file as BodyInit).arrayBuffer()
    const uri = `mxc://mock.localhost/${userId.slice(2, 8)}-${this.nFile++}`
    this.files.set(uri, bytes)
    this.ch.postMessage({ t: 'file', uri, bytes } satisfies HostFile)
    return { contentUri: uri }
  }

  downloadFile(contentUri: string): Promise<{ file: XMLHttpRequestBodyInit }> {
    const bytes = this.files.get(contentUri)
    if (!bytes) return Promise.reject(new Error(`no such mock media: ${contentUri}`))
    return Promise.resolve({ file: new Blob([bytes]) })
  }

  askOpenID(observer: SimpleObservable<IOpenIDUpdate>): void {
    observer.update({
      state: OpenIDRequestState.Allowed,
      token: {
        access_token: 'mock-openid-token',
        expires_in: 3600,
        matrix_server_name: 'mock.localhost',
        token_type: 'Bearer',
      },
    })
  }
}

function boot() {
  const iframe = document.getElementById('widget') as HTMLIFrameElement
  // relative to wherever mock.html is served (subpath hosts included)
  const widgetUrl = new URL('.', location.href)
  widgetUrl.searchParams.set('widgetId', `worldsync-${room}`)
  widgetUrl.searchParams.set('parentUrl', location.href)
  widgetUrl.searchParams.set('roomId', roomId)
  widgetUrl.searchParams.set('userId', userId)
  widgetUrl.searchParams.set('deviceId', deviceId)
  // our own origin: the vite dev server answers /_matrix/client/versions
  widgetUrl.searchParams.set('baseUrl', location.origin)
  widgetUrl.searchParams.set('mockTransport', '1')

  // waitForIframeLoad stays at its default (true), matching what Element
  // Web gives widgets added via /addwidget: the handshake starts from the
  // iframe load event and the widget must NOT send ContentLoaded. Keeping
  // the mock host on the same semantics as the real one is the point.
  const widget = new Widget({
    id: `worldsync-${room}`,
    creatorUserId: userId,
    type: 'm.custom',
    url: widgetUrl.toString(),
  })
  const driver = new MockDriver()
  const api = new ClientWidgetApi(widget, iframe, driver)
  driver.attach(api)
  ;(window as unknown as Record<string, unknown>).__mockhost = { driver, api }
  api.on('ready', () => {
    document.getElementById('status')!.textContent =
      `mock host | room ${room} | ${userId} (${deviceId}) - open this URL in another tab to mesh`
    void api.transport.send(WidgetApiToWidgetAction.ThemeChange, { name: 'dark' }).catch(() => {})
  })
  iframe.src = widgetUrl.toString()
}

boot()
