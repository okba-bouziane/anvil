import type { IntelDiagnostic, LintMessage } from '../../shared/types'
import { monaco } from './monaco'

const api = window.anvil
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const PREFIX = '/file/'

interface Entry {
  model: monaco.editor.ITextModel
  saved: string
  savedVersion: number
  wasDirty: boolean
  lspTimer: ReturnType<typeof setTimeout> | null
  copyTimer: ReturnType<typeof setTimeout> | null
  hasCopy: boolean
  view: monaco.editor.ICodeEditorViewState | null
  timer: ReturnType<typeof setTimeout> | null
  intelTimer: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()
const problems = new Map<string, IntelDiagnostic[]>()
const listeners = new Set<() => void>()
let version = 0
let autoSave = true
const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|html)$/
const lints = new Map<string, IntelDiagnostic[]>()
const lintFixes = new Map<string, LintMessage[]>()
let toolingOn = false
export type LspKind = 'python' | 'angular'
/** Sends a language server the latest text now, so an answer it's about to give isn't out of date. */
export function flushLspChange(path: string): void {
  const entry = entries.get(path)
  if (!entry?.lspTimer) return
  clearTimeout(entry.lspTimer)
  entry.lspTimer = null
  const kind = lspKindOf(path)
  if (kind) void api.lspChange(kind, path, entry.model.getValue()).catch(() => {})
}
let angularProject = false
const lspProblems = new Map<string, IntelDiagnostic[]>()

/** Which language server, if any, follows this file. TypeScript only goes to Angular, for its templates. */
export function lspKindOf(path: string): LspKind | null {
  if (/\.pyi?$/.test(path)) return 'python'
  if (angularProject && /\.(html|ts)$/.test(path)) return 'angular'
  return null
}
const languageIdOf = (path: string) => (/\.pyi?$/.test(path) ? 'python' : path.endsWith('.ts') ? 'typescript' : 'html')
let onError: (e: unknown) => void = () => {}

const notify = () => {
  version++
  listeners.forEach((l) => l())
}

export const relOf = (uri: monaco.Uri): string | null => (uri.path.startsWith(PREFIX) ? uri.path.slice(PREFIX.length) : null)
export const uriOf = (path: string) => monaco.Uri.file(`${PREFIX}${path}`)
// Comparing version numbers, not whole files, keeps typing fast in big files.
const isDirty = (e: Entry) => e.model.getAlternativeVersionId() !== e.savedVersion
const markSaved = (e: Entry) => {
  e.savedVersion = e.model.getAlternativeVersionId()
  e.wasDirty = false
}
/** The recovery copy exists only while a file has edits that aren't on disk. */
const dropCopy = (path: string, e: Entry) => {
  if (e.copyTimer) clearTimeout(e.copyTimer)
  e.copyTimer = null
  if (!e.hasCopy) return
  e.hasCopy = false
  void api.recoveryClear(path).catch(() => {})
}

function setMarkers(path: string, model: monaco.editor.ITextModel, list: IntelDiagnostic[]): void {
  problems.set(path, list)
  monaco.editor.setModelMarkers(model, 'anvil', list.map((d) => ({
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.endLine,
    endColumn: d.endColumn,
    message: d.message,
    code: String(d.code),
    severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning
  })))
  notify()
}

async function syncLint(path: string, entry: Entry): Promise<void> {
  if (!toolingOn || !LINTABLE.test(path)) return
  const text = entry.model.getValue()
  const list = await api.tooling<LintMessage[] | null>('lint', path, text)
  if (!list || entries.get(path) !== entry || entry.model.getValue() !== text) return
  lintFixes.set(path, list)
  lints.set(path, list.map((m) => ({ path, line: m.line, column: m.column, endLine: m.endLine, endColumn: m.endColumn, message: m.message, code: m.rule ? `eslint: ${m.rule}` : 'eslint', severity: m.severity })))
  monaco.editor.setModelMarkers(entry.model, 'eslint', list.map((m) => ({
    startLineNumber: m.line,
    startColumn: m.column,
    endLineNumber: m.endLine,
    endColumn: m.endColumn,
    message: m.message,
    source: 'ESLint',
    code: m.rule ?? undefined,
    severity: m.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning
  })))
  notify()
}

