import { useEffect, useRef, useState } from 'react'
import type { FileChange, Hunk } from '../../shared/types'
import { Icon } from './Icon'
import { MOD, SHIFT } from './keys'
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
      const old = instance.getModel()
      const language = monaco.editor.createModel('', undefined, uri(path, `lang-${Date.now()}`))
      const id = language.getLanguageId()
      language.dispose()
      instance.setModel({
        original: monaco.editor.createModel(original, id, uri(path, `a${Date.now()}`)),
        modified: monaco.editor.createModel(modified, id, uri(path, `b${Date.now()}`))
      })
      old?.original.dispose()
      old?.modified.dispose()
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

function FileView({ path, revision, reveal, onError }: { path: string; revision: number; reveal: number | null; onError: (e: unknown) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [unreadable, setUnreadable] = useState<string | null>(null)

  useEffect(() => {
    const created = monaco.editor.create(host.current!, OPTIONS)
    editor.current = created
    return () => {
      created.getModel()?.dispose()
      created.dispose()
    }
  }, [])

  useEffect(() => {
    const instance = editor.current!
    let stale = false
    void api.readFile(path).then((text) => {
      if (stale) return
      const current = instance.getModel()
      const sameFile = current?.uri.path === uri(path, 'file').path
      if (sameFile && current!.getValue() === text) return
      if (sameFile && dirtyRef.current) return // keep what the user is typing
      current?.dispose()
      const model = monaco.editor.createModel(text, undefined, uri(path, 'file'))
      instance.setModel(model)
      dirtyRef.current = false
      setDirty(false)
      model.onDidChangeContent(() => {
        dirtyRef.current = true
        setDirty(true)
      })
    }).then(() => {
      if (reveal && !stale) {
        instance.revealLineInCenter(reveal)
        instance.setPosition({ lineNumber: reveal, column: 1 })
        instance.focus()
      }
    }).catch((e: Error) => {
      if (/not a text file|too large/.test(e.message)) setUnreadable(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      else onError(e)
    })
    return () => { stale = true }
  }, [path, revision, reveal, onError])

  useEffect(() => {
    const instance = editor.current!
    const command = instance.addAction({
      id: 'anvil.save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void api.writeFile(path, instance.getValue()).then(() => {
          dirtyRef.current = false
          setDirty(false)
        }).catch(onError)
      }
    })
    return () => command.dispose()
  }, [path, onError])

  return (
    <>
      {dirty && <div className="unsaved">Unsaved changes. Press {MOD}S to save.</div>}
      {unreadable && <div className="pane-empty">{unreadable}</div>}
      <div className="monaco-host" ref={host} style={{ display: unreadable ? 'none' : undefined }} />
    </>
  )
}

export function EditorPane({ path, tabs, change, revision, gitDiff, reveal, onSelect, onClose, onError }: {
  path: string | null
  tabs: string[]
  change: FileChange | undefined
  revision: number
  gitDiff: boolean
  reveal: number | null
  onSelect(path: string): void
  onClose(path: string): void
  onError: (e: unknown) => void
}) {
  if (!path) {
    return (
      <div className="pane-empty welcome">
        <div className="mark" />
        <p>Pick a file, or describe a change in the chat.</p>
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
      {gitDiff
        ? <DiffView key={`git:${path}`} path={path} revision={revision} source="git" onError={onError} />
        : change
          ? <DiffView key={path} path={path} revision={revision} source="review" onError={onError} />
          : <FileView key={path} path={path} revision={revision} reveal={reveal} onError={onError} />}
    </div>
  )
}
