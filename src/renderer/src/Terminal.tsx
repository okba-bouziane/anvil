import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { IntelDiagnostic } from '../../shared/types'
import { Icon } from './Icon'
import { MOD } from './keys'

const api = window.anvil
const THEMES = {
  dark: { background: '#0c0d10', foreground: '#d8d9e2', cursor: '#a3a6ff', selectionBackground: '#7c7ff544', black: '#16171d', brightBlack: '#6d6f7c' },
  light: { background: '#ffffff', foreground: '#1b1c24', cursor: '#4f52e0', selectionBackground: '#4f52e033', black: '#1b1c24', white: '#e5e5ea', brightWhite: '#7d7f8c' }
}

function Shell({ id, visible, dark, pending, onSent }: { id: string; visible: boolean; dark: boolean; pending: string | null; onSent(): void }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const created = new XTerm({ fontFamily: "'SF Mono', ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace", fontSize: 12, lineHeight: 1.25, cursorBlink: true, allowProposedApi: false, theme: dark ? THEMES.dark : THEMES.light, scrollback: 5000 })
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
    const observer = new ResizeObserver(resize)
    observer.observe(host.current!)
    return () => {
      observer.disconnect()
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

  return <div className="shell" ref={host} style={{ display: visible ? 'block' : 'none' }} />
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

/** `command` is typed into the terminal when another part of the app asks for it. */
export function TerminalPanel({ open, view, setView, projectKey, command, dark, problems, onOpenProblem, onRefreshProblems, onCommandDone, onClose, onError }: {
  open: boolean
  view: 'terminal' | 'problems'
  setView(view: 'terminal' | 'problems'): void
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
    void api.terminalKill(id).catch(onError)
    const next = shells.filter((s) => s !== id)
    setShells(next)
    if (active === id) setActive(next[next.length - 1] ?? null)
    if (!next.length) onClose()
  }

  return (
    <div className="terminal-panel" style={{ display: open ? 'flex' : 'none' }}>
      <div className="terminal-tabs">
        <button className={`view-tab ${view === 'problems' ? 'active' : ''}`} onClick={() => setView('problems')}>Problems{problems.length > 0 && ` ${problems.length}`}</button>
        {shells.map((id, i) => (
          <div key={id} className={`tab ${view === 'terminal' && id === active ? 'active' : ''}`} onClick={() => { setActive(id); setView('terminal') }}>
            <Icon name="terminal" size={12} /><span>Terminal {i + 1}</span>
            <button className="tab-close" aria-label={`Close terminal ${i + 1}`} onClick={(e) => { e.stopPropagation(); remove(id) }}><Icon name="close" size={11} /></button>
          </div>
        ))}
        <button className="icon-btn" aria-label="New terminal" title="New terminal" onClick={add}><Icon name="plus" size={13} /></button>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Hide panel" title={`Hide (${MOD}J)`} onClick={onClose}><Icon name="close" size={13} /></button>
      </div>
      {view === 'problems' && <Problems list={problems} onOpen={onOpenProblem} onRefresh={onRefreshProblems} />}
      <div className="terminal-body" style={{ display: view === 'terminal' ? 'block' : 'none' }}>
        {shells.map((id) => <Shell key={id} id={id} dark={dark} visible={open && view === 'terminal' && id === active} pending={id === active ? command : null} onSent={onCommandDone} />)}
      </div>
    </div>
  )
}
