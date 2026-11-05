import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assetsOf, supportOf, unpackExtension } from '../src/main/extensions'

let dir = ''
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-ext-'))) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const vsix = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))

describe('supportOf', () => {
  it('tells apart data, mixed and program extensions', () => {
    expect(supportOf({ contributes: { themes: [{}] } }).level).toBe('full')
    expect(supportOf({ main: './a.js', contributes: { snippets: [{}] } }).level).toBe('partial')
    expect(supportOf({ main: './a.js' }).level).toBe('none')
    expect(supportOf({ contributes: { grammars: [{}] } }).level).toBe('none')
  })
})

describe('unpackExtension', () => {
  it('keeps data files, and never the code', () => {
    const manifest = unpackExtension(vsix({
      'extension/package.json': '{"name":"x","main":"./run.js"}',
      'extension/run.js': 'process.exit(1)',
      'extension/themes/t.json': '{}',
      'extension/native.node': 'x',
      '[Content_Types].xml': '<x/>'
    }), path.join(dir, 'x'))
    expect(manifest.name).toBe('x')
    expect(fs.existsSync(path.join(dir, 'x/themes/t.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'x/run.js'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'x/native.node'))).toBe(false)
  })

  it('refuses a path that escapes the folder', () => {
    expect(() => unpackExtension(vsix({ 'extension/package.json': '{}', 'extension/../../evil.json': '{}' }), path.join(dir, 'x'))).toThrow('unsafe')
    expect(fs.existsSync(path.join(dir, 'evil.json'))).toBe(false)
  })

  it('refuses a file that is not an extension', () => {
    expect(() => unpackExtension(vsix({ 'other.json': '{}' }), path.join(dir, 'x'))).toThrow('not an extension')
  })
})

describe('assetsOf', () => {
  it('reads themes and snippets, and ignores paths outside the extension', () => {
    const target = path.join(dir, 'x')
    unpackExtension(vsix({
      'extension/package.json': JSON.stringify({ contributes: { themes: [{ label: 'Night', uiTheme: 'vs-dark', path: './t.json' }, { label: 'Bad', path: '../../outside.json' }], snippets: [{ language: 'typescript', path: './s.json' }] } }),
      'extension/t.json': '{"colors":{"editor.background":"#101010"},"tokenColors":[{"scope":"comment","settings":{"foreground":"#777777"}}]}',
      'extension/s.json': '{"Log":{"prefix":"lg","body":"console.log($1)"}}'
    }), target)
    fs.writeFileSync(path.join(dir, 'outside.json'), '{}')
    const assets = assetsOf(target, 'pub.x')
    expect(assets.themes.map((t) => t.id)).toEqual(['ext:pub.x:Night'])
    expect(assets.themes[0].colors['editor.background']).toBe('#101010')
    expect(assets.snippets[0]).toMatchObject({ language: 'typescript', prefix: 'lg' })
  })
})
