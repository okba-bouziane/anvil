import { execFile } from 'node:child_process'
import type { GitStatus } from '../shared/types'

/** Paths always go after `--` as separate arguments, so a file name can never act as an option. */
function git(root: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

export async function status(root: string): Promise<GitStatus> {
  let out: string
  try {
    out = await git(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
  } catch {
    return { isRepo: false, branch: null, ahead: 0, behind: 0, files: [] }
  }
  const entries = out.split('\0').filter(Boolean)
  const head = entries[0]?.startsWith('## ') ? entries.shift()!.slice(3) : ''
  const branch = head.replace(/^No commits yet on /, '').split('...')[0].split(' ')[0] || null
  const files: GitStatus['files'] = []
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2)
    files.push({ path: entries[i].slice(3), code })
    if (code[0] === 'R' || code[0] === 'C') i++ // the old name follows a rename
  }
  return { isRepo: true, branch, ahead: Number(head.match(/ahead (\d+)/)?.[1] ?? 0), behind: Number(head.match(/behind (\d+)/)?.[1] ?? 0), files }
}

export const init = (root: string) => git(root, ['init']).then(() => undefined)

export async function stage(root: string, paths: string[], add: boolean): Promise<void> {
  if (add) await git(root, ['add', '--', ...paths])
  else await git(root, ['reset', '-q', 'HEAD', '--', ...paths]).catch(() => git(root, ['rm', '-q', '--cached', '--', ...paths]))
}

/** Puts a file back as it was in the last commit. A file git has never seen is left for the caller to trash. */
export async function discard(root: string, path: string): Promise<boolean> {
  const tracked = await git(root, ['ls-files', '--error-unmatch', '--', path]).then(() => true, () => false)
  if (!tracked) return false
  await git(root, ['checkout', 'HEAD', '--', path])
  return true
}

export const commit = (root: string, message: string) => git(root, ['commit', '-m', message]).then(() => undefined)

export const sync = (root: string, action: 'pull' | 'push') => git(root, [action], 120_000).then((o) => o.trim())

export const headVersion = (root: string, path: string) => git(root, ['show', `HEAD:${path}`]).catch(() => '')
