import { Room as LivekitRoom, RoomEvent } from 'livekit-client'
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
    const sfu = await getSFUConfig(this.client, this.serviceUrl, this.roomId, this.userId, this.deviceId)
    await this.room.connect(sfu.url, sfu.jwt)
    emit()
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
  private closed = false

  constructor(room: string, private identity: string) {
    this.ch = new BroadcastChannel(`worldsync-mock-${room}`)
  }

  async connect() {
    this.ch.onmessage = ev => {
      const m = ev.data as { t: 'hello' | 'ack' | 'bye' | 'data'; from: string; to?: string | null; data?: string }
      if (m.from === this.identity) return
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
    this.ch.postMessage({ t: 'bye', from: this.identity })
    this.ch.close()
  }
}
