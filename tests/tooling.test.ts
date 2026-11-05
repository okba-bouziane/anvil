import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Tooling } from '../src/main/tooling'

let root = ''
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-tooling-'))) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function fakeEslint(dir: string) {
  write(`${dir}node_modules/eslint/package.json`, '{"name":"eslint","main":"index.js"}')
  write(`${dir}node_modules/eslint/index.js`, `
    exports.ESLint = class {
      constructor(o) { this.fix = o.fix; this.cwd = o.cwd }
      async isPathIgnored(f) { return f.endsWith('ignored.js') }
      async lintText(text) {
        if (this.fix) return [{ messages: [], output: text.replace('var ', 'const ') }]
        return [{ messages: [{ line: 1, column: 1, endLine: 1, endColumn: 4, message: 'from ' + this.cwd, ruleId: 'no-var', severity: 2, fix: { range: [0, 3], text: 'const' } }] }]
      }
    }`)
}

function fakePrettier(dir: string) {
  write(`${dir}node_modules/prettier/package.json`, '{"name":"prettier","main":"index.js"}')
  write(`${dir}node_modules/prettier/index.js`, `
    exports.getFileInfo = async (f) => ({ ignored: f.endsWith('skip.ts'), inferredParser: f.endsWith('.xyz') ? null : 'typescript' })
    exports.resolveConfig = async () => ({ semi: false })
    exports.format = async (t, o) => t.trim() + (o.semi ? ';' : '') + '\\n'`)
}

describe('Tooling', () => {
  it('reports nothing when the project has no ESLint or Prettier', async () => {
    const tooling = new Tooling(root)
    expect(await tooling.lint('a.js', 'var a')).toEqual([])
    expect(await tooling.format('a.js', 'var a')).toBeNull()
  })

  it('runs the nearest ESLint, so each package uses its own', async () => {
    fakeEslint('')
    fakeEslint('apps/web/')
  write('apps/web/eslint.config.js', '')
    const tooling = new Tooling(root)
    const [inner] = await tooling.lint('apps/web/src/a.js', 'var a')
    expect(inner.message).toBe(`from ${path.join(root, 'apps/web')}`)
    expect(inner).toMatchObject({ rule: 'no-var', severity: 'error', fix: { start: 0, end: 3, text: 'const' } })
    const [outer] = await tooling.lint('other/b.js', 'var b')
    expect(outer.message).toBe(`from ${root}`)
  })

  it('skips files ESLint ignores and applies every fix', async () => {
    fakeEslint('')
    const tooling = new Tooling(root)
    expect(await tooling.lint('ignored.js', 'var a')).toEqual([])
    expect(await tooling.fixAll('a.js', 'var a')).toBe('const a')
  })

  // Vitest's own module loader can't read Windows short paths. The app test covers Prettier on Windows.
  it.skipIf(process.platform === 'win32')('formats with the project config, and skips what Prettier ignores or cannot read', async () => {
    fakePrettier('')
    const tooling = new Tooling(root)
    expect(await tooling.format('a.ts', ' x ')).toBe('x\n')
    expect(await tooling.format('skip.ts', ' x ')).toBeNull()
    expect(await tooling.format('a.xyz', ' x ')).toBeNull()
  })

  it('detects the tools from package.json alone', () => {
    expect(Tooling.detect(root, [{ path: 'package.json', text: '{"devDependencies":{"eslint":"9"}}' }, { path: 'x/package.json', text: 'broken' }])).toEqual({ eslint: true, prettier: false })
  })
})
