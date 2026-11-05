import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BlameLine, EditorSettings, FileChange, Hunk } from '../../shared/types'
import { diffLines } from 'diff'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { findConflicts, resolvedLines, type ConflictBlock, type ConflictChoice } from '../../shared/conflicts'
import { blockPatch } from '../../shared/patch'
import { debug } from './debugStore'
import { FileIcon, Icon, Logo } from './Icon'
import { fixAllLint } from './intel'
import { MOD, SHIFT } from './keys'
import { store } from './models'
import { ago } from './Panels'
import { monaco, OPTIONS } from './monaco'

const api = window.anvil
const uri = (path: string, side: string) => monaco.Uri.file(`/${side}/${path}`)

interface Marker {
  hunk: Hunk
  top: number
}

function DiffView({ path, revision, source, sha, onError, gitMode }: { path: string; revision: number; source: 'review' | 'git' | 'commit'; sha?: string; onError: (e: unknown) => void; gitMode?: 'worktree' | 'staged' }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const hunks = useRef<Hunk[]>([])
  const [markers, setMarkers] = useState<Marker[]>([])
  const [blocks, setBlocks] = useState<{ change: monaco.editor.ILineChange; top: number }[]>([])

  // Buttons sit in a layer over the editor and follow the scroll position, so they stay clickable.
  const place = () => {
    const side = editor.current?.getModifiedEditor()
    if (!side) return
    const scroll = side.getScrollTop()
    setMarkers(hunks.current.map((hunk) => ({ hunk, top: side.getTopForLineNumber(Math.max(1, hunk.firstChangedLine)) - scroll })))
    if (source === 'git') {
      const changes = editor.current?.getLineChanges() ?? []
      setBlocks(changes.map((change) => ({ change, top: side.getTopForLineNumber(Math.max(1, change.modifiedEndLineNumber ? change.modifiedStartLineNumber : change.modifiedStartLineNumber + 1)) - scroll })))
    }
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
    const load = source === 'commit'
      ? api.gitCommitDiff(sha!, path).then((d) => ({ ...d, change: null as FileChange | null }))
      : source === 'git'
        ? api.gitDiff(path, gitMode).then((d) => ({ ...d, change: null as FileChange | null }))
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
  }, [path, revision, source, sha, onError])

  const model = editor.current?.getModel()
  const hasBase = !!model?.original.getValueLength()
  const applyBlock = (change: monaco.editor.ILineChange, target: 'index' | 'tree', reverse: boolean) => {
    if (!model) return
    const patch = blockPatch(path, model.original.getValue(), model.modified.getValue(), {
      originalStart: change.originalStartLineNumber,
      originalEnd: change.originalEndLineNumber,
      modifiedStart: change.modifiedStartLineNumber,
      modifiedEnd: change.modifiedEndLineNumber
    })
    void api.gitOp('applyPatch', patch, target, reverse).catch(onError)
  }

  return (
    <div className="diff-wrap">
      <div className="monaco-host" ref={host} />
      {markers.filter((m) => m.top > -20 && m.top < (host.current?.clientHeight ?? 0)).map(({ hunk, top }) => (
        <div className="hunk-actions" key={hunk.index} style={{ top }}>
          <button className="keep" onClick={() => void api.acceptHunk(path, hunk.index).catch(onError)}>Keep</button>
          <button className="undo" onClick={() => void api.rejectHunk(path, hunk.index).catch(onError)}>Undo</button>
        </div>
      ))}
      {source === 'git' && hasBase && blocks.filter((b) => b.top > -20 && b.top < (host.current?.clientHeight ?? 0)).map(({ change, top }) => (
        <div className="hunk-actions" key={`${change.modifiedStartLineNumber}:${change.originalStartLineNumber}`} style={{ top }}>
          {gitMode === 'staged'
            ? <button onClick={() => applyBlock(change, 'index', true)}>Unstage</button>
            : (
              <>
                <button onClick={() => applyBlock(change, 'index', false)}>Stage</button>
                <button onClick={() => { if (window.confirm('Discard this block of changes?')) applyBlock(change, 'tree', true) }}>Discard</button>
              </>
            )}
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

function FileEditor({ path, revision, reveal, hidden, editorSettings, cursorStyle, stickyScroll, fixLint, themeName, onCursor, onError }: {
  path: string
  revision: number
  reveal: { line: number; at: number } | null
  hidden: boolean
  editorSettings: EditorSettings
  cursorStyle: 'line' | 'block' | 'underline'
  stickyScroll: boolean
  fixLint: boolean
  themeName: string
  onCursor(info: CursorInfo): void
  onError: (e: unknown) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const current = useRef<string | null>(null)
  const formatOnSave = useRef(editorSettings.formatOnSave)
  formatOnSave.current = editorSettings.formatOnSave
  const fixOnSave = useRef(fixLint)
  fixOnSave.current = fixLint
  const [unreadable, setUnreadable] = useState<string | null>(null)

  useEffect(() => {
    const created = monaco.editor.create(host.current!, { ...OPTIONS, model: null })
    editor.current = created
    const report = () => {
      const position = created.getPosition()
      const model = created.getModel()
      if (position && model) onCursor({ line: position.lineNumber, column: position.column, language: model.getLanguageId() })
    }
    const listeners = [created.onDidChangeCursorPosition(report), created.onDidChangeModel(report), created.onDidFocusEditorText(() => store.setActivePath(current.current))]
    created.addAction({
      id: 'anvil.save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: async () => {
        const model = created.getModel()
        if (fixOnSave.current && model) await fixAllLint(model)
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
    editor.current?.updateOptions({ fontSize: editorSettings.fontSize, wordWrap: editorSettings.wordWrap ? 'on' : 'off', minimap: { enabled: editorSettings.minimap }, cursorStyle, stickyScroll: { enabled: stickyScroll } })
    editor.current?.getModel()?.updateOptions({ tabSize: editorSettings.tabSize })
  }, [editorSettings, cursorStyle, stickyScroll])

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
      current.current = path
      if (instance.getModel() !== model) {
        instance.setModel(model)
        model.updateOptions({ tabSize: editorSettings.tabSize })
        const view = store.view(path)
        if (view) instance.restoreViewState(view)
      }
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

  // Who last changed the current line, shown at the end of it.
  const blameLines = useRef<Map<number, BlameLine>>(new Map())
  const blameDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const showBlame = useRef(editorSettings.blame)
  showBlame.current = editorSettings.blame

  const drawBlame = useCallback(() => {
    const instance = editor.current
    if (!instance) return
    blameDecorations.current ??= instance.createDecorationsCollection()
    const position = instance.getPosition()
    const info = position ? blameLines.current.get(position.lineNumber) : undefined
    const file = current.current
    const usable = showBlame.current && info && file && !store.dirty(file) && !/^0+$/.test(info.sha)
    if (!usable || !position) return blameDecorations.current.clear()
    const end = instance.getModel()?.getLineMaxColumn(position.lineNumber) ?? 1
    const label = `${info.author}, ${ago(info.time)} · ${info.subject.slice(0, 70)}`
    blameDecorations.current.set([{
      range: new monaco.Range(position.lineNumber, end, position.lineNumber, end),
      options: {
        showIfCollapsed: true,
        after: { content: `    ${label}`, inlineClassName: 'blame-text', cursorStops: monaco.editor.InjectedTextCursorStops.None },
        hoverMessage: { value: `**${info.author}** · ${new Date(info.time * 1000).toLocaleString()}\n\n${info.subject}\n\n\`${info.sha.slice(0, 7)}\`` }
      }
    }])
  }, [])

  useEffect(() => {
    blameLines.current = new Map()
    drawBlame()
    if (!editorSettings.blame) return
    let stale = false
    void api.gitBlame(path).then((lines) => {
      if (stale) return
      blameLines.current = new Map(lines.map((l) => [l.line, l]))
      drawBlame()
    }).catch(() => {}) // not in Git, or not committed yet
    return () => { stale = true }
  }, [path, revision, editorSettings.blame, drawBlame])

  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    const listeners = [instance.onDidChangeCursorPosition(drawBlame), instance.onDidChangeModelContent(drawBlame), instance.onDidChangeModel(drawBlame)]
    return () => listeners.forEach((l) => l.dispose())
  }, [drawBlame])

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

  // Typing the > of an HTML tag adds its closing tag.
  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i
    const sub = instance.onDidChangeModelContent((event) => {
      const model = instance.getModel()
      if (!model || event.isUndoing || event.isRedoing || !['html', 'xml', 'vue'].includes(model.getLanguageId())) return
      const change = event.changes[0]
      if (event.changes.length !== 1 || change.text !== '>') return
      const line = change.range.startLineNumber
      const column = change.range.startColumn + 1
      const before = model.getLineContent(line).slice(0, column - 1)
      const tag = before.match(/<([A-Za-z][\w:.-]*)(?:\s+[^<>]*)?>$/)
      if (!tag || before.endsWith('/>') || VOID.test(tag[1])) return
      const closing = `</${tag[1]}>`
      if (model.getLineContent(line).slice(column - 1).startsWith(closing)) return
      queueMicrotask(() => {
        instance.executeEdits('anvil.closeTag', [{ range: new monaco.Range(line, column, line, column), text: closing }])
        instance.setPosition({ lineNumber: line, column })
      })
    })
    return () => sub.dispose()
  }, [])

  // Breakpoints in the margin, and the line a paused program has stopped on.
  const debugVersion = useSyncExternalStore(debug.subscribe, debug.version)
  const breakDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    const sub = instance.onMouseDown((e) => {
      const line = e.target.position?.lineNumber
      if (line && current.current && (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && e.event.altKey)) debug.toggle(current.current, line)
    })
    instance.addAction({ id: 'anvil.toggleBreakpoint', label: 'Toggle breakpoint', keybindings: [monaco.KeyCode.F9], run: () => {
      const line = instance.getPosition()?.lineNumber
      if (line && current.current) debug.toggle(current.current, line)
    } })
    return () => sub.dispose()
  }, [])
  const frame = debug.frame()
  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    breakDecorations.current ??= instance.createDecorationsCollection()
    breakDecorations.current.set([
      ...debug.forFile(path).map((b) => ({ range: new monaco.Range(b.line, 1, b.line, 1), options: { glyphMarginClassName: b.condition ? 'bp-glyph conditional' : 'bp-glyph', glyphMarginHoverMessage: b.condition ? { value: `Stops only when ${b.condition}` } : undefined, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } })),
      ...(frame?.path === path ? [{ range: new monaco.Range(frame.line, 1, frame.line, 1), options: { isWholeLine: true, className: 'debug-line', glyphMarginClassName: 'debug-arrow' } }] : [])
    ])
  }, [path, debugVersion, frame])

  // Marks in the margin for lines that differ from the last commit.
  const gutter = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    gutter.current ??= instance.createDecorationsCollection()
    let head = ''
    let stale = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const draw = () => {
      const model = instance.getModel()
      if (!model || !head) return gutter.current?.clear()
      const marks: { line: number; kind: string }[] = []
      let line = 1
      const parts = diffLines(head, model.getValue())
      parts.forEach((part, i) => {
        const count = part.count ?? 0
        if (part.added) {
          const kind = parts[i - 1]?.removed ? 'gut-mod' : 'gut-add'
          for (let n = 0; n < count; n++) marks.push({ line: line + n, kind })
          line += count
        } else if (part.removed) {
          if (!parts[i + 1]?.added) marks.push({ line: Math.max(1, Math.min(line, model.getLineCount())), kind: 'gut-del' })
        } else line += count
      })
      gutter.current?.set(marks.map((m) => ({ range: new monaco.Range(m.line, 1, m.line, 1), options: { linesDecorationsClassName: m.kind } })))
    }
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(draw, 250)
    }
    void api.gitHead(path).then((text) => {
      if (stale) return
      head = text
      later()
    }).catch(() => {})
    const listeners = [instance.onDidChangeModelContent(later), instance.onDidChangeModel(later)]
    return () => {
      stale = true
      if (timer) clearTimeout(timer)
      listeners.forEach((l) => l.dispose())
    }
  }, [path, revision])

  // Git's conflict markers get colors and buttons. Each choice is an ordinary edit, so undo works.
  const [conflicts, setConflicts] = useState<{ block: ConflictBlock; top: number }[]>([])
  const conflictDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    conflictDecorations.current ??= instance.createDecorationsCollection()
    let found: ConflictBlock[] = []
    const place = () => {
      // Most files have no conflicts. Scrolling must not redraw the whole component for nothing.
      if (!found.length) return setConflicts((old) => (old.length ? [] : old))
      const scroll = instance.getScrollTop()
      setConflicts(found.map((block) => ({ block, top: instance.getTopForLineNumber(block.start) - scroll })))
    }
    const scan = () => {
      const model = instance.getModel()
      found = model && model.getValue().includes('<<<<<<<') ? findConflicts(model.getValue()) : []
      conflictDecorations.current?.set(found.flatMap((b) => {
        const lines = (from: number, to: number, className: string) => (from <= to ? [{ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className } }] : [])
        return [
          ...lines(b.start, b.start, 'conflict-marker'),
          ...lines(b.start + 1, (b.base ?? b.separator) - 1, 'conflict-current'),
          ...lines(b.base ?? b.separator, b.separator, 'conflict-marker'),
          ...lines(b.separator + 1, b.end - 1, 'conflict-incoming'),
          ...lines(b.end, b.end, 'conflict-marker')
        ]
      }))
      place()
    }
    scan()
    const listeners = [instance.onDidChangeModelContent(scan), instance.onDidChangeModel(scan), instance.onDidScrollChange(place), instance.onDidLayoutChange(place)]
    return () => listeners.forEach((l) => l.dispose())
  }, [path])
  const resolve = (block: ConflictBlock, choice: ConflictChoice) => {
    const instance = editor.current
    const model = instance?.getModel()
    if (!instance || !model) return
    const kept = resolvedLines(model.getValue().split(/\r?\n/), block, choice)
    const lastLine = model.getLineCount()
    const range = block.end < lastLine ? new monaco.Range(block.start, 1, block.end + 1, 1) : new monaco.Range(block.start, 1, block.end, model.getLineMaxColumn(block.end))
    const text = kept.length ? kept.join('\n') + (block.end < lastLine ? '\n' : '') : ''
    instance.pushUndoStop()
    instance.executeEdits('anvil.conflict', [{ range, text }])
    instance.pushUndoStop()
    instance.focus()
  }

  return (
    <div className="file-editor" style={{ display: hidden ? 'none' : 'flex' }}>
      {unreadable && <div className="pane-empty">{unreadable}</div>}
      <div className="monaco-host" ref={host} style={{ display: unreadable ? 'none' : undefined }} />
      {conflicts.filter((c) => c.top > -20 && c.top < (host.current?.clientHeight ?? 0)).map(({ block, top }) => (
        <div className="conflict-actions" key={block.start} style={{ top }}>
          <button onClick={() => resolve(block, 'current')}>Keep current</button>
          <button onClick={() => resolve(block, 'incoming')}>Keep incoming</button>
          <button onClick={() => resolve(block, 'both')}>Keep both</button>
        </div>
      ))}
    </div>
  )
}

