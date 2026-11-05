import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { AgentMode, ChatSummary, Checkpoint, ClaudeSessionSummary, Effort, FileChange, OpenAiEffort, Settings, Stats, UiItem } from '../../shared/types'
import { isCloud, PROVIDER_LABEL } from '../../shared/types'
import { mdBlocks } from '../../shared/mdblocks'
import { FileIcon, Icon, Logo } from './Icon'
import { MOD } from './keys'

const api = window.anvil

const TOOL: Record<string, { label: string; icon: string }> = {
  read_file: { label: 'Read', icon: 'read' },
  write_file: { label: 'Write', icon: 'file' },
  edit_file: { label: 'Edit', icon: 'edit' },
  list_files: { label: 'List', icon: 'list' },
  search_code: { label: 'Search', icon: 'search' },
  run_command: { label: 'Run', icon: 'terminal' }
}

/** Model text is shown as text, never as HTML. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g)
  return (
    <>
      {parts.map((part, i) => {
        const fence = part.match(/^```([^\n]*)\n([\s\S]*?)(?:```)?$/)
        if (fence) {
          return (
            <div className="code-block" key={i}>
              <div className="code-head">
                <span>{fence[1] || 'code'}</span>
                <button className="icon-btn" aria-label="Copy code" onClick={() => void navigator.clipboard.writeText(fence[2])}><Icon name="copy" size={13} /></button>
              </div>
              <pre>{fence[2]}</pre>
            </div>
          )
        }
        return mdBlocks(part).map((block, j) => {
          const key = `${i}.${j}`
          if (block.kind === 'heading') return <div className={`md-h md-h${Math.min(block.level, 3)}`} key={key}>{inline(block.text)}</div>
          if (block.kind === 'rule') return <hr className="md-rule" key={key} />
          if (block.kind === 'list') {
            const items = block.items.map((item, n) => <li key={n}>{inline(item)}</li>)
            return block.ordered ? <ol key={key} start={block.start}>{items}</ol> : <ul key={key}>{items}</ul>
          }
          if (block.kind === 'table') {
            return (
              <div className="md-table" key={key}>
                <table>
                  <thead><tr>{block.head.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead>
                  <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, n) => <td key={n}>{inline(cell)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )
          }
          return <p key={key}>{inline(block.text)}</p>
        })
      })}
    </>
  )
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    return part
  })
}

const statLine = (s: Stats) => `${s.tokensPerSecond.toFixed(1)} tokens/s · ${s.tokens} token${s.tokens === 1 ? '' : 's'} · first word after ${s.waitSeconds.toFixed(1)} s`

function ToolCard({ item, onOpen }: { item: Extract<UiItem, { kind: 'tool' }>; onOpen(path: string): void }) {
  const running = item.status === 'running'
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLPreElement>(null)
  const output = item.output ?? ''
  const isFile = ['read_file', 'write_file', 'edit_file'].includes(item.name) && item.status === 'ok'
  const meta = TOOL[item.name] ?? { label: item.name, icon: 'chip' }
  useEffect(() => {
    if (running && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [running, output])
  return (
    <div className={`tool ${item.status}`}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon"><Icon name={meta.icon} size={13} /></span>
        <span className="tool-name">{meta.label}</span>
        <span className="tool-summary" title={item.summary}>{item.summary}</span>
        {isFile && <button className="link" onClick={(e) => { e.stopPropagation(); onOpen(item.summary) }}>Open</button>}
      </div>
      {(open || running) && output && <pre ref={body} className={running ? 'live' : ''}>{output}</pre>}
    </div>
  )
}

function Approval({ item, onError }: { item: Extract<UiItem, { kind: 'approval' }>; onError(e: unknown): void }) {
  const answer = (a: 'once' | 'always' | 'deny') => void api.answerApproval(item.id, a).catch(onError)
  return (
    <div className={`approval ${item.status}`}>
      <div className="approval-title"><Icon name="terminal" size={13} />{item.status === 'pending' ? 'Run this command?' : item.status === 'approved' ? 'Command approved' : 'Command not run'}</div>
      <pre>{item.command}</pre>
      {item.status === 'pending' && (
        <>
          <div className="approval-note">Changes made by commands can't be undone from here.</div>
          <div className="row">
            <button className="primary" onClick={() => answer('once')}>Run</button>
            <button onClick={() => answer('always')}>Always run this one</button>
            <button onClick={() => answer('deny')}>Don't run</button>
          </div>
        </>
      )}
    </div>
  )
}

const MODES: { id: AgentMode; label: string; title: string }[] = [
  { id: 'agent', label: 'Agent', title: 'Reads and changes files. Commands ask first.' },
  { id: 'plan', label: 'Plan', title: 'Reads files and writes a plan. Changes nothing.' },
  { id: 'ask', label: 'Ask', title: 'Answers questions. Uses no tools.' }
]

function ImportSessions({ onImport, onClose }: { onImport(ids: string[]): void; onClose(): void }) {
  const [sessions, setSessions] = useState<ClaudeSessionSummary[] | null>(null)
  const [error, setError] = useState('')
  const [everywhere, setEverywhere] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  useEffect(() => {
    api.claudeSessions().then((list) => {
      setSessions(list)
      if (!list.some((s) => s.inThisProject)) setEverywhere(true)
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  const shown = (sessions ?? []).filter((s) => everywhere || s.inThisProject)
  const toggle = (id: string) => setPicked((old) => {
    const next = new Set(old)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const fresh = shown.filter((s) => !s.imported)
  return (
    <div className="modal-wrap top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette import-sessions" role="dialog" aria-label="Import sessions">
        <div className="prompt-title">Import Claude Code sessions into this project</div>
        <div className="import-tabs">
          <button className={everywhere ? '' : 'on'} onClick={() => { setEverywhere(false); setPicked(new Set()) }}>This project</button>
          <button className={everywhere ? 'on' : ''} onClick={() => { setEverywhere(true); setPicked(new Set()) }}>All projects</button>
          <button className="link select-all" disabled={!fresh.length} onClick={() => setPicked(new Set(fresh.map((s) => s.id)))}>Select all</button>
        </div>
        <div className="import-list">
          {error && <div className="pane-empty small">{error}</div>}
          {!sessions && !error && <div className="pane-empty small">Loading…</div>}
          {sessions && !error && !shown.length && <div className="pane-empty small">No Claude Code sessions found.</div>}
          {shown.map((s) => (
            <label key={s.id} className={`import-row ${s.imported ? 'done' : ''}`}>
              <input type="checkbox" disabled={s.imported} checked={s.imported || picked.has(s.id)} onChange={() => toggle(s.id)} />
              <span className="pop-title">{s.title}</span>
              <small>{s.imported ? 'Imported' : `${everywhere ? `${s.project}, ` : ''}${new Date(s.updatedAt).toLocaleDateString()}`}</small>
            </label>
          ))}
        </div>
        <div className="row import-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!picked.size} onClick={() => { onClose(); onImport([...picked]) }}>Import {picked.size || ''}</button>
        </div>
      </div>
    </div>
  )
}

function ChatList({ chats, active, onPick, onDelete, onImport, onClose }: { chats: ChatSummary[]; active: string; onPick(id: string): void; onDelete(id: string): void; onImport(): void; onClose(): void }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="popover chat-popover">
        {chats.map((c) => (
          <div key={c.id} className={`pop-row ${c.id === active ? 'selected' : ''}`} onClick={() => onPick(c.id)}>
            <span className="pop-title">{c.title}</span>
            <button className="icon-btn" aria-label={`Delete chat ${c.title}`} onClick={(e) => { e.stopPropagation(); onDelete(c.id) }}><Icon name="trash" size={13} /></button>
          </div>
        ))}
        <button className="pop-import" onClick={onImport}><Icon name="plus" size={13} />Import sessions</button>
      </div>
    </>
  )
}

export interface ChatProps {
  items: UiItem[]
  chats: ChatSummary[]
  activeChat: string
  checkpoints: Checkpoint[]
  busy: boolean
  live: { tokens: number; tokensPerSecond: number; waiting: boolean }
  context: { tokens: number; limit: number }
  settings: Settings | null
  hasProject: boolean
  ready: boolean
  activeFile: string | null
  files: string[]
  changes: FileChange[]
  selectedFile: string | null
  onOpenFile(path: string): void
  onError(e: unknown): void
  onNewChat(): void
  onImportSessions(ids: string[]): void
  onSwitchChat(id: string): void
  onDeleteChat(id: string): void
  onSetting(patch: Partial<Settings>): void
  onOpenModels(): void
  onBeforeSend(): Promise<void>
}

/** Every file the agent changed, above the chat box. Keep or undo them all, or open the list and handle each file. */
export function ChangesBar({ changes, selected, onOpen, onError }: { changes: FileChange[]; selected: string | null; onOpen(path: string): void; onError(e: unknown): void }) {
  const [open, setOpen] = useState(false)
  if (!changes.length) return null
  const added = changes.reduce((n, c) => n + c.added, 0)
  const removed = changes.reduce((n, c) => n + c.removed, 0)
  const act = (e: MouseEvent, run: () => Promise<unknown>) => {
    e.stopPropagation()
    void run().catch(onError)
  }
  return (
    <div className={`changes-bar ${open ? 'open' : ''}`}>
      <div className="changes-list-wrap"><div className="changes-list" aria-hidden={!open}>
        {changes.map((c) => {
          const slash = c.path.lastIndexOf('/')
          return (
            <div key={c.path} className={`change-row ${selected === c.path ? 'selected' : ''}`} title={c.path} role="button" tabIndex={open ? 0 : -1} onClick={() => onOpen(c.path)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(c.path) }}>
              <FileIcon name={c.path.slice(slash + 1)} />
              <span className="change-name"><b>{c.path.slice(slash + 1)}</b><small>{c.path.slice(0, Math.max(slash, 0))}</small></span>
              <span className="counts"><b className="plus">+{c.added}</b> <b className="minus">−{c.removed}</b></span>
              <span className="change-actions">
                <button className="icon-btn change-keep" tabIndex={open ? 0 : -1} aria-label={`Keep ${c.path}`} title="Keep this file" onClick={(e) => act(e, () => api.acceptFile(c.path))}><Icon name="check" size={13} /></button>
                <button className="icon-btn change-undo" tabIndex={open ? 0 : -1} aria-label={`Undo ${c.path}`} title="Undo this file" onClick={(e) => act(e, () => api.rejectFile(c.path))}><Icon name="undo" size={13} /></button>
              </span>
            </div>
          )
        })}
      </div></div>
      <div className="changes-head">
        <button className="changes-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`tree-caret ${open ? 'open' : ''}`}><Icon name="chevron" size={11} /></span>
          <span className="badge">{changes.length}</span>
          <span>{changes.length === 1 ? 'file changed' : 'files changed'}</span>
          <span className="counts"><b className="plus">+{added}</b> <b className="minus">−{removed}</b></span>
        </button>
        <span className="spacer" />
        <button className="keep" onClick={() => void api.acceptAll().catch(onError)}>Keep all</button>
        <button className="undo" onClick={() => void api.rejectAll().catch(onError)}>Undo all</button>
      </div>
    </div>
  )
}

