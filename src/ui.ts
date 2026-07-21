export interface PeerRow {
  id: string
  order: number
  connected: boolean
  rtt: number
  offset: number
  strikes: number
  excluded: boolean
  sync: string
}

export interface Stats {
  room: string
  id: string
  order: number
  mic: string
  entities: number
  tick: number
  stepMs: number
  perf: { snap: number; norm: number; phys: number; hash: number }
  norm: string
  rollbacks: number
  lastDepth: number
  peers: PeerRow[]
}

export interface Hooks {
  onLatency(v: number): void
  onLagPings(v: boolean): void
  onRubber(v: number): void
  onDumpInputs(): void
  onVerify(): void
  onSceneFile(f: File): void
  onScriptFile(f: File): void
}

export class UI {
  private statusEl: HTMLElement
  private logEl: HTMLElement
  private lines: string[] = []
  private lastRender = 0

  constructor(root: HTMLElement, hooks: Hooks) {
    root.innerHTML = `
      <h1>worldsync <span class="caret">▾</span></h1>
      <div id="body">
      <div class="controls">
        <label>fake latency <input id="lat" type="range" min="0" max="1000" step="25" value="0"> <span id="latv">0ms</span></label>
        <label><input id="lagpings" type="checkbox" checked> lag clock sync too</label>
        <label>rubber-band <input id="rubber" type="number" min="0" max="2000" step="25" value="100"> ms</label>
        <button id="dump">download input log</button>
        <button id="verify">verify replay determinism</button>
        <button id="scene">load glTF scene (.glb)</button>
        <input id="scenefile" type="file" accept=".glb,model/gltf-binary" style="display:none">
        <button id="script">load world script (.js)</button>
        <input id="scriptfile" type="file" accept=".js,text/javascript" style="display:none">
      </div>
      <div id="status"></div>
      <div id="log"></div>
      </div>`
    this.statusEl = root.querySelector('#status')!
    this.logEl = root.querySelector('#log')!
    // Click the title to collapse the panel (it can cover most of a small
    // widget iframe); the body scrolls when content outgrows the viewport.
    const h1 = root.querySelector('h1')!
    const caret = root.querySelector('.caret')!
    h1.addEventListener('click', () => {
      root.classList.toggle('collapsed')
      caret.textContent = root.classList.contains('collapsed') ? '▸' : '▾'
    })
    const lat = root.querySelector('#lat') as HTMLInputElement
    const latv = root.querySelector('#latv') as HTMLElement
    lat.oninput = () => { latv.textContent = `${lat.value}ms`; hooks.onLatency(Number(lat.value)) }
    const lp = root.querySelector('#lagpings') as HTMLInputElement
    lp.onchange = () => hooks.onLagPings(lp.checked)
    const rb = root.querySelector('#rubber') as HTMLInputElement
    rb.oninput = () => hooks.onRubber(Number(rb.value))
    ;(root.querySelector('#dump') as HTMLButtonElement).onclick = () => hooks.onDumpInputs()
    ;(root.querySelector('#verify') as HTMLButtonElement).onclick = () => hooks.onVerify()
    const filePick = (btn: string, input: string, cb: (f: File) => void) => {
      const inp = root.querySelector(input) as HTMLInputElement
      ;(root.querySelector(btn) as HTMLButtonElement).onclick = () => inp.click()
      inp.onchange = () => {
        const f = inp.files?.[0]
        if (f) cb(f)
        inp.value = '' // allow re-picking the same file
      }
    }
    filePick('#scene', '#scenefile', f => hooks.onSceneFile(f))
    filePick('#script', '#scriptfile', f => hooks.onScriptFile(f))
  }

  log(line: string) {
    this.lines.push(line)
    if (this.lines.length > 200) this.lines.shift()
    this.logEl.innerHTML = this.lines.map(l => `<div>${esc(l)}</div>`).join('')
    // follow the tail unless the user has scrolled up to read history
    const body = this.logEl.parentElement!
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60
    if (nearBottom) body.scrollTop = body.scrollHeight
  }

  maybe(now: number, get: () => Stats) {
    if (now - this.lastRender < 250) return
    this.lastRender = now
    const s = get()
    const rows = s.peers.map(p => `
      <tr class="${p.excluded ? 'excluded' : ''}">
        <td>${esc(p.id)}</td><td>#${p.order}</td>
        <td>${p.connected ? p.rtt.toFixed(0) + 'ms' : '...'}</td>
        <td>${p.connected ? p.offset.toFixed(0) : '-'}</td>
        <td>${p.strikes}</td>
        <td>${esc(p.sync)}</td>
        <td>${p.excluded ? 'EXCLUDED' : p.connected ? 'ok' : 'connecting'}</td>
      </tr>`).join('')
    this.statusEl.innerHTML = `
      <div>room <b>${esc(s.room)}</b> as <b>${esc(s.id || '...')}</b> (#${s.order}) | mic <b>${esc(s.mic)}</b></div>
      <div class="hint">open this URL in another tab or browser to join (?room=name picks a room)</div>
      <div>entities ${s.entities} | tick ${s.tick} | step ${s.stepMs.toFixed(1)}ms
        (snap ${s.perf.snap.toFixed(1)} + ${esc(s.norm)} ${s.perf.norm.toFixed(1)} + phys ${s.perf.phys.toFixed(1)} + hash ${s.perf.hash.toFixed(1)})
        | rollbacks ${s.rollbacks} (last depth ${s.lastDepth})</div>
      ${s.peers.length
        ? `<table><tr><th>peer</th><th>join</th><th>rtt</th><th>skew</th><th>strk</th><th>sync</th><th>status</th></tr>${rows}</table>`
        : '<div class="hint">no peers yet</div>'}`
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
