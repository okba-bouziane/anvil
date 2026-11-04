import { useEffect, useState } from 'react'
import type { FileChange, ScriptEntry, TreeEntry } from '../../shared/types'
import { Icon } from './Icon'
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
  const { path, depth, selected, revision, changed, edit, setEdit, onMenu, submit, onOpen, onError } = props
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
              >
                <span className={`tree-caret ${open[e.path] ? 'open' : ''}`}>{e.isDir && <Icon name="chevron" size={11} />}</span>
                <span className="tree-icon"><Icon name={e.isDir ? 'folder' : 'file'} size={13} /></span>
                <span className="tree-name">{e.name}</span>
                {changed.has(e.path) && <span className="tree-dot" />}
              </div>
            )}
          {e.isDir && open[e.path] && <Dir {...props} path={e.path} depth={depth + 1} />}
        </div>
      ))}
    </>
  )
}

function Tree({ selected, revision, changed, onOpen, onRenamed, onError }: { selected: string | null; revision: number; changed: Set<string>; onOpen(p: string): void; onRenamed(from: string, to: string | null): void; onError(e: unknown): void }) {
  const [edit, setEdit] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TreeEntry } | null>(null)

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
        <Dir path="." depth={0} selected={selected} revision={revision} changed={changed} edit={edit} setEdit={setEdit} submit={submit} onMenu={(x, y, entry) => setMenu({ x, y, entry })} onOpen={onOpen} onError={onError} />
      </div>
      {menu && (
        <>
          <div className="scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="popover context-menu" style={{ left: menu.x, top: menu.y }} onClick={() => setMenu(null)}>
            <div className="pop-row" onClick={() => setEdit({ kind: 'file', parent: dirOf(menu.entry) })}><Icon name="newfile" size={13} />New file</div>
            <div className="pop-row" onClick={() => setEdit({ kind: 'folder', parent: dirOf(menu.entry) })}><Icon name="newfolder" size={13} />New folder</div>
            <div className="pop-row" onClick={() => setEdit({ kind: 'rename', path: menu.entry.path, isDir: menu.entry.isDir })}><Icon name="edit" size={13} />Rename</div>
            <div className="pop-row danger" onClick={() => remove(menu.entry)}><Icon name="trash" size={13} />Move to Trash</div>
          </div>
        </>
      )}
    </>
  )
}

export type SidebarTab = 'files' | 'search' | 'changes' | 'git' | 'scripts'

export function Sidebar({ changes, selected, revision, tab, setTab, onOpen, onOpenAt, onDiff, onBranch, onRenamed, onRunScript, onBeforeReplace, onError }: {
  changes: FileChange[]
  selected: string | null
  revision: number
  tab: SidebarTab
  setTab(tab: SidebarTab): void
  onOpen(path: string): void
  onOpenAt(path: string, line: number): void
  onDiff(path: string): void
  onBranch(branch: string | null): void
  onRenamed(from: string, to: string | null): void
  onRunScript(script: ScriptEntry): void
  onBeforeReplace(): Promise<void>
  onError(e: unknown): void
}) {
  const changed = new Set(changes.map((c) => c.path))
  const tabs: { id: SidebarTab; label: string; icon: string }[] = [
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'changes', label: 'Changes', icon: 'edit' },
    { id: 'git', label: 'Git', icon: 'branch' },
    { id: 'scripts', label: 'Scripts', icon: 'play' }
  ]
  return (
    <div className="sidebar">
      <div className="side-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} aria-label={t.label} title={t.label} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={15} />
            {t.id === 'changes' && changes.length > 0 && <span className="badge">{changes.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'files' && <Tree selected={selected} revision={revision} changed={changed} onOpen={onOpen} onRenamed={onRenamed} onError={onError} />}
      {tab === 'search' && <SearchPanel onOpen={onOpenAt} onBeforeReplace={onBeforeReplace} onError={onError} />}
      {tab === 'scripts' && <ScriptsPanel revision={revision} onRun={onRunScript} onError={onError} />}
      {tab === 'git' && <GitPanel revision={revision} onDiff={onDiff} onBranch={onBranch} onError={onError} />}
      {tab === 'changes' && (
        <div className="changes">
          {changes.length === 0 && <div className="pane-empty small">Nothing to review.</div>}
          {changes.length > 0 && (
            <div className="row all">
              <button className="keep" onClick={() => void api.acceptAll().catch(onError)}><Icon name="check" size={13} />Keep all</button>
              <button className="undo" onClick={() => void api.rejectAll().catch(onError)}><Icon name="undo" size={13} />Undo all</button>
            </div>
          )}
          {changes.map((c) => {
            const slash = c.path.lastIndexOf('/')
            return (
              <div key={c.path} className={`change-row ${selected === c.path ? 'selected' : ''}`} title={c.path} onClick={() => onOpen(c.path)}>
                <span className="change-name"><b>{c.path.slice(slash + 1)}</b><small>{c.path.slice(0, Math.max(slash, 0))}</small></span>
                <span className="counts"><b className="plus">+{c.added}</b> <b className="minus">−{c.removed}</b></span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
