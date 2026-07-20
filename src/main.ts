import { Vector3 } from 'three'
import { BOOT_LEAD_TICKS, Sim } from './sim'
import { cachedScene, cacheScene, parseGlb } from './scene'
import { fetchWorldAsset, uploadWorldAsset } from './matrix/world'
import { Net } from './net'
import { Session } from './session'
import { View } from './render'
import { Input, type Emitter } from './input'
import { UI } from './ui'
import { wallNow, type DcMessage } from './types'
import { widgetParams } from './matrix/params'
import { initWidgetClient } from './matrix/widget'

/** What main needs from a transport; Net (ws demo) and MatrixNet both fit. */
interface NetLike {
  sendDelayMs: number
  lagPings: boolean
  peers: Map<string, { connected: boolean }>
  sendToId(id: string, msg: DcMessage): void
  broadcast(msg: DcMessage): void
}

// The widget-api handshake must begin at module scope, before the window
// 'load' event: hosts with waitForIframeLoad=true (Element Web's default
// for /addwidget widgets) fire their capabilities request at iframe load,
// and only a constructed RoomWidgetClient is listening. Module scripts
// finish before 'load', so constructing here wins the race; waiting until
// after the Rapier wasm init (seconds) loses it and the session never
// starts. The stray-rejection guard keeps an early handshake failure
// quiet until connect() awaits and reports it.
const wp = widgetParams()
const widgetBoot = wp ? initWidgetClient(wp) : null
widgetBoot?.catch(() => {})

