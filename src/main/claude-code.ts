import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where the official Claude Code tool is installed, if it is. Anvil only opens it; signing in stays inside that tool. */
export function findClaude(home = os.homedir(), pathValue = process.env.PATH ?? '', exists: (file: string) => boolean = fs.existsSync, windows = process.platform === 'win32'): string | null {
  const name = windows ? 'claude.exe' : 'claude'
  const places = [path.join(home, '.local', 'bin', name), ...(windows ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']), ...pathValue.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name))]
  return places.find(exists) ?? null
}

/** The line typed into the terminal. */
export function claudeCommand(file: string, windows = process.platform === 'win32'): string {
  return windows ? `& "${file}"` : `'${file.replace(/'/g, `'\\''`)}'`
}
