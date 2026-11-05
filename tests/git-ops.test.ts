import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as git from '../src/main/git'
import { findConflicts, resolvedLines } from '../src/shared/conflicts'
import { blockPatch } from '../src/shared/patch'

let root = ''
const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const write = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text)
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8')
const commitAll = (message: string) => { run('add', '.'); run('commit', '-qm', message) }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-git-'))
  run('init', '-qb', 'main')
  run('config', 'user.email', 'dev@example.com')
  run('config', 'user.name', 'Dev')
  run('config', 'core.autocrlf', 'false')
  write('a.txt', 'one\ntwo\nthree\n')
  commitAll('first')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function conflict() {
  run('checkout', '-qb', 'side')
  write('a.txt', 'one\nSIDE\nthree\n')
  commitAll('side')
  run('checkout', '-q', 'main')
  write('a.txt', 'one\nMAIN\nthree\n')
  commitAll('main change')
}

describe('merge', () => {
  it('merges a clean branch', async () => {
    run('checkout', '-qb', 'side')
    write('b.txt', 'b\n')
    commitAll('add b')
    run('checkout', '-q', 'main')
    await git.merge(root, 'side')
    expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(true)
    expect((await git.details(root)).operation).toBeNull()
  })

  it('stops on a conflict, reports it, and can be aborted', async () => {
    conflict()
    await git.merge(root, 'side')
    const info = await git.details(root)
    expect(info.operation).toBe('merge')
    expect(info.conflicts).toEqual(['a.txt'])
    expect(read('a.txt')).toContain('<<<<<<<')
    await git.abortOperation(root)
    expect((await git.details(root)).operation).toBeNull()
    expect(read('a.txt')).toBe('one\nMAIN\nthree\n')
  })

  it('continues once the conflict is resolved', async () => {
    conflict()
    await git.merge(root, 'side')
    write('a.txt', 'one\nBOTH\nthree\n')
    run('add', 'a.txt')
    await git.continueOperation(root)
    expect((await git.details(root)).operation).toBeNull()
    expect(run('log', '-1', '--format=%s')).toContain('Merge')
  })
})

describe('rebase', () => {
  it('stops on a conflict and continues', async () => {
    conflict()
    run('checkout', '-q', 'side')
    await git.rebase(root, 'main')
    expect((await git.details(root)).operation).toBe('rebase')
    write('a.txt', 'one\nFIXED\nthree\n')
    run('add', 'a.txt')
    await git.continueOperation(root)
    expect((await git.details(root)).operation).toBeNull()
    expect(read('a.txt')).toContain('FIXED')
  })

  it('reports a real failure', async () => {
    await expect(git.rebase(root, 'no-such-branch')).rejects.toThrow()
  })
})

describe('stash', () => {
  it('saves, lists, restores and drops, including new files', async () => {
    write('a.txt', 'changed\n')
    write('new.txt', 'new\n')
    await git.stashPush(root, 'work in progress')
    expect(read('a.txt')).toBe('one\ntwo\nthree\n')
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false)
    const list = (await git.details(root)).stashes
    expect(list).toHaveLength(1)
    expect(list[0].message).toContain('work in progress')
    await git.stashApply(root, 0)
    expect(read('a.txt')).toBe('changed\n')
    expect((await git.details(root)).stashes).toHaveLength(1)
    run('checkout', '--', 'a.txt')
    fs.rmSync(path.join(root, 'new.txt'))
    await git.stashPop(root, 0)
    expect(read('new.txt')).toBe('new\n')
    expect((await git.details(root)).stashes).toHaveLength(0)
    await git.stashPush(root, '')
    await git.stashDrop(root, 0)
    expect((await git.details(root)).stashes).toHaveLength(0)
  })
})

describe('commits and branches', () => {
  it('amends the last commit', async () => {
    write('a.txt', 'more\n')
    run('add', '.')
    await git.amend(root, 'better message')
    expect(run('log', '--format=%s').trim().split('\n')).toEqual(['better message'])
    expect((await git.details(root)).lastMessage).toBe('better message')
  })

  it('renames, deletes and describes branches', async () => {
    run('branch', 'old')
    await git.renameBranch(root, 'old', 'new-name')
    const names = (await git.details(root)).branches.map((b) => b.name)
    expect(names).toContain('new-name')
    await git.deleteBranch(root, 'new-name', false)
    expect((await git.details(root)).branches.map((b) => b.name)).toEqual(['main'])
    expect((await git.details(root)).branches[0].current).toBe(true)
  })

  it('cherry-picks, reverts, tags and branches from a commit', async () => {
    run('checkout', '-qb', 'side')
    write('c.txt', 'c\n')
    commitAll('add c')
    const sha = run('rev-parse', 'HEAD').trim()
    run('checkout', '-q', 'main')
    await git.cherryPick(root, sha)
    expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(true)
    await git.revert(root, run('rev-parse', 'HEAD').trim())
    expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(false)
    await git.tag(root, 'v1', sha)
    expect(run('tag').trim()).toBe('v1')
    await git.branchAt(root, 'from-sha', sha)
    expect(run('branch', '--show-current').trim()).toBe('from-sha')
  })

  it('resets softly and hard', async () => {
    const first = run('rev-parse', 'HEAD').trim()
    write('a.txt', 'second\n')
    commitAll('second')
    await git.reset(root, first, 'soft')
    expect(read('a.txt')).toBe('second\n')
    await git.reset(root, first, 'hard')
    expect(read('a.txt')).toBe('one\ntwo\nthree\n')
  })

  it('refuses names and commits that could act as options', async () => {
    await expect(git.merge(root, '--abort')).rejects.toThrow('not a valid name')
    await expect(git.deleteBranch(root, '-D', false)).rejects.toThrow('not a valid name')
    await expect(git.cherryPick(root, '--continue')).rejects.toThrow('not a commit')
    await expect(git.reset(root, 'abcdef1', 'wipe' as 'hard')).rejects.toThrow('Unknown')
  })
})

