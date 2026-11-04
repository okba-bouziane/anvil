import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { importFromVscode } from '../src/main/vscode-import'

let user: string
let extensions: string
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-vs-'))
  user = path.join(root, 'User')
  extensions = path.join(root, 'extensions')
})

it('reports when VS Code is not installed', () => {
  expect(importFromVscode({ user, extensions }).summary).toMatchObject({ found: false, snippets: 0 })
})

it('imports settings, even with comments and trailing commas', () => {
  write(path.join(user, 'settings.json'), '{\n // mine\n "editor.fontSize": 15, "editor.wordWrap": "on", "files.autoSave": "off", "unknown.thing": 1,\n}')
  const { summary, settingsPatch } = importFromVscode({ user, extensions })
  expect(settingsPatch.editor).toEqual({ fontSize: 15, wordWrap: true, autoSave: false })
  expect(summary.settings).toEqual(['Font size', 'Word wrap', 'Auto-save'])
})

it('imports user and extension snippets', () => {
  write(path.join(user, 'snippets/typescript.json'), '{"Log":{"prefix":"lg","body":["console.log($1)"],"description":"Log"}}')
  write(path.join(user, 'snippets/all.code-snippets'), '{"Two":{"scope":"javascript,typescript","prefix":["a","b"],"body":"x"}}')
  write(path.join(extensions, 'me.snip-1/package.json'), JSON.stringify({ name: 'snip', contributes: { snippets: [{ language: 'html', path: './s.json' }] } }))
  write(path.join(extensions, 'me.snip-1/s.json'), '{"Div":{"prefix":"d","body":"<div></div>"}}')
  const { assets, summary } = importFromVscode({ user, extensions })
  expect(assets.snippets.find((s) => s.prefix === 'lg')).toMatchObject({ language: 'typescript', body: 'console.log($1)' })
  expect(assets.snippets.filter((s) => s.name === 'Two')).toHaveLength(4)
  expect(assets.snippets.find((s) => s.prefix === 'd')?.language).toBe('html')
  expect(summary.extensionsUsed).toEqual(['snip'])
})

it('imports themes with their parents, and picks the one in use', () => {
  write(path.join(user, 'settings.json'), '{"workbench.colorTheme":"Night"}')
  write(path.join(extensions, 't-1/package.json'), JSON.stringify({ name: 't', contributes: { themes: [{ label: 'Night', uiTheme: 'vs-dark', path: 'themes/night.json' }] } }))
  write(path.join(extensions, 't-1/themes/night.json'), '{"include":"./base.json","colors":{"editor.background":"#101010","bad":"red"},"tokenColors":[{"scope":"comment","settings":{"foreground":"#777777","fontStyle":"italic"}}]}')
  write(path.join(extensions, 't-1/themes/base.json'), '{"tokenColors":[{"scope":["string.quoted"],"settings":{"foreground":"#00ff00"}}]}')
  const { assets, settingsPatch } = importFromVscode({ user, extensions })
  const [theme] = assets.themes
  expect(theme).toMatchObject({ name: 'Night', dark: true, colors: { 'editor.background': '#101010' } })
  expect(theme.colors.bad).toBeUndefined()
  expect(theme.tokens).toEqual(expect.arrayContaining([{ token: 'comment', foreground: '777777', fontStyle: 'italic' }, { token: 'string', foreground: '00ff00', fontStyle: undefined }]))
  expect(settingsPatch.editorTheme).toBe(theme.id)
})

it('lists extensions that are programs as skipped, and never follows paths out of an extension', () => {
  write(path.join(extensions, 'prog-1/package.json'), JSON.stringify({ displayName: 'ESLint', main: './out/extension.js' }))
  write(path.join(extensions, 'evil-1/package.json'), JSON.stringify({ name: 'evil', contributes: { snippets: [{ language: 'js', path: '../../User/secret.json' }] } }))
  write(path.join(user, 'secret.json'), '{"S":{"prefix":"s","body":"secret"}}')
  const { assets, summary } = importFromVscode({ user, extensions })
  expect(summary.extensionsSkipped).toEqual(['ESLint'])
  expect(assets.snippets).toEqual([])
})
