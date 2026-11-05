import { useCallback, useEffect, useMemo, useState } from 'react'
import { layoutGraph, type GraphRow } from '../../shared/gitgraph'
import type { CommitFile, CommitInfo, GitDetails, GitStatus, PullRequest, ScriptEntry, SearchHit } from '../../shared/types'
import { FileIcon, Icon } from './Icon'

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
  const [wholeWord, setWholeWord] = useState(false)
  const [filters, setFilters] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const options = { caseSensitive, regex, wholeWord, include, exclude }
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [note, setNote] = useState<string | null>(null)

  const replaceAll = async () => {
    await onBeforeReplace()
    const files = new Set((hits ?? []).map((h) => h.path)).size
    if (!window.confirm(`Replace "${query}" with "${replacement}" in ${files} file${files === 1 ? '' : 's'}? You can review and undo this above the chat.`)) return
    const result = await api.replaceInProject(query, options, replacement)
    setNote(`Replaced ${result.matches} in ${result.files} file${result.files === 1 ? '' : 's'}. Review them above the chat.`)
    setHits(null)
  }

  const run = () => {
    setNote(null)
    if (!query.trim()) return setHits(null)
    void api.searchProject(query, options).then(setHits).catch(onError)
  }

  const groups = new Map<string, SearchHit[]>()
  for (const hit of hits ?? []) groups.set(hit.path, [...(groups.get(hit.path) ?? []), hit])

  return (
    <div className="panel-body">
      <div className="search-box">
        <input id="project-search" autoFocus value={query} spellCheck={false} placeholder="Search in project" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run() }} />
        <button className={`flag ${caseSensitive ? 'on' : ''}`} title="Match case" aria-pressed={caseSensitive} onClick={() => setCase(!caseSensitive)}>Aa</button>
        <button className={`flag ${wholeWord ? 'on' : ''}`} title="Whole word" aria-pressed={wholeWord} onClick={() => setWholeWord(!wholeWord)}>W</button>
        <button className={`flag ${regex ? 'on' : ''}`} title="Use a regular expression" aria-pressed={regex} onClick={() => setRegex(!regex)}>.*</button>
        <button className={`flag ${replacing ? 'on' : ''}`} title="Replace" aria-label="Show replace" aria-pressed={replacing} onClick={() => setReplacing(!replacing)}>ab</button>
      </div>
      <button className="link filters-toggle" aria-expanded={filters} onClick={() => setFilters(!filters)}>{filters ? 'Hide file filters' : 'Filter by files'}</button>
      {filters && (
        <div className="replace-box">
          <input id="search-include" value={include} spellCheck={false} placeholder="Only in, like src/**, *.ts" onChange={(e) => setInclude(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run() }} />
          <input id="search-exclude" value={exclude} spellCheck={false} placeholder="Not in, like *.spec.ts, docs" onChange={(e) => setExclude(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run() }} />
        </div>
      )}
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
            <div className="search-file" title={file}><FileIcon name={file.split('/').pop() ?? file} size={14} /><span>{file}</span></div>
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
const LANE_COLORS = ['#a3b8aa', '#a9bac9', '#c9aeb0', '#b8bf92', '#aea79a', '#8fa8a0', '#b5a5c0']

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
  const [menu, setMenu] = useState<{ x: number; y: number; commit: CommitInfo } | null>(null)
  const [naming, setNaming] = useState<{ kind: 'branch' | 'tag'; sha: string } | null>(null)
  const [name, setName] = useState('')
  const act = (run: Promise<unknown>) => { setMenu(null); void run.catch(onError) }

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
            <div className={`commit-row ${open === c.sha ? 'selected' : ''}`} role="button" onClick={() => toggle(c.sha)} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, commit: c }) }}>
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
                    <span className={`git-code code-${f.status}`}>{f.status}</span><FileIcon name={f.path.split('/').pop() ?? f.path} size={14} /><span>{f.path}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {commits.length >= limit && <button className="link more" onClick={() => setLimit(limit + 500)}>Show more</button>}
      </div>
      {naming && (
        <div className="history-name">
          <span>{naming.kind === 'branch' ? 'New branch at' : 'New tag at'} {naming.sha.slice(0, 7)}</span>
          <input id="history-name" autoFocus value={name} spellCheck={false} placeholder="Name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Escape') setNaming(null)
            if (e.key === 'Enter' && name.trim()) { void api.gitOp(naming.kind === 'branch' ? 'branchAt' : 'tag', name.trim(), naming.sha).catch(onError); setNaming(null); setName('') }
          }} />
        </div>
      )}
      {menu && (
        <>
          <div className="scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="popover context-menu commit-menu" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 320) }}>
            <div className="pop-row" role="button" onClick={() => act(api.gitOp('checkoutSha', menu.commit.sha))}>Check out this commit</div>
            <div className="pop-row" role="button" onClick={() => { setNaming({ kind: 'branch', sha: menu.commit.sha }); setName(''); setMenu(null) }}>Create branch here</div>
            <div className="pop-row" role="button" onClick={() => { setNaming({ kind: 'tag', sha: menu.commit.sha }); setName(''); setMenu(null) }}>Create tag here</div>
            <div className="pop-row" role="button" onClick={() => act(api.gitOp('cherryPick', menu.commit.sha))}>Cherry-pick</div>
            <div className="pop-row" role="button" onClick={() => act(api.gitOp('revert', menu.commit.sha))}>Revert this commit</div>
            <div className="pop-row" role="button" onClick={() => act(api.gitOp('reset', menu.commit.sha, 'soft'))}>Reset to here, keep staged</div>
            <div className="pop-row" role="button" onClick={() => act(api.gitOp('reset', menu.commit.sha, 'mixed'))}>Reset to here, keep files</div>
            <div className="pop-row danger" role="button" onClick={() => { if (window.confirm(`Reset to ${menu.commit.sha.slice(0, 7)} and throw away all later work and uncommitted changes? This can't be undone from Anvil.`)) act(api.gitOp('reset', menu.commit.sha, 'hard')); else setMenu(null) }}>Reset to here, discard everything</div>
            <div className="pop-row" role="button" onClick={() => { void navigator.clipboard.writeText(menu.commit.sha); setMenu(null) }}>Copy commit ID</div>
          </div>
        </>
      )}
    </div>
  )
}

