import os from 'node:os'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import type { TerminalEvent } from '../shared/types'
import { interactiveShell } from './platform'

/** Real shells for the Terminal panel. They run as the user, like any other terminal app. */
export class Terminals {
  private shells = new Map<string, pty.IPty>()

  constructor(private emit: (event: TerminalEvent) => void) {}

  create(cwd: string): string {
    const id = randomUUID().slice(0, 8)
    const { file, args } = interactiveShell()
    const term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cwd: cwd || os.homedir(),
      cols: 100,
      rows: 24,
      env: { ...process.env, TERM_PROGRAM: 'Anvil' } as Record<string, string>
    })
    term.onData((data) => this.emit({ type: 'data', id, data }))
    term.onExit(() => {
      this.shells.delete(id)
      this.emit({ type: 'exit', id })
    })
    this.shells.set(id, term)
    return id
  }

  write(id: string, data: string): void {
    this.shells.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.shells.get(id)?.resize(cols, rows)
  }

  kill(id: string): void {
    this.shells.get(id)?.kill()
    this.shells.delete(id)
  }

  killAll(): void {
    for (const id of [...this.shells.keys()]) this.kill(id)
  }
}
