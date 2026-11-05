import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DebugConfig, DebugVariable, ScriptEntry } from '../../shared/types'
import { debug } from './debugStore'
import { Icon } from './Icon'

const api = window.pitoo

function Variable({ item, depth }: { item: DebugVariable; depth: number }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DebugVariable[] | null>(null)
  const toggle = () => {
    if (!item.variablesReference) return
    if (!children) void api.debugVariables(item.variablesReference).then(setChildren).catch(() => setChildren([]))
    setOpen(!open)
  }
  return (
    <>
      <div className="var-row" role={item.variablesReference ? 'button' : undefined} style={{ paddingLeft: 4 + depth * 12 }} title={item.value} onClick={toggle}>
        <span className={`tree-caret ${open ? 'open' : ''}`}>{item.variablesReference > 0 && <Icon name="chevron" size={10} />}</span>
        <span className="var-name">{item.name}</span><span className="var-value">{item.value}</span>
      </div>
      {open && children?.slice(0, 300).map((c) => <Variable key={c.name} item={c} depth={depth + 1} />)}
    </>
  )
}

function Scopes({ frameId }: { frameId: number }) {
  const [scopes, setScopes] = useState<{ name: string; items: DebugVariable[] }[]>([])
  useEffect(() => {
    let stale = false
    void api.debugScopes(frameId).then(async (list) => {
      const shown = list.filter((s) => !s.expensive)
      const filled = await Promise.all(shown.map(async (s) => ({ name: s.name, items: await api.debugVariables(s.variablesReference).catch(() => []) })))
      if (!stale) setScopes(filled)
    }).catch(() => {})
    return () => { stale = true }
  }, [frameId])
  return (
    <>
      {scopes.map((s) => (
        <div key={s.name}>
          <div className="debug-sub">{s.name}</div>
          {s.items.slice(0, 300).map((v) => <Variable key={v.name} item={v} depth={0} />)}
        </div>
      ))}
    </>
  )
}

const WATCH_KEY = 'watches'

function Watches({ frameId, paused }: { frameId: number | null; paused: boolean }) {
  const [list, setListState] = useState<string[]>([])
  const setList = (next: string[]) => { setListState(next); void api.uiSet(WATCH_KEY, next).catch(() => {}) }
  useEffect(() => { void api.uiGet<string[]>(WATCH_KEY).then((saved) => { if (saved) setListState(saved) }).catch(() => {}) }, [])
  const [values, setValues] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState('')
  useEffect(() => {
    if (!paused) return
    let stale = false
    void Promise.all(list.map(async (expression) => [expression, await api.debugEvaluate(expression, frameId, 'watch').then((r) => r.result, (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))] as const)).then((rows) => {
      if (!stale) setValues(Object.fromEntries(rows))
    })
    return () => { stale = true }
  }, [list, frameId, paused])
  return (
    <>
      {list.map((w) => (
        <div key={w} className="var-row watch-row" title={values[w]}>
          <span className="var-name">{w}</span><span className="var-value">{paused ? values[w] : ''}</span>
          <button className="icon-btn" aria-label={`Remove watch ${w}`} onClick={() => setList(list.filter((x) => x !== w))}><Icon name="close" size={11} /></button>
        </div>
      ))}
      <input id="watch-input" className="plain-input debug-input" value={adding} spellCheck={false} placeholder="Add an expression to watch" onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Enter' && adding.trim()) { setList([...list, adding.trim()]); setAdding('') }
      }} />
    </>
  )
}

