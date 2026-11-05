import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { BlameLine, CommitFile, CommitInfo, GitDetails, GitOperation, GitStatus, PullRequest } from '../shared/types'

/** Paths always go after `--` as separate arguments, so a file name can never act as an option. */
function git(root: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    // No optional locks: a plain `git status` must not touch the index, or watching the folder would loop.
    execFile('git', args, { cwd: root, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
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
export const indexVersion = (root: string, path: string) => git(root, ['show', `:${path}`]).catch(() => headVersion(root, path))

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

/* Everything below acts only when you ask for it, from the Git panel or the commit tree. */

const needSha = (sha: string) => {
  if (!isSha(sha)) throw new Error('That is not a commit')
  return sha
}
const needRef = (name: string) => {
  if (!validBranch(name)) throw new Error(`"${name}" is not a valid name`)
  return name
}
const quiet = (p: Promise<unknown>) => p.then(() => undefined)

/** Network commands can't ask for a password here, so they say so instead of hanging. */
function network(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return resolve(`${stdout}${stderr}`.trim())
      const text = (stderr || err.message).trim()
      if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)/.test(text)) reject(new Error(`Git couldn't sign in to the remote. Run "git ${args[0]}" once in the terminal to sign in, then try again.`))
      else reject(new Error(text))
    })
  })
}

async function gitDir(root: string): Promise<string> {
  const dir = (await git(root, ['rev-parse', '--git-dir'])).trim()
  return path.resolve(root, dir)
}

export async function operation(root: string): Promise<GitOperation> {
  const dir = await gitDir(root)
  if (fs.existsSync(path.join(dir, 'rebase-merge')) || fs.existsSync(path.join(dir, 'rebase-apply'))) return 'rebase'
  if (fs.existsSync(path.join(dir, 'MERGE_HEAD'))) return 'merge'
  if (fs.existsSync(path.join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (fs.existsSync(path.join(dir, 'REVERT_HEAD'))) return 'revert'
  return null
}

export async function details(root: string): Promise<GitDetails> {
  const [op, local, remote, stashOut, remotes, conflictOut, lastMessage] = await Promise.all([
    operation(root),
    git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(committerdate:unix)%1f%(subject)']).catch(() => ''),
    git(root, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)%1f%(symref)']).catch(() => ''),
    git(root, ['stash', 'list', '--format=%gd%x1f%s%x1f%ct']).catch(() => ''),
    git(root, ['remote']).catch(() => ''),
    git(root, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => ''),
    git(root, ['log', '-1', '--format=%B']).catch(() => '')
  ])
  return {
    operation: op,
    conflicts: conflictOut.split('\0').filter(Boolean),
    branches: local.split('\n').filter(Boolean).map((row) => {
      const [name, upstream, track, head, time, subject] = row.split('\x1f')
      return {
        name,
        upstream: upstream || null,
        current: head === '*',
        ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0),
        behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0),
        time: Number(time),
        subject
      }
    }).sort((a, b) => b.time - a.time),
    remoteBranches: remote.split('\n').filter(Boolean).map((row) => row.split('\x1f')).filter(([, symref]) => !symref).map(([name]) => name).filter((name) => name.includes('/')),
    stashes: stashOut.split('\n').filter(Boolean).map((row, index) => {
      const [, message, time] = row.split('\x1f')
      return { index, message, time: Number(time) }
    }),
    remotes: remotes.split('\n').filter(Boolean),
    lastMessage: lastMessage.trim()
  }
}

export const fetchAll = (root: string) => network(root, ['fetch', '--all', '--prune'])
export const pullRebase = (root: string) => network(root, ['pull', '--rebase'])

export async function pushCurrent(root: string, force = false): Promise<string> {
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then(() => true, () => false)
  const lease = force ? ['--force-with-lease'] : []
  if (upstream) return network(root, ['push', ...lease])
  const remote = (await git(root, ['remote'])).split('\n').filter(Boolean)
  if (!remote.length) throw new Error('This repository has no remote to push to. Add one first, for example with "git remote add origin <url>" in the terminal.')
  return network(root, ['push', ...lease, '-u', remote.includes('origin') ? 'origin' : remote[0], 'HEAD'])
}

export const amend = (root: string, message: string) => quiet(git(root, message.trim() ? ['commit', '--amend', '-m', message] : ['commit', '--amend', '--no-edit']))

/** Merge and rebase can stop on conflicts. That isn't a failure: the panel then shows what to resolve. */
async function mayConflict(root: string, args: string[]): Promise<void> {
  try {
    await git(root, args, 60_000)
  } catch (error) {
    if (await operation(root)) return
    throw error
  }
}

export const merge = async (root: string, name: string) => mayConflict(root, ['merge', '--no-edit', needRef(name)])
export const rebase = async (root: string, name: string) => mayConflict(root, ['rebase', needRef(name)])
export const cherryPick = async (root: string, sha: string) => mayConflict(root, ['cherry-pick', needSha(sha)])
export const revert = async (root: string, sha: string) => mayConflict(root, ['revert', '--no-edit', needSha(sha)])

export async function abortOperation(root: string): Promise<void> {
  const op = await operation(root)
  if (!op) return
  await git(root, [op, '--abort'], 60_000)
}