const OP_LABEL = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting' }

function Branches({ details, onChanged, onError }: { details: GitDetails; onChanged(): void; onError(e: unknown): void }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [naming, setNaming] = useState<{ kind: 'new' } | { kind: 'rename'; from: string } | null>(null)
  const [name, setName] = useState('')
  const current = details.branches.find((b) => b.current)
  const close = () => { setOpen(false); setFilter(''); setNaming(null); setName('') }
  const run = (action: Promise<unknown>) => void action.then(() => { close(); onChanged() }).catch(onError)
  const query = filter.toLowerCase()
  const locals = details.branches.filter((b) => b.name.toLowerCase().includes(query))
  const localNames = new Set(details.branches.map((b) => b.name))
  const remotes = details.remoteBranches.filter((r) => r.toLowerCase().includes(query) && !localNames.has(r.slice(r.indexOf('/') + 1)))
  const submitName = () => {
    const value = name.trim()
    if (!value || !naming) return
    run(naming.kind === 'new' ? api.gitCheckout(value, true) : api.gitOp('renameBranch', naming.from, value))
  }
  return (
    <div className="branch-row">
      <button className="branch-button" aria-label="Branches" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="branch" size={13} /><span>{current?.name ?? 'No branch yet'}</span>
        {current && (current.ahead > 0 || current.behind > 0) && <small>{current.ahead > 0 && `↑${current.ahead}`} {current.behind > 0 && `↓${current.behind}`}</small>}
        <span className="spacer" /><Icon name="chevron" size={10} />
      </button>
      {open && (
        <>
          <div className="scrim" onClick={close} />
          <div className="popover branch-popover">
            {naming
              ? <input id="new-branch" autoFocus value={name} spellCheck={false} placeholder={naming.kind === 'new' ? 'New branch name' : `New name for ${naming.from}`} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitName(); if (e.key === 'Escape') setNaming(null) }} />
              : <input id="branch-filter" autoFocus value={filter} spellCheck={false} placeholder="Find a branch" onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') close() }} />}
            <div className="pop-row" role="button" onClick={() => { setNaming({ kind: 'new' }); setName('') }}><Icon name="plus" size={13} /><span className="pop-title">New branch</span></div>
            <div className="branch-list">
              {locals.map((b) => (
                <div key={b.name} className={`pop-row branch-item ${b.current ? 'selected' : ''}`} role="button" title={b.subject} onClick={() => { if (!b.current) run(api.gitCheckout(b.name, false)) }}>
                  <span className="pop-title">{b.name}</span>
                  {(b.ahead > 0 || b.behind > 0) && <small>{b.ahead > 0 && `↑${b.ahead}`} {b.behind > 0 && `↓${b.behind}`}</small>}
                  <span className="branch-actions" onClick={(e) => e.stopPropagation()}>
                    {!b.current && <button className="ghost" onClick={() => run(api.gitOp('merge', b.name))} title={`Merge ${b.name} into ${current?.name}`}>Merge</button>}
                    {!b.current && <button className="ghost" onClick={() => run(api.gitOp('rebase', b.name))} title={`Rebase ${current?.name} onto ${b.name}`}>Rebase</button>}
                    <button className="ghost" onClick={() => { setNaming({ kind: 'rename', from: b.name }); setName(b.name) }}>Rename</button>
                    {!b.current && <button className="ghost" onClick={() => {
                      if (!window.confirm(`Delete the branch ${b.name}?`)) return
                      void api.gitOp('deleteBranch', b.name, false).then(onChanged).catch((e: Error) => {
                        if (/not fully merged/.test(e.message) && window.confirm(`${b.name} has commits that aren't merged anywhere. Delete it anyway?`)) void api.gitOp('deleteBranch', b.name, true).then(onChanged).catch(onError)
                        else if (!/not fully merged/.test(e.message)) onError(e)
                      })
                    }}>Delete</button>}
                  </span>
                </div>
              ))}
              {remotes.length > 0 && <div className="git-title">Remote</div>}
              {remotes.map((r) => (
                <div key={r} className="pop-row branch-item" role="button" onClick={() => run(api.gitOp('checkoutRemote', r))}>
                  <span className="pop-title">{r}</span>
                </div>
              ))}
              {!locals.length && !remotes.length && <div className="pane-empty small">No matching branches.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Stashes({ details, canSave, onChanged, onError }: { details: GitDetails; canSave: boolean; onChanged(): void; onError(e: unknown): void }) {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const run = (action: Promise<unknown>) => void action.then(onChanged).catch(onError)
  return (
    <>
      <div className="git-title">Stashes{details.stashes.length > 0 && ` (${details.stashes.length})`}<button className="link" disabled={!canSave} onClick={() => setSaving(!saving)}>Stash changes</button></div>
      {saving && (
        <div className="search-box">
          <input id="stash-message" autoFocus value={message} placeholder="What are you setting aside?" onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter') { run(api.gitOp('stashPush', message)); setSaving(false); setMessage('') }
            if (e.key === 'Escape') setSaving(false)
          }} />
        </div>
      )}
      {details.stashes.map((s) => (
        <div key={s.index} className="git-row stash-row" title={s.message}>
          <span className="change-name"><b>{s.message.replace(/^On [^:]+: /, '').replace(/^WIP on [^:]+: /, '')}</b><small>{ago(s.time)}</small></span>
          <span className="git-actions">
            <button className="icon-btn" aria-label={`Apply stash ${s.index}`} title="Apply and keep the stash" onClick={() => run(api.gitOp('stashApply', s.index))}><Icon name="check" size={12} /></button>
            <button className="icon-btn" aria-label={`Pop stash ${s.index}`} title="Apply and remove the stash" onClick={() => run(api.gitOp('stashPop', s.index))}><Icon name="undo" size={12} /></button>
            <button className="icon-btn" aria-label={`Drop stash ${s.index}`} title="Delete the stash" onClick={() => { if (window.confirm('Delete this stash? It cannot be brought back.')) run(api.gitOp('stashDrop', s.index)) }}><Icon name="close" size={12} /></button>
          </span>
        </div>
      ))}
    </>
  )
}

function PullRequests({ branch, onChanged, onError }: { branch: string | null; onChanged(): void; onError(e: unknown): void }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ state: 'ok' | 'no-gh' | 'error'; message?: string; list: PullRequest[] } | null>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const load = useCallback(() => { setData(null); void api.gitPullRequests().then(setData).catch(onError) }, [onError])
  const toggle = () => { if (!open) load(); setOpen(!open) }
  const create = () => void api.gitOp('createPullRequest', title, body, false).then(() => { setCreating(false); setTitle(''); setBody(''); load() }).catch(onError)
  return (
    <>
      <div className="git-title">
        <button className="link section-toggle" aria-expanded={open} onClick={toggle}><span className={`tree-caret ${open ? 'open' : ''}`}><Icon name="chevron" size={10} /></span>Pull requests</button>
        {open && data?.state === 'ok' && <button className="link" onClick={() => setCreating(!creating)}>New</button>}
      </div>
      {open && !data && <div className="pane-empty small">Loading…</div>}
      {open && data?.state === 'no-gh' && <div className="pane-empty small">Pull requests use GitHub's <code>gh</code> tool. Install it from cli.github.com, then run <code>gh auth login</code> in the terminal.</div>}
      {open && data?.state === 'error' && <div className="pane-empty small">{data.message}</div>}
      {open && creating && (
        <div className="commit-box">
          <input id="pr-title" autoFocus className="plain-input" value={title} placeholder={`Title for ${branch ?? 'this branch'}`} onChange={(e) => setTitle(e.target.value)} />
          <textarea id="pr-body" rows={3} value={body} placeholder="Description" onChange={(e) => setBody(e.target.value)} />
          <button className="primary" disabled={!title.trim()} onClick={create}>Create pull request</button>
        </div>
      )}
      {open && data?.state === 'ok' && !data.list.length && !creating && <div className="pane-empty small">No open pull requests.</div>}
      {open && data?.list.map((pr) => (
        <div key={pr.number} className="git-row" title={pr.title} onClick={() => window.open(pr.url)}>
          <span className="change-name"><b>#{pr.number} {pr.title}</b><small>{pr.branch}, {pr.author}{pr.draft ? ', draft' : ''}{pr.review === 'APPROVED' ? ', approved' : pr.review === 'CHANGES_REQUESTED' ? ', changes requested' : ''}</small></span>
          <span className="git-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" aria-label={`Check out pull request ${pr.number}`} title="Check out this branch" onClick={() => void api.gitOp('checkoutPullRequest', pr.number).then(onChanged).catch(onError)}><Icon name="branch" size={12} /></button>
          </span>
        </div>
      ))}
    </>
  )
}

const LABEL: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'new', U: 'conflict' }

export function GitPanel({ repos, activeRepo, onSelectRepo, revision, onOpen, onDiff, onBranch, onHistory, onError }: { repos: string[]; activeRepo: string | null; onSelectRepo(repo: string): void; revision: number; onOpen(path: string): void; onDiff(path: string, mode?: 'worktree' | 'staged'): void; onBranch(branch: string | null): void; onHistory(): void; onError(e: unknown): void }) {
  const [state, setState] = useState<GitStatus | null>(null)
  const [details, setDetails] = useState<GitDetails | null>(null)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)

  const refresh = useCallback(() => {
    void api.gitStatus().then((s) => {
      setState(s)
      onBranch(s.branch)
      if (s.isRepo) void api.gitDetails().then(setDetails).catch(onError)
    }).catch(onError)
  }, [onBranch, onError])
  useEffect(refresh, [refresh, revision, activeRepo])

  if (!state) return null
  if (!state.isRepo) {
    return (
      <div className="panel-body center-text">
        <p>This folder isn't a Git repository yet.</p>
        <button className="primary" onClick={() => void api.gitInit().then(refresh).catch(onError)}>Start a repository</button>
      </div>
    )
  }
  const conflicted = new Set(details?.conflicts ?? [])
  const staged = state.files.filter((f) => f.code[0] !== ' ' && f.code[0] !== '?' && !conflicted.has(f.path))
  const unstaged = state.files.filter((f) => f.code[1] !== ' ' && !conflicted.has(f.path))
  const stage = (paths: string[], add: boolean) => void api.gitStage(paths, add).then(refresh).catch(onError)
  const row = (path: string, letter: string, action: JSX.Element, open: () => void) => (
    <div key={path + letter} className="git-row" title={path} onClick={open}>
      <FileIcon name={path.split('/').pop() ?? path} /><span className="change-name"><b>{path.split('/').pop()}</b><small>{path.split('/').slice(0, -1).join('/')}</small></span>
      <span className="git-actions" onClick={(e) => e.stopPropagation()}>{action}</span>
      <span className={`git-code code-${letter === '?' ? 'A' : letter}`} title={LABEL[letter]}>{letter === '?' ? 'U' : letter}</span>
    </div>
  )
  const net = (label: string, action: () => Promise<unknown>) => {
    setSyncing(label)
    setMenu(false)
    void action().then(refresh).catch(onError).finally(() => setSyncing(null))
  }
  const op = details?.operation ?? null
  const canCommit = amend || staged.length > 0
  const doCommit = () => {
    const done = () => { setMessage(''); setAmend(false); refresh() }
    if (amend) void api.gitOp('amend', message).then(done).catch(onError)
    else void api.gitCommit(message).then(done).catch(onError)
  }
  return (
    <div className="panel-body">
      {repos.length > 1 && (
        <select id="repo-select" className="repo-select" aria-label="Repository" value={activeRepo ?? ''} onChange={(e) => onSelectRepo(e.target.value)}>
          {repos.map((r) => <option key={r} value={r}>{r === '.' ? 'This folder' : r}</option>)}
        </select>
      )}
      {details && <Branches details={details} onChanged={refresh} onError={onError} />}
      {op && (
        <div className="git-operation" role="status">
          <b>{OP_LABEL[op]}</b>
          <span>{conflicted.size ? `${conflicted.size} conflict${conflicted.size > 1 ? 's' : ''} to resolve` : 'Ready to continue'}</span>
          <div className="row">
            <button className="primary" disabled={conflicted.size > 0} onClick={() => void api.gitOp('continue').then(refresh).catch(onError)}>Continue</button>
            <button onClick={() => { if (window.confirm(`Stop ${OP_LABEL[op].toLowerCase()} and go back to how things were?`)) void api.gitOp('abort').then(refresh).catch(onError) }}>Abort</button>
          </div>
        </div>
      )}
      <div className="commit-box">
        <textarea id="commit-message" rows={2} value={message} placeholder={amend ? 'New message, or leave empty to keep it' : 'Commit message'} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (message.trim() || amend) && canCommit) doCommit() }} />
        <button className="primary" disabled={(!message.trim() && !amend) || !canCommit} onClick={doCommit}>
          <Icon name="check" size={13} />{amend ? 'Amend last commit' : <>Commit {staged.length > 0 && `${staged.length} file${staged.length > 1 ? 's' : ''}`}</>}
        </button>
        <label className="toggle amend-toggle" title="Add the staged changes to the last commit, or change its message">
          <input type="checkbox" checked={amend} onChange={(e) => { setAmend(e.target.checked); if (e.target.checked && !message) setMessage(details?.lastMessage ?? '') }} /><span className="switch" />Amend last commit
        </label>
        <div className="row sync">
          <button disabled={!!syncing} onClick={() => net('fetch', () => api.gitOp('fetch'))}>{syncing === 'fetch' ? 'Fetching…' : 'Fetch'}</button>
          <button disabled={!!syncing} onClick={() => net('pull', () => api.gitSync('pull'))}>{syncing === 'pull' ? 'Pulling…' : `Pull${state.behind ? ` ${state.behind}` : ''}`}</button>
          <button disabled={!!syncing} onClick={() => net('push', () => api.gitOp('push'))}>{syncing === 'push' ? 'Pushing…' : `Push${state.ahead ? ` ${state.ahead}` : ''}`}</button>
          <button className="icon-btn more-btn" aria-label="More Git actions" onClick={() => setMenu(!menu)}>⋯</button>
          {menu && (
            <>
              <div className="scrim" onClick={() => setMenu(false)} />
              <div className="popover git-menu">
                <div className="pop-row" role="button" onClick={() => net('pull', () => api.gitOp('pullRebase'))}>Pull with rebase</div>
                <div className="pop-row" role="button" onClick={() => { if (window.confirm('Force push? This replaces the branch on the remote. It stops if someone else pushed since you last fetched.')) net('push', () => api.gitOp('push', true)) }}>Force push (safe)</div>
                <div className="pop-row" role="button" onClick={() => { setMenu(false); onHistory() }}><Icon name="history" size={13} />Commit history</div>
              </div>
            </>
          )}
        </div>
      </div>
      <button className="history-btn" onClick={onHistory}><Icon name="history" size={13} />Commit history</button>
      <div className="git-list">
        {conflicted.size > 0 && <div className="git-title conflict-title">Conflicts</div>}
        {[...conflicted].map((path) => row(path, 'U', <button className="icon-btn" aria-label={`Mark ${path} as resolved`} title="Mark as resolved" onClick={() => stage([path], true)}><Icon name="check" size={12} /></button>, () => onOpen(path)))}
        {!state.files.length && <div className="pane-empty small">No changes.</div>}
        {staged.length > 0 && <div className="git-title">Staged<button className="link" onClick={() => stage(staged.map((f) => f.path), false)}>Unstage all</button></div>}
        {staged.map((f) => row(f.path, f.code[0], <button className="icon-btn" aria-label={`Unstage ${f.path}`} title="Unstage" onClick={() => stage([f.path], false)}><Icon name="close" size={12} /></button>, () => onDiff(f.path, 'staged')))}
        {unstaged.length > 0 && <div className="git-title">Changes<button className="link" onClick={() => stage(unstaged.map((f) => f.path), true)}>Stage all</button></div>}
        {unstaged.map((f) => row(f.path, f.code[1], (
          <>
            <button className="icon-btn" aria-label={`Discard ${f.path}`} title="Discard changes" onClick={() => { if (window.confirm(`Discard your changes to ${f.path}?`)) void api.gitDiscard(f.path).then(refresh).catch(onError) }}><Icon name="undo" size={12} /></button>
            <button className="icon-btn" aria-label={`Stage ${f.path}`} title="Stage" onClick={() => stage([f.path], true)}><Icon name="plus" size={12} /></button>
          </>
        ), () => onDiff(f.path)))}
        {details && <Stashes details={details} canSave={state.files.length > 0} onChanged={refresh} onError={onError} />}
        {details && <PullRequests branch={state.branch} onChanged={refresh} onError={onError} />}
      </div>
    </div>
  )
}
