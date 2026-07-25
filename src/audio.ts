import type * as THREE from 'three'
import type { SceneAudio, SceneAudioEmitter, SceneAudioSource } from './scene'

/**
 * The MIDI audio engine: plays the active world scene's KHR_audio
 * samples from the cosmetic midi plane (local WebMIDI devices and every
 * peer's 'midi' datachannel broadcasts alike), so a rigged instrument
 * world SOUNDS the same on every client without the sim ever knowing.
 *
 * The mapping rule matches what tools/piano-glb.mjs authors: an emitter
 * whose sources carry {note} in their glTF extras is an instrument. A
 * noteon picks the nearest sampled note and pitch-shifts the remainder
 * via playbackRate (the Salamander set samples every minor third, so a
 * shift is never more than one semitone); velocity maps to voice gain;
 * noteoff releases with a short ramp; CC64 sustains per peer, exactly
 * like the real pedal. Everything is local cosmetics - the same events
 * reach every peer, so ears converge like the rendered keys do.
 *
 * WebAudio graph: voice (BufferSource -> Gain) -> emitter (Gain ->
 * Panner for positional emitters, riding its scene node) -> master ->
 * destination. The context starts suspended under autoplay policy;
 * resume hangs off the first user gesture. Decoding happens once per
 * ParsedScene (keyed by the bytes object), so swapping worlds back and
 * forth never re-decodes.
 */

const MAX_VOICES = 48
const RELEASE_S = 0.35

interface Voice {
  src: AudioBufferSourceNode
  gain: GainNode
  key: string // `${peer} ${note}`
  startedAt: number
  releasing: boolean
  /** noteoff arrived while the peer's pedal was down */
  sustained: boolean
}

export interface MidiEventView {
  peer: string
  type: string
  note?: number
  velocity?: number
  controller?: number
  value?: number
}

interface LiveEmitter {
  def: SceneAudioEmitter
  input: GainNode
  panner: PannerNode | null
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private scene: SceneAudio | null = null
  private live: LiveEmitter[] = []
  private buffers = new Map<ArrayBuffer, AudioBuffer>()
  private decoding = new Set<ArrayBuffer>()
  private voices: Voice[] = []
  private pedal = new Map<string, boolean>()
  onLog: (line: string) => void = () => {}

  constructor() {
    // autoplay policy: a context created before any gesture sits
    // suspended; the first gesture anywhere on the page wakes it
    const wake = () => { if (this.ctx?.state === 'suspended') void this.ctx.resume() }
    addEventListener('pointerdown', wake)
    addEventListener('keydown', wake)
  }

  /** does the active scene declare an instrument (note-mapped samples)?
   * WebMIDI capture keys off this even when no script runs. */
  wantsMidi(): boolean {
    return !!this.scene?.emitters.some(e => e.sources.some(s => s.note !== null))
  }

  /** swap the audible scene (null silences); idempotent per audio object */
  setScene(audio: SceneAudio | null) {
    if (this.scene === audio) return
    for (const v of [...this.voices]) this.stopVoice(v)
    for (const e of this.live) e.input.disconnect()
    this.live = []
    this.pedal.clear()
    this.scene = audio
    if (!audio) return
    const ctx = this.ensureCtx()
    for (const def of audio.emitters) {
      const input = ctx.createGain()
      input.gain.value = def.gain
      let panner: PannerNode | null = null
      if (def.positional) {
        panner = ctx.createPanner()
        panner.panningModel = 'HRTF'
        panner.distanceModel = def.positional.distanceModel
        panner.refDistance = def.positional.refDistance
        panner.maxDistance = def.positional.maxDistance
        panner.rolloffFactor = def.positional.rolloffFactor
        panner.coneInnerAngle = def.positional.coneInnerAngle * 180 / Math.PI
        panner.coneOuterAngle = def.positional.coneOuterAngle * 180 / Math.PI
        panner.coneOuterGain = def.positional.coneOuterGain
        input.connect(panner)
        panner.connect(this.master!)
      } else {
        input.connect(this.master!)
      }
      this.live.push({ def, input, panner })
      for (const s of def.sources) this.decode(s)
    }
    const notes = audio.emitters.reduce((n, e) => n + e.sources.filter(s => s.note !== null).length, 0)
    this.onLog(`scene audio: ${audio.emitters.length} emitter(s), ${notes} instrument sample(s)`)
  }

  /** a parsed midi event off the cosmetic plane (any peer, ours included) */
  midi(ev: MidiEventView) {
    if (!this.scene) return
    if (ev.type === 'noteon' && ev.note !== undefined) this.noteOn(ev.peer, ev.note, ev.velocity ?? 100)
    else if (ev.type === 'noteoff' && ev.note !== undefined) this.noteOff(ev.peer, ev.note)
    else if (ev.type === 'control' && ev.controller === 64) {
      const down = (ev.value ?? 0) >= 64
      this.pedal.set(ev.peer, down)
      if (!down) {
        for (const v of [...this.voices]) {
          if (v.sustained && v.key.startsWith(ev.peer + ' ')) this.release(v)
        }
      }
    }
  }

