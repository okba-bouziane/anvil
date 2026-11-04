import { execFile } from 'node:child_process'
import type { BlameLine, CommitFile, CommitInfo, GitStatus } from '../shared/types'

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

const isSha = (sha: string) => /^[0-9a-f]{7,40}$/i.test(sha)

/** Commits on every branch, newest first. With a path, only commits that changed that file. */
export async function log(root: string, limit: number, path?: string): Promise<CommitInfo[]> {
  const args = ['log', '--date-order', `-n${Math.min(limit, 2000)}`, '--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e']
  if (path) args.push('--follow', '--', path)
  else args.push('--all')
  const out = await git(root, args, 30000).catch((err: Error) => {
    if (/does not have any commits|bad default revision/.test(err.message)) return ''
    throw err
  })
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((record) => {
    const [sha, parents, author, time, refs, subject] = record.split('\x1f')
    return {
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      time: Number(time),
      refs: refs ? refs.split(', ').map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== 'HEAD' && !r.endsWith('/HEAD')) : [],
      subject
    }
  })
}

export async function commitFiles(root: string, sha: string): Promise<CommitFile[]> {
  if (!isSha(sha)) throw new Error('That is not a commit')
  const entries = (await git(root, ['show', '--format=', '--name-status', '-z', '--first-parent', '-m', sha])).split('\0').filter(Boolean)
  const out: CommitFile[] = []
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i]
    if (status[0] === 'R' || status[0] === 'C') {
      out.push({ status: status[0], path: entries[i + 2] })
      i += 2
    } else {
      out.push({ status: status[0], path: entries[i + 1] })
      i++
    }
  }
  return out
}

export async function commitDiff(root: string, sha: string, path: string): Promise<{ original: string; modified: string }> {
  if (!isSha(sha)) throw new Error('That is not a commit')
  const read = (rev: string) => git(root, ['show', `${rev}:${path}`]).catch(() => '')
  return { original: await read(`${sha}^`), modified: await read(sha) }
}

/** Who last changed each line of a file. */
export async function blame(root: string, path: string): Promise<BlameLine[]> {
  const out = await git(root, ['blame', '--line-porcelain', '--', path], 30000)
  const commits = new Map<string, Omit<BlameLine, 'line'>>()
  const lines: BlameLine[] = []
  let current: { sha: string; line: number } | null = null
  let author = ''
  let time = 0
  let subject = ''
  for (const row of out.split('\n')) {
    const head = row.match(/^([0-9a-f]{40}) \d+ (\d+)/)
    if (head) {
      current = { sha: head[1], line: Number(head[2]) }
    } else if (row.startsWith('author ')) author = row.slice(7)
    else if (row.startsWith('author-time ')) time = Number(row.slice(12))
    else if (row.startsWith('summary ')) subject = row.slice(8)
    else if (row.startsWith('\t') && current) {
      const info = commits.get(current.sha) ?? { sha: current.sha, author, time, subject }
      commits.set(current.sha, info)
      lines.push({ ...info, line: current.line })
    }
  }
  return lines
}

export async function branches(root: string): Promise<{ current: string | null; all: string[] }> {
  const out = await git(root, ['branch', '--format=%(HEAD)%(refname:short)'])
  const rows = out.split('\n').filter(Boolean)
  return { current: rows.find((r) => r[0] === '*')?.slice(1) ?? null, all: rows.map((r) => r.slice(1)).filter((r) => !r.startsWith('(')) }
}

const validBranch = (name: string) => /^[^\s~^:?*[\\-][^\s~^:?*[\\]*$/.test(name) && !name.includes('..')

export async function checkout(root: string, name: string, create: boolean): Promise<void> {
  if (!validBranch(name)) throw new Error('That is not a valid branch name')
  await git(root, create ? ['checkout', '-b', name] : ['checkout', name, '--'])
}
