import { useEffect, useState } from 'react'
import type { FileChange, ImportedAssets, ScriptEntry, Settings, TreeEntry } from '../../shared/types'
import { FileIcon, Icon } from './Icon'
import { DebugPanel } from './DebugPanel'
import { ExtensionsPanel } from './ExtensionsPanel'
import { GitPanel, ScriptsPanel, SearchPanel } from './Panels'

const api = window.anvil

type Edit = { kind: 'file' | 'folder'; parent: string } | { kind: 'rename'; path: string; isDir: boolean }

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')
const join = (dir: string, name: string) => (dir === '.' ? name : `${dir}/${name}`)

function NameInput({ initial, depth, onDone, onCancel }: { initial: string; depth: number; onDone(name: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial)
  return (
    <div className="tree-row editing" style={{ paddingLeft: 28 + depth * 13 }}>
      <input
        autoFocus
        aria-label="Name"
        value={value}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.setSelectionRange(0, initial.lastIndexOf('.') > 0 ? initial.lastIndexOf('.') : initial.length)}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && value.trim()) onDone(value.trim())
        }}
      />
    </div>
  )
}

interface DirProps {
  gitCodes: Record<string, string>
  onMove(from: string, to: string): void
  path: string
  depth: number
  selected: string | null
  revision: number
  changed: Set<string>
  edit: Edit | null
  setEdit(edit: Edit | null): void
  onMenu(x: number, y: number, entry: TreeEntry): void
  submit(name: string): void
  onOpen(p: string): void
  onError(e: unknown): void
}

function Dir(props: DirProps) {
  const { path, depth, selected, revision, changed, gitCodes, edit, setEdit, onMenu, onMove, submit, onOpen, onError } = props
  const [entries, setEntries] = useState<TreeEntry[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => {
    void api.listDir(path).then(setEntries).catch(onError)
  }, [path, revision, onError])
  useEffect(() => {
    if (edit && edit.kind !== 'rename' && edit.parent !== '.' && edit.parent.startsWith(path === '.' ? '' : `${path}/`)) {
      const child = edit.parent.slice(path === '.' ? 0 : path.length + 1).split('/')[0]
      setOpen((o) => ({ ...o, [join(path, child)]: true }))
    }
  }, [edit, path])
  const creating = edit && edit.kind !== 'rename' && edit.parent === path
  return (
    <>
      {creating && <NameInput initial="" depth={depth} onDone={submit} onCancel={() => setEdit(null)} />}
      {entries.map((e) => (
        <div key={e.path}>
          {edit?.kind === 'rename' && edit.path === e.path
            ? <NameInput initial={e.name} depth={depth} onDone={submit} onCancel={() => setEdit(null)} />
            : (
              <div
                className={`tree-row ${selected === e.path ? 'selected' : ''}`}
                style={{ paddingLeft: 12 + depth * 13 }}
                onClick={() => (e.isDir ? setOpen({ ...open, [e.path]: !open[e.path] }) : onOpen(e.path))}
                onContextMenu={(ev) => { ev.preventDefault(); onMenu(ev.clientX, ev.clientY, e) }}
                draggable
                onDragStart={(ev) => ev.dataTransfer.setData('anvil/path', e.path)}
                onDragOver={(ev) => { if (e.isDir) ev.preventDefault() }}
                onDrop={(ev) => {
                  ev.preventDefault()
                  const from = ev.dataTransfer.getData('anvil/path')
                  if (!from || !e.isDir || from === e.path || e.path.startsWith(`${from}/`) || parentOf(from) === e.path) return
                  onMove(from, join(e.path, from.split('/').pop() ?? from))
                }}
              >
                <span className={`tree-caret ${open[e.path] ? 'open' : ''}`}>{e.isDir && <Icon name="chevron" size={11} />}</span>
                <span className="tree-icon"><FileIcon name={e.name} isDir={e.isDir} open={!!open[e.path]} /></span>
                <span className="tree-name">{e.name}</span>
                {changed.has(e.path) && <span className="tree-dot" />}
                {!e.isDir && gitCodes[e.path] && <span className="tree-git">{gitCodes[e.path]}</span>}
              </div>
            )}
          {e.isDir && open[e.path] && <div className="tree-kids"><Dir {...props} path={e.path} depth={depth + 1} /></div>}
        </div>
      ))}
    </>
  )
}