export function DebugPanel({ activeFile, revision, onOpenAt, onError }: { activeFile: string | null; revision: number; onOpenAt(path: string, line: number): void; onError(e: unknown): void }) {
  useSyncExternalStore(debug.subscribe, debug.version)
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [choice, setChoice] = useState('file')
  const [port, setPort] = useState('9229')
  const [url, setUrl] = useState('http://localhost:4200')
  const [editing, setEditing] = useState<string | null>(null)
  const lastFile = useRef<string | null>(null)
  const [launches, setLaunches] = useState<{ name: string; folder: string; config: Record<string, unknown> }[]>([])
  useEffect(() => { void api.listScripts().then(setScripts).catch(() => {}) }, [revision])
  useEffect(() => { void api.vscodeLaunch(activeFile).then(setLaunches).catch(() => {}) }, [revision, activeFile])
  if (activeFile && /\.(py|pyi|[cm]?[jt]sx?)$/.test(activeFile)) lastFile.current = activeFile
  const file = lastFile.current
  const phase = debug.phase()
  const running = phase !== 'idle'
  const paused = phase === 'paused'
  const frame = debug.frame()
  const threadId = debug.threadId()
  const control = (action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') => void api.debugControl(action, threadId).catch(onError)

  const start = async () => {
    let config: DebugConfig
    const launch = choice.startsWith('launch:') ? launches[Number(choice.slice(7))] : null
    if (launch) config = { kind: 'raw', name: launch.name, raw: launch.config, python: launch.config.type === 'python' ? await api.debugPython() : undefined }
    else if (choice === 'file') {
      if (!file) throw new Error('Open a JavaScript, TypeScript or Python file first.')
      config = /\.pyi?$/.test(file)
        ? { kind: 'python', name: file, file, python: await api.debugPython() }
        : { kind: 'node-file', name: file, file }
    } else if (choice === 'attach') config = { kind: 'node-attach', name: `Attach to port ${port}`, port: Number(port) }
    else if (choice === 'chrome') config = { kind: 'chrome', name: url, url }
    else {
      const script = scripts.find((s) => `npm:${s.dir}:${s.name}` === choice)
      if (!script) throw new Error('Pick something to run.')
      config = { kind: 'npm', name: `npm run ${script.name}`, script: script.name, cwd: script.dir === '.' ? undefined : script.dir }
    }
    await api.debugStart(config, debug.all())
  }

  return (
    <div className="panel-body debug-panel">
      <div className="debug-run">
        <select id="debug-choice" aria-label="What to run" value={choice} disabled={running} onChange={(e) => setChoice(e.target.value)}>
          {launches.map((l, i) => <option key={`${l.folder}:${l.name}`} value={`launch:${i}`}>{l.name}{l.folder === '.' ? '' : ` (${l.folder})`}</option>)}
          <option value="file">{file ? `This file: ${file.split('/').pop()}` : 'This file'}</option>
          {scripts.map((s) => <option key={`${s.dir}:${s.name}`} value={`npm:${s.dir}:${s.name}`}>npm run {s.name}{s.dir === '.' ? '' : ` (${s.dir})`}</option>)}
          <option value="chrome">Open in Chrome</option>
          <option value="attach">Attach to a running Node</option>
        </select>
        {!running
          ? <button className="primary" title="Start debugging (F5)" onClick={() => void start().catch(onError)}><Icon name="play" size={12} />Start</button>
          : <button title="Stop (Shift+F5)" onClick={() => void api.debugStop().catch(onError)}><Icon name="stop" size={12} />Stop</button>}
      </div>
      {choice === 'attach' && !running && <input id="debug-port" className="plain-input" value={port} placeholder="Port" onChange={(e) => setPort(e.target.value)} />}
      {choice === 'chrome' && !running && <input id="debug-url" className="plain-input" value={url} spellCheck={false} placeholder="Address" onChange={(e) => setUrl(e.target.value)} />}
      {running && (
        <div className="debug-toolbar" role="toolbar" aria-label="Debug controls">
          {paused
            ? <button aria-label="Continue" title="Continue (F5)" onClick={() => control('continue')}>Continue</button>
            : <button aria-label="Pause" title="Pause" onClick={() => control('pause')}>Pause</button>}
          <button aria-label="Step over" title="Step over (F10)" disabled={!paused} onClick={() => control('next')}>Over</button>
          <button aria-label="Step into" title="Step into (F11)" disabled={!paused} onClick={() => control('stepIn')}>Into</button>
          <button aria-label="Step out" title="Step out (Shift+F11)" disabled={!paused} onClick={() => control('stepOut')}>Out</button>
        </div>
      )}
      <div className="debug-state">{phase === 'starting' ? 'Starting…' : phase === 'running' ? `Running ${debug.sessionName()}` : paused ? `Paused: ${debug.reason()}` : 'Click beside a line number to add a breakpoint, then press Start.'}</div>
      <div className="debug-scroll">
        {paused && (
          <>
            <div className="git-title">Call stack</div>
            {debug.frames().slice(0, 40).map((f, i) => (
              <div key={f.id} className={`pop-row frame-row ${i === debug.frameIndex() ? 'selected' : ''}`} role="button" onClick={() => debug.selectFrame(i)}>
                <span className="pop-title">{f.name}</span><small>{f.source.split('/').pop()}:{f.line}</small>
              </div>
            ))}
            <div className="git-title">Variables</div>
            {frame && <Scopes key={frame.id} frameId={frame.id} />}
          </>
        )}
        <div className="git-title">Watch</div>
        <Watches frameId={frame?.id ?? null} paused={paused} />
        <div className="git-title">Breakpoints{Object.keys(debug.all()).length > 0 && <button className="link" onClick={() => debug.clear()}>Remove all</button>}</div>
        {Object.entries(debug.all()).flatMap(([path, list]) => list.map((b) => (
          <div key={`${path}:${b.line}`}>
            <div className="pop-row bp-row" role="button" onClick={() => onOpenAt(path, b.line)}>
              <span className="bp-mark" /><span className="pop-title">{path.split('/').pop()}:{b.line}</span>
              {b.condition && <small title={b.condition}>if {b.condition}</small>}
              <span className="git-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" aria-label={`Condition for ${path}:${b.line}`} title="Stop only when…" onClick={() => setEditing(editing === `${path}:${b.line}` ? null : `${path}:${b.line}`)}><Icon name="edit" size={11} /></button>
                <button className="icon-btn" aria-label={`Remove breakpoint ${path}:${b.line}`} onClick={() => debug.toggle(path, b.line)}><Icon name="close" size={11} /></button>
              </span>
            </div>
            {editing === `${path}:${b.line}` && (
              <input className="plain-input debug-input" autoFocus defaultValue={b.condition ?? ''} placeholder="Stop only when, like total > 100" onKeyDown={(e) => {
                if (e.key === 'Enter') { debug.setCondition(path, b.line, e.currentTarget.value); setEditing(null) }
                if (e.key === 'Escape') setEditing(null)
              }} />
            )}
          </div>
        )))}
      </div>
    </div>
  )
}

/** Program output, and a box to evaluate code where the program is paused. */
export function DebugConsole() {
  useSyncExternalStore(debug.subscribe, debug.version)
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const lines = debug.output()
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [lines.length])
  const run = () => {
    const expression = text.trim()
    if (!expression) return
    setText('')
    debug.addOutput('input', `> ${expression}\n`)
    void api.debugEvaluate(expression, debug.frame()?.id ?? null, 'repl').then((r) => debug.addOutput('result', `${r.result}\n`)).catch((e: Error) => debug.addOutput('stderr', `${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\n`))
  }
  return (
    <div className="debug-console">
      <div className="debug-lines">
        {lines.map((l, i) => <span key={i} className={`debug-line-${l.category}`}>{l.text}</span>)}
        <div ref={end} />
      </div>
      <input id="debug-eval" className="debug-eval" value={text} spellCheck={false} placeholder={debug.phase() === 'paused' ? 'Evaluate an expression' : 'Output appears here. Pause to evaluate.'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run() }} />
    </div>
  )
}