  /** per-frame: the listener rides the camera, panners ride their nodes */
  frame(camera: THREE.Camera) {
    if (!this.ctx || this.ctx.state !== 'running' || !this.live.length) return
    const l = this.ctx.listener
    const e = camera.matrixWorld.elements
    // camera looks down its local -Z; up is local +Y
    this.setVec(l.positionX, l.positionY, l.positionZ, e[12], e[13], e[14],
      (x, y, z) => l.setPosition(x, y, z))
    this.setVec(l.forwardX, l.forwardY, l.forwardZ, -e[8], -e[9], -e[10],
      (fx, fy, fz) => l.setOrientation(fx, fy, fz, e[4], e[5], e[6]))
    this.setVec(l.upX, l.upY, l.upZ, e[4], e[5], e[6], () => {})
    for (const em of this.live) {
      if (!em.panner || !em.def.node) continue
      const m = em.def.node.matrixWorld.elements
      this.setVec(em.panner.positionX, em.panner.positionY, em.panner.positionZ,
        m[12], m[13], m[14], (x, y, z) => em.panner!.setPosition(x, y, z))
    }
  }

  /** live stats for the panel and tests */
  stats() {
    return {
      context: this.ctx?.state ?? 'none',
      emitters: this.live.length,
      samples: this.buffers.size,
      voices: this.voices.length,
      sounding: this.voices.filter(v => !v.releasing).length,
    }
  }

  // Safari still lacks the AudioParam listener/panner properties in some
  // versions; fall back to the deprecated setters when they are absent.
  private setVec(px: AudioParam | undefined, py: AudioParam | undefined, pz: AudioParam | undefined,
    x: number, y: number, z: number, fallback: (x: number, y: number, z: number) => void) {
    if (px && py && pz) { px.value = x; py.value = y; pz.value = z }
    else fallback(x, y, z)
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.9
      this.master.connect(this.ctx.destination)
      if (this.ctx.state === 'suspended') this.onLog('audio ready after the first click or key press')
    }
    return this.ctx
  }

  private decode(s: SceneAudioSource) {
    if (this.buffers.has(s.bytes) || this.decoding.has(s.bytes)) return
    this.decoding.add(s.bytes)
    // decodeAudioData detaches its input, and the bytes are shared with
    // the cached ParsedScene: decode a copy
    this.ensureCtx().decodeAudioData(s.bytes.slice(0))
      .then(buf => { this.buffers.set(s.bytes, buf) })
      .catch(e => this.onLog(`audio decode failed (${s.name}): ${e}`))
      .finally(() => this.decoding.delete(s.bytes))
  }

  private instrument(): LiveEmitter | null {
    return this.live.find(e => e.def.sources.some(s => s.note !== null)) ?? null
  }

  private noteOn(peer: string, note: number, velocity: number) {
    const em = this.instrument()
    if (!em || !this.ctx) return
    let best: SceneAudioSource | null = null
    for (const s of em.def.sources) {
      if (s.note === null) continue
      if (!best || Math.abs(s.note - note) < Math.abs(best.note! - note)) best = s
    }
    const buf = best && this.buffers.get(best.bytes)
    if (!best || !buf) return // still decoding: the tail of a run goes missing, not the world
    const key = `${peer} ${note}`
    // retrigger: the old voice of this key gets its release now
    for (const v of this.voices) { if (v.key === key && !v.releasing) this.release(v) }
    while (this.voices.length >= MAX_VOICES) this.stopVoice(this.voices[0])
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = Math.pow(2, (note - best.note!) / 12)
    const gain = ctx.createGain()
    // perceptual-ish velocity curve; the samples are one forte layer
    gain.gain.value = best.gain * Math.pow(Math.min(velocity, 127) / 127, 1.6)
    src.connect(gain)
    gain.connect(em.input)
    const voice: Voice = { src, gain, key, startedAt: ctx.currentTime, releasing: false, sustained: false }
    src.onended = () => this.stopVoice(voice)
    this.voices.push(voice)
    src.start()
  }

  private noteOff(peer: string, note: number) {
    const key = `${peer} ${note}`
    for (const v of this.voices) {
      if (v.key !== key || v.releasing || v.sustained) continue
      if (this.pedal.get(peer)) v.sustained = true
      else this.release(v)
    }
  }

  private release(v: Voice) {
    if (v.releasing || !this.ctx) return
    v.releasing = true
    v.sustained = false
    const t = this.ctx.currentTime
    v.gain.gain.setValueAtTime(v.gain.gain.value, t)
    v.gain.gain.exponentialRampToValueAtTime(0.001, t + RELEASE_S)
    v.src.stop(t + RELEASE_S + 0.05)
  }

  private stopVoice(v: Voice) {
    const i = this.voices.indexOf(v)
    if (i < 0) return
    this.voices.splice(i, 1)
    v.src.onended = null
    try { v.src.stop() } catch { /* never started or already stopped */ }
    v.src.disconnect()
    v.gain.disconnect()
  }
}
