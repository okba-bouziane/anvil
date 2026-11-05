import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { ChatSummary, Checkpoint, FileChange, ImportedAssets, IntelDiagnostic, ModelStatus, ProjectState, ScriptEntry, Settings, UiItem } from '../../shared/types'
import { DEFAULT_SETTINGS, PROVIDER_LABEL } from '../../shared/types'
import { ChangesBar, Chat } from './Chat'
import { EditorPane, type CursorInfo } from './Editor'
import { FileIcon, Icon, Logo } from './Icon'
import { setFileIconPrefs } from './fileIcons'
import { MOD, modPressed, SHIFT } from './keys'
import { registerLsp } from './lsp'
import { debug } from './debugStore'
import { fixAllLint, registerIntel, registerProjectFormatter, registerSnippets } from './intel'
import { defineImportedTheme, importedThemeName, monaco } from './monaco'
import { store } from './models'
import { SettingsModal, type SettingsTab } from './Settings'
import { Sidebar, type SidebarTab } from './Sidebar'
import { TerminalPanel, type PanelView } from './Terminal'

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
            <div key={f} className={`pop-row ${i === at ? 'selected' : ''}`} onClick={() => onPick(f)}><FileIcon name={f.split('/').pop() ?? f} /><span className="pop-title">{f}</span></div>
          ))}
          {!matches.length && <div className="pane-empty small">No matching files.</div>}
        </div>
      </div>
    </div>
  )
}

function Welcome({ recent, onOpen, onOpenWorkspace, onClone, onRecent }: { recent: string[]; onOpen(): void; onOpenWorkspace(): void; onClone(): void; onRecent(path: string): void }) {
  return (
    <div className="welcome-screen">
      <Logo motion="hop" />
      <h1>Anvil</h1>
      <span className="temper-bar" />
      <p>A code editor that works with the Wi-Fi off.</p>
      <div className="row welcome-actions">
        <button className="primary large" onClick={onOpen}>Open a project</button>
        <button className="large" onClick={onClone}>Clone a repository</button>
        <button className="large" onClick={onOpenWorkspace}>Open a workspace</button>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <h4>Recent</h4>
          {recent.map((r) => <button key={r} className="ghost" onClick={() => onRecent(r)}><Icon name="folder" size={13} /><b>{r.split('/').pop()}</b><small>{r}</small></button>)}
        </div>
      )}
    </div>
  )
}

function NamePrompt({ title, placeholder, initial, onDone, onClose }: { title: string; placeholder: string; initial: string; onDone(value: string): void; onClose(): void }) {
  const [value, setValue] = useState(initial)
  return (
    <div className="modal-wrap top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-label={title}>
        <div className="prompt-title">{title}</div>
        <input id="name-prompt" autoFocus value={value} spellCheck={false} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && value.trim()) { onClose(); onDone(value.trim()) }
        }} />
      </div>
    </div>
  )
}

function Shortcuts({ commands, onClose }: { commands: Command[]; onClose(): void }) {
  const [query, setQuery] = useState('')
  const list = commands.filter((c) => c.keys && `${c.label} ${c.keys}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="modal-wrap top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-label="Keyboard shortcuts">
        <input id="shortcut-search" autoFocus value={query} spellCheck={false} placeholder="Search keyboard shortcuts" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }} />
        <div className="palette-list">
          {list.map((c) => <div key={c.id} className="pop-row"><span className="pop-title">{c.label}</span><kbd>{c.keys}</kbd></div>)}
        </div>
      </div>
    </div>
  )
}

export interface Command {
  id: string
  label: string
  keys?: string
  run(): void
}

/** Every action in one searchable list. */
function CommandPalette({ commands, placeholder, onClose }: { commands: Command[]; placeholder?: string; onClose(): void }) {
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)))
  }, [query, commands])
  const pick = (c: Command | undefined) => {
    if (!c) return
    onClose()
    // After the palette has gone, so the editor has focus again for commands that need it.
    window.setTimeout(c.run, 40)
  }
  return (
    <div className="modal-wrap top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-label="Commands">
        <input id="command-palette" autoFocus value={query} spellCheck={false} placeholder={placeholder ?? 'Type a command…'} onChange={(e) => { setQuery(e.target.value); setAt(0) }} onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((at + 1) % Math.max(matches.length, 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setAt((at - 1 + matches.length) % Math.max(matches.length, 1)) }
          if (e.key === 'Enter') pick(matches[at])
        }} />
        <div className="palette-list">
          {matches.slice(0, 40).map((c, i) => (
            <div key={c.id} className={`pop-row ${i === at ? 'selected' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => pick(c)}>
              <span className="pop-title">{c.label}</span>{c.keys && <kbd>{c.keys}</kbd>}
            </div>
          ))}
          {!matches.length && <div className="pane-empty small">No matching commands.</div>}
        </div>
      </div>
    </div>
  )
}

