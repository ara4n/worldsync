// The slim monaco 0.56 modular build: core editor + every editor feature,
// but only the javascript language (the full 'monaco-editor' entry ships
// ~80 language modes, css/html/json services and an LSP client we never
// use, nearly doubling the chunk).
import * as monaco from 'monaco-editor/editor.js'
import 'monaco-editor/features/register.all.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import * as monacoTs from 'monaco-editor/languages/features/typescript/register.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'
import { WEBSG_DTS, DEFAULT_SCRIPT } from './websg-dts'

/**
 * In-browser world-script editor (ported from thirdroom's monaco
 * ScriptEditor, minus React): a docked overlay with completions and
 * checkJs diagnostics against the sandbox API (websg-dts.ts), a
 * per-room localStorage draft that survives reloads, and Save & Run
 * wired to the same MSC3815 script_url upload path as the file picker.
 * This module is dynamically imported on first open, so monaco's chunk
 * never taxes peers who just play.
 */

// Monaco resolves its language services via worker; only the ts worker
// (which also serves javascript) is wired, everything else falls back to
// the generic editor worker.
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) =>
    label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker(),
}

const THEME_KEY = 'worldsync_editor_theme'
const draftKey = (room: string) => `worldsync_script_draft_${room}`

export interface EditorHooks {
  /** the script currently in room state (null: none, or still unknown) */
  getPersisted(): Promise<string | null>
  /** upload the source and point script_url at it; rejects on failure */
  save(source: string): Promise<void>
  log(line: string): void
}

export class ScriptEditor {
  private el: HTMLElement
  private editor: monaco.editor.IStandaloneCodeEditor
  private saveBtn: HTMLButtonElement
  private revertBtn: HTMLButtonElement
  private stateEl: HTMLElement
  private persisted: string | null = null
  private saving = false
  // setValue fires the change listener too; only USER edits become drafts,
  // or opening the editor would instantly shadow the room's real script
  private settingValue = false

  constructor(parent: HTMLElement, private room: string, private hooks: EditorHooks) {
    this.el = document.createElement('div')
    this.el.id = 'editor'
    this.el.style.display = 'none'
    this.el.innerHTML = `
      <div class="bar">
        <b>world script</b> <span class="state" id="edstate"></span>
        <span class="spacer"></span>
        <button id="edtheme" title="toggle editor theme">theme</button>
        <button id="edrevert" title="discard the local draft, back to the room's script">revert</button>
        <button id="edsave" title="upload and run on every peer (cmd/ctrl-S)">save &amp; run</button>
        <button id="edclose" title="close (esc); the draft keeps">×</button>
      </div>
      <div class="code"></div>`
    parent.appendChild(this.el)
    this.stateEl = this.el.querySelector('#edstate')!
    this.saveBtn = this.el.querySelector('#edsave') as HTMLButtonElement
    this.revertBtn = this.el.querySelector('#edrevert') as HTMLButtonElement

    // The sandbox is plain ES2020 script (no modules, no DOM): tell the JS
    // service exactly that, hand it the API surface, and let checkJs flag
    // typos against it like thirdroom did.
    const js = monacoTs.javascriptDefaults
    js.setCompilerOptions({
      ...js.getCompilerOptions(),
      target: monacoTs.ScriptTarget.ES2020,
      lib: ['esnext'],
      checkJs: true,
      strictNullChecks: false,
      allowNonTsExtensions: true,
    })
    js.addExtraLib(WEBSG_DTS, 'ts:websg.d.ts')

    const theme = localStorage.getItem(THEME_KEY) === 'light' ? 'vs' : 'vs-dark'
    this.editor = monaco.editor.create(this.el.querySelector('.code') as HTMLElement, {
      value: '',
      language: 'javascript',
      theme,
      minimap: { enabled: false },
      fontSize: 12,
      automaticLayout: true,
      scrollBeyondLastLine: false,
    })
    this.editor.onDidChangeModelContent(() => {
      if (!this.settingValue) localStorage.setItem(draftKey(this.room), this.editor.getValue())
      this.syncState()
    })
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save())

    ;(this.el.querySelector('#edclose') as HTMLButtonElement).onclick = () => this.close()
    ;(this.el.querySelector('#edtheme') as HTMLButtonElement).onclick = () => {
      const light = localStorage.getItem(THEME_KEY) !== 'light'
      localStorage.setItem(THEME_KEY, light ? 'light' : 'dark')
      monaco.editor.setTheme(light ? 'vs' : 'vs-dark')
    }
    this.saveBtn.onclick = () => this.save()
    this.revertBtn.onclick = () => this.revert()
    this.el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close() }
    })
  }

  get isOpen() { return this.el.style.display !== 'none' }

  /** Open (or focus) the editor: local draft wins, then the room's script,
   * then the starter template. The persisted fetch fills in late so the
   * dirty marker and revert work even when the fetch is slow. */
  open() {
    this.el.style.display = 'flex'
    if (!this.editor.getValue()) {
      this.setValue(localStorage.getItem(draftKey(this.room)) ?? DEFAULT_SCRIPT)
    }
    this.hooks.getPersisted()
      .then(src => {
        this.persisted = src
        // no local edits yet: show what the room actually runs
        if (src !== null && localStorage.getItem(draftKey(this.room)) === null) this.setValue(src)
        this.syncState()
      })
      .catch(e => this.hooks.log(`script fetch failed: ${e}`))
    this.syncState()
    this.editor.focus()
  }

  private setValue(v: string) {
    this.settingValue = true
    this.editor.setValue(v)
    this.settingValue = false
  }

  close() { this.el.style.display = 'none' }
  toggle() { this.isOpen ? this.close() : this.open() }

  private syncState() {
    const dirty = this.persisted !== null && this.editor.getValue() !== this.persisted
    this.stateEl.textContent = this.saving ? 'uploading...' : dirty ? 'unsaved' : ''
    this.saveBtn.disabled = this.saving
    this.revertBtn.disabled = this.persisted === null || !dirty
  }

  private save() {
    if (this.saving) return
    this.saving = true
    this.syncState()
    const source = this.editor.getValue()
    this.hooks.save(source)
      // the local edit IS the room's script now; dropping the draft lets a
      // future upload by another peer land in this editor on next open
      .then(() => { this.persisted = source; localStorage.removeItem(draftKey(this.room)) })
      .catch(() => {}) // already logged by the save hook
      .finally(() => { this.saving = false; this.syncState() })
  }

  private revert() {
    if (this.persisted === null) return
    this.setValue(this.persisted)
    localStorage.removeItem(draftKey(this.room))
    this.syncState()
  }
}
