import { Room as LivekitRoom, RoomEvent, Track } from 'livekit-client'
import type { MatrixClient } from 'matrix-js-sdk'

/**
 * The data path under MatrixNet, small enough to fake: LiveKit text streams
 * in production, a BroadcastChannel loopback in the mock dev host. Identities
 * are MatrixRTC member ids (`${userId}:${deviceId}`).
 */
export interface DataTransport {
  connect(): Promise<void>
  /** to === null broadcasts to everyone currently reachable */
  send(to: string | null, data: string): void
  onData: (from: string, data: string) => void
  /** fires with the full set of reachable identities on every change */
  onParticipants: (identities: Set<string>) => void
  /** publish/unpublish the local microphone, where the transport has a
   * media path (LiveKit does, the mock does not); resolves to the
   * resulting state */
  setMicEnabled?(on: boolean): Promise<boolean>
  close(): void
}

const TOPIC = 'worldsync'

interface SFUConfig { url: string; jwt: string }

/**
 * OpenID -> LiveKit JWT exchange, after element-call's openIDSFU.ts: prove
 * our Matrix identity to the lk-jwt-service with an OpenID token minted by
 * the homeserver (via the host client), get back the SFU url + access JWT.
 * Tries the Matrix 2.0 endpoint first, falls back to the legacy one.
 */
async function getSFUConfig(
  client: MatrixClient, serviceUrl: string, roomId: string,
  userId: string, deviceId: string,
): Promise<SFUConfig> {
  const openIdToken = await client.getOpenIdToken()
  const memberId = `${userId}:${deviceId}`
  const modern = await fetch(`${serviceUrl}/get_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_id: roomId,
      slot_id: 'm.call#',
      openid_token: openIdToken,
      member: { id: memberId, claimed_user_id: userId, claimed_device_id: deviceId },
    }),
  }).catch(() => null)
  if (modern?.ok) {
    const body = await modern.json()
    return { url: body.url, jwt: body.jwt }
  }
  const legacy = await fetch(`${serviceUrl}/sfu/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomId, openid_token: openIdToken, device_id: deviceId }),
  })
  if (!legacy.ok) throw new Error(`lk-jwt-service refused: ${legacy.status}`)
  const body = await legacy.json()
  return { url: body.url, jwt: body.jwt }
}

export class LiveKitTransport implements DataTransport {
  onData: (from: string, data: string) => void = () => {}
  onParticipants: (identities: Set<string>) => void = () => {}
  private room = new LivekitRoom()

  constructor(
    private client: MatrixClient,
    private serviceUrl: string,
    private roomId: string,
    private userId: string,
    private deviceId: string,
  ) {}

  async connect() {
    this.room.registerTextStreamHandler(TOPIC, async (reader, participant) => {
      const text = await reader.readAll()
      if (participant) this.onData(participant.identity, text)
    })
    const emit = () => this.onParticipants(new Set([...this.room.remoteParticipants.values()].map(p => p.identity)))
    this.room.on(RoomEvent.ParticipantConnected, emit)
    this.room.on(RoomEvent.ParticipantDisconnected, emit)
    this.room.on(RoomEvent.Connected, emit)
    // Voice rides the same room: attach every subscribed audio track to a
    // hidden <audio> element, so hearing others needs no mic of your own.
    this.room.on(RoomEvent.TrackSubscribed, track => {
      if (track.kind !== Track.Kind.Audio) return
      const el = track.attach()
      el.style.display = 'none'
      document.body.appendChild(el)
    })
    this.room.on(RoomEvent.TrackUnsubscribed, track => {
      if (track.kind !== Track.Kind.Audio) return
      for (const el of track.detach()) el.remove()
    })
    // Autoplay policy may hold playback until a user gesture; resume on
    // the next one.
    this.room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (this.room.canPlaybackAudio) return
      const resume = () => {
        removeEventListener('pointerdown', resume)
        removeEventListener('keydown', resume)
        void this.room.startAudio().catch(() => {})
      }
      addEventListener('pointerdown', resume)
      addEventListener('keydown', resume)
    })
    const sfu = await getSFUConfig(this.client, this.serviceUrl, this.roomId, this.userId, this.deviceId)
    await this.room.connect(sfu.url, sfu.jwt)
    emit()
  }

  /** First enable triggers the browser's permission prompt; the track is
   * only ever published while enabled, so "muted" sends nothing. */
  async setMicEnabled(on: boolean): Promise<boolean> {
    await this.room.localParticipant.setMicrophoneEnabled(on)
    return this.room.localParticipant.isMicrophoneEnabled
  }

  send(to: string | null, data: string) {
    void this.room.localParticipant.sendText(data, {
      topic: TOPIC,
      destinationIdentities: to === null ? undefined : [to],
    }).catch(() => {}) // transient disconnects drop messages, like any transport
  }

  close() { void this.room.disconnect() }
}

/**
 * Mock transport for the standalone dev loop: every tab on this origin in
 * the same room shares a BroadcastChannel. Presence is announced explicitly
 * and confirmed pairwise (hello/ack), so late tabs see early ones.
 */
export class BroadcastTransport implements DataTransport {
  onData: (from: string, data: string) => void = () => {}
  onParticipants: (identities: Set<string>) => void = () => {}
  private ch: BroadcastChannel
  private present = new Set<string>()
  private lastSeen = new Map<string, number>()
  private beat: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(room: string, private identity: string) {
    this.ch = new BroadcastChannel(`worldsync-mock-${room}`)
  }

  async connect() {
    this.ch.onmessage = ev => {
      const m = ev.data as { t: 'hello' | 'ack' | 'bye' | 'data'; from: string; to?: string | null; data?: string }
      if (m.from === this.identity) return
      this.lastSeen.set(m.from, Date.now())
      switch (m.t) {
        case 'hello':
          this.ch.postMessage({ t: 'ack', from: this.identity })
          this.add(m.from)
          break
        case 'ack':
          this.add(m.from)
          break
        case 'bye':
          this.present.delete(m.from)
          this.onParticipants(new Set(this.present))
          break
        case 'data':
          if (m.to == null || m.to === this.identity) this.onData(m.from, m.data!)
          break
      }
    }
    this.ch.postMessage({ t: 'hello', from: this.identity })
    addEventListener('pagehide', () => this.close())
    // Liveness, like a real SFU's ParticipantDisconnected: a killed tab
    // often never sends bye (hard close, crash), so re-announce every
    // second and evict anyone silent for 3s. Any message counts as life.
    this.beat = setInterval(() => {
      this.ch.postMessage({ t: 'hello', from: this.identity })
      const cutoff = Date.now() - 3000
      for (const id of this.present) {
        if ((this.lastSeen.get(id) ?? 0) < cutoff) {
          this.present.delete(id)
          this.onParticipants(new Set(this.present))
        }
      }
    }, 1000)
  }

  private add(id: string) {
    if (this.present.has(id)) return
    this.present.add(id)
    this.onParticipants(new Set(this.present))
  }

  send(to: string | null, data: string) {
    this.ch.postMessage({ t: 'data', from: this.identity, to, data })
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.beat) clearInterval(this.beat)
    this.ch.postMessage({ t: 'bye', from: this.identity })
    this.ch.close()
  }
}
