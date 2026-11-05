import fs from 'node:fs'
import path from 'node:path'

const KEPT = ['settings.json', 'ui-state.json', 'vscode-import.json', 'sessions', 'extensions', 'recovery']

/**
 * This app used to be called Anvil, in another data folder. A first launch brings its settings and chats across.
 * Saved API keys stay behind: they're encrypted to the old app name, so people enter them once more.
 */
export function migrateOldData(from: string, to: string): boolean {
  if (from === to || fs.existsSync(path.join(to, 'settings.json')) || !fs.existsSync(path.join(from, 'settings.json'))) return false
  fs.mkdirSync(to, { recursive: true })
  for (const name of KEPT) {
    const source = path.join(from, name)
    if (fs.existsSync(source)) fs.cpSync(source, path.join(to, name), { recursive: true })
  }
  return true
}
