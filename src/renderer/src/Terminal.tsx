import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { IntelDiagnostic } from '../../shared/types'
import { Icon } from './Icon'
import { MOD } from './keys'
import { findTerminalLinks } from '../../shared/termlinks'
import { DebugConsole } from './DebugPanel'
import { HistoryPanel } from './Panels'

const api = window.pitoo
const THEMES = {
  dark: { background: '#211f1c', foreground: '#e0dacf', cursor: '#d8d2c6', cursorAccent: '#211f1c', selectionBackground: '#fff4e428', black: '#272420', red: '#dc8f7c', green: '#93bd94', yellow: '#dcc08a', blue: '#8fb0c9', magenta: '#bfa3bf', cyan: '#8fbdb4', white: '#cfc8bb', brightBlack: '#827a70', brightRed: '#e8ab9c', brightGreen: '#a9cfa9', brightYellow: '#f2d896', brightBlue: '#a3cbf0', brightMagenta: '#cfbdf0', brightCyan: '#a3dade', brightWhite: '#efe9dd' },
  light: { background: '#faf7f0', foreground: '#2a2520', cursor: '#4a4238', cursorAccent: '#faf7f0', selectionBackground: '#2a252022', black: '#1a2129', red: '#b83a28', green: '#1f7a4d', yellow: '#96590d', blue: '#1f66b0', magenta: '#6a3fb0', cyan: '#1a7a80', white: '#e1e5ea', brightBlack: '#677280', brightRed: '#c9503d', brightGreen: '#2b8f5f', brightYellow: '#a86a1c', brightBlue: '#2f79c4', brightMagenta: '#7d54c2', brightCyan: '#25909a', brightWhite: '#f7f8fa' }
}

function Shell({ id, root, onOpenPath, visible, side, dark, pending, onSent }: { id: string; root: string; onOpenPath(path: string, line: number): void; side: 'left' | 'right' | null; visible: boolean; dark: boolean; pending: string | null; onSent(): void }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const created = new XTerm({ fontFamily: "Menlo, 'JetBrains Mono', ui-monospace, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace", fontSize: 12, lineHeight: 1.25, cursorBlink: true, allowProposedApi: false, theme: dark ? THEMES.dark : THEMES.light, scrollback: 5000 })
    const addon = new FitAddon()
    created.loadAddon(addon)
    created.open(host.current!)
    term.current = created
    fit.current = addon
    const input = created.onData((data) => void api.terminalWrite(id, data))
    const off = api.onTerminal((event) => {
      if (event.id !== id) return
      if (event.type === 'data') created.write(event.data)
      else created.write('\r\n[The shell ended. Close this tab or open a new one.]\r\n')
    })
    const resize = () => {
      if (!host.current?.offsetParent) return
      addon.fit()
      void api.terminalResize(id, created.cols, created.rows)
    }
    // Web addresses and file paths in the output can be clicked, like src/app.ts:12:4 in an error.
    const links = created.registerLinkProvider({
      provideLinks(y, callback) {
        const text = created.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const found: { text: string; range: { start: { x: number; y: number }; end: { x: number; y: number } }; activate(): void }[] = []
        const push = (match: RegExpMatchArray, activate: () => void) => {
          const start = (match.index ?? 0) + 1
          found.push({ text: match[0], range: { start: { x: start, y }, end: { x: start + match[0].length - 1, y } }, activate })
        }
        for (const link of findTerminalLinks(text, root)) {
          const m = Object.assign([link.text], { index: link.start }) as unknown as RegExpMatchArray
          push(m, () => {
            if (link.url) window.open(link.url)
            else void api.readFile(link.path!).then(() => onOpenPath(link.path!, link.line)).catch(() => {})
          })
        }
        callback(found.length ? found : undefined)
      }
    })
    const observer = new ResizeObserver(resize)
    observer.observe(host.current!)
    return () => {
      observer.disconnect()
      links.dispose()
      input.dispose()
      off()
      created.dispose()
    }
  }, [id])

  useEffect(() => {
    if (term.current) term.current.options.theme = dark ? THEMES.dark : THEMES.light
  }, [dark])

  useEffect(() => {
    if (visible) {
      fit.current?.fit()
      term.current?.focus()
    }
  }, [visible])

  useEffect(() => {
    if (visible && pending) {
      void api.terminalWrite(id, `${pending}\r`)
      onSent()
    }
  }, [visible, pending, id, onSent])

  return <div className={`shell ${side ? `side-${side}` : ''}`} ref={host} style={{ display: visible ? 'block' : 'none' }} />
}

function Problems({ list, onOpen, onRefresh }: { list: IntelDiagnostic[]; onOpen(path: string, line: number): void; onRefresh(): void }) {
  return (
    <div className="problems">
      <div className="row-between"><small>{list.length ? 'From open files and the last project check' : 'No problems found so far.'}</small><button className="link" onClick={onRefresh}>Check whole project</button></div>
      {list.map((d, i) => (
        <div key={i} className={`problem ${d.severity}`} onClick={() => onOpen(d.path, d.line)}>
          <Icon name={d.severity === 'error' ? 'bug' : 'warn'} size={13} />
          <span>{d.message.split('\n')[0]}</span>
          <small>{d.path}:{d.line}</small>
        </div>
      ))}
    </div>
  )
}

