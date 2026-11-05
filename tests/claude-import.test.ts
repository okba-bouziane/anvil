import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { claudeFolderFor, claudeSessionFile, cleanUserText, listClaudeSessions, readClaudeSession } from '../src/main/claude-import'

let dir: string
const write = (folder: string, name: string, lines: unknown[]) => {
  fs.mkdirSync(path.join(dir, folder), { recursive: true })
  const file = path.join(dir, folder, `${name}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}
const user = (content: unknown, extra = {}) => ({ type: 'user', cwd: '/work/shop', message: { role: 'user', content }, ...extra })
const assistant = (content: unknown, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content }, ...extra })

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-claude-import-')) })

describe('importing Claude Code sessions', () => {
  it('lists sessions with their custom title, or the first thing the person wrote', () => {
    write('-work-shop', 'aaa', [user('<system-reminder>hidden</system-reminder>Fix the cart\nmore'), { type: 'custom-title', customTitle: 'Cart bug', sessionId: 'aaa' }])
    write('-work-shop', 'bbb', [user('Add a login page')])
    write('-work-other', 'ccc', [{ type: 'system' }])
    const list = listClaudeSessions(dir)
    expect(list.map((s) => s.title).sort()).toEqual(['Add a login page', 'Cart bug'])
    expect(list[0].project).toBe('shop')
    expect(list[0].id).toMatch(/^-work-shop\//)
  })

  it('answers with an empty list when there are no sessions at all', () => {
    expect(listClaudeSessions(path.join(dir, 'missing'))).toEqual([])
  })

  it('keeps the conversation and leaves out tool results, side agents and tool notices', async () => {
    const file = write('-work-shop', 'aaa', [
      assistant([{ type: 'text', text: 'Before the first message' }]),
      user('Fix the cart'),
      assistant([{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/cart.js' } }]),
      user([{ type: 'tool_result', content: 'file contents' }]),
      assistant([{ type: 'text', text: 'From a side agent' }], { isSidechain: true }),
      user('<task-notification>done</task-notification>'),
      user('Caveat', { isMeta: true }),
      assistant([{ type: 'text', text: 'Fixed' }])
    ])
    const session = await readClaudeSession(file)
    expect(session.title).toBe('Fix the cart')
    expect(session.history).toEqual([{ role: 'user', content: 'Fix the cart' }, { role: 'assistant', content: 'Looking\n\nFixed' }])
    expect(JSON.stringify(session.items)).not.toContain('file contents')
    expect(JSON.stringify(session.items)).not.toContain('secret')
    expect(session.items.find((i) => i.kind === 'tool')).toMatchObject({ name: 'Read', summary: 'src/cart.js', status: 'ok' })
    expect(session.items[0].kind).toBe('note')
  })

  it('survives broken lines', async () => {
    const file = write('-work-shop', 'aaa', [user('Hello')])
    fs.appendFileSync(file, '{"type":"user", broken\n')
    expect((await readClaudeSession(file)).history).toHaveLength(1)
  })

  it('refuses ids that point outside the sessions folder', () => {
    expect(claudeSessionFile('-work-shop/aaa', dir)).toBe(path.join(dir, '-work-shop', 'aaa.jsonl'))
    for (const bad of ['../../secret/x', '-work/../x', 'one', 'a/b/c', '-work-shop/..']) expect(() => claudeSessionFile(bad, dir)).toThrow()
  })

  it('matches the folder name Claude Code uses for a project', () => {
    expect(claudeFolderFor('/Users/me/my_app.v2')).toBe('-Users-me-my-app-v2')
  })

  it('removes what the tool wrapped around a message', () => {
    expect(cleanUserText('<ide_opened_file>x</ide_opened_file> hi')).toBe('hi')
    expect(cleanUserText('<command-name>/clear</command-name>')).toBe('')
  })
})