const IMAGE = /\.(png|jpe?g|gif|webp|ico|bmp|svg)$/i
const MARKDOWN = /\.(md|markdown|mdx)$/i

function ImagePreview({ path, revision, onError }: { path: string; revision: number; onError(e: unknown): void }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    void api.readImage(path).then((data) => { if (!stale) setSrc(data) }).catch(onError)
    return () => { stale = true }
  }, [path, revision, onError])
  return <div className="image-preview">{src && <img src={src} alt={path} />}</div>
}

function MarkdownPreview({ path }: { path: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    let model: monaco.editor.ITextModel | null = null
    let sub: monaco.IDisposable | null = null
    let stale = false
    void store.ensure(path).then((m) => {
      if (stale) return
      model = m
      const render = () => setHtml(DOMPurify.sanitize(marked.parse(m.getValue(), { async: false }) as string))
      render()
      sub = m.onDidChangeContent(render)
    }).catch(() => {})
    return () => { stale = true; sub?.dispose(); void model }
  }, [path])
  // Scripts can't run here because of the page's security policy. Links open in the browser, not in the app.
  return <div className="markdown-preview" onClick={(e) => {
    const link = (e.target as HTMLElement).closest('a')
    if (link) { e.preventDefault(); if (/^https?:/.test(link.href)) window.open(link.href) }
  }} dangerouslySetInnerHTML={{ __html: html }} />
}

