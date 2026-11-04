import { useCallback, useEffect, useState } from 'react'
import type { GitStatus, ScriptEntry, SearchHit } from '../../shared/types'
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

const LABEL: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'new', U: 'conflict' }

export function GitPanel({ revision, onDiff, onBranch, onError }: { revision: number; onDiff(path: string): void; onBranch(branch: string | null): void; onError(e: unknown): void }) {
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
