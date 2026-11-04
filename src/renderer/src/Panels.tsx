import { useCallback, useEffect, useMemo, useState } from 'react'
import { layoutGraph, type GraphRow } from '../../shared/gitgraph'
import type { CommitFile, CommitInfo, GitStatus, ScriptEntry, SearchHit } from '../../shared/types'
import { Icon } from './Icon'

const api = window.anvil

export function ScriptsPanel({ revision, onRun, onError }: { revision: number; onRun(script: ScriptEntry): void; onError(e: unknown): void }) {
  const [scripts, setScripts] = useState<ScriptEntry[] | null>(null)
  useEffect(() => { void api.listScripts().then(setScripts).catch(onError) }, [revision, onError])
  if (!scripts) return null
  if (!scripts.length) return <div className="panel-body center-text"><p>No npm scripts found in this project.</p></div>
  const dirs = [...new Set(scripts.map((s) => s.dir))]
  return (
    <div className="panel-body scripts">
      <div className="git-list">
        {dirs.map((dir) => (
          <div key={dir}>
            <div className="script-dir">{dir === '.' ? 'Project root' : dir}</div>
            {scripts.filter((s) => s.dir === dir).map((s) => (
              <div key={s.name} className="script-row" title={`Run ${s.command}`} role="button" onClick={() => onRun(s)}>
                <Icon name="play" size={12} /><b>{s.name}</b><small>{s.command}</small>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function SearchPanel({ onOpen, onBeforeReplace, onError }: { onOpen(path: string, line: number): void; onBeforeReplace(): Promise<void>; onError(e: unknown): void }) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCase] = useState(false)
  const [regex, setRegex] = useState(false)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [note, setNote] = useState<string | null>(null)

  const replaceAll = async () => {
    await onBeforeReplace()
    const files = new Set((hits ?? []).map((h) => h.path)).size
    if (!window.confirm(`Replace "${query}" with "${replacement}" in ${files} file${files === 1 ? '' : 's'}? You can review and undo this in Changes.`)) return
    const result = await api.replaceInProject(query, { caseSensitive, regex }, replacement)
    setNote(`Replaced ${result.matches} in ${result.files} file${result.files === 1 ? '' : 's'}. Review them in Changes.`)
    setHits(null)
  }

  const run = () => {
    setNote(null)
    if (!query.trim()) return setHits(null)
    void api.searchProject(query, { caseSensitive, regex }).then(setHits).catch(onError)
  }

  const groups = new Map<string, SearchHit[]>()
  for (const hit of hits ?? []) groups.set(hit.path, [...(groups.get(hit.path) ?? []), hit])

  return (
    <div className="panel-body">
      <div className="search-box">
        <input id="project-search" autoFocus value={query} spellCheck={false} placeholder="Search in project" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run() }} />
        <button className={`flag ${caseSensitive ? 'on' : ''}`} title="Match case" aria-pressed={caseSensitive} onClick={() => setCase(!caseSensitive)}>Aa</button>
        <button className={`flag ${regex ? 'on' : ''}`} title="Use a regular expression" aria-pressed={regex} onClick={() => setRegex(!regex)}>.*</button>
        <button className={`flag ${replacing ? 'on' : ''}`} title="Replace" aria-label="Show replace" aria-pressed={replacing} onClick={() => setReplacing(!replacing)}>ab</button>
      </div>
      {replacing && (
        <div className="replace-box">
          <input id="project-replace" value={replacement} spellCheck={false} placeholder="Replace with" onChange={(e) => setReplacement(e.target.value)} />
          <button disabled={!hits?.length} onClick={() => void replaceAll().catch(onError)}>Replace all</button>
        </div>
      )}
      {note && <div className="search-count">{note}</div>}
      {hits && <div className="search-count">{hits.length >= 500 ? 'First 500 results' : `${hits.length} result${hits.length === 1 ? '' : 's'}`} in {groups.size} file{groups.size === 1 ? '' : 's'}</div>}
      <div className="search-results">
        {[...groups].map(([file, list]) => (
          <div key={file}>
            <div className="search-file" title={file}>{file}</div>
            {list.map((h) => (
              <div key={`${h.path}:${h.line}`} className="search-hit" onClick={() => onOpen(h.path, h.line)}>
                <span className="search-line">{h.line}</span><span className="search-text">{h.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

const ago = (seconds: number) => {
  const d = Date.now() / 1000 - seconds
  if (d < 60) return 'just now'
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]
  for (const [size, name] of units) {
    const n = Math.floor(d / size)
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`
  }
  return 'just now'
}
export { ago }

const ROW = 26
const LANE = 13
const LANE_COLORS = ['#7c7ff5', '#34d399', '#f59e0b', '#f472b6', '#38bdf8', '#a78bfa', '#fb7185']

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => lane * LANE + 8
  const color = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]
  const mid = ROW / 2
  return (
    <svg className="graph-cell" width={width} height={ROW} aria-hidden="true">
      {row.top.map((l) => <line key={`t${l}`} x1={x(l)} y1={0} x2={l === row.lane ? x(l) : x(l)} y2={mid} stroke={color(l)} strokeWidth="1.5" />)}
      {row.bottom.map((b) => <path key={`b${b.from}-${b.to}`} d={`M${x(b.from)} ${mid} C${x(b.from)} ${ROW - 4} ${x(b.to)} ${mid + 4} ${x(b.to)} ${ROW}`} fill="none" stroke={color(Math.max(b.from, b.to))} strokeWidth="1.5" />)}
      <circle cx={x(row.lane)} cy={mid} r="4" fill={color(row.lane)} stroke="var(--editor)" strokeWidth="1.5" />
    </svg>
  )
}

/** The commit tree: every branch, with who changed what and when. */
export function HistoryPanel({ revision, file, onClearFile, onOpenDiff, onError }: { revision: number; file: string | null; onClearFile(): void; onOpenDiff(sha: string, path: string): void; onError(e: unknown): void }) {
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  const [limit, setLimit] = useState(300)
  const [open, setOpen] = useState<string | null>(null)
  const [files, setFiles] = useState<CommitFile[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void api.gitLog(limit, file ?? undefined).then(setCommits).catch(() => setCommits([]))
  }, [limit, file, revision])

  const rows = useMemo(() => layoutGraph(commits ?? []), [commits])
  if (!commits) return null
  const width = Math.max(1, ...rows.map((r) => r.lanes)) * LANE + 8
  const query = filter.toLowerCase()
  const matches = (c: CommitInfo) => !query || `${c.subject} ${c.author} ${c.sha} ${c.refs.join(' ')}`.toLowerCase().includes(query)

  const toggle = (sha: string) => {
    if (open === sha) return setOpen(null)
    setOpen(sha)
    setFiles([])
    void api.gitCommitFiles(sha).then(setFiles).catch(onError)
  }

  return (
    <div className="history">
      <div className="history-bar">
        <input id="history-filter" value={filter} spellCheck={false} placeholder="Filter by message, author, branch or commit" onChange={(e) => setFilter(e.target.value)} />
        {file && <span className="pill-file" title={file}>History of {file.split('/').pop()}<button className="tab-close" aria-label="Show all commits" onClick={onClearFile}><Icon name="close" size={11} /></button></span>}
        <span className="spacer" />
        <small>{commits.length} commit{commits.length === 1 ? '' : 's'}</small>
      </div>
      <div className="history-list">
        {!commits.length && <div className="pane-empty small">No commits yet.</div>}
        {commits.map((c, i) => matches(c) && (
          <div key={c.sha}>
            <div className={`commit-row ${open === c.sha ? 'selected' : ''}`} role="button" onClick={() => toggle(c.sha)}>
              {!query && <GraphCell row={rows[i]} width={width} />}
              <span className="commit-subject" title={c.subject}>
                {c.refs.map((r) => <span key={r} className={`ref ${r.startsWith('tag: ') ? 'tag' : r.includes('/') ? 'remote' : ''}`}>{r.replace('tag: ', '')}</span>)}
                {c.subject}
              </span>
              <span className="commit-author">{c.author}</span>
              <span className="commit-time" title={new Date(c.time * 1000).toLocaleString()}>{ago(c.time)}</span>
              <code className="commit-sha">{c.sha.slice(0, 7)}</code>
            </div>
            {open === c.sha && (
              <div className="commit-files">
                {files.map((f) => (
                  <div key={f.path} className="commit-file" role="button" onClick={() => onOpenDiff(c.sha, f.path)}>
                    <span className={`git-code code-${f.status}`}>{f.status}</span><span>{f.path}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {commits.length >= limit && <button className="link more" onClick={() => setLimit(limit + 500)}>Show more</button>}
      </div>
    </div>
  )
}

function Branches({ onChanged, onError }: { onChanged(): void; onError(e: unknown): void }) {
  const [info, setInfo] = useState<{ current: string | null; all: string[] } | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const load = useCallback(() => void api.gitBranches().then(setInfo).catch(() => {}), [])
  useEffect(load, [load])
  const go = (branch: string, create: boolean) => void api.gitCheckout(branch, create).then(() => { setCreating(false); setName(''); load(); onChanged() }).catch(onError)
  if (!info) return null
  if (creating) {
    return (
      <div className="branch-row">
        <input id="new-branch" autoFocus value={name} spellCheck={false} placeholder="New branch name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) go(name.trim(), true); if (e.key === 'Escape') setCreating(false) }} />
        <button className="icon-btn" aria-label="Cancel" onClick={() => setCreating(false)}><Icon name="close" size={13} /></button>
      </div>
    )
  }
  return (
    <div className="branch-row">
      <Icon name="branch" size={13} />
      <select id="branch-select" aria-label="Branch" value={info.current ?? ''} onChange={(e) => go(e.target.value, false)}>
        {info.current === null && <option value="">No branch yet</option>}
        {info.all.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
      <button className="icon-btn" aria-label="New branch" title="New branch" onClick={() => setCreating(true)}><Icon name="plus" size={13} /></button>
    </div>
  )
}

const LABEL: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'new', U: 'conflict' }

export function GitPanel({ revision, onDiff, onBranch, onHistory, onError }: { revision: number; onDiff(path: string): void; onBranch(branch: string | null): void; onHistory(): void; onError(e: unknown): void }) {
  const [state, setState] = useState<GitStatus | null>(null)
  const [message, setMessage] = useState('')
  const [syncing, setSyncing] = useState<string | null>(null)

  const refresh = useCallback(() => void api.gitStatus().then((s) => { setState(s); onBranch(s.branch) }).catch(onError), [onBranch, onError])
  useEffect(refresh, [refresh, revision])

  if (!state) return null
  if (!state.isRepo) {
    return (
      <div className="panel-body center-text">
        <p>This folder isn't a Git repository yet.</p>
        <button className="primary" onClick={() => void api.gitInit().then(refresh).catch(onError)}>Start a repository</button>
      </div>
    )
  }
  const staged = state.files.filter((f) => f.code[0] !== ' ' && f.code[0] !== '?')
  const unstaged = state.files.filter((f) => f.code[1] !== ' ')
  const stage = (paths: string[], add: boolean) => void api.gitStage(paths, add).then(refresh).catch(onError)
  const row = (path: string, letter: string, action: JSX.Element) => (
    <div key={path + letter} className="git-row" title={path} onClick={() => onDiff(path)}>
      <span className="change-name"><b>{path.split('/').pop()}</b><small>{path.split('/').slice(0, -1).join('/')}</small></span>
      <span className="git-actions" onClick={(e) => e.stopPropagation()}>{action}</span>
      <span className={`git-code code-${letter === '?' ? 'A' : letter}`} title={LABEL[letter]}>{letter === '?' ? 'U' : letter}</span>
    </div>
  )
  const sync = (action: 'pull' | 'push') => {
    setSyncing(action)
    void api.gitSync(action).then(refresh).catch(onError).finally(() => setSyncing(null))
  }
  return (
    <div className="panel-body">
      <Branches onChanged={refresh} onError={onError} />
      <button className="history-btn" onClick={onHistory}><Icon name="history" size={13} />Commit history</button>
      <div className="commit-box">
        <textarea id="commit-message" rows={2} value={message} placeholder="Commit message" onChange={(e) => setMessage(e.target.value)} />
        <button className="primary" disabled={!message.trim() || !staged.length} onClick={() => void api.gitCommit(message).then(() => { setMessage(''); refresh() }).catch(onError)}>
          <Icon name="check" size={13} />Commit {staged.length > 0 && `${staged.length} file${staged.length > 1 ? 's' : ''}`}
        </button>
        <div className="row sync">
          <button disabled={!!syncing} onClick={() => sync('pull')}>{syncing === 'pull' ? 'Pulling…' : `Pull${state.behind ? ` ${state.behind}` : ''}`}</button>
          <button disabled={!!syncing} onClick={() => sync('push')}>{syncing === 'push' ? 'Pushing…' : `Push${state.ahead ? ` ${state.ahead}` : ''}`}</button>
        </div>
      </div>
      <div className="git-list">
        {!state.files.length && <div className="pane-empty small">No changes.</div>}
        {staged.length > 0 && <div className="git-title">Staged<button className="link" onClick={() => stage(staged.map((f) => f.path), false)}>Unstage all</button></div>}
        {staged.map((f) => row(f.path, f.code[0], <button className="icon-btn" aria-label={`Unstage ${f.path}`} title="Unstage" onClick={() => stage([f.path], false)}><Icon name="close" size={12} /></button>))}
        {unstaged.length > 0 && <div className="git-title">Changes<button className="link" onClick={() => stage(unstaged.map((f) => f.path), true)}>Stage all</button></div>}
        {unstaged.map((f) => row(f.path, f.code[1], (
          <>
            <button className="icon-btn" aria-label={`Discard ${f.path}`} title="Discard changes" onClick={() => { if (window.confirm(`Discard your changes to ${f.path}?`)) void api.gitDiscard(f.path).then(refresh).catch(onError) }}><Icon name="undo" size={12} /></button>
            <button className="icon-btn" aria-label={`Stage ${f.path}`} title="Stage" onClick={() => stage([f.path], true)}><Icon name="plus" size={12} /></button>
          </>
        )))}
      </div>
    </div>
  )
}