function Tree({ selected, revision, changed, folders, onRemoveFolder, onOpen, onRenamed, onError }: { selected: string | null; revision: number; changed: Set<string>; folders: string[] | null; onRemoveFolder(path: string): void; onOpen(p: string): void; onRenamed(from: string, to: string | null): void; onError(e: unknown): void }) {
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TreeEntry } | null>(null)
  const [gitCodes, setGitCodes] = useState<Record<string, string>>({})
  useEffect(() => {
    void api.gitStatusAll().then((all) => {
      const codes: Record<string, string> = {}
      for (const [path, raw] of Object.entries(all)) {
        const code = raw.trim()
        codes[path] = code.startsWith('?') ? 'U' : code.includes('U') ? '!' : code[0]
      }
      setGitCodes(codes)
    }).catch(() => {})
  }, [revision])

  const submit = (name: string) => {
    const current = edit
    setEdit(null)
    if (!current) return
    if (current.kind === 'rename') {
      const to = join(parentOf(current.path), name)
      if (to !== current.path) void api.renamePath(current.path, to).then(() => onRenamed(current.path, to)).catch(onError)
    } else {
      const target = join(current.parent, name)
      void api.createPath(target, current.kind === 'folder').then(() => { if (current.kind === 'file') onOpen(target) }).catch(onError)
    }
  }
  const remove = (entry: TreeEntry) => {
    if (window.confirm(`Move ${entry.name} to the Trash?`)) void api.deletePath(entry.path).then(() => onRenamed(entry.path, null)).catch(onError)
  }
  const dirOf = (entry: TreeEntry) => (entry.isDir ? entry.path : parentOf(entry.path))

  return (
    <>
      <div className="tree-tools">
        <button className="icon-btn" aria-label="New file" title="New file" onClick={() => setEdit({ kind: 'file', parent: selected ? parentOf(selected) : '.' })}><Icon name="newfile" size={14} /></button>
        <button className="icon-btn" aria-label="New folder" title="New folder" onClick={() => setEdit({ kind: 'folder', parent: selected ? parentOf(selected) : '.' })}><Icon name="newfolder" size={14} /></button>
      </div>
      <div className="tree">
        <Dir path="." depth={0} selected={selected} revision={revision} changed={changed} gitCodes={gitCodes} onMove={(from, to) => void api.renamePath(from, to).then(() => onRenamed(from, to)).catch(onError)} edit={edit} setEdit={setEdit} submit={submit} onMenu={(x, y, entry) => setMenu({ x, y, entry })} onOpen={onOpen} onError={onError} />
      </div>
      {menu && (
        <>
          <div className="scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="popover context-menu" style={{ left: menu.x, top: menu.y }} onClick={() => setMenu(null)}>
            <div className="pop-row" onClick={() => setEdit({ kind: 'file', parent: dirOf(menu.entry) })}><Icon name="newfile" size={13} />New file</div>
            <div className="pop-row" onClick={() => setEdit({ kind: 'folder', parent: dirOf(menu.entry) })}><Icon name="newfolder" size={13} />New folder</div>
            <div className="pop-row" onClick={() => setEdit({ kind: 'rename', path: menu.entry.path, isDir: menu.entry.isDir })}><Icon name="edit" size={13} />Rename</div>
            {menu.entry.isDir && folders?.includes(menu.entry.path) && <div className="pop-row" onClick={() => onRemoveFolder(menu.entry.path)}><Icon name="close" size={13} />Remove from workspace</div>}
            <div className="pop-row" onClick={() => void navigator.clipboard.writeText(menu.entry.path)}><Icon name="file" size={13} />Copy path</div>
            <div className="pop-row" onClick={() => void api.revealPath(menu.entry.path).catch(onError)}><Icon name="folder" size={13} />Reveal in file manager</div>
            <div className="pop-row danger" onClick={() => remove(menu.entry)}><Icon name="trash" size={13} />Move to Trash</div>
          </div>
        </>
      )}
    </>
  )
}