async function syncIntel(path: string, entry: Entry): Promise<void> {
  if (!CODE.test(path)) return
  const text = entry.model.getValue()
  await api.intel('update', path, text)
  const list = await api.intel<IntelDiagnostic[]>('diagnostics', path)
  if (entries.get(path) === entry && entry.model.getValue() === text) setMarkers(path, entry.model, list)
}

let activePath: string | null = null

export const store = {
  activePath: () => activePath,
  formatActive() {
    return store.runAction('editor.action.formatDocument')
  },
  runAction(id: string) {
    const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus() || e.getModel() === entries.get(activePath ?? '')?.model)
    editor?.focus()
    return editor?.getAction(id)?.run()
  },
  setActivePath(path: string | null) { activePath = path },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  version: () => version,
  configure(options: { autoSave: boolean; onError(e: unknown): void }) {
    autoSave = options.autoSave
    onError = options.onError
  },
  dirty: (path: string) => {
    const e = entries.get(path)
    return !!e && isDirty(e)
  },
  anyDirty: () => [...entries.values()].some(isDirty),
  problems: () => [...problems.values(), ...lints.values(), ...lspProblems.values()].flat(),
  setAngular(on: boolean) {
    angularProject = on
    if (on) for (const [path, entry] of entries) { const kind = lspKindOf(path); if (kind) void api.lspOpen(kind, path, languageIdOf(path), entry.model.getValue()).catch(() => {}) }
  },
  setLspDiagnostics(path: string, list: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; message: string; severity?: number; code?: string | number; source?: string }[]) {
    const items = list.filter((d) => (d.severity ?? 1) <= 2)
    lspProblems.set(path, items.map((d) => ({ path, line: d.range.start.line + 1, column: d.range.start.character + 1, endLine: d.range.end.line + 1, endColumn: d.range.end.character + 1, message: d.message, code: d.code ?? d.source ?? '', severity: d.severity === 2 ? 'warning' as const : 'error' as const })))
    const entry = entries.get(path)
    if (entry) {
      monaco.editor.setModelMarkers(entry.model, 'lsp', list.map((d) => ({
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        message: d.message,
        source: d.source,
        code: d.code === undefined ? undefined : String(d.code),
        severity: d.severity === 2 ? monaco.MarkerSeverity.Warning : d.severity === 3 ? monaco.MarkerSeverity.Info : d.severity === 4 ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Error
      })))
    }
    notify()
  },
  lintFixes: (path: string) => lintFixes.get(path) ?? [],
  setTooling(on: boolean) {
    toolingOn = on
    if (on) for (const [path, entry] of entries) void syncLint(path, entry).catch(() => {})
  },
  setProjectProblems(list: IntelDiagnostic[]) {
    const open = new Set(entries.keys())
    for (const key of [...problems.keys()]) if (!open.has(key)) problems.delete(key)
    const grouped = new Map<string, IntelDiagnostic[]>()
    for (const d of list) grouped.set(d.path, [...(grouped.get(d.path) ?? []), d])
    for (const [path, items] of grouped) if (!open.has(path)) problems.set(path, items)
    notify()
  },

  /** Models live as long as the tab, so edits, undo history and scroll position survive switching tabs. */
  async ensure(path: string): Promise<monaco.editor.ITextModel> {
    const existing = entries.get(path)
    if (existing) return existing.model
    const text = await api.readFile(path)
    const again = entries.get(path)
    if (again) return again.model
    const model = monaco.editor.createModel(text, undefined, uriOf(path))
    const entry: Entry = { model, saved: text, savedVersion: model.getAlternativeVersionId(), wasDirty: false, lspTimer: null, copyTimer: null, hasCopy: false, view: null, timer: null, intelTimer: null }
    entries.set(path, entry)
    model.onDidChangeContent(() => {
      // Tab dots only change when a file becomes edited or goes back to its saved state.
      if (isDirty(entry) !== entry.wasDirty) {
        entry.wasDirty = !entry.wasDirty
        notify()
      }
      if (lspKindOf(path)) {
        if (entry.lspTimer) clearTimeout(entry.lspTimer)
        entry.lspTimer = setTimeout(() => flushLspChange(path), 80)
      }
      if (entry.intelTimer) clearTimeout(entry.intelTimer)
      entry.intelTimer = setTimeout(() => { void syncIntel(path, entry).catch(() => {}); void syncLint(path, entry).catch(() => {}) }, 350)
      if (entry.timer) clearTimeout(entry.timer)
      if (autoSave) entry.timer = setTimeout(() => void store.save(path).catch(onError), 900)
      else if (isDirty(entry)) {
        if (entry.copyTimer) clearTimeout(entry.copyTimer)
        entry.copyTimer = setTimeout(() => {
          entry.hasCopy = true
          void api.recoverySave(path, model.getValue()).catch(() => {})
        }, 1200)
      } else dropCopy(path, entry)
    })
    void syncIntel(path, entry).catch(() => {})
    void syncLint(path, entry).catch(() => {})
    const lspKind = lspKindOf(path)
    if (lspKind) void api.lspOpen(lspKind, path, languageIdOf(path), text).catch(() => {})
    return model
  },
  view: (path: string) => entries.get(path)?.view ?? null,
  setView(path: string, view: monaco.editor.ICodeEditorViewState | null) {
    const e = entries.get(path)
    if (e) e.view = view
  },

  async save(path: string) {
    const e = entries.get(path)
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    const text = e.model.getValue()
    const version = e.model.getAlternativeVersionId()
    if (text === e.saved) {
      markSaved(e)
      dropCopy(path, e)
      return
    }
    await api.writeFile(path, text)
    e.saved = text
    // Typing during the save leaves the file edited.
    e.savedVersion = version
    e.wasDirty = isDirty(e)
    if (!e.wasDirty) dropCopy(path, e)
    notify()
  },
  async saveAs(path: string, target: string) {
    const e = entries.get(path)
    if (!e) return
    await api.createPath(target, false).catch(() => {})
    await api.writeFile(target, e.model.getValue())
  },
  async revert(path: string) {
    const e = entries.get(path)
    if (!e) return
    const text = await api.readFile(path)
    e.saved = text
    e.model.setValue(text)
    markSaved(e)
    dropCopy(path, e)
    notify()
  },
  /** Puts back edits saved by the recovery copy. They stay unsaved until the person saves. */
  async restoreCopy(path: string, text: string) {
    const model = await store.ensure(path)
    model.setValue(text)
    const e = entries.get(path)
    if (e) {
      e.hasCopy = true
      if (e.timer) clearTimeout(e.timer)
    }
  },
  async saveAll() {
    await Promise.all([...entries.keys()].map((p) => store.save(p)))
  },

  /** Picks up changes from the model, a command or another program, without touching unsaved work. */
  async refresh() {
    for (const [path, entry] of entries) {
      if (isDirty(entry)) continue
      try {
        const text = await api.readFile(path)
        if (text !== entry.saved) {
          entry.saved = text
          if (entry.model.getValue() !== text) entry.model.setValue(text)
          markSaved(entry)
          notify()
        }
      } catch {
        /* the file is gone; its tab is closed separately */
      }
    }
  },

  /** Closing a tab means the edits are done with. Leaving the project keeps their recovery copy. */
  close(path: string, keepCopy = false) {
    const e = entries.get(path)
    if (!e) return
    if (keepCopy && e.copyTimer) clearTimeout(e.copyTimer)
    else if (!keepCopy) dropCopy(path, e)
    if (e.lspTimer) clearTimeout(e.lspTimer)
    if (e.timer) clearTimeout(e.timer)
    if (e.intelTimer) clearTimeout(e.intelTimer)
    e.model.dispose()
    entries.delete(path)
    problems.delete(path)
    lints.delete(path)
    lintFixes.delete(path)
    lspProblems.delete(path)
    const kind = lspKindOf(path)
    if (kind) void api.lspClose(kind, path).catch(() => {})
    void api.intel('close', path).catch(() => {})
    notify()
  },
  reset() {
    for (const path of [...entries.keys()]) store.close(path, true)
    problems.clear()
    notify()
  }
}
