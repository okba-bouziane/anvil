import type { IntelDiagnostic } from '../../shared/types'
import { monaco } from './monaco'

const api = window.anvil
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const PREFIX = '/file/'

interface Entry {
  model: monaco.editor.ITextModel
  saved: string
  view: monaco.editor.ICodeEditorViewState | null
  timer: ReturnType<typeof setTimeout> | null
  intelTimer: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()
const problems = new Map<string, IntelDiagnostic[]>()
const listeners = new Set<() => void>()
let version = 0
let autoSave = true
let onError: (e: unknown) => void = () => {}

const notify = () => {
  version++
  listeners.forEach((l) => l())
}

export const relOf = (uri: monaco.Uri): string | null => (uri.path.startsWith(PREFIX) ? uri.path.slice(PREFIX.length) : null)
export const uriOf = (path: string) => monaco.Uri.file(`${PREFIX}${path}`)
const isDirty = (e: Entry) => e.model.getValue() !== e.saved

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

async function syncIntel(path: string, entry: Entry): Promise<void> {
  if (!CODE.test(path)) return
  const text = entry.model.getValue()
  await api.intel('update', path, text)
  const list = await api.intel<IntelDiagnostic[]>('diagnostics', path)
  if (entries.get(path) === entry && entry.model.getValue() === text) setMarkers(path, entry.model, list)
}

export const store = {
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
  problems: () => [...problems.values()].flat(),
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
    const entry: Entry = { model, saved: text, view: null, timer: null, intelTimer: null }
    entries.set(path, entry)
    model.onDidChangeContent(() => {
      notify()
      if (entry.intelTimer) clearTimeout(entry.intelTimer)
      entry.intelTimer = setTimeout(() => void syncIntel(path, entry).catch(() => {}), 350)
      if (entry.timer) clearTimeout(entry.timer)
      if (autoSave) entry.timer = setTimeout(() => void store.save(path).catch(onError), 900)
    })
    void syncIntel(path, entry).catch(() => {})
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
    if (text === e.saved) return
    await api.writeFile(path, text)
    e.saved = text
    notify()
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
        }
      } catch {
        /* the file is gone; its tab is closed separately */
      }
    }
  },

  close(path: string) {
    const e = entries.get(path)
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    if (e.intelTimer) clearTimeout(e.intelTimer)
    e.model.dispose()
    entries.delete(path)
    problems.delete(path)
    void api.intel('close', path).catch(() => {})
    notify()
  },
  reset() {
    for (const path of [...entries.keys()]) store.close(path)
    problems.clear()
    notify()
  }
}
