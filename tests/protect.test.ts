import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { assertNotProtected, isProtected, listFilesTool, searchTool } from '../src/main/tools'
import { projectTree, relatedFiles } from '../src/main/context'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-protect-'))
  fs.mkdirSync(path.join(root, 'config'))
  fs.writeFileSync(path.join(root, '.env'), 'PASSWORD=hunter2\n')
  fs.writeFileSync(path.join(root, '.env.production'), 'PASSWORD=hunter2\n')
  fs.writeFileSync(path.join(root, '.env.example'), 'PASSWORD=\n')
  fs.writeFileSync(path.join(root, 'server.pem'), 'PASSWORD=hunter2\n')
  fs.writeFileSync(path.join(root, 'config', 'private.txt'), 'PASSWORD=hunter2\n')
  fs.writeFileSync(path.join(root, 'app.ts'), 'const PASSWORD = process.env.PASSWORD\n')
})

describe('protecting secrets from the agent', () => {
  it('covers common secret files by default, but not examples', () => {
    expect(isProtected(root, '.env')).toBe(true)
    expect(isProtected(root, '.env.production')).toBe(true)
    expect(isProtected(root, 'server.pem')).toBe(true)
    expect(isProtected(root, 'deep/.ssh/id_rsa')).toBe(true)
    expect(isProtected(root, '.env.example')).toBe(false)
    expect(isProtected(root, 'app.ts')).toBe(false)
  })

  it('follows the project ignore file, including exceptions', () => {
    fs.writeFileSync(path.join(root, '.sindanignore'), '# mine\nconfig/\n!.env.production\n')
    expect(isProtected(root, 'config/private.txt')).toBe(true)
    expect(isProtected(root, '.env.production')).toBe(false)
    expect(isProtected(root, '.env')).toBe(true)
  })

  it('refuses to open a protected file', () => {
    expect(() => assertNotProtected(root, '.env')).toThrow('protected')
    expect(() => assertNotProtected(root, 'app.ts')).not.toThrow()
  })

  it('keeps protected files out of listings, search and context', () => {
    expect(listFilesTool(root, '.')).not.toContain('.env\n')
    expect(listFilesTool(root, '.')).not.toContain('server.pem')
    expect(searchTool(root, 'PASSWORD')).toContain('app.ts')
    expect(searchTool(root, 'hunter2')).not.toContain('.env')
    expect(searchTool(root, 'hunter2')).not.toContain('server.pem')
    expect(projectTree(root)).not.toContain('server.pem')
    expect(relatedFiles(root, 'where is the password')).not.toContain('.env')
  })
})
