import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentMode, ChatSummary, Checkpoint, Effort, OpenAiEffort, Settings, Stats, UiItem } from '../../shared/types'
import { isCloud, PROVIDER_LABEL } from '../../shared/types'
import { Icon } from './Icon'
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
        return part.trim() ? <p key={i}>{inline(part.trim())}</p> : null
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

function ChatList({ chats, active, onPick, onDelete, onClose }: { chats: ChatSummary[]; active: string; onPick(id: string): void; onDelete(id: string): void; onClose(): void }) {
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
  onOpenFile(path: string): void
  onError(e: unknown): void
  onNewChat(): void
  onSwitchChat(id: string): void
  onDeleteChat(id: string): void
  onSetting(patch: Partial<Settings>): void
  onOpenModels(): void
  onBeforeSend(): Promise<void>
}

export function Chat(p: ChatProps) {
  const { items, busy, live, settings, hasProject, ready, onError } = p
  const [text, setText] = useState('')
  const [mode, setMode] = useState<AgentMode>('agent')
  const [showChats, setShowChats] = useState(false)
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
      <div className="chat-head">
        <button className="ghost chat-title" onClick={() => setShowChats(!showChats)} disabled={!hasProject}>
          <Icon name="history" size={14} />
          <span>{p.chats.find((c) => c.id === p.activeChat)?.title ?? 'Chat'}</span>
        </button>
        <button className="icon-btn" aria-label="New chat" title={`New chat (${MOD}N)`} disabled={busy || !hasProject} onClick={p.onNewChat}><Icon name="plus" /></button>
        {showChats && <ChatList chats={p.chats} active={p.activeChat} onClose={() => setShowChats(false)} onPick={(id) => { setShowChats(false); p.onSwitchChat(id) }} onDelete={p.onDeleteChat} />}
      </div>

      <div className="chat-list" ref={list} onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}>
        {!items.length && (
          <div className="chat-empty">
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
          <span className="pulse" />
          {live.waiting ? 'Waiting for the model…' : <span>Writing <b>{live.tokensPerSecond.toFixed(1)}</b> tokens/s · {live.tokens} tokens</span>}
        </div>
      )}

      <div className="composer">
        {matches.length > 0 && (
          <div className="popover mention-popover">
            {matches.map((f, i) => (
              <div key={f} className={`pop-row ${i === mentionAt ? 'selected' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickMention(f) }}>
                <Icon name="file" size={13} /><span className="pop-title">{f}</span>
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
                {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((v) => <option key={v} value={v}>{v} effort</option>)}
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
