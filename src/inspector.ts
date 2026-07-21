import * as THREE from 'three'

/**
 * Scene inspector (ported from thirdroom's hierarchy/properties editor
 * panels, minus React): a docked overlay with the WHOLE rendered scene's
 * node tree on top - the glTF world plus every live entity: physics
 * boxes, props, cosmetic lines and screens, lights, ground - and the
 * selected node's properties below. The tree tracks the scene live, so
 * spawns and despawns appear as they happen, and the properties panel
 * re-reads the selected node's values in place (moving entities update
 * under your eyes; the field being edited is left alone). Transform,
 * visibility, name, material and light fields are editable - as LOCAL
 * PREVIEWS only: nothing is replicated to other peers, and the physics
 * colliders were baked from the GLB at parse time, so edits move pixels,
 * not the world. (Scripts reading node positions see the edits, since
 * they read the same graph.) Selection lights the node up in 3D through
 * the view's silhouette outline pass, like thirdroom's.
 * Dynamically imported on first open, like the script editor.
 */

export interface InspectorHooks {
  /** the whole rendered scene: glTF world, boxes, props, lines, lights */
  root(): THREE.Object3D | null
  /** the active glTF scene root within it, tagged in the tree */
  gltfRoot(): THREE.Object3D | null
  /** the glTF's mxc url, for the header */
  url(): string | null
  /** highlight these objects with the view's outline pass ([] clears) */
  setOutline(objects: THREE.Object3D[]): void
}

export class SceneInspector {
  private el: HTMLElement
  private treeEl: HTMLElement
  private propsEl: HTMLElement
  private headEl: HTMLElement
  // undefined = never rendered, so the first refresh (even with no scene,
  // root null) always paints the tree or its hint
  private shownRoot: THREE.Object3D | null | undefined = undefined
  private selected: THREE.Object3D | null = null
  private expanded = new WeakSet<THREE.Object3D>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(parent: HTMLElement, private hooks: InspectorHooks) {
    this.el = document.createElement('div')
    this.el.id = 'inspector'
    this.el.style.display = 'none'
    this.el.innerHTML = `
      <div class="bar">
        <b>scene inspector</b> <span class="state" id="insphead"></span>
        <span class="spacer"></span>
        <button id="inspclose" title="close (esc)">×</button>
      </div>
      <div class="tree"></div>
      <div class="props"></div>`
    parent.appendChild(this.el)
    this.headEl = this.el.querySelector('#insphead')!
    this.treeEl = this.el.querySelector('.tree') as HTMLElement
    this.propsEl = this.el.querySelector('.props') as HTMLElement
    ;(this.el.querySelector('#inspclose') as HTMLButtonElement).onclick = () => this.close()
    this.el.tabIndex = -1
    this.el.addEventListener('keydown', e => {
      if (e.key === 'Escape' && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.stopPropagation()
        this.close()
      }
    })
  }

  get isOpen() { return this.el.style.display !== 'none' }

  open() {
    this.el.style.display = 'flex'
    this.refresh()
    // The graph is static once parsed, but WHICH graph is live follows the
    // sim (uploads, rollbacks, late fetches), and the selected node's
    // values move every frame; track both while open.
    this.timer ??= setInterval(() => this.refresh(), 250)
  }

  close() {
    this.el.style.display = 'none'
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.select(null)
  }

  toggle() { this.isOpen ? this.close() : this.open() }

  // Entities spawn and despawn while the panel is open, so the tree
  // refreshes whenever the graph's SHAPE changes (a cheap traversal
  // signature); expansion state survives, keyed by object identity.
  private shownSig = ''

  private refresh() {
    const root = this.hooks.root()
    if (!root) return
    let nodes = 0, tris = 0
    const names: string[] = []
    root.traverse(o => {
      nodes++
      names.push(o.name)
      const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null
      if (g) tris += (g.getIndex()?.count ?? g.getAttribute('position')?.count ?? 0) / 3
    })
    const sig = names.join('|')
    if (root === this.shownRoot && sig === this.shownSig) {
      // same graph, same shape: just pull the selected node's live values
      for (const u of this.live) u()
      return
    }
    this.shownRoot = root
    this.shownSig = sig
    // a despawned selection has nothing left to outline or edit
    let p: THREE.Object3D | null = this.selected
    while (p && p !== root) p = p.parent
    if (this.selected && p !== root) { this.select(null) }
    const url = this.hooks.url()
    this.headEl.textContent = `${nodes} nodes · ${Math.round(tris)} tris${url ? ` · ${url}` : ''}`
    this.expanded.add(root)
    this.renderTree()
  }

