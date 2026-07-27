import { Box3, Raycaster, Vector2, Vector3, type Object3D } from 'three'
import sanitizeHtml from 'sanitize-html'
import { BOOT_LEAD_TICKS, Sim, TICK_MS } from './sim'
import { peerColor } from './color'
import { cachedScene, cacheScene, configureGlbLoader, parseGlb, parseGltfJson } from './scene'
import { fetchWorldAsset, mediaUploadLimit, SCRIPT_STATE_TYPES, uploadWorldAsset } from './matrix/world'
import { loadCheckpoint, readPersist, setPersist, writeCheckpoint } from './matrix/persist'
import { Net } from './net'
import { AudioEngine } from './audio'
import { Session } from './session'
import { View } from './render'
import { Input, type Emitter } from './input'
import { Nav } from './nav'
import { UI } from './ui'
import { AVATAR_DIMS, AVATAR_PREFIX, avatarNetId, wallNow, type DcMessage, type Vec3 } from './types'
import { widgetParams } from './matrix/params'
import { initWidgetClient, requestScriptStateCapabilities } from './matrix/widget'

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
  view.dimsFor = id => sim.boxDims(id)
  configureGlbLoader(view.renderer)
  // world.avatars: scripts hide the figures (dots); the collider
  // lifecycle in avatarSync follows the same flag
  let avatarsOn = true
  const setAvatarsOn = (on: boolean) => {
    avatarsOn = on
    view.avatars.setEnabled(on)
  }
  // The world's own sound: plays the active scene's KHR_audio samples
  // from the cosmetic midi plane (see the WebMIDI section below).
  const audio = new AudioEngine()
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
    onInspectScene: () => toggleInspector(),
    // org.worldsync.checkpoint: opt-in world persistence. The flag is room
    // state, so every peer's checkbox follows; whoever is root does the
    // writing. Toggling OFF clears the checkpoint - ephemeral is the
    // default and turning persistence back off leaves nothing behind.
    onPersist: on => {
      if (!wp) {
        log('world persistence needs Matrix (run as a widget; the mock host works: /mock.html)')
        ui.setPersist(false)
        return
      }
      const m = net as import('./matrix/net').MatrixNet
      setPersist(m.client, wp.roomId, on)
        // checkpoint now rather than on the next cadence point
        .then(() => { if (on) { persist.lastWritten = null; persist.nextWriteAt = 0 } })
        .catch(e => { logErr('persist toggle failed', e); ui.setPersist(persist.on) })
    },
  })
  let editor: import('./editor').ScriptEditor | null = null
  let inspector: import('./inspector').SceneInspector | null = null
  const toggleInspector = async () => {
    const { SceneInspector } = await import('./inspector')
    inspector ??= new SceneInspector(document.body, {
      root: () => view.scene,
      gltfRoot: () => sim.sceneUrl ? cachedScene(sim.sceneUrl)?.object ?? null : null,
      url: () => sim.sceneUrl,
      setOutline: objs => view.setOutline(objs),
    })
    inspector.toggle()
  }
  // ` is the HUD button's keyboard twin for the scene inspector. Match
  // e.key, not e.code: code 'Backquote' is the PHYSICAL key left of 1,
  // which on ISO (UK) Mac keyboards is section-sign - the backtick key
  // there sits left of Z and reports code 'IntlBackslash'.
  addEventListener('keydown', e => {
    if (e.key !== '`' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    toggleInspector()
  })
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
  audio.onLog = log
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

  // The cosmetic planes (midi, shared lines) ride beside the session
  // protocol, so they are intercepted before receive(). Shared lines are
  // latest-wins full state per (author, id).
  const onMsg = (from: string, msg: DcMessage) => {
    if (msg.kind === 'midi') {
      deliverMidi(msg.peer, msg.d)
      return
    }
    if (msg.kind === 'line') {
      view.setLine(`${msg.peer}/${msg.id}`, msg.points.length ? msg.points : null,
        msg.color, msg.opacity, msg.width, msg.worldUnits)
      return
    }
    if (msg.kind === 'avatar') {
      view.avatars.apply(msg.peer, {
        pos: msg.pos, yaw: msg.yaw, pitch: msg.pitch, vel: msg.vel,
        grounded: msg.grounded, mode: msg.mode, aim: msg.aim ?? null,
      })
      return
    }
    session.receive(from, msg)
  }
  // Who each figure is, for the billboard over its head. In Matrix mode
  // the room member's displayname + avatar image (fetched through the
  // host via MSC4039, mxc blob cached); the ws demo just shows peer ids.
  // Member state can lag the transport (a joiner's profile crawls through
  // the host after LiveKit already sees them), so retry a few times while
  // the profile is missing and redraw in place when it lands.
  const mxcBlobs = new Map<string, Promise<string | null>>()
  const avatarImageUrl = (mxc: string): Promise<string | null> => {
    let p = mxcBlobs.get(mxc)
    if (!p) {
      p = fetchWorldAsset((net as import('./matrix/net').MatrixNet).api, mxc)
        .then(buf => URL.createObjectURL(new Blob([buf])))
        .catch(() => null)
      mxcBlobs.set(mxc, p)
    }
    return p
  }
  const resolveIdentity = (peerId: string, attempt = 0) => {
    if (!wp) { view.avatars.setIdentity(peerId, { name: peerId }); return }
    const m = net as import('./matrix/net').MatrixNet
    const userId = m.userIdFor(peerId)
    const member = m.client.getRoom(wp.roomId)?.getMember(userId)
    view.avatars.setIdentity(peerId, { name: member?.name ?? userId })
    const mxc = member?.getMxcAvatarUrl()
    if (mxc) {
      void avatarImageUrl(mxc).then(url => {
        if (url) view.avatars.setIdentity(peerId, { name: member!.name ?? userId, imageUrl: url })
      })
    }
    if ((!member || !mxc) && attempt < 5) setTimeout(() => resolveIdentity(peerId, attempt + 1), 3000)
  }

  // A departed peer takes its shared lines and its avatar with it, and the
  // primary clears any claims it left behind (its own session can no
  // longer unclaim them) and retires its avatar collider.
  const onLeft = (id: string) => {
    session.peerLeft(id)
    view.removeLines(`${id}/`)
    view.avatars.remove(id)
    if (isRoot()) {
      for (const [pid, p] of sim.props) {
        if (p.claim === id) session.emit('unclaim', pid, { pos: { x: 0, y: 0, z: 0 }, force: true })
      }
      if (sim.bodies.has(avatarNetId(id))) {
        session.emit('despawn', avatarNetId(id), { pos: { x: 0, y: 0, z: 0 } })
      }
    }
  }

  if (net instanceof Net) {
    net.onJoined = (id, order, alone) => { session.identity(id, order, alone); resolveIdentity(id) }
    net.onMessage = (peer, msg) => onMsg(peer.id, msg)
    net.onPeerConnected = peer => { session.peerConnected(peer.id, peer.order); resolveIdentity(peer.id) }
    net.onPeerLeft = onLeft
    net.onLog = log
  } else {
    const m = net as import('./matrix/net').MatrixNet
    m.onJoined = (id, order, alone) => {
      log(`joined as ${id} (order ${order}${alone ? ', alone: rooting grid' : ''})`)
      session.identity(id, order, alone)
      resolveIdentity(id)
    }
    m.onMessage = onMsg
    m.onPeerConnected = (id, order) => { log(`peer connected ${id} (#${order})`); session.peerConnected(id, order); resolveIdentity(id) }
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
    m.onCheckpointChanged = content => checkpointChanged(content)
  }

  // Keep the rendered scene in step with the sim's active scene (which can
  // change via ops, rollbacks, and preloads), and fetch any scene the sim
  // adopted before we have its GLB (another peer swapped it mid-session).
  const sceneFetches = new Set<string>()
  const syncScene = () => {
    const url = sim.sceneUrl
    const cached = url ? cachedScene(url) : null
    view.setScene(cached?.object ?? null)
    view.setGroundVisible(!url)
    // the scene's KHR_audio sound follows it; a scene whose samples are
    // note-mapped is an instrument, which is a MIDI subscription just
    // like a script defining world.onmidi
    audio.setScene(cached?.audio ?? null)
    if (audio.wantsMidi()) startMidi()
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
  let scriptMoveOn = false
  let scriptKeysOn = false
  let scriptMidiOn = false
  // world.aim: the script's left-hand point target for the local figure
  let scriptAim: Vec3 | null = null
  // Arrow keys (and space, and P - tetrix pauses on it) go to the script
  // while it defines world.onkeydown; typing in the panel or the monaco
  // editor keeps them (same guard as M/V).
  addEventListener('keydown', e => {
    if (!script || !scriptKeysOn || e.metaKey || e.ctrlKey || e.altKey) return
    if (![' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'p', 'P'].includes(e.key)) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    e.preventDefault()
    script.key({ key: e.key })
  })
  // --- WebMIDI -> world.onmidi + the audio engine ---
  // Access is requested lazily, once a running script defines
  // world.onmidi OR the scene carries note-mapped KHR_audio samples
  // (worlds that never use MIDI never prompt). Every parsed channel
  // message from a local device is delivered to our own script AND
  // broadcast as a cosmetic 'midi' message (never folded, never hashed),
  // so every peer's script hears every peer's device, tagged by peer -
  // which is what lets one world script animate a shared instrument
  // identically on all clients. The SAME plane, local and remote alike,
  // drives the audio engine, so the instrument also sounds the same
  // everywhere - script or no script.
  let midiAccess: MIDIAccess | null = null
  let midiRequested = false
  const midiEvent = (peer: string, d: number[]) => {
    const type = d[0] >> 4
    const base = { peer, me: peer === session.id, channel: d[0] & 15 }
    switch (type) {
      case 8: return { ...base, type: 'noteoff', note: d[1], velocity: 0 }
      // a noteon at velocity 0 is the wire's idiom for noteoff; normalize
      // so scripts never need to know
      case 9: return d[2] === 0
        ? { ...base, type: 'noteoff', note: d[1], velocity: 0 }
        : { ...base, type: 'noteon', note: d[1], velocity: d[2] }
      case 11: return { ...base, type: 'control', controller: d[1], value: d[2] }
      case 14: return { ...base, type: 'pitchbend', value: ((d[2] << 7) | d[1]) - 8192 }
      default: return null // aftertouch/program/system: not worth the surface yet
    }
  }
  const deliverMidi = (peer: string, d: number[]) => {
    const ev = midiEvent(peer, d)
    if (!ev) return
    audio.midi(ev)
    if (script && scriptMidiOn) script.midi(ev)
  }
  // one entry point for hardware, scripts (world.sendMidi) and the __jig
  // test hook alike
  const onMidiBytes = (d: number[]) => {
    if (d.length < 2 || d[0] < 0x80 || d[0] >= 0xf0) return // system/realtime chatter stays local
    deliverMidi(session.id, d)
    net.broadcast({ kind: 'midi', peer: session.id, d })
  }
  const midiWanted = () => (!!script && scriptMidiOn) || audio.wantsMidi()
  const attachMidiInputs = () => {
    if (!midiAccess) return
    for (const input of midiAccess.inputs.values()) {
      input.onmidimessage = midiWanted()
        ? e => { if (e.data) onMidiBytes([...e.data]) }
        : null
    }
  }
  const startMidi = () => {
    if (midiAccess) { attachMidiInputs(); return }
    if (midiRequested) return // denied access stays denied; don't prompt-spam
    midiRequested = true
    if (!('requestMIDIAccess' in navigator)) {
      log('MIDI wanted (world.onmidi or an instrument scene), but this browser has no WebMIDI')
      return
    }
    navigator.requestMIDIAccess()
      .then(a => {
        midiAccess = a
        const names = [...a.inputs.values()].map(i => i.name ?? i.id)
        log(`midi: ${names.length ? names.join(', ') : 'no inputs connected (hot-plug works)'}`)
        a.onstatechange = attachMidiInputs // hot-plugged devices join live
        attachMidiInputs()
      })
      .catch(e => logErr('midi access failed (iframe without allow="midi"?)', e))
  }

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
  // Script-instantiated glTF (world.loadGltf): local cosmetics parsed
  // from script-supplied glTF JSON, mounted under view.scriptRoot; their
  // nodes join the scene-node namespace below. Parsing is async: the
  // entry exists from the call, the object lands when the parse does
  // (scripts poll findNodeByName, like waiting for the world scene).
  const scriptGltf = new Map<string, { obj: import('three').Object3D | null }>()
  // glTF scene nodes a script has repositioned (world.findNodeByName +
  // TRS writes): local cosmetics - every peer's script animates its own
  // rendered copy, and the baked trimesh collider never moves.
  // Originals are saved on first touch and restored when the script stops,
  // so the URL-cached scene survives a script swap unmutated.
  // the shared scene-node namespace: the world scene's nodes first, then
  // script-instantiated glTF (which needs no restore bookkeeping - it
  // dies with the script)
  const sceneNodeFor = (name: string) => {
    const url = sim.sceneUrl
    const fromScene = url ? cachedScene(url)?.object.getObjectByName(name) ?? null : null
    if (fromScene) return { url, obj: fromScene, scripted: false }
    return { url, obj: view.scriptRoot.getObjectByName(name) ?? null, scripted: true }
  }
  const sceneTouched = new Map<string, { url: string; name: string; t: number[]; r: number[]; s: number[] }>()
  const restoreSceneNodes = () => {
    for (const { url, name, t, r, s } of sceneTouched.values()) {
      const obj = cachedScene(url)?.object.getObjectByName(name)
      if (!obj) continue
      obj.position.fromArray(t as [number, number, number])
      obj.quaternion.fromArray(r as [number, number, number, number])
      obj.scale.fromArray(s as [number, number, number])
    }
    sceneTouched.clear()
  }
  // scene nodes the script marked interactable: pointer picking reports
  // them (by name) once props miss
  const scriptInteractables = new Set<string>()
  const scriptScreens = new Set<string>()
  const scriptLabels = new Set<string>()
  // Flipped by the first screen a script places; gates the camera toggle,
  // so worlds that never ask for video never show it.
  let videoWanted = false
  // world.say: the script chats into the room as this user. Rate-limited
  // here (not in the sandbox) so a buggy onupdate cannot flood the room;
  // outside widget mode there is no room, so it just logs.
  let lastSay = 0
  const scriptSay = (text: string) => {
    const t = text.slice(0, 500)
    if (!wp) { log(`[script chat] ${t}`); return }
    if (performance.now() - lastSay < 1000) { log(`script chat dropped (rate limit): ${t}`); return }
    lastSay = performance.now()
    const m = net as import('./matrix/net').MatrixNet
    void m.client.sendTextMessage(wp.roomId, t).catch(e => logErr('script chat failed', e))
  }

  // world.hud: an HTML overlay the script fully owns. The sandbox exists
  // so scripts CANNOT touch the page, so the HTML goes through
  // sanitize-html with an ALLOWLIST - element-web's Matrix-message
  // subset (its Linkify.ts sanitizeHtmlParams) - rather than any
  // blacklist. Styles are restricted to a cosmetic property set instead
  // of element-web's data-mx-* transformation dance, and only https
  // image sources survive. Identical updates are deduped so scripts may
  // call it every frame.
  const HUD_STYLE_VALUE = [/^[#\w(),.%/ -]{1,200}$/]
  const HUD_SANITIZE: sanitizeHtml.IOptions = {
    allowedTags: [
      'font', 'del', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
      'sup', 'sub', 'nl', 'li', 'b', 'i', 'u', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div',
      'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'span', 'img', 'details', 'summary',
    ],
    allowedAttributes: {
      font: ['color', 'style'],
      span: ['style'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      ol: ['start'],
      code: ['class'],
    },
    allowedStyles: {
      '*': {
        'color': HUD_STYLE_VALUE, 'background-color': HUD_STYLE_VALUE,
        'font-weight': HUD_STYLE_VALUE, 'font-style': HUD_STYLE_VALUE, 'font-size': HUD_STYLE_VALUE,
        'text-decoration': HUD_STYLE_VALUE, 'text-align': HUD_STYLE_VALUE,
        'padding': HUD_STYLE_VALUE, 'margin': HUD_STYLE_VALUE, 'opacity': HUD_STYLE_VALUE,
      },
    },
    allowedSchemes: ['https', 'http', 'mailto', 'matrix'],
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false,
    nestingLimit: 50,
    // an img whose src the scheme filter ate is a husk; drop it whole
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  }
  let hudEl: HTMLElement | null = null
  let hudLast = ''
  const scriptHud = (html: string) => {
    if (html === hudLast) return
    hudLast = html
    if (!hudEl) {
      hudEl = document.createElement('div')
      hudEl.id = 'hud'
      document.body.appendChild(hudEl)
    }
    hudEl.innerHTML = sanitizeHtml(html, HUD_SANITIZE)
    hudEl.style.display = html.trim() ? 'block' : 'none'
  }

  // world.getStateEvents / world.setStateEvent: real Matrix room state,
  // scoped to the SCRIPT_STATE_TYPES allowlist and, for writes, to OUR
  // OWN MXID as the state key (core auth rules bar writing anyone else's
  // @-prefixed key, so per-user events cannot clobber each other;
  // nothing stops lying in your own - no witnessing yet). The widget
  // capabilities for these are requested lazily (MSC2974) on the first
  // state API call, so worlds that never touch room state never prompt -
  // and the request flags the room in localStorage so FUTURE boots fold
  // them into the boot handshake instead, keeping stock Element Web's
  // capability memory intact (see initWidgetClient). Content is entirely
  // the script's business - the example games keep top-10 highscore
  // lists in io.element.highscores - the host only stores, capping size
  // and rate. Reads are local cosmetics for HUDs and never touch the
  // sim. Outside widget mode an in-memory map stands in so scripts
  // behave; it dies with the tab.
  const scriptUser = () => wp ? wp.userId : session.id
  let stateCaps: Promise<void> | null = null
  // Events that PREDATE the grant need an explicit fetch: only hosts on a
  // recent widget-api re-push current room state after an MSC2974
  // renegotiation, so without this a room's standing high scores never
  // load. Kept as a fallback layer under the live-pushed room state.
  const stateBackfill = new Map<string, Map<string, { sender: string; ts: number; content: unknown }>>()
  const ensureStateCaps = (): Promise<void> => {
    if (!wp) return Promise.resolve()
    const m = net as import('./matrix/net').MatrixNet
    return stateCaps ??= requestScriptStateCapabilities(m.api, wp.userId, wp.roomId)
      .then(async () => {
        for (const type of SCRIPT_STATE_TYPES) {
          try {
            const forType = stateBackfill.get(type) ?? new Map<string, { sender: string; ts: number; content: unknown }>()
            for (const ev of await m.api.readStateEvents(type, undefined, undefined, [wp.roomId])) {
              if ((ev.room_id && ev.room_id !== wp.roomId) || typeof ev.state_key !== 'string') continue
              const prev = forType.get(ev.state_key)
              if (!prev || prev.ts <= ev.origin_server_ts) {
                forType.set(ev.state_key, { sender: ev.sender, ts: ev.origin_server_ts, content: ev.content })
              }
            }
            stateBackfill.set(type, forType)
          } catch (e) {
            logErr(`room-state backfill failed for ${type}`, e)
          }
        }
      })
      .catch(e => {
        stateCaps = null // a transport hiccup should not wedge state access for good
        throw e
      })
  }
  const memState = new Map<string, Map<string, unknown>>() // type -> stateKey -> content
  const scriptGetStateEvents = (type: string) => {
    if (!SCRIPT_STATE_TYPES.includes(type)) {
      log(`getStateEvents: event type not allowlisted: ${type}`)
      return []
    }
    if (!wp) {
      return [...(memState.get(type) ?? [])].map(([stateKey, content]) =>
        ({ type, stateKey, sender: scriptUser(), ts: 0, content }))
    }
    // first touch kicks off the capability grab; until the grant (and its
    // backfill) lands, reads just come back empty. Live-pushed room state
    // shadows the backfill per state key
    void ensureStateCaps().catch(e => logErr('room-state capability request failed', e))
    const m = net as import('./matrix/net').MatrixNet
    const out = new Map<string, { type: string; stateKey: string; sender: string; ts: number; content: unknown }>()
    for (const [stateKey, e] of stateBackfill.get(type) ?? []) {
      out.set(stateKey, { type, stateKey, sender: e.sender, ts: e.ts, content: e.content })
    }
    for (const ev of m.client.getRoom(wp.roomId)?.currentState.getStateEvents(type) ?? []) {
      const stateKey = ev.getStateKey() ?? ''
      out.set(stateKey, { type, stateKey, sender: ev.getSender() ?? '', ts: ev.getTs(), content: ev.getContent() as unknown })
    }
    return [...out.values()]
  }
  let lastStateWrite = -Infinity
  const scriptSetStateEvent = (type: string, json: string, stateKey: string) => {
    if (!SCRIPT_STATE_TYPES.includes(type)) {
      log(`setStateEvent: event type not allowlisted: ${type}`)
      return
    }
    if (stateKey !== scriptUser()) {
      log(`setStateEvent: scripts may only write their own state key (${scriptUser()})`)
      return
    }
    if (json.length > 16384) { log('setStateEvent dropped: content over 16KB'); return }
    let content: unknown
    try { content = JSON.parse(json) } catch { return }
    if (performance.now() - lastStateWrite < 2000) { log('setStateEvent dropped (rate limit)'); return }
    lastStateWrite = performance.now()
    if (!wp) {
      const forType = memState.get(type) ?? new Map<string, unknown>()
      forType.set(stateKey, content)
      memState.set(type, forType)
      return
    }
    const m = net as import('./matrix/net').MatrixNet
    const sendState = m.client.sendStateEvent.bind(m.client) as
      (roomId: string, type: string, content: unknown, stateKey: string) => Promise<unknown>
    void ensureStateCaps()
      .then(() => sendState(wp.roomId, type, content, stateKey))
      .catch(e => logErr('setStateEvent failed (no permission to send room state?)', e))
  }

  const scriptHost: import('./websg').ScriptHost = {
    log: l => log(`[script] ${l}`),
    say: scriptSay,
    hud: scriptHud,
    boxes: () => {
      const out = []
      for (const netId of sim.bodies.keys()) {
        if (netId.startsWith(AVATAR_PREFIX)) continue // avatars are not boxes
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
      const { obj } = sceneNodeFor(name)
      if (!obj) return null
      const v = new Vector3()
      obj.getWorldPosition(v)
      return { x: v.x, y: v.y, z: v.z }
    },
    sceneNodeTransform: name => {
      const { obj } = sceneNodeFor(name)
      if (!obj) return null
      return {
        t: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        r: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
        s: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
      }
    },
    setSceneNodeTransform: (name, json) => {
      const { url, obj, scripted } = sceneNodeFor(name)
      if (!obj) return false
      // world-scene nodes get restore bookkeeping; script glTF dies with
      // the script (mxc URLs cannot contain spaces, so the key is unique)
      const key = `${url} ${name}`
      if (!scripted && url && !sceneTouched.has(key)) {
        sceneTouched.set(key, {
          url, name,
          t: obj.position.toArray(), r: obj.quaternion.toArray() as number[], s: obj.scale.toArray(),
        })
      }
      const { t, r, s } = JSON.parse(json) as {
        t?: { x: number; y: number; z: number }
        r?: { x: number; y: number; z: number; w: number }
        s?: { x: number; y: number; z: number }
      }
      if (t) obj.position.set(t.x, t.y, t.z)
      if (r) obj.quaternion.set(r.x, r.y, r.z, r.w)
      if (s) obj.scale.set(s.x, s.y, s.z)
      return true
    },
    setInteractable: (name, on) => {
      if (on) scriptInteractables.add(name)
      else scriptInteractables.delete(name)
    },
    // GLTFLoader surfaces glTF extras as userData: plain JSON authoring
    // metadata (the piano world's key rig parameters live there)
    sceneNodeExtras: name => {
      const { obj } = sceneNodeFor(name)
      return obj && Object.keys(obj.userData).length ? obj.userData : null
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
    me: () => ({ id: session.id, user: scriptUser(), primary: isRoot(), color: peerColor(session.id) }),
    peers: () => {
      const out = [{ id: session.id, order: session.order, color: peerColor(session.id), me: true }]
      for (const p of session.peers.values()) {
        if (!p.excluded) out.push({ id: p.id, order: p.order, color: peerColor(p.id), me: false })
      }
      return out.sort((a, b) => a.order - b.order)
    },
    getStateEvents: scriptGetStateEvents,
    setStateEvent: scriptSetStateEvent,
    props: () => [...sim.props].map(([id, p]) => propView(id, p)),
    prop: id => {
      const p = sim.props.get(id)
      return p ? propView(id, p) : null
    },
    spawnProp: (kind, x, y, z, color, size, unlit, bounce, pop, opacity) => {
      const id = session.nextNetId()
      // bounce/pop/opacity are only carried when non-default, keeping the
      // common op lean
      session.emit('prop', id, {
        pos: { x, y, z }, color, shape: kind, size, unlit,
        ...(bounce ? {} : { bounce: false }), ...(pop ? {} : { pop: false }),
        ...(opacity >= 1 ? {} : { opacity: Math.max(0, opacity) }),
      })
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
    getData: key => sim.data.get(key) ?? null,
    dataKeys: () => [...sim.data.keys()].sort(),
    setData: (key, json) => {
      if (json.length > 4096) { log(`setData('${key}') dropped: value over 4KB`); return false }
      // a same-value write is dropped here rather than folded: it could
      // only churn the timeline (last-write-wins makes it a no-op)
      if ((sim.data.get(key) ?? '') === json) return true
      session.emit('data', key, { pos: { x: 0, y: 0, z: 0 }, data: json })
      return true
    },
    line: (id, pointsJson, color, opacity, width, worldUnits, shared) => {
      const points = pointsJson ? JSON.parse(pointsJson) as { x: number; y: number; z: number }[] : []
      scriptLines.set(id, shared)
      view.setLine(`${session.id}/${id}`, points, color, opacity, width, worldUnits)
      if (shared) {
        net.broadcast({ kind: 'line', peer: session.id, id, points, color, opacity, width, worldUnits })
      }
    },
    removeLine: id => {
      const shared = scriptLines.get(id)
      if (shared === undefined) return
      scriptLines.delete(id)
      view.setLine(`${session.id}/${id}`, null, 0, 0, 0, false)
      if (shared) {
        net.broadcast({
          kind: 'line', peer: session.id, id, points: [], color: 0, opacity: 0, width: 0, worldUnits: false,
        })
      }
    },
    loadGltf: (name, json) => {
      if (scriptGltf.has(name)) return false
      const entry: { obj: import('three').Object3D | null } = { obj: null }
      scriptGltf.set(name, entry)
      parseGltfJson(json)
        .then(obj => {
          if (scriptGltf.get(name) !== entry) return // unloaded mid-parse
          obj.name = name
          entry.obj = obj
          view.mountScriptObject(obj)
        })
        .catch(e => {
          if (scriptGltf.get(name) === entry) scriptGltf.delete(name)
          log(`loadGltf('${name}') failed: ${e}`)
        })
      return true
    },
    unloadGltf: name => {
      const entry = scriptGltf.get(name)
      if (!entry) return
      scriptGltf.delete(name)
      if (entry.obj) view.unmountScriptObject(entry.obj)
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
    label: (id, text, x, y, z, yaw, h, color, flat) => {
      scriptLabels.add(id)
      view.setLabel(`${session.id}/${id}`, text.slice(0, 64), { x, y, z }, yaw, h, color, flat)
    },
    removeLabel: id => {
      scriptLabels.delete(id)
      view.removeLabel(`${session.id}/${id}`)
    },
    setEnv: json => view.setEnvironment(JSON.parse(json)),
    setCamera: (x, y, z, tx, ty, tz) => nav.setCameraPose({ x, y, z }, { x: tx, y: ty, z: tz }),
    // world.navigation: the script suggests a camera regime - floorless
    // board worlds (dots, snake) open in orbit. A one-shot default: the
    // user's toggle can override it afterwards.
    setNavMode: mode => {
      if (mode === 'walk' || mode === 'orbit') nav.setScriptMode(mode)
      else log(`world.navigation: unknown mode '${mode}' (use 'walk' or 'orbit')`)
    },
    // world.avatars: board worlds (dots) hide the figures and retire the
    // colliders; back on (the default) when the script stops
    setAvatars: on => setAvatarsOn(on),
    // world.aim: the script points the local figure's nearer hand (a
    // hovered piano key, the piece being steered). It rides the avatar
    // plane broadcast exactly like the built-in point-at-selection,
    // which it overrides while set.
    setAim: (x, y, z) => { scriptAim = { x, y, z } },
    clearAim: () => { scriptAim = null },
    // world.sendMidi: the script PERFORMS - its bytes take the exact
    // hardware path (own script + audio engine + broadcast), so a clicked
    // piano key sounds and moves on every peer. Deferred a microtask so
    // the echo into world.onmidi never re-enters the sandbox mid-dispatch.
    sendMidi: (status, d1, d2) => {
      const d = [status, d1, d2].map(b => Math.max(0, Math.min(255, Math.floor(b))))
      queueMicrotask(() => onMidiBytes(d))
    },
    // world.highlight: outline named scene nodes through the view's
    // OutlinePass (the inspector's selection glow). Local cosmetic;
    // cleared when the script stops.
    highlight: namesJson => {
      const names = JSON.parse(namesJson) as string[]
      view.setOutline(names.slice(0, 64)
        .map(n => sceneNodeFor(n).obj)
        .filter((o): o is NonNullable<typeof o> => !!o))
    },
  }

  // Pointer events for the script: raycast the prop layer, hand the script
  // the hit plus the raw ray (for its own plane math), and capture the
  // gesture away from box spawning/grabbing when a prop was hit.
  const scriptRay = new Raycaster()
  const scriptNdc = new Vector2()
  const scriptEv = (e: PointerEvent) => {
    // while the walker holds pointer lock the cursor is captured: script
    // pointer events ray through the crosshair instead (piano keys are
    // clicked by looking at them)
    if (nav.locked) scriptNdc.set(0, 0)
    else {
      const r = view.renderer.domElement.getBoundingClientRect()
      scriptNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    }
    scriptRay.setFromCamera(scriptNdc, view.camera)
    const hit = view.props.pick(scriptRay)
    let entity = hit?.id ?? null
    let point = hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null
    // props missed: try the scene nodes the script marked interactable
    // (nearest intersection whose ancestry carries a registered name),
    // in the world scene and script-instantiated glTF alike
    if (!entity && scriptInteractables.size) {
      const roots: Object3D[] = [view.scriptRoot]
      const sceneRoot = sim.sceneUrl ? cachedScene(sim.sceneUrl)?.object : null
      if (sceneRoot) roots.push(sceneRoot)
      for (const h of scriptRay.intersectObjects(roots, true)) {
        let o: Object3D | null = h.object
        while (o && !scriptInteractables.has(o.name)) o = o.parent
        if (!o) continue
        entity = o.name
        point = { x: h.point.x, y: h.point.y, z: h.point.z }
        break
      }
    }
    const o = scriptRay.ray.origin, d = scriptRay.ray.direction
    return {
      entity, point,
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
    // uncaptured moves: only raycast + cross the sandbox when the script
    // actually defines onpointermove (hover highlights)
    hover: e => { if (script && scriptMoveOn) script.pointer('onpointermove', scriptEv(e)) },
  }
  const stopScript = (why: string) => {
    if (!script) return
    script.dispose()
    script = null
    scriptPointerOn = false
    scriptMoveOn = false
    scriptKeysOn = false
    scriptMidiOn = false
    attachMidiInputs() // detaches, unless an instrument scene still listens
    for (const id of [...scriptLines.keys()]) scriptHost.removeLine(id) // its lines go with it
    for (const name of [...scriptGltf.keys()]) scriptHost.unloadGltf(name) // its glTF goes with it
    for (const id of [...scriptScreens]) scriptHost.removeScreen(id) // and its screens
    for (const id of [...scriptLabels]) scriptHost.removeLabel(id) // and its labels
    restoreSceneNodes() // scene nodes it moved go back where the glb put them
    scriptInteractables.clear()
    scriptAim = null // the hand comes down with the script
    nav.setScriptMode(null) // clears its default memory; the mode stands
    setAvatarsOn(true) // avatars come back if it hid them
    view.setOutline([]) // its hover/selection glow goes with it
    if (videoWanted) {
      videoWanted = false
      stopCam() // no world is asking for video anymore: stop publishing
    }
    view.setEnvironment({}) // back to the default look
    scriptHud('') // its HUD goes with it
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
          scriptMoveOn = s.handles('onpointermove')
          scriptKeysOn = s.handles('onkeydown')
          scriptMidiOn = s.handles('onmidi')
          if (scriptMidiOn) startMidi()
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

  // --- org.worldsync.checkpoint: opt-in world persistence ---
  // OFF by default: a room's world dies with its last session. When ON,
  // the root peer checkpoints the settled sim state (the OLDEST history
  // snapshot: nothing can fold below it, so what leaves is final) into
  // room state every few seconds - inline in the event while it fits, a
  // media-repo CBOR blob with a pointer event beyond that (see persist.ts).
  // The peer that next ROOTS a fresh tick grid replays the checkpoint as
  // a boot seam; a peer that adopted a running grid never restores, since
  // the live world it booted from is newer than any checkpoint.
  const CHECKPOINT_EVERY_MS = 10_000
  const persist = {
    on: false,
    restoreChecked: false,
    lastWritten: null as string | null, // JSON of the last dump written (change detection)
    nextWriteAt: 0,
    writing: false,
  }
  const checkpointChanged = (content: Record<string, unknown>) => {
    const on = content.persist === true
    if (on === persist.on) return
    persist.on = on
    ui.setPersist(on)
    log(on ? 'world persistence ON for this room' : 'world persistence OFF (the default)')
  }
  const syncPersist = (now: number) => {
    if (!wp || !session.ready()) return
    const m = net as import('./matrix/net').MatrixNet
    if (!persist.restoreChecked && session.rooted) {
      persist.restoreChecked = true
      ;(async () => {
        const cp = await loadCheckpoint(m.api, m.client, wp.roomId)
        // rooted can flip mid-fetch (a live senior appeared and hard-resynced
        // us): their world wins, drop the restore
        if (!cp || cp.entities.length === 0 || !session.rooted) return
        // Stamped ahead like any boot seam; from = the current tick, so ops
        // that race the restore are re-applied on top of it everywhere.
        const seamTick = sim.tick + BOOT_LEAD_TICKS
        for (const e of cp.entities) {
          session.emit('boot', e.netId,
            { pos: e.pos, rot: e.rot, vel: e.linvel, angvel: e.angvel, color: e.color,
              dims: e.dims, prop: e.prop, data: e.data },
            seamTick, sim.tick)
        }
        log(`world restored from checkpoint (${cp.entities.length} entities, saved at tick ${cp.tick})`)
      })().catch(e => logErr('checkpoint restore failed', e))
    }
    if (!persist.on || persist.writing || now < persist.nextWriteAt || !isRoot()) return
    persist.nextWriteAt = now + CHECKPOINT_EVERY_MS
    const dump = sim.dumpPersist()
    const key = JSON.stringify(dump.entities)
    if (key === persist.lastWritten) return
    persist.writing = true
    writeCheckpoint(m.api, m.client, wp.roomId, dump)
      .then(how => {
        persist.lastWritten = key
        log(`checkpoint saved (${dump.entities.length} entities, ${how})`)
      })
      .catch(e => logErr('checkpoint save failed', e))
      .finally(() => { persist.writing = false })
  }
  // Best-effort flush on the way out, so the last session's final seconds
  // are not lost with it; the postMessage may not complete before the page
  // dies, and the periodic checkpoint bounds the loss either way.
  addEventListener('pagehide', () => {
    if (!wp || !persist.on || !session.ready() || !isRoot()) return
    const m = net as import('./matrix/net').MatrixNet
    const dump = sim.dumpPersist()
    if (JSON.stringify(dump.entities) === persist.lastWritten) return
    void writeCheckpoint(m.api, m.client, wp.roomId, dump).catch(() => {})
  })

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
    // rot rides along: the gizmo streams it while precision-rotating
    // (this wrapper used to drop it, leaving streamed rotation dead)
    streamPose: (netId, pos, rot) => session.streamPose(netId, pos, rot),
  }
  const nav = new Nav(view, out, document.body)
  nav.keysClaimedByScript = () => !!script && scriptKeysOn
  const input = new Input(view, out, nav)
  input.scriptPointer = scriptPointerDelegate

  // --- avatars: the figure rides the cosmetic plane, the collider rides
  // the timeline (one 'avatar' op) + the pose plane (streamPose pins it
  // like a held box). Each peer owns exactly its own; scene ops reset
  // the world and take the body with them, so the spawn self-heals. ---
  view.avatars.log = log
  let avatarPlaced = false
  let avatarSceneFor: string | null = null // scene the placement used
  let avatarLastOp = 0
  let avatarLastPose = 0
  let avatarLastSent = 0
  let avatarLastKey = ''
  const avatarStreamed = new Vector3(NaN, NaN, NaN)
  const aimPoint = (): Vec3 | undefined => {
    if (scriptAim) return scriptAim // world.aim outranks the built-ins
    // a click-dragged box: the hand tracks the carry
    const dragged = input.draggedEid !== null ? view.meshes.get(input.draggedEid) : null
    const obj = dragged
      ?? (nav.selection ? (nav.selection.kind === 'box' ? nav.selection.mesh : nav.selection.obj) : null)
    if (!obj) return undefined
    const p = obj.getWorldPosition(new Vector3())
    return { x: p.x, y: p.y, z: p.z }
  }
  // Spawn slots: an arc around the world's centre of interest - the
  // scene's bounding-box centre when there is one, the origin otherwise -
  // shoulder-to-shoulder by join rank (0, +1, -1, +2, -2 ... slots ~1.4m
  // apart), everyone facing the centre. Similar but non-overlapping.
  const spawnSlot = () => {
    const target = new Vector3(0, 0.5, 0)
    let radius = 8
    const cached = sim.sceneUrl ? cachedScene(sim.sceneUrl) : null
    if (cached) {
      const box = new Box3().setFromObject(cached.object)
      if (!box.isEmpty()) {
        box.getCenter(target)
        radius = Math.min(18, Math.max(3.5,
          Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2 + 2.5))
      }
    }
    let rank = 0
    for (const p of session.peers.values()) if (p.order < session.order) rank++
    const offset = Math.ceil(rank / 2) * (rank % 2 === 1 ? 1 : -1)
    const a = offset * (1.4 / radius)
    return {
      x: target.x + Math.sin(a) * radius, z: target.z + Math.cos(a) * radius,
      yaw: a, fromY: target.y + 4,
    }
  }
  const avatarSync = (now: number) => {
    if (!session.ready()) return
    view.avatars.localId = session.id
    const myId = avatarNetId(session.id)
    // placement: provisional immediately, refined once a pending scene
    // arrives - unless the user already set off on foot
    const url = sim.sceneUrl
    const sceneNow = url && cachedScene(url) ? url : null
    if (!avatarPlaced || sceneNow !== avatarSceneFor) {
      if (!avatarPlaced || !nav.hasMoved) {
        const s = spawnSlot()
        nav.spawnAt(s.x, s.z, s.yaw, s.fromY)
      }
      avatarPlaced = true
      avatarSceneFor = sceneNow
    }
    const st = nav.avatarState
    const center = { x: st.pos.x, y: st.pos.y + AVATAR_DIMS.y / 2, z: st.pos.z }
    // collider lifecycle follows world.avatars (self-healing re-spawn:
    // a scene op deterministically resets the world, body included)
    const have = sim.bodies.has(myId)
    if (now - avatarLastOp > 500) {
      if (avatarsOn && !have) {
        avatarLastOp = now
        session.emit('avatar', myId, { pos: center, dims: AVATAR_DIMS, color: peerColor(session.id) })
        avatarStreamed.set(center.x, center.y, center.z)
      } else if (!avatarsOn && have) {
        avatarLastOp = now
        session.emit('despawn', myId, { pos: { x: 0, y: 0, z: 0 } })
      } else if (isRoot()) {
        // ghost sweep: an avatar body whose peer is gone and whose
        // despawn nobody sent (the previous primary died with it)
        for (const netId of sim.bodies.keys()) {
          if (!netId.startsWith(AVATAR_PREFIX)) continue
          const peer = netId.slice(AVATAR_PREFIX.length)
          if (peer !== session.id && !session.peers.has(peer)) {
            avatarLastOp = now
            session.emit('despawn', netId, { pos: { x: 0, y: 0, z: 0 } })
            break
          }
        }
      }
    }
    const mode: 'walk' | 'orbit' = nav.effective() === 'walk' ? 'walk' : 'orbit'
    // the collider follows the figure in every mode (orbit WASD steers it
    // third-person); standing still, the change check keeps the wire quiet
    if (avatarsOn && have && now - avatarLastPose >= TICK_MS
      && avatarStreamed.distanceToSquared(new Vector3(center.x, center.y, center.z)) > 1e-6) {
      avatarLastPose = now
      avatarStreamed.set(center.x, center.y, center.z)
      session.streamPose(myId, center)
    }
    // the figure: ours updates locally every frame (orbit shows it);
    // peers get the latest-wins broadcast at tick rate on change, with a
    // 1s keepalive so late joiners fill in without asking
    const pose = {
      pos: st.pos, yaw: st.yaw, pitch: st.pitch, vel: st.vel,
      grounded: st.grounded, mode, aim: aimPoint(),
    }
    view.avatars.apply(session.id, { ...pose, aim: pose.aim ?? null })
    if (now - avatarLastSent >= TICK_MS) {
      const key = JSON.stringify(pose)
      if (key !== avatarLastKey || now - avatarLastSent > 1000) {
        avatarLastKey = key
        avatarLastSent = now
        net.broadcast({
          kind: 'avatar', peer: session.id, pos: pose.pos, yaw: pose.yaw, pitch: pose.pitch,
          vel: pose.vel, grounded: pose.grounded, mode, ...(pose.aim ? { aim: pose.aim } : {}),
        })
      }
    }
  }

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
    const m = net as import('./matrix/net').MatrixNet
    m.connect(wp!, params.get('lkService'), widgetBoot!)
      .then(() => {
        micUi()
        camUi()
        // the persist flag that predates us arrives with the initial state
        // read, not through the event watch
        checkpointChanged({ persist: readPersist(m.client, wp!.roomId) })
      })
      .catch(e => { log(`matrix connect failed: ${e}`); console.error('[worldsync]', e) })
  }

  function frame() {
    const now = wallNow()
    if (sim.needsResim) {
      const presented = view.capture()
      if (session.foldIfNeeded()) {
        sim.mirror()
        view.applyCorrections(presented, now, input.draggedEid ?? nav.authorityEid)
      }
    }
    session.advance()
    sim.mirror()
    view.syncBodies(sim.bodies.keys())
    view.props.sync(sim.props, now)
    syncScene()
    syncScript()
    syncPersist(now)
    nav.update(now)  // walk-mode camera first...
    avatarSync(now)  // ...then the avatar reads the fresh walker state...
    input.tick(now)  // ...then carried boxes retarget off the fresh view ray
    const alpha = session.calibrated
      ? Math.min(Math.max(session.tickTimeNow(now) - sim.tick, 0), 1)
      : 0
    view.frame(now, alpha)
    audio.frame(view.camera) // the listener rides the camera, panners their nodes
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
    syncPersist(wallNow()) // nor checkpoints, ditto
    avatarSync(wallNow()) // nor the collider self-heal / ghost sweep
  }

  // Hooks for automated smoke tests and console poking.
  ;(window as any).__jig = {
    sim, net, session, view, nav, input,
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
    // inject a MIDI channel message as if a local device sent it (tests
    // and consoles have no hardware): delivered to our script and the
    // audio engine, and broadcast to peers exactly like the real thing
    midi: (status: number, d1?: number, d2?: number) => onMidiBytes([status, d1 ?? 0, d2 ?? 0]),
    audio: () => audio.stats(),
    // avatar layer state: per-peer dominant clip, presented feet, visibility
    avatars: () => view.avatars.debug(),
  }
}

main()
