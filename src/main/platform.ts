import { spawn, execFile, type ChildProcess, type StdioOptions } from 'node:child_process'
import path from 'node:path'

const isWindows = process.platform === 'win32'

/** Paths inside a project always use forward slashes, whatever the system uses. */
export const toPosix = (p: string) => (path.sep === '/' ? p : p.split(path.sep).join('/'))

/** MLX, the fast local model option, only runs on Apple Silicon. */
export const canRunMlx = () => process.platform === 'darwin' && process.arch === 'arm64'

/** Runs a command line in the system's shell, as its own process group so it can be stopped as a whole. */
export function spawnShell(command: string, cwd: string | undefined, stdio: StdioOptions): ChildProcess {
  if (isWindows) return spawn(command, { shell: true, cwd, stdio, windowsHide: true })
  const shell = process.platform === 'darwin' ? '/bin/zsh' : process.env.SHELL || '/bin/bash'
  return spawn(shell, ['-lc', command], { cwd, detached: true, stdio })
}

export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (isWindows) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

/** The shell for the Terminal panel. */
export function interactiveShell(): { file: string; args: string[] } {
  if (isWindows) return { file: 'powershell.exe', args: ['-NoLogo'] }
  return { file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] }
}
