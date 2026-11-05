import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safePath, setScope, walkFiles } from '../src/main/tools'
import { commonParent, findRepos, outOfRepo, readWorkspaceFile, repoOf, vscodeEditorSettings, vscodeLaunch, vscodeTasks, withinRepo, writeWorkspaceFile } from '../src/main/workspace'

let root = ''
const write = (rel: string, text = '') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-ws-'))) })
afterEach(() => { setScope(root, null); fs.rmSync(root, { recursive: true, force: true }) })

describe('workspace folders', () => {
  it('finds the shared parent', () => {
    expect(commonParent(['/a/b/c', '/a/b/d'])).toBe('/a/b')
    expect(commonParent(['/a/b'])).toBe('/a/b')
    expect(commonParent(['/x/1', '/y/2'])).toBe('/')
  })

  it('round-trips a workspace file and skips missing folders', () => {
    write('api/a.ts')
    write('web/b.ts')
    const file = path.join(root, 'all.code-workspace')
    writeWorkspaceFile(file, [path.join(root, 'api'), path.join(root, 'web')])
    expect(readWorkspaceFile(file)).toEqual([path.join(root, 'api'), path.join(root, 'web')])
    fs.writeFileSync(file, '// a comment\n{ "folders": [{ "path": "api" }, { "path": "gone" },], }')
    expect(readWorkspaceFile(file)).toEqual([path.join(root, 'api')])
    fs.writeFileSync(file, '{ "folders": [{ "path": "gone" }] }')
    expect(() => readWorkspaceFile(file)).toThrow('no folders')
  })

  it('limits files and paths to the chosen folders', () => {
    write('api/a.ts')
    write('web/b.ts')
    write('secret/key.txt')
    setScope(root, ['api', 'web'])
    expect([...walkFiles(root)].sort()).toEqual(['api/a.ts', 'web/b.ts'])
    expect(safePath(root, 'api/a.ts')).toBe('api/a.ts')
    expect(safePath(root, '.')).toBe('.')
    expect(() => safePath(root, 'secret/key.txt')).toThrow('outside')
    expect(() => safePath(root, 'api/../secret/key.txt')).toThrow('outside')
    setScope(root, null)
    expect(safePath(root, 'secret/key.txt')).toBe('secret/key.txt')
  })
})

describe('repositories', () => {
  it('finds the root, workspace folders, or folders one level down', () => {
    write('api/.git/HEAD')
    write('web/.git/HEAD')
    write('docs/x.md')
    expect(findRepos(root, null)).toEqual(['api', 'web'])
    expect(findRepos(root, ['api', 'docs'])).toEqual(['api'])
    write('.git/HEAD')
    expect(findRepos(root, null)).toEqual(['.'])
  })

  it('maps files to and from their repository', () => {
    expect(repoOf(['api', 'web'], 'web/src/a.ts')).toBe('web')
    expect(repoOf(['api', 'web'], 'webby/a.ts')).toBeNull()
    expect(repoOf(['.'], 'a/b.ts')).toBe('.')
    expect(withinRepo('web', 'web/src/a.ts')).toBe('src/a.ts')
    expect(withinRepo('.', 'a.ts')).toBe('a.ts')
    expect(outOfRepo('web', 'src/a.ts')).toBe('web/src/a.ts')
  })
})

describe('.vscode files', () => {
  it('reads the editor settings Anvil understands', () => {
    write('.vscode/settings.json', '// mine\n{ "editor.tabSize": 4, "editor.wordWrap": "on", "files.autoSave": "off", "editor.formatOnSave": true, "other": 1, }')
    expect(vscodeEditorSettings(root, null)).toEqual({ tabSize: 4, wordWrap: true, autoSave: false, formatOnSave: true })
    expect(vscodeEditorSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')), null)).toEqual({})
  })

  it('reads tasks', () => {
    write('.vscode/tasks.json', '{ "tasks": [{ "label": "Build", "type": "shell", "command": "make", "args": ["all"] }, { "type": "npm", "script": "test" }, { "label": "bad" }] }')
    expect(vscodeTasks(root, null)).toEqual([{ label: 'Build', command: 'make all', cwd: '.' }, { label: 'test', command: 'npm run test', cwd: '.' }])
  })

  it('reads debug setups and fills in folders', () => {
    write('.vscode/launch.json', '{ "configurations": [{ "name": "API", "type": "node", "request": "launch", "program": "${workspaceFolder}/a.js" }, { "name": "Py", "type": "debugpy", "request": "launch", "program": "${file}" }, { "name": "Go", "type": "go" }] }')
    const list = vscodeLaunch(root, null, 'x.py')
    expect(list.map((l) => l.name)).toEqual(['API', 'Py'])
    expect(list[0].config).toMatchObject({ type: 'pwa-node', program: path.join(root, 'a.js'), cwd: root })
    expect(list[1].config).toMatchObject({ type: 'python', program: path.join(root, 'x.py') })
  })
})