  private renderTree() {
    this.treeEl.innerHTML = ''
    if (this.shownRoot) this.treeEl.appendChild(this.renderNode(this.shownRoot, 0))
  }

  private renderNode(obj: THREE.Object3D, depth: number): HTMLElement {
    const frag = document.createElement('div')
    const row = document.createElement('div')
    row.className = 'row' + (obj === this.selected ? ' sel' : '')
    row.style.paddingLeft = `${depth * 12}px`
    const kids = obj.children.length > 0
    const open = this.expanded.has(obj)
    const label = obj.name || `(${obj.type})`
    const t = obj === this.hooks.gltfRoot() ? 'glTF scene' : tag(obj)
    row.innerHTML = `<span class="twist">${kids ? (open ? '▾' : '▸') : '·'}</span>`
      + `<span class="name">${esc(label)}</span> <span class="type">${esc(t)}</span>`
    ;(row.querySelector('.twist') as HTMLElement).onclick = e => {
      e.stopPropagation()
      if (!kids) return
      open ? this.expanded.delete(obj) : this.expanded.add(obj)
      this.renderTree()
    }
    row.onclick = () => this.select(obj === this.selected ? null : obj)
    frag.appendChild(row)
    if (kids && open) for (const c of obj.children) frag.appendChild(this.renderNode(c, depth + 1))
    return frag
  }

  private select(obj: THREE.Object3D | null) {
    this.selected = obj
    this.hooks.setOutline(obj ? [obj] : [])
    if (this.isOpen) this.renderTree()
    this.renderProps()
  }

  // Re-readers for the visible property fields, run on every refresh tick
  // so a moving/repainted entity's values track live. Each skips its input
  // while focused: the form never rewrites under the cursor.
  private live: (() => void)[] = []

