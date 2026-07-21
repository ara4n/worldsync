import { Raycaster, Vector2, Vector3 } from 'three'
import { BOOT_LEAD_TICKS, Sim } from './sim'
import { peerColor } from './color'
import { cachedScene, cacheScene, configureGlbLoader, parseGlb } from './scene'
import { fetchWorldAsset, mediaUploadLimit, uploadWorldAsset } from './matrix/world'
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
  configureGlbLoader(view.renderer)
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
        // Pre-flight the homeserver's media cap: a too-big file otherwise
        // dies deep in the host as an unexplained 413. Logged either way,
        // so a failed upload can be compared against the claimed limit.
        const limit = await mediaUploadLimit(m.api)
        if (limit !== null && file.size > limit) {
          log(`scene too big to upload: ${(file.size / 1e6).toFixed(1)}MB > the homeserver's `
            + `${(limit / 1e6).toFixed(1)}MB media limit`)
          return
        }
        log(`uploading ${file.name} (${(file.size / 1024).toFixed(0)} kB, ${parsed.geometry.indices.length / 3} tris; `
          + `host reports ${limit === null ? 'no' : (limit / 1e6).toFixed(1) + 'MB'} media limit)...`)
        const mxc = await uploadWorldAsset(m.api, m.client, wp.roomId, file, 'scene')
        cacheScene(mxc, parsed)
        sim.registerSceneGeometry(mxc, parsed.geometry)
        // Stamped ahead like a boot seam so no peer has passed the tick when
        // it arrives; peers still downloading heal by folding once cached.
        session.emit('scene', mxc, { pos: { x: 0, y: 0, z: 0 } }, sim.tick + BOOT_LEAD_TICKS)
        log(`scene set: ${mxc}`)
      } catch (e) {
        logErr('scene upload failed', e)
      }
    },
    // MSC3815 script_url: upload the JS, merge it into the world state
    // event; the state echo (ours and every other peer's watch) feeds the
    // script driver below, which runs it only on the current root peer.
    onScriptFile: file => uploadScript(file).catch(() => {}),
    // The monaco editor and glTF inspector are heavy overlays most peers
    // never open; each lives in its own dynamically-imported chunk.
    onEditScript: async () => {
      const { ScriptEditor } = await import('./editor')
      editor ??= new ScriptEditor(document.body, room, {
        log,
        getPersisted: async () => {
          if (!scriptUrl || !wp) return null
          const cached = scriptSrc.get(scriptUrl)
          if (cached !== undefined) return cached
          const m = net as import('./matrix/net').MatrixNet
          const src = new TextDecoder().decode(await fetchWorldAsset(m.api, scriptUrl))
          scriptSrc.set(scriptUrl, src)
          return src
        },
        save: source =>
          uploadScript(new File([source], 'script.js', { type: 'text/javascript' })),
      })
      editor.toggle()
    },
    onInspectScene: async () => {
      const { SceneInspector } = await import('./inspector')
      inspector ??= new SceneInspector(document.body, {
        root: () => sim.sceneUrl ? cachedScene(sim.sceneUrl)?.object ?? null : null,
        url: () => sim.sceneUrl,
        setOutline: objs => view.setOutline(objs),
      })
      inspector.toggle()
    },
  })
  let editor: import('./editor').ScriptEditor | null = null
  let inspector: import('./inspector').SceneInspector | null = null
  // Shared by the file picker and the editor's Save & Run; throws so the
  // editor can show the failure, after it has been logged here.
  const uploadScript = async (file: File) => {
    if (!wp) {
      log('world scripts need Matrix (run as a widget; the mock host works: /mock.html)')
      throw new Error('no matrix transport')
    }
    const m = net as import('./matrix/net').MatrixNet
    try {
      log(`uploading ${file.name} (${(file.size / 1024).toFixed(1)} kB)...`)
      const mxc = await uploadWorldAsset(m.api, m.client, wp.roomId, file, 'script')
      log(`world script set: ${mxc}`)
      worldScriptChanged(mxc) // don't wait for our own state echo
    } catch (e) {
      logErr('script upload failed', e)
      throw e
    }
  }
  // In widget mode the panel can be tiny or hidden, so mirror every
  // diagnostic line to the console; debugging inside a host iframe with a
  // silent panel is otherwise guesswork.
  const log = (l: string) => {
    ui.log(l)
    if (wp) console.log('[worldsync]', l)
  }
  // Widget-api errors bury the homeserver's actual complaint (errcode,
  // http status) in data.matrix_api_error; dig it out or debugging an
  // upload failure means guessing.
  const logErr = (what: string, e: unknown) => {
    log(`${what}: ${e}`)
    const detail = (e as { data?: { matrix_api_error?: unknown } })?.data?.matrix_api_error
    if (detail) log(`homeserver said: ${JSON.stringify(detail)}`)
    console.error('[worldsync]', e)
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

  // Ephemeral shared line entities ride beside the session protocol:
  // latest-wins per (author, id), purely cosmetic, so they are intercepted
  // before receive().
  const onMsg = (from: string, msg: DcMessage) => {
    if (msg.kind === 'line') {
      view.setLine(`${msg.peer}/${msg.id}`, msg.points.length ? msg.points : null,
        msg.color, msg.opacity, msg.width, msg.worldUnits)
      return
    }
    session.receive(from, msg)
  }
  // A departed peer takes its shared lines with it, and the primary clears
  // any claims it left behind (its own session can no longer unclaim them).
  const onLeft = (id: string) => {
    session.peerLeft(id)
    view.removeLines(`${id}/`)
    if (isRoot()) {
      for (const [pid, p] of sim.props) {
        if (p.claim === id) session.emit('unclaim', pid, { pos: { x: 0, y: 0, z: 0 }, force: true })
      }
    }
  }

  if (net instanceof Net) {
    net.onJoined = (id, order, alone) => session.identity(id, order, alone)
    net.onMessage = (peer, msg) => onMsg(peer.id, msg)
    net.onPeerConnected = peer => session.peerConnected(peer.id, peer.order)
    net.onPeerLeft = onLeft
    net.onLog = log
  } else {
    const m = net as import('./matrix/net').MatrixNet
    m.onJoined = (id, order, alone) => { log(`joined as ${id} (order ${order}${alone ? ', alone: rooting grid' : ''})`); session.identity(id, order, alone) }
    m.onMessage = onMsg
    m.onPeerConnected = (id, order) => { log(`peer connected ${id} (#${order})`); session.peerConnected(id, order) }
    m.onPeerLeft = onLeft
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
    view.setGroundVisible(!url)
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

  // --- MSC3815 script_url: WebSG-subset scripts on EVERY peer ---
  // Each peer runs its own script instance, uncoordinated: everything a
  // script does leaves the sandbox as ordinary ops, so peers fold script
  // effects exactly like human input. Claims coordinate sustained
  // interactions (racing claims resolve deterministically by timeline
  // order); single-runner logic (board init, ambient behaviour) keys off
  // world.me.primary, which names the senior-most REACHABLE peer.
  let scriptUrl: string | null = null
  let script: import('./websg').WorldScript | null = null
  let scriptFor: string | null = null
  let scriptStarting = false
  let scriptPointerOn = false
  let lastScriptTick = 0
  const scriptSrc = new Map<string, string>()
  const scriptFetches = new Set<string>()
  const worldScriptChanged = (url: string | null) => {
    if (url === scriptUrl) return
    scriptUrl = url
    log(url ? `world script in room state: ${url}` : 'world script cleared')
  }
  // Primacy goes to the senior-most REACHABLE peer, not the senior
  // membership: a ghost membership (dead tab, killed session) must not hold
  // single-runner logic hostage. During a partition both sides can briefly
  // believe they are primary (split-brain: doubled effects) - a real fix
  // needs consensus, which the jig deliberately does not have.
  const isRoot = () => {
    if (!session.ready()) return false
    for (const p of session.peers.values()) {
      if (p.order < session.order && (net.peers.get(p.id)?.connected ?? false)) return false
    }
    return true
  }
  const propView = (id: string, p: import('./sim').Prop) => ({
    id, x: p.pos.x, y: p.pos.y, z: p.pos.z, color: p.color, size: p.size, kind: p.kind,
    claimedBy: p.claim ?? '', mine: p.claim === session.id,
  })
  // The script's line entities: rendered locally under our author key, and
  // (when shared) broadcast as full latest-wins state per (author, id).
  const scriptLines = new Map<string, boolean>() // id -> shared
  const scriptScreens = new Set<string>()
  // Flipped by the first screen a script places; gates the camera toggle,
  // so worlds that never ask for video never show it.
  let videoWanted = false
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
    me: () => ({ id: session.id, primary: isRoot(), color: peerColor(session.id) }),
    peers: () => {
      const out = [{ id: session.id, order: session.order, color: peerColor(session.id), me: true }]
      for (const p of session.peers.values()) {
        if (!p.excluded) out.push({ id: p.id, order: p.order, color: peerColor(p.id), me: false })
      }
      return out.sort((a, b) => a.order - b.order)
    },
    props: () => [...sim.props].map(([id, p]) => propView(id, p)),
    prop: id => {
      const p = sim.props.get(id)
      return p ? propView(id, p) : null
    },
    spawnProp: (kind, x, y, z, color, size, unlit) => {
      const id = session.nextNetId()
      session.emit('prop', id, { pos: { x, y, z }, color, shape: kind, size, unlit })
      return id
    },
    spawnSolid: (x, y, z, yaw, w, h, d) => {
      const id = session.nextNetId()
      session.emit('prop', id, { pos: { x, y, z }, shape: 'collider', yaw, dims: { x: w, y: h, z: d }, solid: true })
      return id
    },
    despawn: id => {
      if (!sim.props.has(id) && !sim.bodies.has(id)) return false
      session.emit('despawn', id, { pos: { x: 0, y: 0, z: 0 } })
      return true
    },
    claim: id => {
      const p = sim.props.get(id)
      if (!p || (p.claim !== null && p.claim !== session.id)) return false
      session.emit('claim', id, { pos: { x: 0, y: 0, z: 0 } })
      return true
    },
    unclaim: id => {
      const p = sim.props.get(id)
      if (!p || p.claim !== session.id) return false
      session.emit('unclaim', id, { pos: { x: 0, y: 0, z: 0 } })
      return true
    },
    setPos: (id, x, y, z) => {
      if (!sim.props.has(id)) return false
      session.emit('move', id, { pos: { x, y, z } })
      return true
    },
    paint: (id, color) => {
      if (!sim.props.has(id)) return false
      session.emit('paint', id, { pos: { x: 0, y: 0, z: 0 }, color })
      return true
    },
    line: (id, pointsJson, color, opacity, width, worldUnits, shared) => {
      const points = pointsJson ? JSON.parse(pointsJson) as { x: number; y: number; z: number }[] : []
      scriptLines.set(id, shared)
      view.setLine(`${session.id}/${id}`, points, color, opacity, width, worldUnits)
      if (shared) {
        (net as NetLike).broadcast({ kind: 'line', peer: session.id, id, points, color, opacity, width, worldUnits })
      }
    },
    removeLine: id => {
      const shared = scriptLines.get(id)
      if (shared === undefined) return
      scriptLines.delete(id)
      view.setLine(`${session.id}/${id}`, null, 0, 0, 0, false)
      if (shared) {
        (net as NetLike).broadcast({
          kind: 'line', peer: session.id, id, points: [], color: 0, opacity: 0, width: 0, worldUnits: false,
        })
      }
    },
    screen: (id, peer, x, y, z, yaw, w, h) => {
      scriptScreens.add(id)
      if (!videoWanted) { videoWanted = true; camUi() }
      view.setScreen(`${session.id}/${id}`, peer, { x, y, z }, yaw, w, h)
    },
    removeScreen: id => {
      scriptScreens.delete(id)
      view.removeScreen(`${session.id}/${id}`)
    },
    setEnv: json => view.setEnvironment(JSON.parse(json)),
    setCamera: (x, y, z, tx, ty, tz) => view.setCameraPose({ x, y, z }, { x: tx, y: ty, z: tz }),
  }

  // Pointer events for the script: raycast the prop layer, hand the script
  // the hit plus the raw ray (for its own plane math), and capture the
  // gesture away from box spawning/grabbing when a prop was hit.
  const scriptRay = new Raycaster()
  const scriptNdc = new Vector2()
  const scriptEv = (e: PointerEvent) => {
    const r = view.renderer.domElement.getBoundingClientRect()
    scriptNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    scriptRay.setFromCamera(scriptNdc, view.camera)
    const hit = view.props.pick(scriptRay)
    const o = scriptRay.ray.origin, d = scriptRay.ray.direction
    return {
      entity: hit?.id ?? null,
      point: hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null,
      origin: { x: o.x, y: o.y, z: o.z },
      dir: { x: d.x, y: d.y, z: d.z },
    }
  }
  const scriptPointerDelegate: import('./input').ScriptPointer = {
    down: e => {
      if (!script || !scriptPointerOn) return false
      const ev = scriptEv(e)
      if (!ev.entity) return false
      script.pointer('onpointerdown', ev)
      return true
    },
    move: e => script?.pointer('onpointermove', scriptEv(e)),
    up: e => script?.pointer('onpointerup', scriptEv(e)),
  }
  const stopScript = (why: string) => {
    if (!script) return
    script.dispose()
    script = null
    scriptPointerOn = false
    for (const id of [...scriptLines.keys()]) scriptHost.removeLine(id) // its lines go with it
    for (const id of [...scriptScreens]) scriptHost.removeScreen(id) // and its screens
    if (videoWanted) {
      videoWanted = false
      stopCam() // no world is asking for video anymore: stop publishing
    }
    view.setEnvironment({}) // back to the default look
    log(why)
  }
  const syncScript = () => {
    // Scripts wait for the session: they read sim state and emit ops from
    // the first dispatch, neither of which means anything before startAt.
    const want = scriptUrl !== null && wp !== null && session.ready()
    if (script && (!want || scriptFor !== scriptUrl)) {
      stopScript(!want ? 'world script stopped' : 'world script replaced')
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
    // A boot seam still in flight means the world the script would read
    // (and might seed!) is about to be replaced: hold the start until it
    // lands, or a rejoining primary plants a second board on everyone.
    if (!script && !scriptStarting && session.worldSettled()) {
      scriptStarting = true
      import('./websg')
        .then(({ WorldScript }) => WorldScript.create(src, scriptHost))
        .then(s => {
          scriptStarting = false
          if (scriptUrl !== url) { s.dispose(); return }
          script = s
          scriptFor = url
          scriptPointerOn = s.handles('onpointerdown')
          lastScriptTick = sim.tick
          s.enter()
          log(`world script running${isRoot() ? ' (this peer is primary)' : ''}`)
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
        scriptSrc.delete(scriptFor!)
        stopScript('world script disabled after repeated errors')
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
  input.scriptPointer = scriptPointerDelegate

  // Voice, muted by default: the mic is never captured or published until
  // the first unmute (M toggles it), so joining a world never prompts for
  // permission on its own. Remote peers' audio always plays - hearing
  // others needs no mic of your own.
  let micLive = false
  let micBusy = false
  const audioNet = net as { hasAudio?: () => boolean; setMicEnabled?: (on: boolean) => Promise<boolean> }
  const toggleMic = () => {
    if (!audioNet.hasAudio?.()) {
      log('voice needs the LiveKit transport (the mock host and ws demo have no media path)')
      return
    }
    if (micBusy) return // a permission prompt is likely up; don't queue flips
    micBusy = true
    audioNet.setMicEnabled!(!micLive)
      .then(on => { micLive = on; log(on ? 'mic live (M mutes)' : 'mic muted (M unmutes)') })
      .catch(e => logErr('mic toggle failed', e))
      .finally(() => { micBusy = false; micUi() })
  }
  addEventListener('keydown', e => {
    if ((e.key !== 'm' && e.key !== 'M') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    toggleMic()
  })
  // On-canvas mute state, always visible (the panel can be collapsed or
  // tiny in a widget iframe); hidden on transports with no media path.
  const micBtn = document.createElement('button')
  micBtn.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:20;display:none;'
    + 'padding:8px 14px;border-radius:20px;border:1px solid rgba(255,255,255,0.3);cursor:pointer;'
    + 'font:13px system-ui,sans-serif;color:#fff;background:rgba(20,24,32,0.75)'
  micBtn.onclick = () => toggleMic()
  document.body.appendChild(micBtn)
  // Redrawn on the events that can change it: a mic toggle settling, and
  // the transport coming up mid-connect (hasAudio flips exactly once).
  const micUi = () => {
    if (!audioNet.hasAudio?.()) { micBtn.style.display = 'none'; return }
    micBtn.style.display = 'block'
    micBtn.textContent = micLive ? '\u{1F399} mic live · click to mute (M)' : '\u{1F507} muted · click to talk (M)'
    micBtn.style.background = micLive ? 'rgba(46,125,50,0.9)' : 'rgba(20,24,32,0.75)'
  }
  micUi()

  // Camera, same lifecycle as the mic (never captured until the first
  // enable), but only offered while a world script has placed video
  // screens: without one the pixels would have nowhere to go.
  let camLive = false
  let camBusy = false
  const videoNet = net as { hasVideo?: () => boolean; setCameraEnabled?: (on: boolean) => Promise<boolean> }
  const toggleCam = () => {
    if (!videoWanted) return
    if (!videoNet.hasVideo?.()) {
      log('video needs the LiveKit transport (the mock host and ws demo have no media path)')
      return
    }
    if (camBusy) return // a permission prompt is likely up; don't queue flips
    camBusy = true
    videoNet.setCameraEnabled!(!camLive)
      .then(on => { camLive = on; log(on ? 'camera live (V stops it)' : 'camera off (V shares it)') })
      .catch(e => logErr('camera toggle failed', e))
      .finally(() => { camBusy = false; camUi() })
  }
  const stopCam = () => {
    if (camLive) void videoNet.setCameraEnabled?.(false).then(() => { camLive = false; camUi() })
    else camUi()
  }
  addEventListener('keydown', e => {
    if ((e.key !== 'v' && e.key !== 'V') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    toggleCam()
  })
  const camBtn = document.createElement('button')
  camBtn.style.cssText = 'position:fixed;left:12px;bottom:52px;z-index:20;display:none;'
    + 'padding:8px 14px;border-radius:20px;border:1px solid rgba(255,255,255,0.3);cursor:pointer;'
    + 'font:13px system-ui,sans-serif;color:#fff;background:rgba(20,24,32,0.75)'
  camBtn.onclick = () => toggleCam()
  document.body.appendChild(camBtn)
  const camUi = () => {
    if (!videoWanted || !videoNet.hasVideo?.()) { camBtn.style.display = 'none'; return }
    camBtn.style.display = 'block'
    camBtn.textContent = camLive ? '\u{1F4F9} camera live · click to stop (V)' : '\u{1F4F7} camera off · click to share (V)'
    camBtn.style.background = camLive ? 'rgba(46,125,50,0.9)' : 'rgba(20,24,32,0.75)'
  }
  if ('onVideo' in net) {
    (net as import('./matrix/net').MatrixNet).onVideo = (peer, track) => view.setVideoTrack(peer, track)
  }

  if (net instanceof Net) net.connect(room)
  else {
    (net as import('./matrix/net').MatrixNet)
      .connect(wp!, params.get('lkService'), widgetBoot!)
      .then(() => { micUi(); camUi() })
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
    view.syncBodies(sim.bodies.keys())
    view.props.sync(sim.props, now)
    syncScene()
    syncScript()
    const alpha = session.calibrated
      ? Math.min(Math.max(session.tickTimeNow(now) - sim.tick, 0), 1)
      : 0
    view.frame(now, alpha)
    ui.maybe(now, () => ({
      room, id: session.id, order: session.order,
      mic: audioNet.hasAudio?.() ? (micLive ? 'live - M mutes' : 'muted - M unmutes') : 'n/a',
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
    props: () => [...sim.props].map(([id, p]) => ({ id, ...p.pos, color: p.color, claim: p.claim })),
    screenOfProp: (netId: string) => {
      const p = sim.props.get(netId)
      if (!p) return null
      const v = new Vector3(p.pos.x, p.pos.y, p.pos.z).project(view.camera)
      const el = view.renderer.domElement
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight }
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
