export interface PeerRow {
  id: string
  order: number
  connected: boolean
  rtt: number
  offset: number
  strikes: number
  excluded: boolean
  hashMatch: boolean | null
}

export interface Stats {
  room: string
  id: string
  order: number
  entities: number
  tick: number
  rollbacks: number
  lastDepth: number
  peers: PeerRow[]
}

export interface Hooks {
  onLatency(v: number): void
  onLagPings(v: boolean): void
  onRubber(v: number): void
}

export class UI {
  private statusEl: HTMLElement
  private logEl: HTMLElement
  private lines: string[] = []
  private lastRender = 0

  constructor(root: HTMLElement, hooks: Hooks) {
    root.innerHTML = `
      <h1>worldsync</h1>
      <div class="controls">
        <label>fake latency <input id="lat" type="range" min="0" max="400" step="10" value="0"> <span id="latv">0ms</span></label>
        <label><input id="lagpings" type="checkbox" checked> lag clock sync too (uncheck to look like a cheater)</label>
        <label>rubber-band <input id="rubber" type="number" min="0" max="2000" step="25" value="100"> ms</label>
      </div>
      <div id="status"></div>
      <div id="log"></div>`
    this.statusEl = root.querySelector('#status')!
    this.logEl = root.querySelector('#log')!
    const lat = root.querySelector('#lat') as HTMLInputElement
    const latv = root.querySelector('#latv') as HTMLElement
    lat.oninput = () => { latv.textContent = `${lat.value}ms`; hooks.onLatency(Number(lat.value)) }
    const lp = root.querySelector('#lagpings') as HTMLInputElement
    lp.onchange = () => hooks.onLagPings(lp.checked)
    const rb = root.querySelector('#rubber') as HTMLInputElement
    rb.oninput = () => hooks.onRubber(Number(rb.value))
  }

  log(line: string) {
    this.lines.push(line)
    if (this.lines.length > 9) this.lines.shift()
    this.logEl.innerHTML = this.lines.map(l => `<div>${esc(l)}</div>`).join('')
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
        <td>${p.hashMatch === null ? '-' : p.hashMatch ? '=' : '&ne;'}</td>
        <td>${p.excluded ? 'EXCLUDED' : p.connected ? 'ok' : 'connecting'}</td>
      </tr>`).join('')
    this.statusEl.innerHTML = `
      <div>room <b>${esc(s.room)}</b> as <b>${esc(s.id || '...')}</b> (#${s.order})</div>
      <div class="hint">open this URL in another tab or browser to join (?room=name picks a room)</div>
      <div>entities ${s.entities} | tick ${s.tick} | rollbacks ${s.rollbacks} (last depth ${s.lastDepth})</div>
      ${s.peers.length
        ? `<table><tr><th>peer</th><th>join</th><th>rtt</th><th>skew</th><th>strk</th><th>hash</th><th>status</th></tr>${rows}</table>`
        : '<div class="hint">no peers yet</div>'}`
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
