import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSummary, Checkpoint, FileChange, ModelStatus, ProjectState, ProviderId, Settings, UiItem } from '../../shared/types'
import { PROVIDER_LABEL } from '../../shared/types'
import { Chat } from './Chat'
import { EditorPane } from './Editor'
import { Icon } from './Icon'
import { SettingsModal } from './Settings'
import { Sidebar, type SidebarTab } from './Sidebar'
import { TerminalPanel } from './Terminal'

const api = window.anvil
const STATUS_LABEL: Record<ModelStatus, string> = { online: 'Ready', offline: 'Off', starting: 'Starting…', nokey: 'Needs API key' }

function QuickOpen({ files, onPick, onClose }: { files: string[]; onPick(path: string): void; onClose(): void }) {
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const matches = useMemo(() => {
    const q = query.toLowerCase()
    return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 12)
  }, [query, files])
  return (
    <div className="modal-wrap top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-label="Open a file">
        <input
          id="quick-open"
          autoFocus
          value={query}
          spellCheck={false}
          placeholder="Open a file…"
          onChange={(e) => { setQuery(e.target.value); setAt(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt((at + 1) % Math.max(matches.length, 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setAt((at - 1 + matches.length) % Math.max(matches.length, 1)) }
            if (e.key === 'Enter' && matches[at]) onPick(matches[at])
          }}
        />
        <div className="palette-list">
          {matches.map((f, i) => (
            <div key={f} className={`pop-row ${i === at ? 'selected' : ''}`} onClick={() => onPick(f)}><Icon name="file" size={13} /><span className="pop-title">{f}</span></div>
          ))}
          {!matches.length && <div className="pane-empty small">No matching files.</div>}
        </div>
      </div>
    </div>
  )
}

function Welcome({ recent, onOpen, onRecent }: { recent: string[]; onOpen(): void; onRecent(path: string): void }) {
  return (
    <div className="welcome-screen">
      <div className="mark big" />
      <h1>Anvil</h1>
      <p>A coding assistant that keeps working with no internet.</p>
      <button className="primary large" onClick={onOpen}>Open a project</button>
      {recent.length > 0 && (
        <div className="recent">
          <h4>Recent</h4>
          {recent.map((r) => <button key={r} className="ghost" onClick={() => onRecent(r)}><Icon name="folder" size={13} /><b>{r.split('/').pop()}</b><small>{r}</small></button>)}
        </div>
      )}
    </div>
  )
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<ModelStatus>('offline')
  const [project, setProject] = useState<ProjectState | null>(null)
  const [items, setItems] = useState<UiItem[]>([])
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [activeChat, setActiveChat] = useState('')
  const [changes, setChanges] = useState<FileChange[]>([])
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState({ tokens: 0, tokensPerSecond: 0, waiting: false })
  const [context, setContext] = useState({ tokens: 0, limit: 0 })
  const [selected, setSelected] = useState<string | null>(null)
  const [tabs, setTabs] = useState<string[]>([])
  const [revision, setRevision] = useState(0)
  const [tab, setTab] = useState<SidebarTab>('files')
  const [gitDiff, setGitDiff] = useState(false)
  const [reveal, setReveal] = useState<number | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<ProviderId | null>(null)
  const [quick, setQuick] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [chatWidth, setChatWidth] = useState(440)
  const dragging = useRef(false)

  const onError = useCallback((e: unknown) => setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), [])
  const poll = useCallback(() => void api.modelStatus().then(setStatus), [])

  const openFile = useCallback((path: string) => {
    setSelected(path)
    setGitDiff(false)
    setReveal(null)
    setTabs((t) => (t.includes(path) ? t : [...t, path]))
  }, [])
  const openAt = (path: string, line: number) => {
    openFile(path)
    setReveal(line)
  }
  const openDiff = (path: string) => {
    openFile(path)
    setGitDiff(true)
  }
  const renamed = (from: string, to: string | null) => {
    const match = (t: string) => t === from || t.startsWith(`${from}/`)
    setTabs((list) => list.flatMap((t) => (match(t) ? (to ? [to + t.slice(from.length)] : []) : [t])))
    setSelected((cur) => (cur && match(cur) ? (to ? to + cur.slice(from.length) : null) : cur))
  }
  const closeTab = (path: string) => {
    const next = tabs.filter((t) => t !== path)
    setTabs(next)
    if (selected === path) setSelected(next[next.length - 1] ?? null)
  }

  const showChat = useCallback((state: ProjectState) => {
    setItems(state.items)
    setChats(state.chats)
    setActiveChat(state.activeChat)
    setContext({ tokens: 0, limit: 0 })
  }, [])

  const load = useCallback((state: ProjectState | null) => {
    if (!state) return
    setProject(state)
    setBranch(state.branch)
    setGitDiff(false)
    showChat(state)
    setChanges(state.changes)
    setCheckpoints(state.checkpoints)
    setSelected(null)
    setTabs([])
    setRevision((r) => r + 1)
    void api.listFiles().then(setFiles).catch(onError)
    void api.getSettings().then(setSettings)
    if (state.changes.length) setTab('changes')
  }, [onError, showChat])

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.initialProject().then(load).catch(onError)
    poll()
    const timer = setInterval(poll, 4000)
    const off = api.onEvent((event) => {
      switch (event.type) {
        case 'item':
          setItems((list) => {
            const at = list.findIndex((i) => i.id === event.item.id)
            if (at < 0) return [...list, event.item]
            const next = [...list]
            next[at] = event.item
            return next
          })
          break
        case 'item-update':
          setItems((list) => list.map((i) => (i.id === event.id ? ({ ...i, ...event.patch } as UiItem) : i)))
          break
        case 'text-delta':
          setItems((list) => list.map((i) => {
            if (i.id !== event.id) return i
            if (i.kind === 'assistant') return { ...i, text: i.text + event.delta }
            if (i.kind === 'tool') return { ...i, output: (i.output ?? '') + event.delta }
            return i
          }))
          break
        case 'busy':
          setBusy(event.busy)
          if (!event.busy) void api.listFiles().then(setFiles).catch(() => {})
          break
        case 'changes':
          setChanges(event.changes)
          setCheckpoints(event.checkpoints)
          setRevision((r) => r + 1)
          if (event.changes.length) setTab('changes')
          break
        case 'live-stats':
          setLive({ tokens: event.tokens, tokensPerSecond: event.tokensPerSecond, waiting: event.waiting })
          break
        case 'file-changed':
          openFile(event.path)
          break
        case 'tree':
          setRevision((r) => r + 1)
          void api.listFiles().then(setFiles).catch(() => {})
          break
        case 'context':
          setContext({ tokens: event.tokens, limit: event.limit })
          break
        case 'chats':
          setChats(event.chats)
          setActiveChat(event.activeChat)
          break
      }
    })
    return () => {
      clearInterval(timer)
      off()
    }
  }, [load, onError, openFile, poll])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (e.key === 'j' && project) { e.preventDefault(); setTerminalOpen((o) => !o) }
      if (e.key.toLowerCase() === 'f' && e.shiftKey && project) { e.preventDefault(); setTab('search') }
      if (e.key === 'p' && project) { e.preventDefault(); void api.listFiles().then(setFiles); setQuick(true) }
      if (e.key === ',') { e.preventDefault(); setModal(settings?.provider ?? 'local') }
      if (e.key === 'n' && project && !busy) { e.preventDefault(); void api.newChat().then(showChat).catch(onError) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project, settings, busy, onError, showChat])

  useEffect(() => {
    const move = (e: PointerEvent) => { if (dragging.current) setChatWidth(Math.min(720, Math.max(340, window.innerWidth - e.clientX))) }
    const up = () => { dragging.current = false; document.body.classList.remove('resizing') }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [])

  const clearCommand = useCallback(() => setTerminalCommand(null), [])
  const update = (patch: Partial<Settings>) => void api.setSettings(patch).then((s) => { setSettings(s); poll() }).catch(onError)
  const open = () => void api.openProject().then(load).catch(onError)
  const change = changes.find((c) => c.path === selected)
  const provider = settings?.provider ?? 'local'
  const modelName = settings ? (settings.models[provider] || 'No model').split('/').pop() : ''

  return (
    <div className="app">
      <header className="topbar">
        <div className="mark" />
        <span className="brand">Anvil</span>
        {project && <span className="sep">/</span>}
        {project && <button className="ghost project" title={project.root} onClick={open}>{project.name}</button>}
        {branch && <button className="ghost pill" title="Open Git" onClick={() => setTab('git')}><Icon name="branch" size={12} />{branch}</button>}
        <span className="spacer" />
        <button className={`model ${status}`} title="Change model" onClick={() => setModal(provider)}>
          <span className="dot" />
          <span className="model-provider">{PROVIDER_LABEL[provider]}</span>
          <span className="model-label">{modelName}</span>
          <span className="model-status">{STATUS_LABEL[status]}</span>
        </button>
        {provider === 'local' && status === 'offline' && <button onClick={() => void api.startModel().then(setStatus).catch(onError)}>Start model</button>}
        {provider === 'local' && status === 'online' && <button disabled={busy} onClick={() => void api.stopModel().then(setStatus).catch(onError)}>Stop model</button>}
        {project && <button className={`icon-btn ${terminalOpen ? 'on' : ''}`} aria-label="Terminal" title="Terminal (⌘J)" onClick={() => setTerminalOpen(!terminalOpen)}><Icon name="terminal" /></button>}
        <button className="icon-btn" aria-label="Settings" title="Settings (⌘,)" onClick={() => setModal(provider)}><Icon name="gear" /></button>
      </header>
      {error && <div className="banner" role="alert" onClick={() => setError(null)}><Icon name="warn" size={13} />{error}<span>Dismiss</span></div>}
      {!project
        ? <Welcome recent={settings?.recentProjects ?? []} onOpen={open} onRecent={(r) => void api.openProjectPath(r).then(load).catch(onError)} />
        : (
          <main className="panes" style={{ gridTemplateColumns: `248px minmax(0,1fr) 5px ${chatWidth}px` }}>
            <Sidebar changes={changes} selected={selected} revision={revision} tab={tab} setTab={setTab} onOpen={openFile} onOpenAt={openAt} onDiff={openDiff} onBranch={setBranch} onRenamed={renamed} onError={onError} />
            <div className="center">
              <div className="center-top"><EditorPane path={selected} tabs={tabs} change={change} revision={revision} gitDiff={gitDiff} reveal={reveal} onSelect={(t) => { setSelected(t); setGitDiff(false) }} onClose={closeTab} onError={onError} /></div>
              <TerminalPanel open={terminalOpen} projectKey={project.root} command={terminalCommand} onCommandDone={clearCommand} onClose={() => setTerminalOpen(false)} onError={onError} />
            </div>
            <div className="resizer" onPointerDown={() => { dragging.current = true; document.body.classList.add('resizing') }} />
            <Chat
              items={items} chats={chats} activeChat={activeChat} checkpoints={checkpoints} busy={busy} live={live} context={context} settings={settings}
              hasProject ready={status === 'online'} activeFile={selected} files={files} onOpenFile={openFile} onError={onError}
              onNewChat={() => void api.newChat().then(showChat).catch(onError)}
              onSwitchChat={(id) => void api.switchChat(id).then(showChat).catch(onError)}
              onDeleteChat={(id) => void api.deleteChat(id).then(showChat).catch(onError)}
              onSetting={update}
              onOpenModels={() => setModal(provider)}
            />
          </main>
        )}
      {quick && <QuickOpen files={files} onClose={() => setQuick(false)} onPick={(f) => { openFile(f); setQuick(false) }} />}
      {modal && settings && <SettingsModal settings={settings} initial={modal} onSettings={update} onStatus={poll} onClose={() => setModal(null)} onError={onError} hasProject={!!project} onRunInTerminal={(command) => { setModal(null); setTerminalOpen(true); setTerminalCommand(command) }} />}
    </div>
  )
}