/** The symbols in the open file, below the file tree. */
function Outline({ path, revision, onOpenAt }: { path: string | null; revision: number; onOpenAt(path: string, line: number): void }) {
  // Not localStorage: reading it first blocks the whole window while Chromium opens its database, about 3.6 s in one measured launch.
  const [open, setOpen] = useState(false)
  useEffect(() => { void api.uiGet<boolean>('outlineOpen').then((saved) => { if (saved) setOpen(true) }) }, [])
  const [symbols, setSymbols] = useState<{ name: string; kind: string; line: number; container?: string }[]>([])
  useEffect(() => {
    if (!open || !path || !/\.[cm]?[jt]sx?$/.test(path)) return setSymbols([])
    let stale = false
    void api.intel<{ name: string; kind: string; line: number; container?: string }[]>('symbols', path).then((list) => { if (!stale) setSymbols(list) }).catch(() => setSymbols([]))
    return () => { stale = true }
  }, [open, path, revision])
  return (
    <div className={`outline ${open ? 'open' : ''}`}>
      <button className="link section-toggle outline-toggle" aria-expanded={open} onClick={() => { setOpen(!open); void api.uiSet('outlineOpen', !open) }}><span className={`tree-caret ${open ? 'open' : ''}`}><Icon name="chevron" size={10} /></span>Outline</button>
      {open && (
        <div className="outline-list">
          {!symbols.length && <div className="pane-empty small">{path ? 'No symbols in this file.' : 'Open a file.'}</div>}
          {symbols.map((sym, i) => (
            <div key={`${sym.name}:${sym.line}:${i}`} className="tree-row" style={{ paddingLeft: sym.container ? 22 : 10 }} onClick={() => path && onOpenAt(path, sym.line)}>
              <span className="tree-name">{sym.name}</span><small>{sym.kind}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export type SidebarTab = 'files' | 'search' | 'git' | 'scripts' | 'debug' | 'extensions'

export function Sidebar({ changes, selected, revision, tab, setTab, onOpen, onOpenAt, onDiff, onBranch, onRenamed, onRunScript, onBeforeReplace, onHistory, onError, assets, settings, onAssets, onSettings, folders, repos, activeRepo, onRemoveFolder, onSelectRepo }: {
  changes: FileChange[]
  selected: string | null
  revision: number
  tab: SidebarTab
  setTab(tab: SidebarTab): void
  onOpen(path: string): void
  onOpenAt(path: string, line: number): void
  onDiff(path: string, mode?: 'worktree' | 'staged'): void
  onBranch(branch: string | null): void
  onRenamed(from: string, to: string | null): void
  onRunScript(script: ScriptEntry): void
  onBeforeReplace(): Promise<void>
  onHistory(): void
  folders: string[] | null
  repos: string[]
  activeRepo: string | null
  onRemoveFolder(path: string): void
  onSelectRepo(repo: string): void
  assets: ImportedAssets
  settings: Settings | null
  onAssets(): void
  onSettings(patch: Partial<Settings>): void
  onError(e: unknown): void
}) {
  const changed = new Set(changes.map((c) => c.path))
  const tabs: { id: SidebarTab; label: string; icon: string }[] = [
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'git', label: 'Git', icon: 'branch' },
    { id: 'scripts', label: 'Scripts', icon: 'play' },
    { id: 'debug', label: 'Debug', icon: 'bug' },
    { id: 'extensions', label: 'Extensions', icon: 'extensions' }
  ]
  return (
    <div className="sidebar">
      <div className="side-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} aria-label={t.label} title={t.label} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={15} />
          </button>
        ))}
      </div>
      {tab === 'files' && <><Tree selected={selected} revision={revision} changed={changed} folders={folders} onRemoveFolder={onRemoveFolder} onOpen={onOpen} onRenamed={onRenamed} onError={onError} /><Outline path={selected} revision={revision} onOpenAt={onOpenAt} /></>}
      {tab === 'search' && <SearchPanel onOpen={onOpenAt} onBeforeReplace={onBeforeReplace} onError={onError} />}
      {tab === 'scripts' && <ScriptsPanel revision={revision} onRun={onRunScript} onError={onError} />}
      {tab === 'extensions' && <ExtensionsPanel assets={assets} settings={settings} onAssets={onAssets} onSettings={onSettings} onError={onError} />}
      {tab === 'debug' && <DebugPanel activeFile={selected} revision={revision} onOpenAt={onOpenAt} onError={onError} />}
      {tab === 'git' && <GitPanel repos={repos} activeRepo={activeRepo} onSelectRepo={onSelectRepo} revision={revision} onOpen={onOpen} onDiff={onDiff} onBranch={onBranch} onHistory={onHistory} onError={onError} />}
    </div>
  )
}
