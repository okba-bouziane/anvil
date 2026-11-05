import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChangeTracker } from '../src/main/changes'

let root: string
const f = (rel: string) => path.join(root, rel)
const read = (rel: string) => fs.readFileSync(f(rel), 'utf8')
const lines = (...n: (string | number)[]) => n.map((x) => `line ${x}`).join('\n') + '\n'
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-'))
})

describe('review', () => {
  it('rejecting restores an edited file', () => {
    fs.writeFileSync(f('a.txt'), 'old\n')
    const t = new ChangeTracker(root)
    t.write('a.txt', 'new\n')
    expect(read('a.txt')).toBe('new\n')
    expect(t.list()[0]).toMatchObject({ path: 'a.txt', status: 'modified', added: 1, removed: 1 })
    t.rejectFile('a.txt')
    expect(read('a.txt')).toBe('old\n')
    expect(t.list()).toEqual([])
  })

  it('rejecting a new file removes it', () => {
    const t = new ChangeTracker(root)
    t.write('src/new.ts', 'x\n')
    expect(t.list()[0].status).toBe('added')
    t.rejectFile('src/new.ts')
    expect(fs.existsSync(f('src/new.ts'))).toBe(false)
  })

  it('accepting keeps the file and clears the change', () => {
    fs.writeFileSync(f('a.txt'), 'old\n')
    const t = new ChangeTracker(root)
    t.write('a.txt', 'new\n')
    t.acceptFile('a.txt')
    expect(t.list()).toEqual([])
    expect(read('a.txt')).toBe('new\n')
  })

  it('several edits to one file keep the first baseline', () => {
    fs.writeFileSync(f('a.txt'), 'one\n')
    const t = new ChangeTracker(root)
    t.write('a.txt', 'two\n')
    t.write('a.txt', 'three\n')
    t.rejectFile('a.txt')
    expect(read('a.txt')).toBe('one\n')
  })

  it('writing the original content back leaves nothing to review', () => {
    fs.writeFileSync(f('a.txt'), 'one\n')
    const t = new ChangeTracker(root)
    t.write('a.txt', 'two\n')
    t.write('a.txt', 'one\n')
    expect(t.list()).toEqual([])
  })

  it('handles each block separately', () => {
    fs.writeFileSync(f('a.txt'), lines(...ALL))
    const t = new ChangeTracker(root)
    const edited = ALL.map((n) => (n === 2 ? 'TWO' : n === 18 ? 'EIGHTEEN' : n))
    t.write('a.txt', lines(...edited))
    expect(t.list()[0].hunks).toHaveLength(2)

    t.rejectHunk('a.txt', 0)
    expect(read('a.txt')).toContain('line 2\n')
    expect(read('a.txt')).toContain('line EIGHTEEN\n')
    expect(t.list()[0].hunks).toHaveLength(1)

    t.acceptHunk('a.txt', 0)
    expect(t.list()).toEqual([])
    expect(read('a.txt')).toContain('line EIGHTEEN\n')
  })

  it('accepting one block keeps the other under review', () => {
    fs.writeFileSync(f('a.txt'), lines(...ALL))
    const t = new ChangeTracker(root)
    t.write('a.txt', lines(...ALL.map((n) => (n === 2 ? 'TWO' : n === 18 ? 'EIGHTEEN' : n))))
    t.acceptHunk('a.txt', 0)
    expect(t.list()[0].hunks).toHaveLength(1)
    t.rejectFile('a.txt')
    expect(read('a.txt')).toContain('line TWO\n')
    expect(read('a.txt')).toContain('line 18\n')
  })

  it('rejecting the only block of a new file removes the file', () => {
    const t = new ChangeTracker(root)
    t.write('n.txt', 'a\nb\n')
    t.rejectHunk('n.txt', 0)
    expect(fs.existsSync(f('n.txt'))).toBe(false)
    expect(t.list()).toEqual([])
  })

  it('survives a restart', () => {
    fs.writeFileSync(f('a.txt'), 'old\n')
    const t = new ChangeTracker(root)
    t.beginCheckpoint('s', 'step')
    t.write('a.txt', 'new\n')
    t.endCheckpoint()
    const again = new ChangeTracker(root, JSON.parse(JSON.stringify(t.toJSON())))
    expect(again.list()).toHaveLength(1)
    again.undoCheckpoint('s')
    expect(read('a.txt')).toBe('old\n')
  })
})

describe('undo a step', () => {
  it('puts back every file in the step, even after accepting', () => {
    fs.writeFileSync(f('a.txt'), 'a\n')
    const t = new ChangeTracker(root)
    t.beginCheckpoint('one', 'step')
    t.write('a.txt', 'a2\n')
    t.write('b.txt', 'b\n')
    expect(t.endCheckpoint()?.files).toEqual(['a.txt', 'b.txt'])
    t.acceptAll()
    t.undoCheckpoint('one')
    expect(read('a.txt')).toBe('a\n')
    expect(fs.existsSync(f('b.txt'))).toBe(false)
  })

  it('undoing an earlier step also undoes later ones', () => {
    fs.writeFileSync(f('a.txt'), '0\n')
    const t = new ChangeTracker(root)
    t.beginCheckpoint('one', 's'); t.write('a.txt', '1\n'); t.endCheckpoint()
    t.beginCheckpoint('two', 's'); t.write('a.txt', '2\n'); t.endCheckpoint()
    t.undoCheckpoint('one')
    expect(read('a.txt')).toBe('0\n')
    expect(t.listCheckpoints().every((c) => c.undone)).toBe(true)
    expect(t.list()).toEqual([])
  })

  it('a step that changed nothing makes no checkpoint', () => {
    const t = new ChangeTracker(root)
    t.beginCheckpoint('x', 's')
    expect(t.endCheckpoint()).toBeNull()
  })
})