/** A panel edge you can drag. It follows the pointer directly, and double-clicking it returns the panel to its default size. */
function Splitter({ label, side, value, min, max, onMove, onCommit, onReset }: {
  label: string
  side: 'left' | 'right'
  value: number
  min(): number
  max(): number
  onMove(width: number): void
  onCommit(width: number): void
  onReset(): void
}) {
  const start = useRef({ x: 0, width: 0 })
  const latest = useRef(value)
  const frame = useRef(0)
  const clamp = (width: number) => Math.round(Math.max(min(), Math.min(max(), width)))
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, width: value }
        latest.current = value
        document.body.classList.add('resizing')
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const delta = e.clientX - start.current.x
        latest.current = clamp(start.current.width + (side === 'left' ? delta : -delta))
        cancelAnimationFrame(frame.current)
        frame.current = requestAnimationFrame(() => onMove(latest.current))
      }}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        e.currentTarget.releasePointerCapture(e.pointerId)
        cancelAnimationFrame(frame.current)
        document.body.classList.remove('resizing')
        onMove(latest.current)
        if (latest.current !== value) onCommit(latest.current)
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const grow = (e.key === 'ArrowRight') === (side === 'left')
        const next = clamp(value + (grow ? 16 : -16))
        onMove(next)
        onCommit(next)
      }}
    />
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
  const [gitDiff, setGitDiff] = useState<false | 'worktree' | 'staged'>(false)
  const [reveal, setReveal] = useState<{ line: number; at: number } | null>(null)
  const [panelView, setPanelView] = useState<PanelView>('terminal')
  const [historyFile, setHistoryFile] = useState<string | null>(null)
  const [commitSha, setCommitSha] = useState<string | null>(null)
  const [cursor, setCursor] = useState<CursorInfo | null>(null)
  const [assets, setAssets] = useState<ImportedAssets>({ snippets: [], themes: [] })
  const [newVersion, setNewVersion] = useState<{ version: string; url: string; canInstall: boolean } | null>(null)
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const [updateReady, setUpdateReady] = useState<string | null>(null)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [branch, setBranch] = useState<string | null>(null)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<SettingsTab | null>(null)
  const [quick, setQuick] = useState(false)
  const [palette, setPalette] = useState(false)
  const [prompt, setPrompt] = useState<{ title: string; placeholder: string; initial: string; run(value: string): void } | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [taskPicker, setTaskPicker] = useState<Command[] | null>(null)
  const [zen, setZen] = useState(false)
  const [splitShell, setSplitShell] = useState(0)
  const [splitTabs, setSplitTabs] = useState<string[]>([])
  const [splitSelected, setSplitSelected] = useState<string | null>(null)
  const activeGroup = useRef<1 | 2>(1)
  const closedTabs = useRef<string[]>([])
  const tabsRestored = useRef(false)
  const [tooling, setTooling] = useState<{ eslint: boolean; prettier: boolean; trusted: boolean; dismissed?: boolean } | null>(null)
  const [files, setFiles] = useState<string[]>([])

  const onError = useCallback((e: unknown) => setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), [])
  const poll = useCallback(() => void api.modelStatus().then(setStatus), [])

  const openFile = useCallback((path: string) => {
    setSelected(path)
    setGitDiff(false)
    setCommitSha(null)
    setReveal(null)
    setTabs((t) => (t.includes(path) ? t : [...t, path]))
  }, [])
  const openAt = (path: string, line: number) => {
    openFile(path)
    setReveal({ line, at: Date.now() })
  }
  const askSaveRef = useRef<() => void>(() => {})
  const openAtRef = useRef(openAt)
  openAtRef.current = openAt
  const openHistory = (file: string | null) => {
    setHistoryFile(file)
    setPanelView('history')
    setTerminalOpen(true)
  }
  const openCommitDiff = (sha: string, path: string) => {
    openFile(path)
    setCommitSha(sha)
  }
  const openDiff = (path: string, mode: 'worktree' | 'staged' = 'worktree') => {
    openFile(path)
    setGitDiff(mode)
  }
  const renamed = (from: string, to: string | null) => {
    const match = (t: string) => t === from || t.startsWith(`${from}/`)
    setTabs((list) => list.flatMap((t) => (match(t) ? (to ? [to + t.slice(from.length)] : []) : [t])))
    setSelected((cur) => (cur && match(cur) ? (to ? to + cur.slice(from.length) : null) : cur))
  }
  const closeTab = (path: string) => {
    if (store.dirty(path) && !window.confirm(`Close ${path.split('/').pop()} without saving your changes?`)) return
    if (!splitTabs.includes(path)) store.close(path)
    closedTabs.current.push(path)
    const next = tabs.filter((t) => t !== path)
    setTabs(next)
    if (selected === path) setSelected(next[next.length - 1] ?? null)
  }
  const closeSplitTab = (path: string) => {
    if (!tabs.includes(path)) {
      if (store.dirty(path) && !window.confirm(`Close ${path.split('/').pop()} without saving your changes?`)) return
      store.close(path)
    }
    const next = splitTabs.filter((t) => t !== path)
    setSplitTabs(next)
    if (splitSelected === path) setSplitSelected(next[next.length - 1] ?? null)
    if (!next.length) activeGroup.current = 1
  }
  const closeMany = (list: string[], at: string, which: 'others' | 'right' | 'all', close: (p: string) => void) => {
    const targets = which === 'all' ? list : which === 'others' ? list.filter((t) => t !== at) : list.slice(list.indexOf(at) + 1)
    targets.forEach(close)
  }
  const reorder = (list: string[], from: string, to: string) => {
    const next = list.filter((t) => t !== from)
    next.splice(next.indexOf(to) + (list.indexOf(from) < list.indexOf(to) ? 1 : 0), 0, from)
    return next
  }
  const openSplit = (path: string) => {
    setSplitTabs((t) => (t.includes(path) ? t : [...t, path]))
    setSplitSelected(path)
    activeGroup.current = 2
  }
  // Files you choose open in whichever side you last worked in.
  const pickFile = (path: string) => {
    if (activeGroup.current === 2 && splitSelected) openSplit(path)
    else openFile(path)
  }

  const showChat = useCallback((state: ProjectState) => {
    setItems(state.items)
    setChats(state.chats)
    setActiveChat(state.activeChat)
    setContext({ tokens: 0, limit: 0 })
  }, [])

  const load = useCallback((state: ProjectState | null) => {
    if (!state) return
    store.reset()
    setProject(state)
    setBranch(state.branch)
    setGitDiff(false)
    showChat(state)
    setChanges(state.changes)
    setCheckpoints(state.checkpoints)
    // The tabs you had open come back, as they do in VS Code. Files that are gone are dropped.
    setSelected(null)
    setTabs([])
    tabsRestored.current = false
    void api.uiGet<{ tabs?: string[]; selected?: string | null }>(`tabs:${state.workspaceFile ?? state.root}`).then(async (remembered) => {
      const found = await Promise.all((remembered?.tabs ?? []).map((t) => api.readFile(t).then(() => t, () => null)))
      const list = found.filter((t): t is string => !!t)
      setTabs((open) => [...new Set([...list, ...open])])
      setSelected((current) => current ?? (remembered?.selected && list.includes(remembered.selected) ? remembered.selected : list[list.length - 1] ?? null))
    }).finally(() => { tabsRestored.current = true })
    setRevision((r) => r + 1)
    void api.listFiles().then(setFiles).catch(onError)
    void api.getSettings().then(setSettings)
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
          break
        case 'live-stats':
          setLive({ tokens: event.tokens, tokensPerSecond: event.tokensPerSecond, waiting: event.waiting })
          break
        case 'file-changed':
          openFile(event.path)
          break
        case 'update':
          setNewVersion({ version: event.version, url: event.url, canInstall: event.canInstall })
          break
        case 'debug':
          if (event.event.kind === 'state' && event.event.state === 'starting') { setPanelView('debug'); setTerminalOpen(true) }
          debug.handle(event.event)
          break
        case 'menu':
          if (event.id.startsWith('editor:')) void store.runAction(event.id.slice(7))
          else if (event.id.startsWith('recent:')) void api.openProjectPath(event.id.slice(7)).then(load).catch(onError)
          else commandsRef.current.find((c) => c.id === event.id)?.run()
          break
        case 'lsp-diagnostics':
          store.setLspDiagnostics(event.path, event.diagnostics)
          break
        case 'update-progress':
          setUpdateProgress(event.percent)
          break
        case 'update-ready':
          setUpdateProgress(null)
          setUpdateReady(event.label)
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

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const closeRef = useRef(closeTab)
  closeRef.current = closeTab

  const loadAssets = useCallback(() => {
    void api.importedAssets().then((a) => {
      a.themes.forEach(defineImportedTheme)
      registerSnippets(a.snippets)
      setAssets(a)
    }).catch(() => {})
    void api.getSettings().then(setSettings).catch(() => {})
  }, [])

  useEffect(() => {
    registerIntel(openAt)
    registerLsp()
    debug.onReveal((path, line) => openAtRef.current(path, line))
    loadAssets()
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    media.addEventListener('change', onChange)
    // With auto-save on, a last edit just gets saved. Only with it off is there anything to ask about.
    const warnUnsaved = (e: BeforeUnloadEvent) => {
      if (!store.anyDirty()) return
      if (settingsRef.current?.editor.autoSave) void store.saveAll()
      else e.preventDefault()
    }
    window.addEventListener('beforeunload', warnUnsaved)
    return () => {
      media.removeEventListener('change', onChange)
      window.removeEventListener('beforeunload', warnUnsaved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dark = (settings?.theme ?? 'system') === 'system' ? systemDark : settings?.theme === 'dark'
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  useEffect(() => { if (settings) store.configure({ autoSave: settings.editor.autoSave, onError }) }, [settings, onError])
  useSyncExternalStore(store.subscribe, store.version)
  const problems: IntelDiagnostic[] = store.problems()
  const errorCount = problems.filter((d) => d.severity === 'error').length
  const warningCount = problems.length - errorCount
  const refreshProblems = () => {
    const target = selected && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(selected) ? selected : files.find((f) => /\.(ts|tsx)$/.test(f))
    if (target) void api.intel<IntelDiagnostic[]>('projectProblems', target).then(store.setProjectProblems).catch(onError)
  }
  const openProblems = () => { setPanelView('problems'); setTerminalOpen(true); refreshProblems() }
  const runScript = (script: ScriptEntry) => {
    const win = api.platform === 'win32'
    const root = project?.root ?? '.'
    const dir = script.dir === '.' ? root : `${root}/${script.dir}`
    setPanelView('terminal')
    setTerminalOpen(true)
    setTerminalCommand(`cd "${dir}"${win ? ';' : ' &&'} npm run ${script.name}`)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || e.key === 'F10' || e.key === 'F11') {
        e.preventDefault()
        const paused = debug.phase() === 'paused'
        const thread = debug.threadId()
        if (e.key === 'F5' && e.shiftKey) void api.debugStop().catch(onError)
        else if (e.key === 'F5' && paused) void api.debugControl('continue', thread).catch(onError)
        else if (e.key === 'F5' && debug.phase() === 'idle') setTab('debug')
        else if (e.key === 'F10' && paused) void api.debugControl('next', thread).catch(onError)
        else if (e.key === 'F11' && paused) void api.debugControl(e.shiftKey ? 'stepOut' : 'stepIn', thread).catch(onError)
        return
      }
      if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); commandsRef.current.find((c) => c.id === (e.shiftKey ? 'prev' : 'next'))?.run(); return }
      if (!modPressed(e)) return
      if (e.key === 'l' && project) { e.preventDefault(); void api.setSettings({ showAgent: !settingsRef.current?.showAgent }).then(setSettings) }
      if (e.key === 'w' && project) { e.preventDefault(); commandsRef.current.find((c) => c.id === 'close')?.run() }
      if (e.key === 'j' && project) { e.preventDefault(); setTerminalOpen((o) => !o) }
      if (e.key.toLowerCase() === 'p' && e.shiftKey) { e.preventDefault(); setPalette(true); return }
      if (e.key === 'o' && !e.shiftKey && project) { e.preventDefault(); commandsRef.current.find((c) => c.id === 'open-file-dialog')?.run(); return }
      if (e.key.toLowerCase() === 's' && e.shiftKey && project) { e.preventDefault(); askSaveRef.current(); return }
      if (e.key.toLowerCase() === 'x' && e.shiftKey && project) { e.preventDefault(); setTab('extensions'); return }
      if (e.key === 'b' && project) { e.preventDefault(); commandsRef.current.find((c) => c.id === 'side')?.run() }
      if (e.key === '\\' && project) { e.preventDefault(); commandsRef.current.find((c) => c.id === 'split')?.run() }
      if (e.key.toLowerCase() === 't' && e.shiftKey && project) { e.preventDefault(); commandsRef.current.find((c) => c.id === 'reopen')?.run() }
      if (e.key.toLowerCase() === 'f' && e.shiftKey && project) { e.preventDefault(); setTab('search') }
      if (e.key === 'p' && project) { e.preventDefault(); void api.listFiles().then(setFiles); setQuick(true) }
      if (e.key === ',') { e.preventDefault(); setModal(settings?.provider ?? 'local') }
      if (e.key.toLowerCase() === 'n' && e.shiftKey) { e.preventDefault(); void api.newWindow().catch(onError); return }
      if (e.key === 'n' && project && !busy) { e.preventDefault(); void api.newChat().then(showChat).catch(onError) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project, settings, busy, onError, showChat])

  const clearCommand = useCallback(() => setTerminalCommand(null), [])
  // Shown straight away, so switches and number boxes respond without waiting for the save.
  const update = (patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    void api.setSettings(patch).then(poll).catch(onError)
  }
  const open = () => void api.openProject().then(load).catch(onError)
  const change = changes.find((c) => c.path === selected)
  const provider = settings?.provider ?? 'local'
  const showAgent = settings?.showAgent ?? true
  const sideWidth = settings?.sideWidth ?? DEFAULT_SETTINGS.sideWidth
  const chatWidth = settings?.chatWidth ?? DEFAULT_SETTINGS.chatWidth
  const panes = useRef<HTMLElement>(null)
  const centerTop = useRef<HTMLDivElement>(null)
  const [splitWidth, setSplitWidth] = useState(520)
  const sideHidden = settings?.showSide === false || zen
  const editorSettings = useMemo(() => ({ ...(settings?.editor ?? DEFAULT_SETTINGS.editor), ...project?.vscodeEditor }), [settings?.editor, project?.vscodeEditor])
  const setVar = (name: string, px: number) => panes.current?.style.setProperty(name, `${px}px`)
  // Only changes that come from a button or a double-click glide. While dragging, the panel follows the pointer exactly.
  const glide = useCallback(() => {
    panes.current?.classList.add('settling')
    window.setTimeout(() => panes.current?.classList.remove('settling'), 260)
  }, [])
  const [agentMounted, setAgentMounted] = useState(showAgent)
  const agentWas = useRef(showAgent)
  useEffect(() => {
    if (agentWas.current === showAgent) return
    agentWas.current = showAgent
    glide()
    if (showAgent) return setAgentMounted(true)
    const timer = window.setTimeout(() => setAgentMounted(false), 260)
    return () => window.clearTimeout(timer)
  }, [showAgent, glide])
  const importedTheme = assets.themes.find((t) => t.id === settings?.editorTheme)
  const themeName = importedTheme ? importedThemeName(importedTheme.id) : dark ? 'anvil' : 'anvil-light'
  setFileIconPrefs(settings?.fileIcons !== false, !dark)
  const darkWas = useRef(dark)
  useEffect(() => {
    if (darkWas.current === dark) return
    darkWas.current = dark
    document.documentElement.classList.add('theming')
    const timer = window.setTimeout(() => document.documentElement.classList.remove('theming'), 280)
    return () => window.clearTimeout(timer)
  }, [dark])
  const modelName = settings ? (settings.models[provider] || 'No model').split('/').pop() : ''

  const projectRoot = project?.root ?? null
  const tabsKey = project ? `tabs:${project.workspaceFile ?? project.root}` : null
  useEffect(() => {
    if (tabsKey && tabsRestored.current) void api.uiSet(tabsKey, { tabs, selected }).catch(() => {})
  }, [tabsKey, tabs, selected])
  useEffect(() => {
    if (!projectRoot) return
    let stale = false
    void api.toolingStatus().then((status) => {
      if (stale) return
      setTooling(status)
      store.setTooling(status.trusted)
      registerProjectFormatter(status.trusted && status.prettier)
    }).catch(() => {})
    if (projectRoot) debug.useProject(projectRoot)
    void api.lspStatus().then((status) => { if (!stale) store.setAngular(status.angular) }).catch(() => {})
    return () => { stale = true }
  }, [project, projectRoot])
  const allowTooling = () => {
    void api.toolingTrust().then(() => {
      setTooling((t) => (t ? { ...t, trusted: true } : t))
      store.setTooling(true)
      registerProjectFormatter(!!tooling?.prettier)
    }).catch(onError)
  }

  const askClone = () => setPrompt({ title: 'Clone a repository', placeholder: 'https://github.com/you/project.git', initial: '', run: (url) => void api.gitClone(url).then(load).catch(onError) })
  const askNewFile = () => setPrompt({ title: 'New file', placeholder: 'src/name.ts', initial: selected?.includes('/') ? `${selected.slice(0, selected.lastIndexOf('/'))}/` : '', run: (name) => void api.createPath(name, false).then(() => pickFile(name)).catch(onError) })
  const askSaveAs = () => {
    if (!selected) return
    setPrompt({ title: 'Save as', placeholder: 'src/name.ts', initial: selected, run: (name) => void store.saveAs(selected, name).then(() => pickFile(name)).catch(onError) })
  }
  const runTasks = () => void api.vscodeTasks().then((tasks) => {
    const root = project?.root ?? '.'
    const runCommand = (cwd: string, command: string) => {
      setPanelView('terminal')
      setTerminalOpen(true)
      setTerminalCommand(`cd "${cwd === '.' ? root : `${root}/${cwd}`}" ${api.platform === 'win32' ? ';' : '&&'} ${command}`)
    }
    const fromVscode = tasks.map((t) => ({ id: `task:${t.cwd}:${t.label}`, label: `${t.label}  (.vscode/tasks.json)`, run: () => runCommand(t.cwd, t.command) }))
    void api.listScripts().then((scripts) => {
      setTaskPicker([...fromVscode, ...scripts.map((sc) => ({ id: `npm:${sc.dir}:${sc.name}`, label: `npm run ${sc.name}${sc.dir === '.' ? '' : `  (${sc.dir})`}`, run: () => runScript(sc) }))])
    }).catch(onError)
  }).catch(onError)

  const gitAction = (name: string, ...args: unknown[]) => void api.gitOp(name, ...args).catch(onError)
  const commands: Command[] = [
    { id: 'open-file', label: 'Go to file', keys: `${MOD}P`, run: () => { void api.listFiles().then(setFiles); setQuick(true) } },
    { id: 'open-folder', label: 'Open a project', run: open },
    { id: 'new-window', label: 'Open a project in a new window', keys: `${SHIFT}${MOD}N`, run: () => void api.newWindow().catch(onError) },
    { id: 'install-command', label: 'Install the anvil terminal command', run: () => void api.installCommand().then((m) => window.alert(m)).catch(onError) },
    { id: 'new-file', label: 'New file', keys: `${MOD}⌥N`, run: askNewFile },
    { id: 'new-window-empty', label: 'New window', keys: `${SHIFT}${MOD}N`, run: () => void api.newWindow().catch(onError) },
    { id: 'open-file-dialog', label: 'Open a file', keys: `${MOD}O`, run: () => void api.openFileDialog().then((f) => { if (f) pickFile(f) }).catch(onError) },
    { id: 'open-workspace', label: 'Workspaces: open a workspace', run: () => void api.workspaceOpen().then(load).catch(onError) },
    { id: 'add-folder', label: 'Workspaces: add a folder', run: () => void api.workspaceAddFolder().then(load).catch(onError) },
    { id: 'save-workspace', label: 'Workspaces: save as a file', run: () => void api.workspaceSave().then(load).catch(onError) },
    { id: 'clone', label: 'Git: clone a repository', run: askClone },
    { id: 'save', label: 'Save', keys: `${MOD}S`, run: () => { if (selected) void store.save(selected).catch(onError) } },
    { id: 'save-as', label: 'Save as', keys: `${SHIFT}${MOD}S`, run: askSaveAs },
    { id: 'revert', label: 'Revert this file to what is on disk', run: () => { if (selected) void store.revert(selected).catch(onError) } },
    { id: 'toggle-auto-save', label: 'Turn auto-save on or off', run: () => settings && update({ editor: { ...settings.editor, autoSave: !settings.editor.autoSave } }) },
    { id: 'word-wrap', label: 'Turn word wrap on or off', keys: '⌥Z', run: () => settings && update({ editor: { ...settings.editor, wordWrap: !settings.editor.wordWrap } }) },
    { id: 'minimap', label: 'Turn the minimap on or off', run: () => settings && update({ editor: { ...settings.editor, minimap: !settings.editor.minimap } }) },
    { id: 'zen', label: 'Zen mode: only the code', run: () => { glide(); setZen(!zen) } },
    { id: 'shortcuts', label: 'Keyboard shortcuts', run: () => setShowShortcuts(true) },
    { id: 'tasks', label: 'Run a task', run: runTasks },
    { id: 'split-terminal', label: 'Split the terminal', run: () => { setPanelView('terminal'); setTerminalOpen(true); setSplitShell((n) => n + 1) } },
    { id: 'files', label: 'Show files', run: () => setTab('files') },
    { id: 'close-folder', label: 'Close this project', run: () => void api.closeProject().then(() => { store.reset(); setProject(null); setTabs([]); setSelected(null); setSplitTabs([]); setSplitSelected(null) }).catch(onError) },
    { id: 'check-update', label: 'Check for updates', run: () => void api.checkUpdate().then(({ latest }) => { if (!latest) window.alert('You have the latest version.') }).catch(onError) },
    { id: 'palette', label: 'Show all commands', keys: `${SHIFT}${MOD}P`, run: () => setPalette(true) },
    { id: 'symbol', label: 'Go to a symbol in this file', keys: `${SHIFT}${MOD}O`, run: () => void store.runAction('editor.action.quickOutline') },
    { id: 'line', label: 'Go to a line', keys: 'Ctrl G', run: () => void store.runAction('editor.action.gotoLine') },
    { id: 'editor-commands', label: 'All editor commands', keys: 'F1', run: () => void store.runAction('editor.action.quickCommand') },
    ...(settings?.recentProjects ?? []).map((r) => ({ id: `recent:${r}`, label: `Open recent: ${r.split('/').pop()?.replace('.code-workspace', '')}`, run: () => void api.openProjectPath(r).then(load).catch(onError) })),
    { id: 'side', label: 'Show or hide the side panel', keys: `${MOD}B`, run: () => { glide(); update({ showSide: sideHidden }) } },
    { id: 'terminal', label: 'Show or hide the terminal', keys: `${MOD}J`, run: () => setTerminalOpen((o) => !o) },
    { id: 'new-terminal', label: 'New terminal', run: () => { setPanelView('terminal'); setTerminalOpen(true) } },
    { id: 'agent', label: 'Show or hide the agent', keys: `${MOD}L`, run: () => update({ showAgent: !showAgent }) },
    { id: 'split', label: 'Open this file to the side', keys: `${MOD}\\`, run: () => { if (selected) openSplit(selected) } },
    { id: 'close', label: 'Close this tab', keys: `${MOD}W`, run: () => { if (activeGroup.current === 2 && splitSelected) closeSplitTab(splitSelected); else if (selected) closeTab(selected) } },
    { id: 'close-all', label: 'Close all tabs', run: () => tabs.forEach(closeTab) },
    { id: 'reopen', label: 'Reopen the last closed tab', keys: `${SHIFT}${MOD}T`, run: () => { const last = closedTabs.current.pop(); if (last) openFile(last) } },
    { id: 'next', label: 'Next tab', keys: 'Ctrl Tab', run: () => { if (selected && tabs.length) openFile(tabs[(tabs.indexOf(selected) + 1) % tabs.length]) } },
    { id: 'prev', label: 'Previous tab', keys: `${SHIFT}Ctrl Tab`, run: () => { if (selected && tabs.length) openFile(tabs[(tabs.indexOf(selected) - 1 + tabs.length) % tabs.length]) } },
    { id: 'save-all', label: 'Save all', run: () => void store.saveAll().catch(onError) },
    { id: 'search', label: 'Search in project', keys: `${SHIFT}${MOD}F`, run: () => setTab('search') },
    { id: 'problems', label: 'Show problems', run: openProblems },
    { id: 'debug', label: 'Debug: open the panel', keys: 'F5', run: () => setTab('debug') },
    { id: 'debug-console', label: 'Debug: show the console', run: () => { setPanelView('debug'); setTerminalOpen(true) } },
    { id: 'history', label: 'Git: commit history', run: () => openHistory(null) },
    { id: 'extensions', label: 'Extensions', keys: `${SHIFT}${MOD}X`, run: () => setTab('extensions') },
    { id: 'git-panel', label: 'Git: open the panel', run: () => setTab('git') },
    { id: 'git-fetch', label: 'Git: fetch', run: () => gitAction('fetch') },
    { id: 'git-pull', label: 'Git: pull', run: () => void api.gitSync('pull').catch(onError) },
    { id: 'git-pull-rebase', label: 'Git: pull with rebase', run: () => gitAction('pullRebase') },
    { id: 'git-push', label: 'Git: push', run: () => gitAction('push') },
    { id: 'git-stash', label: 'Git: stash changes', run: () => gitAction('stashPush', '') },
    { id: 'eslint-fix', label: 'ESLint: fix all problems in this file', run: () => { const model = monaco.editor.getModels().find((m) => m.uri.path.endsWith(`/${selected}`)); if (model) void fixAllLint(model) } },
    { id: 'format', label: 'Format this file', run: () => void store.formatActive() },
    { id: 'theme', label: 'Switch between light and dark', run: () => update({ theme: dark ? 'light' : 'dark' }) },
    { id: 'settings', label: 'Settings', keys: `${MOD},`, run: () => setModal('editor') },
    { id: 'models', label: 'Models and API keys', run: () => setModal(provider) },
    { id: 'new-chat', label: 'New chat', keys: `${MOD}N`, run: () => void api.newChat().then(showChat).catch(onError) }
  ]
  askSaveRef.current = askSaveAs
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  return (
    <div className={`app platform-${api.platform} ${zen ? 'zen' : ''}`} onKeyDown={(e) => { if (e.key === 'Escape' && zen) setZen(false) }}>
      <header className="topbar">
        <Logo motion={busy ? 'working' : undefined} />
        <span className="brand">Anvil</span>
        {project && <span className="sep">/</span>}
        {project && <button className="ghost project" title={project.folders ? project.folders.join(', ') : project.root} onClick={open}>{project.name}</button>}
        {branch && <button className="ghost pill" title="Open Git" onClick={() => setTab('git')}><Icon name="branch" size={12} />{branch}</button>}
        <span className="spacer" />
        {project && <button className={`icon-btn ${showAgent ? 'on' : ''}`} aria-label="Agent panel" title={`${showAgent ? 'Hide' : 'Show'} the agent (${MOD}L)`} onClick={() => update({ showAgent: !showAgent })}><Icon name="sparkle" /></button>}
        {showAgent && <button className={`model ${status}`} title="Change model" onClick={() => setModal(provider)}>
          <span className="dot" />
          <span className="model-provider">{PROVIDER_LABEL[provider]}</span>
          <span className="model-label">{modelName}</span>
          <span className="model-status">{STATUS_LABEL[status]}</span>
        </button>}
        {showAgent && provider === 'local' && status === 'offline' && api.platform === 'darwin' && <button onClick={() => void api.startModel().then(setStatus).catch(onError)}>Start model</button>}
        {showAgent && provider === 'local' && status === 'online' && <button disabled={busy} onClick={() => void api.stopModel().then(setStatus).catch(onError)}>Stop model</button>}
        {project && <button className={`icon-btn ${terminalOpen ? 'on' : ''}`} aria-label="Terminal" title={`Terminal (${MOD}J)`} onClick={() => setTerminalOpen(!terminalOpen)}><Icon name="terminal" /></button>}
        {newVersion && (updateReady
          ? <button className="primary update-btn" onClick={() => void api.applyUpdate().catch(onError)}>{updateReady}</button>
          : updateProgress !== null
            ? <button className="update-btn downloading" disabled style={{ '--p': `${updateProgress}%` } as CSSProperties}>Downloading {updateProgress}%</button>
            : <button className="primary update-btn" title={`Anvil ${newVersion.version} is available`} onClick={() => {
                if (!newVersion.canInstall) return void api.openRelease(newVersion.url)
                setUpdateProgress(0)
                void api.downloadUpdate().catch((e) => { setUpdateProgress(null); onError(e) })
              }}>Update to {newVersion.version.replace(/^v/, '')}</button>)}
        <button className="icon-btn" aria-label="Settings" title={`Settings (${MOD},)`} onClick={() => setModal(provider)}><Icon name="gear" /></button>
      </header>
      {project && tooling && (tooling.eslint || tooling.prettier) && !tooling.trusted && !tooling.dismissed && (
        <div className="banner notice" role="status">
          This project uses {[tooling.eslint && 'ESLint', tooling.prettier && 'Prettier'].filter(Boolean).join(' and ')}. Running them also runs code from the project's own config.
          <button className="primary" onClick={allowTooling}>Allow for this project</button>
          <button onClick={() => setTooling({ ...tooling, dismissed: true })}>Not now</button>
        </div>
      )}
      {error && <div className="banner" role="alert" onClick={() => setError(null)}><Icon name="warn" size={13} />{error}<span>Dismiss</span></div>}
      {!project
        ? <Welcome recent={settings?.recentProjects ?? []} onOpen={open} onOpenWorkspace={() => void api.workspaceOpen().then(load).catch(onError)} onClone={askClone} onRecent={(r) => void api.openProjectPath(r).then(load).catch(onError)} />
        : (
          <main ref={panes} className="panes" style={{ '--side-w': sideHidden ? '0px' : `${sideWidth}px`, '--chat-w': `${chatWidth}px`, '--chat-track': showAgent && !zen ? `${chatWidth}px` : '0px', '--chat-gap': showAgent && !zen ? '1px' : '0px' } as CSSProperties}>
            <Sidebar changes={changes} folders={project.folders} repos={project.repos} activeRepo={project.activeRepo} onRemoveFolder={(f) => void api.workspaceRemoveFolder(f).then(load).catch(onError)} onSelectRepo={(r) => void api.gitSelectRepo(r).then(() => { setProject((pr) => (pr ? { ...pr, activeRepo: r } : pr)) }).catch(onError)} assets={assets} settings={settings} onAssets={loadAssets} onSettings={update} selected={selected} revision={revision} tab={tab} setTab={setTab} onOpen={pickFile} onOpenAt={openAt} onDiff={openDiff} onBranch={setBranch} onRenamed={renamed} onRunScript={runScript} onBeforeReplace={store.saveAll} onHistory={() => openHistory(null)} onError={onError} />
            <Splitter
              label="Resize the side panel"
              side="left"
              value={sideWidth}
              min={() => 170}
              max={() => Math.min(560, window.innerWidth - (showAgent ? chatWidth : 0) - 360)}
              onMove={(w) => setVar('--side-w', w)}
              onCommit={(w) => update({ sideWidth: w })}
              onReset={() => { glide(); update({ sideWidth: DEFAULT_SETTINGS.sideWidth }) }}
            />
            <div className="center">
              <div className="center-top" ref={centerTop} style={{ '--split-w': `${splitWidth}px` } as CSSProperties}>
                <div className="editor-group" onMouseDownCapture={() => { activeGroup.current = 1 }} onFocusCapture={() => { activeGroup.current = 1 }}>
                  <EditorPane path={selected} tabs={tabs} change={change} revision={revision} gitDiff={gitDiff} commitSha={commitSha} onHistory={openHistory} reveal={reveal} editorSettings={editorSettings} themeName={themeName} onCursor={setCursor} onSelect={(t) => { setSelected(t); setGitDiff(false); setCommitSha(null) }} onClose={closeTab} onError={onError} cursorStyle={settings?.cursorStyle ?? 'line'} stickyScroll={settings?.stickyScroll !== false} fixLint={!!settings?.fixOnSave} onCloseOthers={(at, which) => closeMany(tabs, at, which, closeTab)} onSplit={openSplit} onReorder={(from, to) => setTabs((t) => reorder(t, from, to))} />
                </div>
                {splitSelected && (
                  <>
                    <Splitter label="Resize the side-by-side editor" side="right" value={splitWidth} min={() => 260} max={() => (centerTop.current?.clientWidth ?? 1000) - 260}
                      onMove={(w) => centerTop.current?.style.setProperty('--split-w', `${w}px`)} onCommit={setSplitWidth}
                      onReset={() => { const half = Math.round((centerTop.current?.clientWidth ?? 800) / 2); setSplitWidth(half) }} />
                    <div className="editor-group second" onMouseDownCapture={() => { activeGroup.current = 2 }} onFocusCapture={() => { activeGroup.current = 2 }}>
                      <EditorPane path={splitSelected} tabs={splitTabs} change={undefined} revision={revision} gitDiff={false} commitSha={null} reveal={null} editorSettings={editorSettings} cursorStyle={settings?.cursorStyle ?? 'line'} stickyScroll={settings?.stickyScroll !== false} fixLint={!!settings?.fixOnSave} themeName={themeName} onHistory={openHistory} onCursor={setCursor} onSelect={setSplitSelected} onClose={closeSplitTab} onCloseOthers={(at, which) => closeMany(splitTabs, at, which, closeSplitTab)} onReorder={(from, to) => setSplitTabs((t) => reorder(t, from, to))} onError={onError} />
                    </div>
                  </>
                )}
              </div>
              <TerminalPanel open={terminalOpen} splitSignal={splitShell} onOpenPath={openAt} view={panelView} setView={setPanelView} projectKey={project.root} command={terminalCommand} dark={dark} problems={problems} revision={revision} historyFile={historyFile} onClearHistoryFile={() => setHistoryFile(null)} onOpenCommitDiff={openCommitDiff} onOpenProblem={openAt} onRefreshProblems={refreshProblems} onCommandDone={clearCommand} onClose={() => setTerminalOpen(false)} onError={onError} />
              {!showAgent && changes.length > 0 && <div className="changes-dock"><ChangesBar changes={changes} selected={selected} onOpen={openFile} onError={onError} /></div>}
            </div>
            <Splitter
              label="Resize the agent panel"
              side="right"
              value={chatWidth}
              min={() => 340}
              max={() => Math.min(720, window.innerWidth - sideWidth - 360)}
              onMove={(w) => { setVar('--chat-w', w); setVar('--chat-track', w) }}
              onCommit={(w) => update({ chatWidth: w })}
              onReset={() => { glide(); update({ chatWidth: DEFAULT_SETTINGS.chatWidth }) }}
            />
            <div className="chat-slot">{agentMounted && <Chat
              changes={changes} selectedFile={selected} items={items} chats={chats} activeChat={activeChat} checkpoints={checkpoints} busy={busy} live={live} context={context} settings={settings}
              hasProject ready={status === 'online'} activeFile={selected} files={files} onOpenFile={openFile} onError={onError}
              onNewChat={() => void api.newChat().then(showChat).catch(onError)}
              onSwitchChat={(id) => void api.switchChat(id).then(showChat).catch(onError)}
              onDeleteChat={(id) => void api.deleteChat(id).then(showChat).catch(onError)}
              onSetting={update}
              onOpenModels={() => setModal(provider)}
              onBeforeSend={store.saveAll}
            />}</div>
          </main>
        )}
      {project && (
        <footer className="statusbar">
          <button className={errorCount ? 'has-errors' : warningCount ? 'has-warnings' : ''} aria-label="Problems" title="Open Problems" onClick={openProblems}><Icon name="bug" size={12} />{errorCount} error{errorCount === 1 ? '' : 's'}, {warningCount} warning{warningCount === 1 ? '' : 's'}</button>
          <span className="spacer" />
          {cursor && selected && <span>Ln {cursor.line}, Col {cursor.column}</span>}
          {cursor && selected && <span>{cursor.language}</span>}
          {selected && <span>{settings?.editor.autoSave ? 'Auto-save on' : store.dirty(selected) ? 'Not saved' : 'Saved'}</span>}
        </footer>
      )}
      {quick && <QuickOpen files={files} onClose={() => setQuick(false)} onPick={(f) => { pickFile(f); setQuick(false) }} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {taskPicker && <CommandPalette commands={taskPicker} placeholder="Choose a task to run" onClose={() => setTaskPicker(null)} />}
      {showShortcuts && <Shortcuts commands={commands} onClose={() => setShowShortcuts(false)} />}
      {prompt && <NamePrompt title={prompt.title} placeholder={prompt.placeholder} initial={prompt.initial} onDone={prompt.run} onClose={() => setPrompt(null)} />}
      {modal && settings && <SettingsModal settings={settings} initial={modal} assets={assets} onImported={loadAssets} onSettings={update} onStatus={poll} onClose={() => setModal(null)} onError={onError} hasProject={!!project} onRunInTerminal={(command) => { setModal(null); setTerminalOpen(true); setTerminalCommand(command) }} />}
    </div>
  )
}