export async function continueOperation(root: string): Promise<void> {
  const op = await operation(root)
  if (!op) return
  await new Promise<void>((resolve, reject) => {
    execFile('git', [op, '--continue'], { cwd: root, timeout: 60_000, env: { ...process.env, GIT_EDITOR: 'true' } }, async (err, stdout, stderr) => {
      if (!err) return resolve()
      // A rebase moves on to the next commit, which may stop on its own conflicts.
      const stillGoing = await operation(root).catch(() => null)
      const conflicted = stillGoing && (await git(root, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim()
      if (conflicted) return resolve()
      reject(new Error((stderr || stdout || err.message).trim()))
    })
  })
}

export const deleteBranch = async (root: string, name: string, force: boolean) => quiet(git(root, ['branch', force ? '-D' : '-d', needRef(name)]))
export const renameBranch = async (root: string, from: string, to: string) => quiet(git(root, ['branch', '-m', needRef(from), needRef(to)]))
export const branchAt = async (root: string, name: string, sha: string) => quiet(git(root, ['checkout', '-b', needRef(name), needSha(sha)]))
export const checkoutSha = async (root: string, sha: string) => quiet(git(root, ['checkout', needSha(sha)]))
/** Switching to origin/feature makes a local feature branch that follows it. */
export const checkoutRemote = async (root: string, remoteName: string) => quiet(git(root, ['checkout', '--track', needRef(remoteName)]))
export const tag = async (root: string, name: string, sha: string) => quiet(git(root, ['tag', needRef(name), needSha(sha)]))
export const reset = async (root: string, sha: string, mode: 'soft' | 'mixed' | 'hard') => {
  if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Unknown reset mode')
  return quiet(git(root, ['reset', `--${mode}`, needSha(sha)]))
}

export const stashPush = (root: string, message: string) => quiet(git(root, message.trim() ? ['stash', 'push', '--include-untracked', '-m', message] : ['stash', 'push', '--include-untracked']))
const stashRef = (index: number) => {
  if (!Number.isInteger(index) || index < 0) throw new Error('That stash no longer exists')
  return `stash@{${index}}`
}
export const stashApply = async (root: string, index: number) => mayConflictStash(root, ['stash', 'apply', stashRef(index)])
export const stashPop = async (root: string, index: number) => mayConflictStash(root, ['stash', 'pop', stashRef(index)])
export const stashDrop = async (root: string, index: number) => quiet(git(root, ['stash', 'drop', stashRef(index)]))

async function mayConflictStash(root: string, args: string[]): Promise<void> {
  try {
    await git(root, args, 60_000)
  } catch (error) {
    const conflicted = (await git(root, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim()
    if (!conflicted) throw error
  }
}

/** Stages one block of a change. The patch is built from the two versions on screen. */
export function applyPatch(root: string, patch: string, target: 'index' | 'tree', reverse = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['apply', ...(target === 'index' ? ['--cached'] : []), ...(reverse ? ['-R'] : []), '--unidiff-zero', '--whitespace=nowarn', '-']
    const child = execFile('git', args, { cwd: root, timeout: 15000 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve()
    })
    child.stdin?.end(patch)
  })
}

/* Pull requests go through GitHub's own `gh` tool, so Anvil never sees your GitHub password or token. */

function gh(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd: root, timeout: 30000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('NO_GH'))
      reject(new Error((stderr || err.message).trim()))
    })
  })
}

export async function pullRequests(root: string): Promise<{ state: 'ok' | 'no-gh' | 'error'; message?: string; list: PullRequest[] }> {
  try {
    const out = await gh(root, ['pr', 'list', '--limit', '30', '--json', 'number,title,headRefName,author,url,isDraft,reviewDecision,updatedAt'])
    const rows = JSON.parse(out) as { number: number; title: string; headRefName: string; author?: { login?: string }; url: string; isDraft: boolean; reviewDecision: string; updatedAt: string }[]
    return { state: 'ok', list: rows.map((r) => ({ number: r.number, title: r.title, branch: r.headRefName, author: r.author?.login ?? '', url: r.url, draft: r.isDraft, review: r.reviewDecision, updated: Date.parse(r.updatedAt) / 1000 })) }
  } catch (error) {
    const message = (error as Error).message
    if (message === 'NO_GH') return { state: 'no-gh', list: [] }
    return { state: 'error', message, list: [] }
  }
}

export const checkoutPullRequest = async (root: string, number: number) => {
  if (!Number.isInteger(number) || number <= 0) throw new Error('That is not a pull request')
  return gh(root, ['pr', 'checkout', String(number)]).then(() => undefined)
}

export async function createPullRequest(root: string, title: string, body: string, draft: boolean): Promise<string> {
  const args = ['pr', 'create', '--title', title, '--body', body]
  if (draft) args.push('--draft')
  return (await gh(root, args)).trim()
}

/** Clones into a new folder named after the repository, and returns that folder. */
export async function clone(parent: string, url: string): Promise<string> {
  const name = url.replace(/\.git\/?$/, '').split(/[/:]/).pop()
  if (!name || name.startsWith('.') || name.startsWith('-')) throw new Error('That is not a repository address.')
  const target = path.join(parent, name)
  if (fs.existsSync(target)) throw new Error(`${target} already exists.`)
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['clone', '--', url, target], { timeout: 600_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, _out, stderr) => {
      if (err) reject(new Error(/could not read Username|Authentication failed|terminal prompts disabled|Permission denied/.test(stderr) ? 'Git couldn\'t sign in. Run the clone once in a terminal to sign in, then try again.' : (stderr || err.message).trim()))
      else resolve()
    })
  })
  return target
}