describe('remotes', () => {
  it('fetches, pushes with upstream, pulls and follows a remote branch', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-remote-'))
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    run('remote', 'add', 'origin', bare)
    await git.pushCurrent(root)
    expect((await git.details(root)).branches[0].upstream).toBe('origin/main')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-clone-'))
    execFileSync('git', ['clone', '-q', bare, other])
    const inOther = (...args: string[]) => execFileSync('git', args, { cwd: other, encoding: 'utf8' })
    inOther('config', 'user.email', 'x@example.com')
    inOther('config', 'user.name', 'X')
    inOther('checkout', '-qb', 'feature')
    fs.writeFileSync(path.join(other, 'f.txt'), 'f\n')
    inOther('add', '.')
    inOther('commit', '-qm', 'feature')
    inOther('push', '-q', 'origin', 'feature')
    await git.fetchAll(root)
    expect((await git.details(root)).remoteBranches).toContain('origin/feature')
    await git.checkoutRemote(root, 'origin/feature')
    expect(run('branch', '--show-current').trim()).toBe('feature')
    expect(fs.existsSync(path.join(root, 'f.txt'))).toBe(true)
    fs.rmSync(bare, { recursive: true, force: true })
    fs.rmSync(other, { recursive: true, force: true })
  })

  it('explains a push with no remote', async () => {
    await expect(git.pushCurrent(root)).rejects.toThrow('no remote')
  })
})

describe('staging one block', () => {
  it('stages only the chosen block', async () => {
    const original = 'a\nb\nc\nd\ne\nf\ng\nh\n'
    const modified = 'A\nb\nc\nd\ne\nf\ng\nH\n'
    write('p.txt', original)
    commitAll('p')
    write('p.txt', modified)
    await git.applyPatch(root, blockPatch('p.txt', original, modified, { originalStart: 1, originalEnd: 1, modifiedStart: 1, modifiedEnd: 1 }), 'index')
    expect(run('show', ':p.txt')).toBe('A\nb\nc\nd\ne\nf\ng\nh\n')
    expect(read('p.txt')).toBe(modified)
  })

  it('stages added and removed lines', async () => {
    const original = 'a\nb\nc\n'
    write('p.txt', original)
    commitAll('p')
    const added = 'a\nb\nNEW\nc\n'
    write('p.txt', added)
    await git.applyPatch(root, blockPatch('p.txt', original, added, { originalStart: 2, originalEnd: 0, modifiedStart: 3, modifiedEnd: 3 }), 'index')
    expect(run('show', ':p.txt')).toBe(added)
    commitAll('add')
    const removed = 'a\nc\n'
    write('p.txt', removed)
    await git.applyPatch(root, blockPatch('p.txt', added, removed, { originalStart: 2, originalEnd: 3, modifiedStart: 1, modifiedEnd: 0 }), 'index')
    expect(run('show', ':p.txt')).toBe(removed)
  })
})

describe('conflict blocks', () => {
  const text = 'top\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> side\nmid\n<<<<<<< HEAD\nm2\n||||||| base\nold\n=======\nt2\n>>>>>>> side\nend'

  it('finds each block', () => {
    expect(findConflicts(text)).toEqual([
      { start: 2, separator: 4, end: 6, base: null },
      { start: 8, separator: 12, end: 14, base: 10 }
    ])
  })

  it('ignores a marker with no end', () => {
    expect(findConflicts('<<<<<<< HEAD\nonly\n=======\nhalf')).toEqual([])
  })

  it('gives the lines for each choice, without the common base', () => {
    const lines = text.split('\n')
    const [first, second] = findConflicts(text)
    expect(resolvedLines(lines, first, 'current')).toEqual(['mine'])
    expect(resolvedLines(lines, first, 'incoming')).toEqual(['theirs'])
    expect(resolvedLines(lines, first, 'both')).toEqual(['mine', 'theirs'])
    expect(resolvedLines(lines, second, 'current')).toEqual(['m2'])
  })
})
