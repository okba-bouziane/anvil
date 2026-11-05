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

export function loadSession(dir: string, root: string): SavedSession | null {
  try {
    const saved = JSON.parse(fs.readFileSync(fileFor(dir, root), 'utf8'))
    return saved.chats ? saved : null
  } catch {
    return null
  }
}

/** Written to a temporary file first, so a crash mid-save cannot damage the last good copy. */
export function saveSession(dir: string, root: string, session: SavedSession): void {
  fs.mkdirSync(dir, { recursive: true })
  const file = fileFor(dir, root)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(session))
  fs.renameSync(`${file}.tmp`, file)
}
