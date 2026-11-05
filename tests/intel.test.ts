import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { beforeEach, describe, expect, it } from 'vitest'
import { Intel } from '../src/main/intel'
import { findScripts, replaceInFiles } from '../src/main/tools'

let root: string
let intel: Intel
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-intel-')))
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true, types: [] }, include: ['src'] }))
  write('package.json', '{"type":"module"}')
  write('src/lib.ts', 'export interface Item {\n  /** How many */\n  count: number\n}\nexport function add(a: number, b: number): number {\n  return a + b\n}\n')
  write('src/main.ts', "import { add } from './lib.js'\nexport const v: number = add(1, 2)\n")
  intel = new Intel(root, ts)
})

describe('code intelligence', () => {
  it('finds errors as text changes, before anything is saved', () => {
    expect(intel.diagnostics('src/main.ts')).toEqual([])
    intel.update('src/main.ts', "import { add } from './lib.js'\nexport const v: string = add(1, 2)\n")
    const [d] = intel.diagnostics('src/main.ts')
    expect(d).toMatchObject({ severity: 'error', code: 2322, line: 2 })
    expect(d.message).toMatch(/not assignable/)
  })

  it('lists problems across the project', () => {
    write('src/bad.ts', 'export const x: number = "no"\n')
    intel.filesChanged()
    expect(intel.projectProblems('src/main.ts').map((p) => p.path)).toEqual(['src/bad.ts'])
  })

  it('completes members with details', () => {
    intel.update('src/main.ts', "import type { Item } from './lib.js'\ndeclare const i: Item\ni.\n")
    const list = intel.completions('src/main.ts', 3, 3)
    expect(list.map((c) => c.name)).toContain('count')
    const detail = intel.completionDetail('src/main.ts', 3, 3, list.find((c) => c.name === 'count')!)
    expect(detail?.detail).toContain('count: number')
    expect(detail?.docs).toBe('How many')
  })

  it('offers to import from other files', () => {
    intel.update('src/main.ts', 'export const v = ad\n')
    const entry = intel.completions('src/main.ts', 1, 20).find((c) => c.name === 'add' && c.source)
    expect(entry).toBeTruthy()
    const detail = intel.completionDetail('src/main.ts', 1, 20, entry!)
    expect(detail?.edits[0].text).toMatch(/import \{ add \} from/)
  })

  it('hovers, goes to definition and finds references', () => {
    expect(intel.hover('src/main.ts', 2, 27)?.signature).toContain('add(a: number, b: number)')
    expect(intel.definition('src/main.ts', 2, 27)[0]).toMatchObject({ path: 'src/lib.ts', line: 5 })
    expect(intel.references('src/lib.ts', 5, 18).map((r) => r.path).sort()).toEqual(['src/lib.ts', 'src/main.ts', 'src/main.ts'])
  })

  it('renames across files', () => {
    const edits = intel.rename('src/lib.ts', 5, 18, 'sum')
    expect(Array.isArray(edits) && edits.map((e) => e.path).sort()).toEqual(['src/lib.ts', 'src/main.ts', 'src/main.ts'])
    expect(intel.rename('src/lib.ts', 3, 1, 'x')).toHaveProperty('error')
  })

  it('formats, lists symbols and shows signatures', () => {
    write('src/ugly.ts', 'export   const a=1\n')
    intel.filesChanged()
    expect(intel.format('src/ugly.ts', 2).length).toBeGreaterThan(0)
    expect(intel.symbols('src/lib.ts').map((s) => s.name)).toEqual(expect.arrayContaining(['Item', 'count', 'add']))
    intel.update('src/main.ts', "import { add } from './lib.js'\nadd(1, \n")
    expect(intel.signature('src/main.ts', 2, 8)).toMatchObject({ activeParameter: 1, parameters: ['a: number', 'b: number'] })
  })

  it('still helps in a folder with no tsconfig, using the bundled TypeScript', () => {
    fs.rmSync(path.join(root, 'tsconfig.json'))
    write('a.js', 'const s = "x"\ns.\n')
    const fresh = new Intel(root, ts)
    fresh.update('a.js', 'const s = "x"\ns.\n')
    expect(fresh.completions('a.js', 2, 3).map((c) => c.name)).toContain('toUpperCase')
    expect(fresh.diagnostics('notes.md')).toEqual([])
  })
})

describe('project tools', () => {
  it('replaces in every file, plain or with a pattern', () => {
    write('x.txt', 'foo foo\n')
    write('y.txt', 'Foo\n')
    const opts = { caseSensitive: false, regex: false }
    expect(replaceInFiles(root, 'foo', opts, '$1').map((r) => [r.path, r.matches, r.content])).toEqual([['x.txt', 2, '$1 $1\n'], ['y.txt', 1, '$1\n']])
    expect(replaceInFiles(root, 'foo', { ...opts, caseSensitive: true }, 'z').map((r) => r.path)).toEqual(['x.txt'])
    expect(replaceInFiles(root, '(fo)o', { regex: true, caseSensitive: true }, '$1x')[0].content).toBe('fox fox\n')
  })

  it('finds npm scripts in sub-projects', () => {
    write('package.json', '{"scripts":{"dev":"vite"}}')
    write('api/package.json', '{"scripts":{"test":"vitest"}}')
    write('broken/package.json', '{')
    expect(findScripts(root)).toEqual(expect.arrayContaining([{ dir: '.', name: 'dev', command: 'vite' }, { dir: 'api', name: 'test', command: 'vitest' }]))
  })
})