  private renderProps() {
    const o = this.selected
    this.propsEl.innerHTML = ''
    this.live = []
    if (!o) { this.propsEl.innerHTML = '<div class="hint">select a node</div>'; return }

    const table = document.createElement('table')
    const row = (label: string, ...cells: (HTMLElement | string)[]) => {
      const tr = document.createElement('tr')
      const th = document.createElement('th')
      th.textContent = label
      const td = document.createElement('td')
      for (const c of cells) c instanceof HTMLElement ? td.appendChild(c) : td.append(c)
      tr.append(th, td)
      table.appendChild(tr)
      return td
    }
    // Live read-only world position: edits below poke refreshWorld, so the
    // derived value tracks without rebuilding the form under the cursor.
    let worldTd: HTMLElement
    const refreshWorld = () => {
      const v = o.getWorldPosition(new THREE.Vector3())
      worldTd.textContent = `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`
    }

    const num = (get: () => number, set: (v: number) => void, step = 0.1, min?: number, max?: number) => {
      const inp = document.createElement('input')
      inp.type = 'number'
      inp.step = String(step)
      if (min !== undefined) inp.min = String(min)
      if (max !== undefined) inp.max = String(max)
      inp.value = f(get())
      inp.oninput = () => {
        const v = Number(inp.value)
        if (!Number.isFinite(v)) return
        set(v)
        refreshWorld()
      }
      this.live.push(() => {
        if (document.activeElement === inp) return
        const v = f(get())
        if (inp.value !== v) inp.value = v
      })
      return inp
    }
    const vec3 = (label: string, get: () => THREE.Vector3, scale = 1) =>
      row(label,
        num(() => get().x * scale, v => { get().x = v / scale }),
        num(() => get().y * scale, v => { get().y = v / scale }),
        num(() => get().z * scale, v => { get().z = v / scale }))
    const check = (get: () => boolean, set: (v: boolean) => void) => {
      const inp = document.createElement('input')
      inp.type = 'checkbox'
      inp.checked = get()
      inp.onchange = () => set(inp.checked)
      this.live.push(() => {
        if (document.activeElement !== inp) inp.checked = get()
      })
      return inp
    }
    const color = (get: () => THREE.Color, set: (hex: string) => void) => {
      const inp = document.createElement('input')
      inp.type = 'color'
      inp.value = `#${get().getHexString()}`
      inp.oninput = () => set(inp.value)
      this.live.push(() => {
        if (document.activeElement === inp) return
        const v = `#${get().getHexString()}`
        if (inp.value !== v) inp.value = v
      })
      return inp
    }
    const text = (get: () => string, set: (v: string) => void) => {
      const inp = document.createElement('input')
      inp.type = 'text'
      inp.className = 'wide'
      inp.value = get()
      inp.onchange = () => { set(inp.value); this.renderTree() } // tree shows names
      this.live.push(() => {
        if (document.activeElement !== inp && inp.value !== get()) inp.value = get()
      })
      return inp
    }

    row('name', text(() => o.name, v => { o.name = v }))
    row('type', o.type)
    row('visible', check(() => o.visible, v => { o.visible = v }))
    vec3('position', () => o.position)
    // rotation edits in degrees; Euler exposes .x/.y/.z, so vec3 fits
    vec3('rotation °', () => o.rotation as unknown as THREE.Vector3, RAD2DEG)
    vec3('scale', () => o.scale)
    worldTd = row('world pos', '')
    refreshWorld()
    this.live.push(refreshWorld)

    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      const g = mesh.geometry
      const pos = g.getAttribute('position')
      row('vertices', String(pos?.count ?? 0))
      row('triangles', String(Math.round((g.getIndex()?.count ?? pos?.count ?? 0) / 3)))
      row('attributes', Object.keys(g.attributes).join(', '))
      const inst = mesh as THREE.InstancedMesh
      if (inst.isInstancedMesh) row('instances', String(inst.count))
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        row('material', `${m.name || '(unnamed)'} · ${m.type}`)
        const std = m as THREE.MeshStandardMaterial
        if (std.color) row('color', color(() => std.color, hex => std.color.set(hex)))
        if (std.isMeshStandardMaterial) {
          row('metalness', num(() => std.metalness, v => { std.metalness = v }, 0.05, 0, 1))
          row('roughness', num(() => std.roughness, v => { std.roughness = v }, 0.05, 0, 1))
        }
        const maps = (['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'emissiveMap'] as const)
          .filter(k => std[k])
        if (maps.length) row('textures', maps.join(', '))
        row('opacity', num(() => m.opacity, v => {
          m.opacity = v
          m.transparent = v < 1 // opaque materials ignore opacity otherwise
          m.needsUpdate = true
        }, 0.05, 0, 1))
        row('side', m.side === THREE.DoubleSide ? 'double' : m.side === THREE.BackSide ? 'back' : 'front')
      }
    }
    const light = o as THREE.Light
    if (light.isLight) {
      row('light color', color(() => light.color, hex => light.color.set(hex)))
      row('intensity', num(() => light.intensity, v => { light.intensity = v }, 0.1, 0))
    }
    if (Object.keys(o.userData).length) row('userData', JSON.stringify(o.userData))

    this.propsEl.appendChild(table)
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = 'edits are local previews: not replicated, colliders unchanged'
    this.propsEl.appendChild(hint)
  }
}

const RAD2DEG = 180 / Math.PI

const tag = (o: THREE.Object3D) =>
  o.type === 'Line2' ? 'line'
  : (o as THREE.Mesh).isMesh ? ((o as THREE.InstancedMesh).isInstancedMesh ? 'instanced' : 'mesh')
  : (o as THREE.Light).isLight ? 'light'
  : (o as THREE.Camera).isCamera ? 'camera'
  : (o as THREE.Bone).isBone ? 'bone'
  : o.children.length ? 'group' : ''

const f = (n: number) => (Math.round(n * 1000) / 1000).toString()

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
