import { Sim, TICK_MS } from './sim'
import { Session } from './session'
import type { DcMessage } from './types'

/**
 * Loopback "network" on a virtual clock: per-link one-way latency,
 * deterministic delivery order, no sockets, no browser. Messages take the
 * same JSON round-trip they would on the wire, so serialisation hazards
 * (-0, float formatting) are exercised, not hidden. A test drives virtual
 * time with run(); each increment delivers due messages, then ticks every
 * peer, exactly like the rAF loop does live.
 */
export interface HubPeer {
  id: string
  order: number
  sim: Sim
  session: Session
}

export const createHub = (defaultLatencyMs = 0) => {
  const peers: HubPeer[] = []
  const links = new Map<string, number>() // "from>to" -> one-way ms
  const queue: { due: number; n: number; from: string; to: Session; msg: DcMessage }[] = []
  let now = 0
  let sent = 0
  let order = 0

  const latency = (from: string, to: string) => links.get(from + '>' + to) ?? defaultLatencyMs

  const deliverTo = (from: string, target: HubPeer, msg: DcMessage) => {
    queue.push({
      due: now + latency(from, target.id), n: sent++, from,
      to: target.session,
      msg: JSON.parse(JSON.stringify(msg)),
    })
  }

  return {
    now: () => now,
    peers,
    /** symmetric latency override for one pair */
    link(a: string, b: string, ms: number) {
      links.set(a + '>' + b, ms)
      links.set(b + '>' + a, ms)
    },
    /** one-way latency override (an asymmetric or lagging sender) */
    linkOneWay(from: string, to: string, ms: number) {
      links.set(from + '>' + to, ms)
    },
    /** create a peer and full-mesh it with everyone already present.
     * clockWarp distorts this peer's LOCAL clock (skew, drift) to prove
     * calibration absorbs it; the tick grid must not care. */
    async join(id: string, clockWarp: (nowMs: number) => number = n => n): Promise<HubPeer> {
      const sim = new Sim()
      await sim.init()
      const me: HubPeer = { id, order: ++order, sim, session: null as unknown as Session }
      me.session = new Session(
        sim,
        (to, msg) => {
          for (const p of peers) {
            if (p === me) continue
            if (to === null || to === p.id) deliverTo(id, p, msg)
          }
        },
        () => clockWarp(now))
      me.session.identity(id, me.order, peers.length === 0)
      for (const p of peers) {
        p.session.peerConnected(id, me.order)
        me.session.peerConnected(p.id, p.order)
      }
      peers.push(me)
      return me
    },
    /** advance virtual time in whole ticks, delivering due messages before
     * each tick; onTick runs after each tick for scripting user actions */
    run(ms: number, onTick?: (i: number) => void) {
      const ticks = Math.round(ms / TICK_MS)
      for (let i = 0; i < ticks; i++) {
        now += TICK_MS
        queue.sort((x, y) => x.due - y.due || x.n - y.n)
        while (queue.length && queue[0].due <= now) {
          const m = queue.shift()!
          m.to.receive(m.from, m.msg)
        }
        for (const p of peers) {
          p.session.foldIfNeeded()
          p.session.advance()
        }
        onTick?.(i)
      }
    },
  }
}
