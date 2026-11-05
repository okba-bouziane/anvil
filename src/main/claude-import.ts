import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { UiItem } from '../shared/types'
import type { ChatMessage } from './model'

export interface ClaudeSessionInfo {
  id: string
  title: string
  project: string
  folder: string
  updatedAt: number
  sizeMb: number
}

const WINDOW = 256 * 1024
const MAX_ITEMS = 1500
const MAX_LINE = 32 * 1024 * 1024

export const claudeProjectsDir = (home = os.homedir()) => path.join(home, '.claude', 'projects')

/** Claude Code names a project's folder after its path, with everything but letters and digits as dashes. */
export const claudeFolderFor = (root: string) => root.replace(/[^a-zA-Z0-9]/g, '-')

/** Takes out what the tool added around a message. Returns '' when nothing the person wrote is left. */
export function cleanUserText(text: string): string {
  if (/<(local-command-[a-z]+|task-notification|command-name)>/.test(text)) return ''
  return text.replace(/<(system-reminder|ide_[a-z_]+)[^>]*>[\s\S]*?<\/\1>/g, '').trim()
}

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }
interface Line {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  customTitle?: string
  cwd?: string
  timestamp?: string
  message?: { content?: string | Block[] }
}

function parse(line: string): Line | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function userTextOf(line: Line): string {
  if (line.type !== 'user' || line.isSidechain || line.isMeta || line.isCompactSummary) return ''
  const content = line.message?.content
  const text = typeof content === 'string' ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
  return cleanUserText(text)
}

function toolSummary(input: Record<string, unknown> = {}): string {
  const value = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description'].map((k) => input[k]).find((v) => typeof v === 'string')
  return String(value ?? '').split('\n')[0].slice(0, 120)
}

/** Reads the start and end of a file only, so listing stays quick however large the sessions are. */
function peek(file: string, size: number): { head: string[]; tail: string[] } {
  const fd = fs.openSync(file, 'r')
  try {
    const read = (from: number, length: number) => {
      const buffer = Buffer.alloc(length)
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, from)).toString('utf8')
    }
    const start = read(0, Math.min(WINDOW, size))
    const end = size > WINDOW ? read(Math.max(WINDOW, size - WINDOW), Math.min(WINDOW, size - WINDOW)) : ''
    const head = start.split('\n')
    if (size > WINDOW) head.pop() // cut off partway
    const tail = end.split('\n').slice(1)
    return { head, tail }
  } finally {
    fs.closeSync(fd)
  }
}

export function listClaudeSessions(dir = claudeProjectsDir()): ClaudeSessionInfo[] {
  const out: ClaudeSessionInfo[] = []
  let folders: fs.Dirent[] = []
  try {
    folders = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }
  for (const folder of folders) {
    let names: string[] = []
    try {
      names = fs.readdirSync(path.join(dir, folder.name)).filter((n) => n.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const file = path.join(dir, folder.name, name)
        const stat = fs.statSync(file)
        if (!stat.size) continue
        const { head, tail } = peek(file, stat.size)
        let cwd = ''
        let first = ''
        let custom = ''
        for (const raw of [...head, ...tail]) {
          const line = raw.includes('"cwd"') || raw.includes('"custom-title"') || raw.includes('"user"') ? parse(raw) : null
          if (!line) continue
          cwd ||= line.cwd ?? ''
          if (line.type === 'custom-title' && line.customTitle) custom = line.customTitle
          if (!first) first = userTextOf(line)
        }
        const title = (custom || first).split('\n')[0].slice(0, 80)
        if (!title) continue
        out.push({ id: `${folder.name}/${name.slice(0, -6)}`, title, project: cwd ? path.basename(cwd) : folder.name, folder: folder.name, updatedAt: stat.mtimeMs, sizeMb: Math.round((stat.size / 1048576) * 10) / 10 })
      } catch {
        /* one unreadable session shouldn't hide the rest */
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface ImportedSession {
  title: string
  updatedAt: number
  history: ChatMessage[]
  items: UiItem[]
}

/** Turns an id from the list back into a file, and refuses anything outside the sessions folder. */
export function claudeSessionFile(id: string, dir = claudeProjectsDir()): string {
  const parts = id.split('/')
  if (parts.length !== 2 || parts.some((p) => !p || p === '.' || p === '..' || /[\\]/.test(p))) throw new Error('That session id is not valid.')
  return path.join(dir, parts[0], `${parts[1]}.jsonl`)
}

export async function readClaudeSession(file: string): Promise<ImportedSession> {
  const history: ChatMessage[] = []
  let items: UiItem[] = []
  let custom = ''
  let first = ''
  let n = 0
  const add = (role: 'user' | 'assistant', text: string) => {
    const last = history[history.length - 1]
    if (last?.role === role) last.content += `\n\n${text}`
    else history.push({ role, content: text })
  }
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const raw of lines) {
    if (raw.length > MAX_LINE) continue
    if (!/"type":"(user|assistant|custom-title)"/.test(raw)) continue
    const line = parse(raw)
    if (!line) continue
    if (line.type === 'custom-title' && line.customTitle) custom = line.customTitle
    if (line.isSidechain) continue
    if (line.type === 'user') {
      const text = userTextOf(line)
      if (!text) continue
      first ||= text
      add('user', text)
      items.push({ kind: 'user', id: `i${n++}`, text })
    } else if (line.type === 'assistant') {
      const blocks = line.message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block.type === 'text' && block.text?.trim()) {
          add('assistant', block.text)
          items.push({ kind: 'assistant', id: `i${n++}`, text: block.text })
        } else if (block.type === 'tool_use') {
          items.push({ kind: 'tool', id: `i${n++}`, name: block.name ?? 'tool', summary: toolSummary(block.input), status: 'ok' })
        }
      }
    }
  }
  const note = (text: string): UiItem => ({ kind: 'note', id: `i${n++}`, text })
  if (items.length > MAX_ITEMS) items = [note(`Showing the last ${MAX_ITEMS} of ${items.length} steps. The rest stays in the original session.`), ...items.slice(-MAX_ITEMS)]
  // A model expects a chat to start with the person's message.
  while (history[0]?.role === 'assistant') history.shift()
  const updatedAt = fs.statSync(file).mtimeMs
  return { title: (custom || first || 'Imported session').split('\n')[0].slice(0, 60), updatedAt, history, items: [note('Imported from Claude Code. Earlier file edits aren’t in the review list, and tool results weren’t carried over.'), ...items] }
}