export type PanelView = 'terminal' | 'problems' | 'history' | 'debug'

/** `command` is typed into the terminal when another part of the app asks for it. */
export function TerminalPanel({ open, view, setView, projectKey, command, dark, problems, revision, historyFile, onClearHistoryFile, onOpenCommitDiff, onOpenProblem, onRefreshProblems, onCommandDone, onClose, onError, onOpenPath, splitSignal }: {
  open: boolean
  view: PanelView
  setView(view: PanelView): void
  revision: number
  historyFile: string | null
  onClearHistoryFile(): void
  onOpenCommitDiff(sha: string, path: string): void
  onOpenPath(path: string, line: number): void
  splitSignal: number
  projectKey: string
  command: string | null
  dark: boolean
  problems: IntelDiagnostic[]
  onOpenProblem(path: string, line: number): void
  onRefreshProblems(): void
  onCommandDone(): void
  onClose(): void
  onError(e: unknown): void
}) {
  const [height, setHeight] = useState(270)
  const drag = useRef<{ y: number; h: number } | null>(null)
  const [split, setSplit] = useState<string | null>(null)
  const addSplit = () => void api.terminalCreate().then((id) => { setShells((s) => [...s, id]); setSplit(id); setView('terminal') }).catch(onError)
  const splitSeen = useRef(splitSignal)
  useEffect(() => {
    if (splitSeen.current === splitSignal) return
    splitSeen.current = splitSignal
    addSplit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitSignal])
  const [shells, setShells] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)

  const add = () => void api.terminalCreate().then((id) => { setShells((s) => [...s, id]); setActive(id); setView('terminal') }).catch(onError)

  useEffect(() => {
    setShells([])
    setActive(null)
  }, [projectKey])

  useEffect(() => {
    if (open && view === 'terminal' && !shells.length) add()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, shells.length])

  const remove = (id: string) => {
    if (split === id) setSplit(null)
    void api.terminalKill(id).catch(onError)
    const next = shells.filter((s) => s !== id)
    setShells(next)
    if (active === id) setActive(next[next.length - 1] ?? null)
    if (!next.length) onClose()
  }

  return (
    <div className={`terminal-panel ${open ? '' : 'closed'}`} style={{ '--panel-h': `${height}px` } as CSSProperties}>
      <div className="panel-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize the bottom panel" title="Drag to resize. Double-click to reset."
        onDoubleClick={() => setHeight(270)}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, h: height }; document.body.classList.add('resizing-y') }}
        onPointerMove={(e) => { if (drag.current) setHeight(Math.max(120, Math.min(window.innerHeight - 180, drag.current.h + drag.current.y - e.clientY))) }}
        onPointerUp={() => { drag.current = null; document.body.classList.remove('resizing-y') }} />
      <div className="terminal-inner">
      <div className="terminal-tabs">
        <button className={`view-tab ${view === 'problems' ? 'active' : ''}`} onClick={() => setView('problems')}>Problems{problems.length > 0 && ` ${problems.length}`}</button>
        <button className={`view-tab ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}>History</button>
        <button className={`view-tab ${view === 'debug' ? 'active' : ''}`} onClick={() => setView('debug')}>Debug console</button>
        {shells.map((id, i) => (
          <div key={id} className={`tab ${view === 'terminal' && id === active ? 'active' : ''}`} onClick={() => { setActive(id); setView('terminal') }}>
            <Icon name="terminal" size={12} /><span>Terminal {i + 1}</span>
            <button className="tab-close" aria-label={`Close terminal ${i + 1}`} onClick={(e) => { e.stopPropagation(); remove(id) }}><Icon name="close" size={11} /></button>
          </div>
        ))}
        <button className="icon-btn" aria-label="Split terminal" title="Split terminal" onClick={addSplit}><Icon name="split" size={13} /></button>
        <button className="icon-btn" aria-label="New terminal" title="New terminal" onClick={add}><Icon name="plus" size={13} /></button>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Hide panel" title={`Hide (${MOD}J)`} onClick={onClose}><Icon name="close" size={13} /></button>
      </div>
      {view === 'problems' && <Problems list={problems} onOpen={onOpenProblem} onRefresh={onRefreshProblems} />}
      {view === 'debug' && <DebugConsole />}
      {view === 'history' && <HistoryPanel revision={revision} file={historyFile} onClearFile={onClearHistoryFile} onOpenDiff={onOpenCommitDiff} onError={onError} />}
      <div className="terminal-body" style={{ display: view === 'terminal' ? 'block' : 'none' }}>
        {shells.map((id) => <Shell key={id} id={id} root={projectKey} onOpenPath={onOpenPath} dark={dark} visible={open && view === 'terminal' && (id === active || id === split)} side={split && (id === active || id === split) ? (id === split ? 'right' : 'left') : null} pending={id === active ? command : null} onSent={onCommandDone} />)}
      </div>
      </div>
    </div>
  )
}