export function Chat(p: ChatProps) {
  const { items, busy, live, settings, hasProject, ready, onError } = p
  const [text, setText] = useState('')
  const [mode, setMode] = useState<AgentMode>('agent')
  const [showChats, setShowChats] = useState(false)
  const [importing, setImporting] = useState(false)
  const [mentionAt, setMentionAt] = useState(0)
  const [cursor, setCursor] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (stick.current && list.current) list.current.scrollTop = list.current.scrollHeight
  })

  const query = useMemo(() => {
    return text.slice(0, cursor).match(/(?:^|\s)@([\w./-]*)$/)?.[1] ?? null
  }, [text, cursor])
  const matches = useMemo(() => (query === null ? [] : p.files.filter((f) => f.toLowerCase().includes(query.toLowerCase())).slice(0, 7)), [query, p.files])

  const pickMention = (file: string) => {
    const start = text.slice(0, cursor).lastIndexOf('@')
    const next = start + file.length + 2
    setText(`${text.slice(0, start)}@${file} ${text.slice(cursor)}`)
    setCursor(next)
    setMentionAt(0)
    input.current?.focus()
    requestAnimationFrame(() => input.current?.setSelectionRange(next, next))
  }

  const submit = () => {
    const value = text.trim()
    if (!value || busy || !hasProject || !ready) return
    setText('')
    stick.current = true
    // The model should see what's on screen, including edits not saved yet.
    void p.onBeforeSend().then(() => api.send(value, p.activeFile, mode)).catch(onError)
  }

  const percent = Math.min(100, Math.round((p.context.tokens / Math.max(p.context.limit, 1)) * 100))
  const cloud = settings ? isCloud(settings) && settings.provider !== 'custom' : false
  const isRemote = settings ? isCloud(settings) && settings.provider === 'custom' : false
  const modelName = settings ? (settings.models[settings.provider] || 'Pick a model').split('/').pop() : ''

  return (
    <aside className="chat">
      {importing && <ImportSessions onClose={() => setImporting(false)} onImport={p.onImportSessions} />}
      <div className="chat-head">
        <button className="ghost chat-title" onClick={() => setShowChats(!showChats)} disabled={!hasProject}>
          <Icon name="history" size={14} />
          <span>{p.chats.find((c) => c.id === p.activeChat)?.title ?? 'Chat'}</span>
        </button>
        <button className="icon-btn" aria-label="New chat" title={`New chat (${MOD}N)`} disabled={busy || !hasProject} onClick={p.onNewChat}><Icon name="plus" /></button>
        {showChats && <ChatList chats={p.chats} active={p.activeChat} onImport={() => { setShowChats(false); setImporting(true) }} onClose={() => setShowChats(false)} onPick={(id) => { setShowChats(false); p.onSwitchChat(id) }} onDelete={p.onDeleteChat} />}
      </div>

      <div className="chat-list" ref={list} onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}>
        {!items.length && (
          <div className="chat-empty">
            <Logo />
            <h3>{!hasProject ? 'Open a project to start' : ready ? 'What should change?' : 'The agent is optional'}</h3>
            {hasProject && !ready && (
              <>
                <p>The editor, terminal, search and Git all work without a model. To use the agent, set up a local model or add an API key.</p>
                <div className="row no-model">
                  <button className="primary" onClick={p.onOpenModels}>Set up a model</button>
                  <button onClick={() => p.onSetting({ showAgent: false })}>Hide the agent</button>
                </div>
              </>
            )}
            {hasProject && ready && (
              <>
                <p>Edits appear for review as they happen. Type @ to attach a file.</p>
                <div className="suggestions">
                  {['Explain how this project is structured', 'Find bugs in the file I have open', 'Write tests for the file I have open'].map((s) => (
                    <button key={s} onClick={() => { setText(s); input.current?.focus() }}>{s}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {items.map((item) => {
          switch (item.kind) {
            case 'user': return <div className="msg user" key={item.id}>{item.text}</div>
            case 'assistant': return (
              <div className="msg assistant" key={item.id}>
                <Rich text={item.text} />
                {item.stats && <div className="stat">{statLine(item.stats)}</div>}
              </div>
            )
            case 'tool': return <ToolCard key={item.id} item={item} onOpen={p.onOpenFile} />
            case 'approval': return <Approval key={item.id} item={item} onError={onError} />
            case 'check': return <div key={item.id} className={`check ${item.ok ? 'ok' : 'bad'}`}><Icon name={item.ok ? 'check' : 'warn'} size={13} /><pre>{item.text}</pre></div>
            case 'error': return <div key={item.id} className="check bad"><Icon name="warn" size={13} /><pre>{item.text}</pre></div>
            case 'note': return <div key={item.id} className="stat">{item.text}</div>
            case 'checkpoint': {
              const cp = p.checkpoints.find((c) => c.id === item.checkpointId)
              if (!cp) return null
              return (
                <div className="checkpoint" key={item.id}>
                  <span>{cp.undone ? 'This step was undone' : `${cp.files.length} file${cp.files.length > 1 ? 's' : ''} changed in this step`}</span>
                  {!cp.undone && <button disabled={busy} onClick={() => void api.undoCheckpoint(cp.id).catch(onError)}><Icon name="undo" size={13} />Undo this step</button>}
                </div>
              )
            }
          }
        })}
      </div>

      {busy && (
        <div className="live-bar">
          <Logo motion="working" />
          {items.some((i) => i.kind === 'approval' && i.status === 'pending') ? 'Waiting for your answer' : live.waiting ? 'Waiting for the model…' : <span>Writing <b>{live.tokensPerSecond.toFixed(1)}</b> tokens/s · {live.tokens} tokens</span>}
        </div>
      )}

      <div className="composer">
        <ChangesBar changes={p.changes} selected={p.selectedFile} onOpen={p.onOpenFile} onError={onError} />
        {matches.length > 0 && (
          <div className="popover mention-popover">
            {matches.map((f, i) => (
              <div key={f} className={`pop-row ${i === mentionAt ? 'selected' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickMention(f) }}>
                <FileIcon name={f.split('/').pop() ?? f} /><span className="pop-title">{f}</span>
              </div>
            ))}
          </div>
        )}
        <div className="composer-card">
          <textarea
            ref={input}
            value={text}
            placeholder={ready ? 'Ask for a change. @ attaches a file.' : 'Set up a model to use the agent'}
            disabled={!hasProject}
            rows={3}
            onChange={(e) => { setText(e.target.value); setCursor(e.target.selectionStart); setMentionAt(0) }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (matches.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setMentionAt((mentionAt + 1) % matches.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setMentionAt((mentionAt - 1 + matches.length) % matches.length); return }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(matches[mentionAt]); return }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-row">
            <div className="segmented" role="group" aria-label="Mode">
              {MODES.map((m) => <button key={m.id} className={mode === m.id ? 'active' : ''} title={m.title} onClick={() => setMode(m.id)}>{m.label}</button>)}
            </div>
            <button className="ghost model-chip" title="Change model" onClick={p.onOpenModels}>
              <Icon name={cloud ? 'cloud' : 'chip'} size={13} /><span>{modelName}</span>
            </button>
            {settings?.provider === 'anthropic' && (
              <select className="effort" id="effort-quick" aria-label="Effort" title="Effort: higher thinks longer and costs more" value={settings.effort} onChange={(e) => p.onSetting({ effort: e.target.value as Effort })}>
                {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((v) => <option key={v} value={v}>{v === 'xhigh' ? 'Extra high' : v[0].toUpperCase() + v.slice(1)} effort</option>)}
              </select>
            )}
            {settings?.provider === 'openai' && (
              <select className="effort" id="effort-quick" aria-label="Effort" title="Effort: for models that support it. Higher thinks longer and costs more" value={settings.openaiEffort} onChange={(e) => p.onSetting({ openaiEffort: e.target.value as OpenAiEffort })}>
                {(['default', 'minimal', 'low', 'medium', 'high'] as OpenAiEffort[]).map((v) => <option key={v} value={v}>{v === 'default' ? 'default effort' : `${v} effort`}</option>)}
              </select>
            )}
            <span className="spacer" />
            {p.context.limit > 0 && <span className="meter" title={`About ${p.context.tokens.toLocaleString()} of ${p.context.limit.toLocaleString()} tokens of context used`} style={{ '--p': `${percent}%` } as React.CSSProperties} />}
            {busy
              ? <button className="send stop" aria-label="Stop" title="Stop" onClick={() => void api.cancel().catch(onError)}><Icon name="stop" size={14} /></button>
              : <button className="send" aria-label="Send" disabled={!text.trim() || !hasProject || !ready} onClick={submit}><Icon name="send" size={15} /></button>}
          </div>
        </div>
        <div className="composer-foot">
          {settings && (
            <>
              <label className="toggle" title="Edits are kept without review. You can still undo a whole step.">
                <input type="checkbox" checked={settings.autoAcceptEdits} onChange={(e) => p.onSetting({ autoAcceptEdits: e.target.checked })} /><span className="switch" />Auto-accept edits
              </label>
              <label className="toggle" title="Commands run without asking. The model could run anything on this computer.">
                <input type="checkbox" checked={settings.autoRunCommands} onChange={(e) => p.onSetting({ autoRunCommands: e.target.checked })} /><span className="switch" />Auto-run commands
              </label>
              <span className="spacer" />
              <span className={cloud ? 'where cloud' : 'where'}>{cloud ? `Sends code to ${PROVIDER_LABEL[settings.provider]}` : isRemote ? 'Sends code to your server' : 'Stays local'}</span>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
