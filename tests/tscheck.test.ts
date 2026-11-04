import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { checkFiles } from '../src/main/tscheck'

let root: string
const nm = path.resolve('node_modules/typescript')
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-')))
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true, types: [] }, include: ['*.ts'] }))
})
const link = () => {
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.symlinkSync(nm, path.join(root, 'node_modules/typescript'), 'junction')
}

it('adds a missing import from the project itself', () => {
  link()
  fs.writeFileSync(path.join(root, 'lib.ts'), 'export function helper(): number { return 1 }\n')
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const v: number = helper()\n')
  const r = checkFiles(root, ['a.ts'])
  expect(r.fixedCount).toBe(1)
  expect(r.errors).toEqual([])
  expect(r.fixedImports[0].content).toMatch(/import \{ helper \} from ["']\.\/lib(\.js)?["']/)
})

it('prefers a file in the project over a package with the same name', () => {
  link()
  fs.mkdirSync(path.join(root, 'node_modules/other'))
  fs.writeFileSync(path.join(root, 'node_modules/other/package.json'), '{"name":"other","types":"index.d.ts"}')
  fs.writeFileSync(path.join(root, 'node_modules/other/index.d.ts'), 'export class Thing {}\n')
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"other":"1"}}')
  fs.writeFileSync(path.join(root, 'lib.ts'), 'export class Thing {}\n')
  fs.writeFileSync(path.join(root, 'b.ts'), 'import { Thing as T } from "other"\nexport const t = new T()\n')
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const v = new Thing()\n')
  const r = checkFiles(root, ['a.ts'])
  expect(r.fixedCount).toBe(1)
  expect(r.fixedImports[0].content).toMatch(/from ["']\.\/lib/)
})

it('offers the options when two project files could fit', () => {
  link()
  fs.writeFileSync(path.join(root, 'one.ts'), 'export class Thing {}\n')
  fs.writeFileSync(path.join(root, 'two.ts'), 'export class Thing {}\n')
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const v = new Thing()\n')
  const r = checkFiles(root, ['a.ts'])
  expect(r.fixedCount).toBe(0)
  expect(r.errors[0]).toMatch(/possible fixes:.*one.*two/)
})

it('explains two different types with the same name', () => {
  link()
  fs.writeFileSync(path.join(root, 'global.d.ts'), "type TaskPriority = 'background' | 'other'\n")
  fs.writeFileSync(path.join(root, 'lib.ts'), "export type TaskPriority = 'LOW' | 'HIGH'\nexport function take(p?: TaskPriority) { return p }\n")
  fs.writeFileSync(path.join(root, 'a.ts'), "import { take } from './lib.js'\nexport const f = (p: TaskPriority) => take(p)\n")
  expect(checkFiles(root, ['a.ts']).errors[0]).toMatch(/two different types both called TaskPriority/)
})

it('reports real type errors with the line', () => {
  link()
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const v: number = "no"\n')
  const r = checkFiles(root, ['a.ts'])
  expect(r.errors[0]).toMatch(/a\.ts:1 TS2322/)
  expect(r.errors[0]).toMatch(/that line is:/)
})

it('leaves unknown names as errors for the model', () => {
  link()
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const v = doesNotExist()\n')
  const r = checkFiles(root, ['a.ts'])
  expect(r.fixedCount).toBe(0)
  expect(r.errors[0]).toMatch(/doesNotExist/)
})

it('says when TypeScript is not installed', () => {
  fs.writeFileSync(path.join(root, 'a.ts'), 'x\n')
  const r = checkFiles(root, ['a.ts'])
  expect(r.ran).toBe(false)
  expect(r.note).toMatch(/npm install/)
})

it('ignores files that are not TypeScript', () => {
  link()
  fs.writeFileSync(path.join(root, 'a.css'), 'x')
  expect(checkFiles(root, ['a.css']).ran).toBe(false)
})
