import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { UiItem } from '../shared/types'
import type { ChangeState } from './changes'
import type { ChatMessage } from './model'

export interface Chat {
  id: string
  title: string
  updatedAt: number
  history: ChatMessage[]
  items: UiItem[]
  /** The Claude Code session this came from, so importing twice doesn't duplicate it. */
  importedFrom?: string
}

export interface SavedSession {
  chats: Chat[]
  activeChat: string
  changes: ChangeState
}

const fileFor = (dir: string, root: string) => path.join(dir, `${createHash('sha1').update(root).digest('hex')}.json`)
const chatDirFor = (dir: string, root: string) => fileFor(dir, root).slice(0, -'.json'.length)

function writeAtomic(file: string, text: string): void {
  fs.writeFileSync(`${file}.tmp`, text)
  fs.renameSync(`${file}.tmp`, file)
}

/** Reads the current layout, one file per chat, and the older one that kept everything in a single file. */
export function loadSession(dir: string, root: string): SavedSession | null {
  try {
    const saved = JSON.parse(fs.readFileSync(fileFor(dir, root), 'utf8'))
    if (!saved.chats) return null
    if (saved.version !== 2) return saved
    const folder = chatDirFor(dir, root)
    const chats = saved.chats.map((meta: Omit<Chat, 'history' | 'items'>) => {
      try {
        return { ...meta, ...JSON.parse(fs.readFileSync(path.join(folder, `${meta.id}.json`), 'utf8')) }
      } catch {
        return { ...meta, history: [], items: [] }
      }
    })
    return { chats, activeChat: saved.activeChat, changes: saved.changes }
  } catch {
    return null
  }
}

/**
 * Written to temporary files first, so a crash mid-save cannot damage the last good copy.
 * Only the chat being used is written, plus any that have no file yet, so a long history doesn't slow every save.
 */
export function saveSession(dir: string, root: string, session: SavedSession): void {
  const folder = chatDirFor(dir, root)
  fs.mkdirSync(folder, { recursive: true })
  const keep = new Set<string>()
  for (const chat of session.chats) {
    const name = `${chat.id}.json`
    keep.add(name)
    const file = path.join(folder, name)
    if (chat.id === session.activeChat || !fs.existsSync(file)) writeAtomic(file, JSON.stringify({ history: chat.history, items: chat.items }))
  }
  for (const name of fs.readdirSync(folder)) if (!keep.has(name)) fs.rmSync(path.join(folder, name), { force: true })
  const chats = session.chats.map(({ history: _history, items: _items, ...meta }) => meta)
  writeAtomic(fileFor(dir, root), JSON.stringify({ version: 2, chats, activeChat: session.activeChat, changes: session.changes }))
}
