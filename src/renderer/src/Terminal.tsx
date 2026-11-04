import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Icon } from './Icon'

const api = window.anvil
const THEME = { background: '#0c0d10', foreground: '#d8d9e2', cursor: '#a3a6ff', selectionBackground: '#7c7ff544', black: '#16171d', brightBlack: '#6d6f7c' }

function Shell({ id, visible, pending, onSent }: { id: string; visible: boolean; pending: string | null; onSent(): void }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    const created = new XTerm({ fontFamily: "'SF Mono', ui-monospace, Menlo, monospace", fontSize: 12, lineHeight: 1.25, cursorBlink: true, allowProposedApi: false, theme: THEME, scrollback: 5000 })
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

/** `command` is typed into the terminal when another part of the app asks for it. */
export function TerminalPanel({ open, projectKey, command, onCommandDone, onClose, onError }: { open: boolean; projectKey: string; command: string | null; onCommandDone(): void; onClose(): void; onError(e: unknown): void }) {
  const [shells, setShells] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)

  const add = () => void api.terminalCreate().then((id) => { setShells((s) => [...s, id]); setActive(id) }).catch(onError)

  useEffect(() => {
    setShells([])
    setActive(null)
  }, [projectKey])

  useEffect(() => {
    if (open && !shells.length) add()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shells.length])

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
        {shells.map((id, i) => (
          <div key={id} className={`tab ${id === active ? 'active' : ''}`} onClick={() => setActive(id)}>
            <Icon name="terminal" size={12} /><span>Terminal {i + 1}</span>
            <button className="tab-close" aria-label={`Close terminal ${i + 1}`} onClick={(e) => { e.stopPropagation(); remove(id) }}><Icon name="close" size={11} /></button>
          </div>
        ))}
        <button className="icon-btn" aria-label="New terminal" title="New terminal" onClick={add}><Icon name="plus" size={13} /></button>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Hide terminal" title="Hide terminal (⌘J)" onClick={onClose}><Icon name="close" size={13} /></button>
      </div>
      <div className="terminal-body">
        {shells.map((id) => <Shell key={id} id={id} visible={open && id === active} pending={id === active ? command : null} onSent={onCommandDone} />)}
      </div>
    </div>
  )
}