async function main() {
  const params = new URLSearchParams(location.search)
  const room = wp ? wp.roomId : params.get('room') ?? 'default'
  const sim = new Sim()
  // ?norm=pipeline swaps per-tick world restore for per-tick solver reset
  // (refuted, kept as a demo); ?cad=K snapshots/normalises every K
  // grid-aligned ticks. Every peer in a room must use the same settings.
  if (params.get('norm') === 'pipeline') sim.normalizeMode = 'pipeline'
  const cad = Math.floor(Number(params.get('cad') ?? '0'))
  if (cad >= 1) sim.cadence = cad
  await sim.init()
  const view = new View(document.body, sim.ecs)
  // In widget mode the transport is Matrix (identity from the host client,
  // MatrixRTC membership, LiveKit or mock data path); otherwise the classic
  // ws-signalled WebRTC mesh. The Session cannot tell them apart.
  const net: NetLike = wp
    ? new (await import('./matrix/net')).MatrixNet()
    : new Net()
  const session = new Session(
    sim,
    (to, msg) => to === null ? net.broadcast(msg) : net.sendToId(to, msg),
    wallNow)

  const ui = new UI(document.getElementById('panel')!, {
    onLatency: v => { net.sendDelayMs = v },
    onLagPings: v => { net.lagPings = v },
    onRubber: v => { view.rubberMs = v },
    onVerify: () => ui.log(`replay self-check: ${JSON.stringify(sim.verifyReplay(60))}`),
    onDumpInputs: () => {
      const blob = new Blob(
        [JSON.stringify({ peer: session.id, order: session.order, tick: sim.tick, log: sim.inputLog }, null, 1)],
        { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `inputs-${session.id}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    },
    // MSC3815: upload a GLB to the media repo, point the room's world state
    // event at it, and fold a 'scene' op into the shared timeline so every
    // peer swaps colliders on the same tick.
    onSceneFile: async file => {
      if (!wp) { log('scene loading needs Matrix (run as a widget; the mock host works: /mock.html)'); return }
      if (!session.ready()) { log('scene upload ignored: session not started yet'); return }
      const m = net as import('./matrix/net').MatrixNet
      try {
        const parsed = await parseGlb(await file.arrayBuffer()) // validate before it can land in room state
        log(`uploading ${file.name} (${(file.size / 1024).toFixed(0)} kB, ${parsed.geometry.indices.length / 3} tris)...`)
        const mxc = await uploadWorldAsset(m.api, m.client, wp.roomId, file, 'scene')
        cacheScene(mxc, parsed)
        sim.registerSceneGeometry(mxc, parsed.geometry)
        // Stamped ahead like a boot seam so no peer has passed the tick when
        // it arrives; peers still downloading heal by folding once cached.
        session.emit('scene', mxc, { pos: { x: 0, y: 0, z: 0 } }, sim.tick + BOOT_LEAD_TICKS)
        log(`scene set: ${mxc}`)
      } catch (e) {
        log(`scene upload failed: ${e}`)
        console.error('[worldsync]', e)
      }
    },
    // MSC3815 script_url: upload the JS, merge it into the world state
    // event; the state echo (ours and every other peer's watch) feeds the
    // script driver below, which runs it only on the current root peer.
    onScriptFile: async file => {
      if (!wp) { log('world scripts need Matrix (run as a widget; the mock host works: /mock.html)'); return }
      const m = net as import('./matrix/net').MatrixNet
      try {
        log(`uploading ${file.name} (${(file.size / 1024).toFixed(1)} kB)...`)
        const mxc = await uploadWorldAsset(m.api, m.client, wp.roomId, file, 'script')
        log(`world script set: ${mxc}`)
        worldScriptChanged(mxc) // don't wait for our own state echo
      } catch (e) {
        log(`script upload failed: ${e}`)
        console.error('[worldsync]', e)
      }
    },
  })
  // In widget mode the panel can be tiny or hidden, so mirror every
  // diagnostic line to the console; debugging inside a host iframe with a
  // silent panel is otherwise guesswork.
  const log = (l: string) => {
    ui.log(l)
    if (wp) console.log('[worldsync]', l)
  }
  if (wp) console.log('[worldsync] widget mode', {
    userId: wp.userId, deviceId: wp.deviceId, roomId: wp.roomId,
    baseUrl: wp.baseUrl, mockTransport: wp.mockTransport,
  })
  session.onLog = log
  sim.onAnomaly = m => log(`ANOMALY: ${m}`)
  // Stash bit-level dumps of our state at (and just before) the divergent
  // tick for cross-peer post-mortem diffing.
  session.onDiverged = (peerId, t) => {
    const b64 = (u: Uint8Array | null) => {
      if (!u) return null
      let s = ''
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
      return btoa(s)
    }
    ;(window as any).__divergence = {
      peer: peerId, tick: t,
      state: sim.stateAt(t), statePrev: sim.stateAt(t - 1),
      snapPrev: b64(sim.snapshotAt(t - 1)), snap: b64(sim.snapshotAt(t)),
      inputsAt: sim.inputLog.filter(e => e.tick >= t - 1 && e.tick <= t),
    }
  }

  if (net instanceof Net) {
    net.onJoined = (id, order, alone) => session.identity(id, order, alone)
    net.onMessage = (peer, msg) => session.receive(peer.id, msg)
    net.onPeerConnected = peer => session.peerConnected(peer.id, peer.order)
    net.onPeerLeft = id => session.peerLeft(id)
    net.onLog = log
  } else {
    const m = net as import('./matrix/net').MatrixNet
    m.onJoined = (id, order, alone) => { log(`joined as ${id} (order ${order}${alone ? ', alone: rooting grid' : ''})`); session.identity(id, order, alone) }
    m.onMessage = (from, msg) => session.receive(from, msg)
    m.onPeerConnected = (id, order) => { log(`peer connected ${id} (#${order})`); session.peerConnected(id, order) }
    m.onPeerLeft = id => session.peerLeft(id)
    m.onLog = log
    // Room already has an MSC3815 scene: fetch, parse, and adopt it before
    // the sim's first tick (connect() awaits this before joining the RTC
    // session, so calibration cannot start early).
    m.onPreloadScene = async url => {
      const parsed = await parseGlb(await fetchWorldAsset(m.api, url))
      cacheScene(url, parsed)
      sim.registerSceneGeometry(url, parsed.geometry)
      sim.adoptScene(url)
      log(`scene preloaded (${parsed.geometry.indices.length / 3} tris)`)
    }
    m.onWorldScript = url => worldScriptChanged(url)
    m.onSeniorsUnreachable = () => session.seniorsUnreachable()
  }

  // Keep the rendered scene in step with the sim's active scene (which can
  // change via ops, rollbacks, and preloads), and fetch any scene the sim
  // adopted before we have its GLB (another peer swapped it mid-session).
  const sceneFetches = new Set<string>()
  const syncScene = () => {
    const url = sim.sceneUrl
    view.setScene(url ? cachedScene(url)?.object ?? null : null)
    if (!url || cachedScene(url) || !wp || sceneFetches.has(url)) return
    sceneFetches.add(url)
    const m = net as import('./matrix/net').MatrixNet
    ;(async () => {
      const parsed = await parseGlb(await fetchWorldAsset(m.api, url))
      cacheScene(url, parsed)
      sim.registerSceneGeometry(url, parsed.geometry) // schedules the healing fold
      log(`scene fetched (${parsed.geometry.indices.length / 3} tris)`)
    })().catch(e => {
      sceneFetches.delete(url) // retried next frame
      log(`scene fetch failed: ${e}`)
    })
  }

  // --- MSC3815 script_url: WebSG-subset scripts, root-peer authority ---
  // The script runs ONLY on the current root peer (lowest join order);
  // everything it does leaves the sandbox as ordinary ops, which is what
  // keeps remote peers deterministic. Every peer tracks the url so a root
  // handover just starts the script on the successor (state resets).
  let scriptUrl: string | null = null
  let script: import('./websg').WorldScript | null = null
  let scriptFor: string | null = null
  let scriptStarting = false
  let lastScriptTick = 0
  const scriptSrc = new Map<string, string>()
  const scriptFetches = new Set<string>()
  const worldScriptChanged = (url: string | null) => {
    if (url === scriptUrl) return
    scriptUrl = url
    log(url ? `world script in room state: ${url}` : 'world script cleared')
  }
  // Script authority goes to the senior-most REACHABLE peer, not the senior
  // membership: a ghost membership (dead tab, killed session) must not hold
  // the script hostage. During a partition both sides can briefly believe
  // they are root (split-brain: doubled script effects) - a real fix needs
  // consensus, which the jig deliberately does not have.
  const isRoot = () => {
    if (!session.ready()) return false
    for (const p of session.peers.values()) {
      if (p.order < session.order && (net.peers.get(p.id)?.connected ?? false)) return false
    }
    return true
  }
  const scriptHost: import('./websg').ScriptHost = {
    log: l => log(`[script] ${l}`),
    boxes: () => {
      const out = []
      for (const netId of sim.bodies.keys()) {
        const b = sim.body(netId)
        if (!b) continue
        const p = b.translation()
        const g = sim.grabs.get(netId)
        out.push({ id: netId, x: p.x, y: p.y, z: p.z, grabbed: !!g, mine: g?.holder === session.id })
      }
      return out
    },
    box: id => {
      const b = sim.body(id)
      if (!b) return null
      const p = b.translation()
      const g = sim.grabs.get(id)
      return { x: p.x, y: p.y, z: p.z, grabbed: !!g, mine: g?.holder === session.id }
    },
    sceneNode: name => {
      const url = sim.sceneUrl
      const obj = url ? cachedScene(url)?.object.getObjectByName(name) : null
      if (!obj) return null
      const v = new Vector3()
      obj.getWorldPosition(v)
      return { x: v.x, y: v.y, z: v.z }
    },
    spawn: (x, y, z, color) => {
      const id = session.nextNetId()
      session.emit('spawn', id, { pos: { x, y, z }, color })
      return id
    },
    grab: id => {
      const b = sim.body(id)
      if (!b || sim.grabs.has(id)) return false
      const p = b.translation()
      session.emit('grab', id, { pos: { x: p.x, y: p.y, z: p.z } })
      return true
    },
    moveTo: (id, x, y, z) => {
      const g = sim.grabs.get(id)
      if (!g || g.holder !== session.id) return false
      session.streamPose(id, { x, y, z })
      return true
    },
    release: (id, vx, vy, vz) => {
      const g = sim.grabs.get(id)
      if (!g || g.holder !== session.id) return false
      const b = sim.body(id)
      const p = b ? b.translation() : { x: 0, y: 0, z: 0 }
      session.emit('release', id, { pos: { x: p.x, y: p.y, z: p.z }, vel: { x: vx, y: vy, z: vz } })
      return true
    },
  }
  const syncScript = () => {
    const want = scriptUrl !== null && wp !== null && isRoot()
    if (script && (!want || scriptFor !== scriptUrl)) {
      script.dispose()
      script = null
      log(!want ? 'world script stopped (not root here)' : 'world script replaced')
    }
    if (!want) return
    const url = scriptUrl!
    const src = scriptSrc.get(url)
    if (src === undefined) {
      if (scriptFetches.has(url)) return
      scriptFetches.add(url)
      const m = net as import('./matrix/net').MatrixNet
      fetchWorldAsset(m.api, url)
        .then(buf => { scriptSrc.set(url, new TextDecoder().decode(buf)) })
        .catch(e => { scriptFetches.delete(url); log(`script fetch failed: ${e}`) })
      return
    }
    if (!script && !scriptStarting) {
      scriptStarting = true
      import('./websg')
        .then(({ WorldScript }) => WorldScript.create(src, scriptHost))
        .then(s => {
          scriptStarting = false
          if (scriptUrl !== url || !isRoot()) { s.dispose(); return }
          script = s
          scriptFor = url
          lastScriptTick = sim.tick
          s.enter()
          log('world script running (this peer is root)')
        })
        .catch(e => {
          scriptStarting = false
          scriptSrc.delete(url) // don't retry a broken script in a loop
          log(`world script failed to start: ${e}`)
        })
      return
    }
    if (script && sim.tick > lastScriptTick) {
      const dt = (sim.tick - lastScriptTick) / 60
      lastScriptTick = sim.tick
      script.update(dt, (sim.tick - session.startTick) / 60)
      if (script.dead) {
        script.dispose()
        script = null
        scriptSrc.delete(scriptFor!)
        log('world script disabled after repeated errors')
      }
    }
  }

  let lastNotReady = 0
  const out: Emitter = {
    ready: () => {
      const r = session.ready()
      if (!r && performance.now() - lastNotReady > 2000) {
        lastNotReady = performance.now()
        log('input ignored: session not started (no identity yet, or waiting for a senior peer to calibrate against)')
      }
      return r
    },
    nextNetId: () => session.nextNetId(),
    emit: (type, netId, data) => session.emit(type, netId, data),
    streamPose: (netId, pos) => session.streamPose(netId, pos),
  }
  const input = new Input(view, out)

  if (net instanceof Net) net.connect(room)
  else {
    (net as import('./matrix/net').MatrixNet)
      .connect(wp!, params.get('lkService'), widgetBoot!)
      .catch(e => { log(`matrix connect failed: ${e}`); console.error('[worldsync]', e) })
  }

  function frame() {
    const now = wallNow()
    if (sim.needsResim) {
      const presented = view.capture()
      if (session.foldIfNeeded()) {
        sim.mirror()
        view.applyCorrections(presented, now, input.draggedEid)
      }
    }
    session.advance()
    sim.mirror()
    syncScene()
    syncScript()
    const alpha = session.calibrated
      ? Math.min(Math.max(session.tickTimeNow(now) - sim.tick, 0), 1)
      : 0
    view.frame(now, alpha)
    ui.maybe(now, () => ({
      room, id: session.id, order: session.order,
      entities: sim.bodies.size, tick: sim.tick - session.startTick, stepMs: sim.stepMs,
      perf: sim.perf, norm: sim.cadence > 1 ? `${sim.normalizeMode}/${sim.cadence}` : sim.normalizeMode,
      rollbacks: sim.rollbacks, lastDepth: sim.lastReplayDepth,
      peers: [...session.peers.values()].map(p => ({
        id: p.id, order: p.order,
        connected: net.peers.get(p.id)?.connected ?? false,
        rtt: p.rtt, offset: p.offset, strikes: p.strikes, excluded: p.excluded,
        sync: p.divergedAt !== null ? `≠@${p.divergedAt - session.startTick}` : p.checked ? '=' : '-',
      })),
    }))
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // Hidden tabs get no rAF, and throttled timers alone would eventually trip
  // the tick-jump anomaly; worker messages are not throttled, so a worker
  // heartbeat keeps the sim stepping (without rendering) in the background.
  const ticker = new Worker(URL.createObjectURL(new Blob(
    ['setInterval(() => postMessage(0), 100)'], { type: 'application/javascript' })))
  ticker.onmessage = () => {
    if (!document.hidden) return
    session.foldIfNeeded()
    session.advance()
    sim.mirror()
    syncScene() // scene fetches must not stall while the tab is hidden
    syncScript() // nor the script, if the hidden tab is the root
  }

  // Hooks for automated smoke tests and console poking.
  ;(window as any).__jig = {
    sim, net, session, view,
    pos: (netId: string) => {
      const b = sim.body(netId)
      if (!b) return null
      const p = b.translation()
      return { x: p.x, y: p.y, z: p.z }
    },
    screenPos: (netId: string) => {
      const eid = sim.ecs.entityFor(netId)
      const m = eid === undefined ? undefined : view.meshes.get(eid)
      if (!m) return null
      const v = m.position.clone().project(view.camera)
      const el = view.renderer.domElement
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight }
    },
    screenOfGround: (x: number, zz: number) => {
      const v = new Vector3(x, 0, zz).project(view.camera)
      const el = view.renderer.domElement
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight }
    },
    screenOfWorld: (x: number, y: number, zz: number) => {
      const v = new Vector3(x, y, zz).project(view.camera)
      const el = view.renderer.domElement
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight }
    },
    verify: (depth?: number) => sim.verifyReplay(depth ?? 60),
    roundTrip: () => sim.roundTrip(),
  }
}

main()