export function EditorPane({ path, tabs, change, revision, gitDiff, commitSha, reveal, editorSettings, cursorStyle, stickyScroll, fixLint, themeName, onHistory, onCursor, onSelect, onClose, onCloseOthers, onSplit, onReorder, onError }: {
  path: string | null
  tabs: string[]
  change: FileChange | undefined
  revision: number
  gitDiff: false | 'worktree' | 'staged'
  commitSha: string | null
  reveal: { line: number; at: number } | null
  editorSettings: EditorSettings
  cursorStyle: 'line' | 'block' | 'underline'
  stickyScroll: boolean
  fixLint: boolean
  themeName: string
  onHistory(path: string): void
  onCursor(info: CursorInfo): void
  onSelect(path: string): void
  onClose(path: string): void
  onCloseOthers(path: string, which: 'others' | 'right' | 'all'): void
  onSplit?(path: string): void
  onReorder(from: string, to: string): void
  onError: (e: unknown) => void
}) {
  useSyncExternalStore(store.subscribe, store.version)
  const [preview, setPreview] = useState(false)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  if (!path) {
    return (
      <div className="pane-empty welcome">
        <Logo />
        <p>Pick a file to start.</p>
        <div className="keys"><kbd>{MOD}P</kbd> Open a file <kbd>{SHIFT}{MOD}F</kbd> Search <kbd>{MOD}J</kbd> Terminal <kbd>{MOD},</kbd> Settings</div>
      </div>
    )
  }
  const showReview = !!change && !gitDiff && !commitSha
  return (
    <div className="editor-pane">
      <div className="tabbar">
        {tabs.map((t) => (
          <div key={t} className={`tab ${t === path ? 'active' : ''} ${dragging === t ? 'dragging' : ''}`} title={t} draggable
            onClick={() => onSelect(t)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t) } }}
            onContextMenu={(e) => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, path: t }) }}
            onDragStart={() => setDragging(t)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => { e.preventDefault(); if (dragging && dragging !== t) onReorder(dragging, t) }}>
            {store.dirty(t) && <span className="dirty-dot" title="Not saved yet" />}
            <FileIcon name={t.split('/').pop() ?? t} size={14} />
            <span>{t.split('/').pop()}</span>
            <button className="tab-close" aria-label={`Close ${t}`} onClick={(e) => { e.stopPropagation(); onClose(t) }}><Icon name="close" size={11} /></button>
          </div>
        ))}
      </div>
      <div className="editor-head">
        {tabMenu && (
          <>
            <div className="scrim" onClick={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null) }} />
            <div className="popover context-menu tab-menu" style={{ left: tabMenu.x, top: tabMenu.y }} onClick={() => setTabMenu(null)}>
              <div className="pop-row" role="button" onClick={() => onClose(tabMenu.path)}>Close</div>
              <div className="pop-row" role="button" onClick={() => onCloseOthers(tabMenu.path, 'others')}>Close others</div>
              <div className="pop-row" role="button" onClick={() => onCloseOthers(tabMenu.path, 'right')}>Close to the right</div>
              <div className="pop-row" role="button" onClick={() => onCloseOthers(tabMenu.path, 'all')}>Close all</div>
              {onSplit && <div className="pop-row" role="button" onClick={() => onSplit(tabMenu.path)}>Open to the side</div>}
              <div className="pop-row" role="button" onClick={() => void navigator.clipboard.writeText(tabMenu.path)}>Copy path</div>
              <div className="pop-row" role="button" onClick={() => void api.revealPath(tabMenu.path).catch(onError)}>Reveal in file manager</div>
            </div>
          </>
        )}
        <span className="editor-path">{path}{commitSha ? ` · changes in ${commitSha.slice(0, 7)}` : gitDiff === 'staged' ? ' · staged, compared with the last commit' : gitDiff && ' · not staged yet'}</span>
        {!showReview && MARKDOWN.test(path) && <button className="link" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>}
        {onSplit && <button className="icon-btn split-btn" aria-label="Open to the side" title={`Open to the side (${MOD}\\)`} onClick={() => onSplit(path)}><Icon name="split" size={14} /></button>}
        {!showReview && <button className="link" onClick={() => onHistory(path)}>File history</button>}
        {showReview && change && (
          <span className="editor-actions">
            <span className="counts"><b className="plus">+{change.added}</b> <b className="minus">−{change.removed}</b></span>
            <button className="keep" onClick={() => void api.acceptFile(path).catch(onError)}><Icon name="check" size={13} />Keep file</button>
            <button className="undo" onClick={() => void api.rejectFile(path).catch(onError)}><Icon name="undo" size={13} />Undo file</button>
          </span>
        )}
      </div>
      {commitSha && <DiffView key={`commit:${commitSha}:${path}`} path={path} revision={revision} source="commit" sha={commitSha} onError={onError} />}
      {!commitSha && gitDiff && <DiffView key={`git:${gitDiff}:${path}`} path={path} revision={revision} source="git" gitMode={gitDiff} onError={onError} />}
      {!commitSha && !gitDiff && change && <DiffView key={path} path={path} revision={revision} source="review" onError={onError} />}
      {IMAGE.test(path) && !gitDiff && !commitSha && <ImagePreview path={path} revision={revision} onError={onError} />}
      {preview && MARKDOWN.test(path) && !gitDiff && !commitSha && !change && <MarkdownPreview path={path} />}
      {!IMAGE.test(path) && <FileEditor path={path} revision={revision} reveal={reveal} hidden={!!gitDiff || !!commitSha || !!change || (preview && MARKDOWN.test(path))} editorSettings={editorSettings} cursorStyle={cursorStyle} stickyScroll={stickyScroll} fixLint={fixLint} themeName={themeName} onCursor={onCursor} onError={onError} />}
    </div>
  )
}
