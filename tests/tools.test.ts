import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyEdit, readFileTool, repairArgs, runCommand, safePath, searchTool, trimOutput } from '../src/main/tools'

let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-')))
})

describe('safePath', () => {
  it('accepts paths inside the project', () => {
    expect(safePath(root, 'src/a.ts')).toBe('src/a.ts')
    expect(safePath(root, './src/../a.ts')).toBe('a.ts')
    expect(safePath(root, path.join(root, 'a.ts'))).toBe('a.ts')
    expect(safePath(root, '.')).toBe('.')
  })
  it('refuses paths outside', () => {
    expect(() => safePath(root, '../x')).toThrow(/outside/)
    expect(() => safePath(root, path.resolve(root, '../elsewhere/passwd'))).toThrow(/outside/)
    expect(() => safePath(root, '~/x')).toThrow(/relative/)
  })
  it('refuses symlinks that lead outside', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'))
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction')
    expect(() => safePath(root, 'link/secret.txt')).toThrow(/outside/)
  })
})

describe('applyEdit', () => {
  it('replaces one match', () => expect(applyEdit('a b c', 'b', 'x')).toBe('a x c'))
  it('accepts changed indentation and copied line numbers', () => {
    expect(applyEdit('  a\n    b\n  c\n', 'a\nb', 'x')).toBe('x\n  c\n')
    expect(applyEdit('a\nb\nc\n', '2\tb', '2\tB')).toBe('a\nB\nc\n')
  })
  it('shows what the file really says when an edit nearly matches', () => {
    expect(() => applyEdit('one\ntwo\n', 'one\nTWO', 'x')).toThrow(/first line is at line 1[\s\S]*two/)
  })
  it('rejects missing and repeated text', () => {
    expect(() => applyEdit('abc', 'z', 'x')).toThrow(/not found/)
    expect(() => applyEdit('a a', 'a', 'x')).toThrow(/more than once/)
    expect(() => applyEdit('a', 'a', 'a')).toThrow(/same/)
  })
})

it('repairs common wrong argument names', () => {
  expect(repairArgs({ file_path: 'a', contents: 'b' })).toEqual({ path: 'a', content: 'b' })
  expect(repairArgs({ filepath: 'a', old_str: 'x', new_str: 'y' })).toEqual({ path: 'a', old_string: 'x', new_string: 'y' })
})

it('reads long files in parts', () => {
  fs.writeFileSync(path.join(root, 'l.txt'), Array.from({ length: 1000 }, (_, i) => `row${i + 1}`).join('\n'))
  const part = readFileTool(root, 'l.txt')
  expect(part).toContain('1\trow1\n')
  expect(part).toContain('start_line 401')
  expect(readFileTool(root, 'l.txt', 401)).toContain('401\trow401')
})

it('finds text and skips node_modules', () => {
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'node_modules/x.js'), 'needle')
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\nneedle here\n')
  expect(searchTool(root, 'needle')).toBe('a.ts:2: needle here')
})

it('keeps the end of long output', () => {
  expect(trimOutput('x'.repeat(50) + 'END', 10)).toContain('END')
})

describe('runCommand', () => {
  const never = () => new AbortController().signal
  it('returns output and exit code', async () => {
    const result = await runCommand(root, 'node -e "console.log(\'hi\');process.exit(3)"', never())
    expect(result).toMatchObject({ code: 3, timedOut: false })
    expect(result.output.trim()).toBe('hi')
  })
  it('stops at the time limit', async () => {
    const result = await runCommand(root, 'node -e "setTimeout(()=>{},30000)"', never(), 500)
    expect(result.timedOut).toBe(true)
  })
  it('stops when cancelled', async () => {
    const abort = new AbortController()
    const run = runCommand(root, 'node -e "setTimeout(()=>{},30000)"', abort.signal)
    setTimeout(() => abort.abort(), 500)
    expect((await run).code).not.toBe(0)
  })
})

describe('searchProject', () => {
  it('finds text, respects case and regex, and reports bad patterns', async () => {
    const { searchProject } = await import('../src/main/tools')
    fs.writeFileSync(path.join(root, 'a.ts'), 'Hello\nhello there\nh.llo\n')
    const opts = { caseSensitive: false, regex: false }
    expect(searchProject(root, 'hello', opts).map((h) => h.line)).toEqual([1, 2])
    expect(searchProject(root, 'hello', { ...opts, caseSensitive: true }).map((h) => h.line)).toEqual([2])
    expect(searchProject(root, 'h.llo', opts).map((h) => h.line)).toEqual([3])
    expect(searchProject(root, 'h.llo', { ...opts, regex: true }).map((h) => h.line)).toEqual([1, 2, 3])
    expect(() => searchProject(root, '(', { ...opts, regex: true })).toThrow(SyntaxError)
    expect(searchProject(root, '', opts)).toEqual([])
  })
})
