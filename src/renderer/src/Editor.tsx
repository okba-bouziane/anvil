import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { EditorSettings, FileChange, Hunk } from '../../shared/types'
import { Icon } from './Icon'
import { MOD, SHIFT } from './keys'
import { store } from './models'
import { monaco, OPTIONS } from './monaco'

const api = window.anvil
const uri = (path: string, side: string) => monaco.Uri.file(`/${side}/${path}`)

interface Marker {
  hunk: Hunk
  top: number
}

function DiffView({ path, revision, source, onError }: { path: string; revision: number; source: 'review' | 'git'; onError: (e: unknown) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const hunks = useRef<Hunk[]>([])
  const [markers, setMarkers] = useState<Marker[]>([])

  // Buttons sit in a layer over the editor and follow the scroll position, so they stay clickable.
  const place = () => {
    const side = editor.current?.getModifiedEditor()
    if (!side) return
    const scroll = side.getScrollTop()
    setMarkers(hunks.current.map((hunk) => ({ hunk, top: side.getTopForLineNumber(Math.max(1, hunk.firstChangedLine)) - scroll })))
  }

  useEffect(() => {
    const created = monaco.editor.createDiffEditor(host.current!, { ...OPTIONS, renderSideBySide: false, readOnly: true, renderOverviewRuler: false })
    editor.current = created
    const side = created.getModifiedEditor()
    const listeners = [side.onDidScrollChange(place), side.onDidLayoutChange(place), created.onDidUpdateDiff(place)]
    return () => {
      listeners.forEach((l) => l.dispose())
      const { original, modified } = created.getModel() ?? {}
      created.setModel(null)
      created.dispose()
      original?.dispose()
      modified?.dispose()
    }
  }, [])

  useEffect(() => {
    let stale = false
    const load = source === 'git'
      ? api.gitDiff(path).then((d) => ({ ...d, change: null as FileChange | null }))
      : api.getDiff(path)
    void load.then(({ original, modified, change }) => {
      if (stale || !editor.current) return
      const instance = editor.current
      const existing = instance.getModel()
      if (existing) {
        // Updating in place: replacing models while a diff is being worked out makes the editor throw.
        if (existing.original.getValue() !== original) existing.original.setValue(original)
        if (existing.modified.getValue() !== modified) existing.modified.setValue(modified)
      } else {
        const language = monaco.editor.createModel('', undefined, uri(path, `lang-${Date.now()}`))
        const id = language.getLanguageId()
        language.dispose()
        instance.setModel({
          original: monaco.editor.createModel(original, id, uri(path, `a${Date.now()}`)),
          modified: monaco.editor.createModel(modified, id, uri(path, `b${Date.now()}`))
        })
      }
      hunks.current = change?.hunks ?? []
      place()
    }).catch(onError)
    return () => { stale = true }
  }, [path, revision, source, onError])

  return (
    <div className="diff-wrap">
      <div className="monaco-host" ref={host} />
      {markers.filter((m) => m.top > -20 && m.top < (host.current?.clientHeight ?? 0)).map(({ hunk, top }) => (
        <div className="hunk-actions" key={hunk.index} style={{ top }}>
          <button className="keep" onClick={() => void api.acceptHunk(path, hunk.index).catch(onError)}>Keep</button>
          <button className="undo" onClick={() => void api.rejectHunk(path, hunk.index).catch(onError)}>Undo</button>
        </div>
      ))}
    </div>
  )
}

export interface CursorInfo {
  line: number
  column: number
  language: string
}

function FileEditor({ path, revision, reveal, hidden, editorSettings, themeName, onCursor, onError }: {
  path: string
  revision: number
  reveal: { line: number; at: number } | null
  hidden: boolean
  editorSettings: EditorSettings
  themeName: string
  onCursor(info: CursorInfo): void
  onError: (e: unknown) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const current = useRef<string | null>(null)
  const formatOnSave = useRef(editorSettings.formatOnSave)
  formatOnSave.current = editorSettings.formatOnSave
  const [unreadable, setUnreadable] = useState<string | null>(null)

  useEffect(() => {
    const created = monaco.editor.create(host.current!, { ...OPTIONS, model: null })
    editor.current = created
    const report = () => {
      const position = created.getPosition()
      const model = created.getModel()
      if (position && model) onCursor({ line: position.lineNumber, column: position.column, language: model.getLanguageId() })
    }
    const listeners = [created.onDidChangeCursorPosition(report), created.onDidChangeModel(report)]
    created.addAction({
      id: 'anvil.save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: async () => {
        if (formatOnSave.current) await created.getAction('editor.action.formatDocument')?.run()
        if (current.current) await store.save(current.current).catch(onError)
      }
    })
    return () => {
      listeners.forEach((l) => l.dispose())
      created.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    editor.current?.updateOptions({ fontSize: editorSettings.fontSize, wordWrap: editorSettings.wordWrap ? 'on' : 'off', minimap: { enabled: editorSettings.minimap } })
    editor.current?.getModel()?.updateOptions({ tabSize: editorSettings.tabSize })
  }, [editorSettings])

  useEffect(() => {
    monaco.editor.setTheme(themeName)
  }, [themeName])

  useEffect(() => {
    const instance = editor.current!
    let stale = false
    if (current.current && current.current !== path) store.setView(current.current, instance.saveViewState())
    void store.ensure(path).then((model) => {
      if (stale) return
      setUnreadable(null)
      if (instance.getModel() !== model) {
        instance.setModel(model)
        model.updateOptions({ tabSize: editorSettings.tabSize })
        const view = store.view(path)
        if (view) instance.restoreViewState(view)
      }
      current.current = path
      instance.focus()
    }).catch((e: Error) => {
      const message = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (/not a text file|too large/.test(message)) {
        instance.setModel(null)
        setUnreadable(message)
      } else onError(e)
    })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, onError])

  useEffect(() => {
    void store.refresh()
  }, [revision])

  useEffect(() => {
    if (!reveal) return
    const instance = editor.current!
    void store.ensure(path).then((model) => {
      if (instance.getModel() !== model) instance.setModel(model)
      instance.revealLineInCenter(reveal.line)
      instance.setPosition({ lineNumber: reveal.line, column: 1 })
      instance.focus()
    }).catch(() => {})
  }, [reveal, path])

  return (
    <div className="file-editor" style={{ display: hidden ? 'none' : 'flex' }}>
      {unreadable && <div className="pane-empty">{unreadable}</div>}
      <div className="monaco-host" ref={host} style={{ display: unreadable ? 'none' : undefined }} />
    </div>
  )
}

export function EditorPane({ path, tabs, change, revision, gitDiff, reveal, editorSettings, themeName, onCursor, onSelect, onClose, onError }: {
  path: string | null
  tabs: string[]
  change: FileChange | undefined
  revision: number
  gitDiff: boolean
  reveal: { line: number; at: number } | null
  editorSettings: EditorSettings
  themeName: string
  onCursor(info: CursorInfo): void
  onSelect(path: string): void
  onClose(path: string): void
  onError: (e: unknown) => void
}) {
  useSyncExternalStore(store.subscribe, store.version)
  if (!path) {
    return (
      <div className="pane-empty welcome">
        <div className="mark" />
        <p>Pick a file to start.</p>
        <div className="keys"><kbd>{MOD}P</kbd> Open a file <kbd>{SHIFT}{MOD}F</kbd> Search <kbd>{MOD}J</kbd> Terminal <kbd>{MOD},</kbd> Settings</div>
      </div>
    )
  }
  const showReview = !!change && !gitDiff
  return (
    <div className="editor-pane">
      <div className="tabbar">
        {tabs.map((t) => (
          <div key={t} className={`tab ${t === path ? 'active' : ''}`} title={t} onClick={() => onSelect(t)}>
            {store.dirty(t) && <span className="dirty-dot" title="Not saved yet" />}
            <span>{t.split('/').pop()}</span>
            <button className="tab-close" aria-label={`Close ${t}`} onClick={(e) => { e.stopPropagation(); onClose(t) }}><Icon name="close" size={11} /></button>
          </div>
        ))}
      </div>
      <div className="editor-head">
        <span className="editor-path">{path}{gitDiff && ' · compared with the last commit'}</span>
        {showReview && change && (
          <span className="editor-actions">
            <span className="counts"><b className="plus">+{change.added}</b> <b className="minus">−{change.removed}</b></span>
            <button className="keep" onClick={() => void api.acceptFile(path).catch(onError)}><Icon name="check" size={13} />Keep file</button>
            <button className="undo" onClick={() => void api.rejectFile(path).catch(onError)}><Icon name="undo" size={13} />Undo file</button>
          </span>
        )}
      </div>
      {gitDiff && <DiffView key={`git:${path}`} path={path} revision={revision} source="git" onError={onError} />}
      {!gitDiff && change && <DiffView key={path} path={path} revision={revision} source="review" onError={onError} />}
      <FileEditor path={path} revision={revision} reveal={reveal} hidden={gitDiff || !!change} editorSettings={editorSettings} themeName={themeName} onCursor={onCursor} onError={onError} />
    </div>
  )
}
