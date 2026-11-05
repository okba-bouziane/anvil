import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import * as git from '../src/main/git'
import { portOf, serverCommand, shellQuote } from '../src/main/model'

let root: string
const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-git-')))
})

it('reports when a folder is not a repository, and can start one', async () => {
  expect((await git.status(root)).isRepo).toBe(false)
  await git.init(root)
  expect((await git.status(root)).isRepo).toBe(true)
})

it('stages, commits and discards', async () => {
  run('init', '-b', 'main')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'T')
  run('config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(root, 'a file.txt'), 'one\n')
  expect((await git.status(root)).files).toEqual([{ path: 'a file.txt', code: '??' }])
  await git.stage(root, ['a file.txt'], true)
  expect((await git.status(root)).files[0].code).toBe('A ')
  await git.commit(root, 'first')
  const clean = await git.status(root)
  expect(clean).toMatchObject({ branch: 'main', files: [] })

  fs.writeFileSync(path.join(root, 'a file.txt'), 'two\n')
  expect((await git.status(root)).files[0].code).toBe(' M')
  expect(await git.headVersion(root, 'a file.txt')).toBe('one\n')
  await git.stage(root, ['a file.txt'], true)
  await git.stage(root, ['a file.txt'], false)
  expect((await git.status(root)).files[0].code).toBe(' M')
  expect(await git.discard(root, 'a file.txt')).toBe(true)
  expect(fs.readFileSync(path.join(root, 'a file.txt'), 'utf8')).toBe('one\n')
  fs.writeFileSync(path.join(root, 'new.txt'), 'x')
  expect(await git.discard(root, 'new.txt')).toBe(false)
})

it('a file name cannot act as a git option', async () => {
  run('init', '-b', 'main')
  fs.writeFileSync(path.join(root, '--force'), 'x')
  await git.stage(root, ['--force'], true)
  expect((await git.status(root)).files[0]).toEqual({ path: '--force', code: 'A ' })
})

it('builds a safe command for the model server', () => {
  expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
  const command = serverCommand("evil'; rm -rf x; '", 8080, 16e9)
  expect(command).toContain(`--model 'evil'\\''; rm -rf x; '\\'''`)
  expect(command).toContain('--host 127.0.0.1')
  expect(command).toContain('--prompt-cache-bytes 4800000000')
  expect(portOf('http://127.0.0.1:9000/v1')).toBe(9000)
  expect(portOf('bad')).toBe(8080)
})

it('reads history across branches, commit files and diffs, and who changed each line', async () => {
  run('init', '-b', 'main')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'Amina')
  run('config', 'core.autocrlf', 'false')
  expect(await git.log(root, 10)).toEqual([])
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n')
  run('add', '.')
  run('commit', '-m', 'first')
  run('checkout', '-b', 'side')
  fs.writeFileSync(path.join(root, 'b c.txt'), 'x\n')
  run('add', '.')
  run('commit', '-m', 'side work')
  run('checkout', 'main')
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n')
  run('add', '.')
  run('commit', '-m', 'second')

  const all = await git.log(root, 10)
  expect(all.map((c) => c.subject).sort()).toEqual(['first', 'second', 'side work'])
  const second = all.find((c) => c.subject === 'second')!
  expect(second.refs).toContain('main')
  expect(second.author).toBe('Amina')
  expect(second.parents).toHaveLength(1)
  expect((await git.log(root, 10, 'a.txt')).map((c) => c.subject)).toEqual(['second', 'first'])

  expect(await git.commitFiles(root, second.sha)).toEqual([{ status: 'M', path: 'a.txt' }])
  expect(await git.commitDiff(root, second.sha, 'a.txt')).toEqual({ original: 'one\ntwo\n', modified: 'one\nTWO\n' })
  await expect(git.commitFiles(root, '--all')).rejects.toThrow(/not a commit/)

  const lines = await git.blame(root, 'a.txt')
  expect(lines.map((l) => [l.line, l.subject, l.author])).toEqual([[1, 'first', 'Amina'], [2, 'second', 'Amina']])

  expect(await git.branches(root)).toEqual({ current: 'main', all: ['main', 'side'] })
  await git.checkout(root, 'side', false)
  expect((await git.branches(root)).current).toBe('side')
  await git.checkout(root, 'new/thing', true)
  expect((await git.branches(root)).current).toBe('new/thing')
  await expect(git.checkout(root, '--force', false)).rejects.toThrow(/valid branch/)
})
