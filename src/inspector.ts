import * as THREE from 'three'

/**
 * glTF scene inspector (ported from thirdroom's hierarchy/properties
 * editor panels, minus React and minus editing): a docked overlay with
 * the loaded GLB's node tree on top and the selected node's properties
 * below. Read-only on purpose - the scene graph feeds the deterministic
 * collider bake, so local mutations would desync peers. Selection drops
 * a BoxHelper into the view so the node lights up in 3D.
 * Dynamically imported on first open, like the script editor.
 */

export interface InspectorHooks {
  /** the active glTF scene root, or null when no scene is loaded */
  root(): THREE.Object3D | null
  /** its mxc url, for the header */
  url(): string | null
  /** where the selection highlight lives */
  overlay: THREE.Scene
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
  private helper: THREE.BoxHelper | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(parent: HTMLElement, private hooks: InspectorHooks) {
    this.el = document.createElement('div')
    this.el.id = 'inspector'
    this.el.style.display = 'none'
    this.el.innerHTML = `
      <div class="bar">
        <b>glTF inspector</b> <span class="state" id="insphead"></span>
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
      if (e.key === 'Escape') { e.stopPropagation(); this.close() }
    })
  }

  get isOpen() { return this.el.style.display !== 'none' }

  open() {
    this.el.style.display = 'flex'
    this.refresh()
    // The graph is static once parsed, but WHICH graph is live follows the
    // sim (uploads, rollbacks, late fetches); track it while open.
    this.timer ??= setInterval(() => this.refresh(), 500)
  }

  close() {
    this.el.style.display = 'none'
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.select(null)
  }

  toggle() { this.isOpen ? this.close() : this.open() }

  private refresh() {
    const root = this.hooks.root()
    if (root === this.shownRoot) return
    this.shownRoot = root
    this.select(null)
    if (!root) {
      this.headEl.textContent = ''
      this.treeEl.innerHTML = '<div class="hint">no glTF scene loaded (use "load glTF scene")</div>'
      return
    }
    let nodes = 0, tris = 0
    root.traverse(o => {
      nodes++
      const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null
      if (g) tris += (g.getIndex()?.count ?? g.getAttribute('position')?.count ?? 0) / 3
    })
    this.headEl.textContent = `${this.hooks.url() ?? ''} · ${nodes} nodes · ${Math.round(tris)} tris`
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
    row.innerHTML = `<span class="twist">${kids ? (open ? '▾' : '▸') : '·'}</span>`
      + `<span class="name">${esc(label)}</span> <span class="type">${esc(tag(obj))}</span>`
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
    if (this.helper) {
      this.hooks.overlay.remove(this.helper)
      this.helper.dispose()
      this.helper = null
    }
    if (obj) {
      this.helper = new THREE.BoxHelper(obj, 0x58a6ff)
      this.hooks.overlay.add(this.helper)
    }
    if (this.isOpen) this.renderTree()
    this.renderProps()
  }

  private renderProps() {
    const o = this.selected
    if (!o) { this.propsEl.innerHTML = '<div class="hint">select a node</div>'; return }
    const v3 = (v: THREE.Vector3) => `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`
    const rows: [string, string][] = [
      ['name', o.name || '(unnamed)'],
      ['type', o.type],
      ['visible', String(o.visible)],
      ['position', v3(o.position)],
      ['rotation', `${d(o.rotation.x)}°, ${d(o.rotation.y)}°, ${d(o.rotation.z)}°`],
      ['scale', v3(o.scale)],
      ['world pos', v3(o.getWorldPosition(new THREE.Vector3()))],
    ]
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      const g = mesh.geometry
      const pos = g.getAttribute('position')
      rows.push(['vertices', String(pos?.count ?? 0)])
      rows.push(['triangles', String(Math.round((g.getIndex()?.count ?? pos?.count ?? 0) / 3))])
      rows.push(['attributes', Object.keys(g.attributes).join(', ')])
      const inst = mesh as THREE.InstancedMesh
      if (inst.isInstancedMesh) rows.push(['instances', String(inst.count)])
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        rows.push(['material', `${m.name || '(unnamed)'} · ${m.type}`])
        const std = m as THREE.MeshStandardMaterial
        if (std.color) rows.push(['color', `#${std.color.getHexString()}`])
        if (std.isMeshStandardMaterial) {
          rows.push(['metal/rough', `${f(std.metalness)} / ${f(std.roughness)}`])
        }
        const maps = (['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'emissiveMap'] as const)
          .filter(k => std[k])
        if (maps.length) rows.push(['textures', maps.join(', ')])
        if (m.transparent) rows.push(['opacity', f(m.opacity)])
        rows.push(['side', m.side === THREE.DoubleSide ? 'double' : m.side === THREE.BackSide ? 'back' : 'front'])
      }
    }
    const light = o as THREE.Light
    if (light.isLight) {
      rows.push(['light color', `#${light.color.getHexString()}`])
      rows.push(['intensity', f(light.intensity)])
    }
    if (Object.keys(o.userData).length) {
      rows.push(['userData', JSON.stringify(o.userData)])
    }
    this.propsEl.innerHTML = `<table>${rows.map(([k, v]) =>
      `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`
  }
}

const tag = (o: THREE.Object3D) =>
  (o as THREE.Mesh).isMesh ? ((o as THREE.InstancedMesh).isInstancedMesh ? 'instanced' : 'mesh')
  : (o as THREE.Light).isLight ? 'light'
  : (o as THREE.Camera).isCamera ? 'camera'
  : (o as THREE.Bone).isBone ? 'bone'
  : o.children.length ? 'group' : ''

const f = (n: number) => (Math.round(n * 1000) / 1000).toString()
const d = (rad: number) => Math.round(THREE.MathUtils.radToDeg(rad) * 10) / 10

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
