import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agent, missingInstall, type AgentDeps } from '../src/main/agent'
import { ChangeTracker } from '../src/main/changes'
import type { ChatMessage, ModelResult } from '../src/main/model'
import type { ApprovalAnswer, UiItem } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type { CheckResult } from '../src/main/tscheck'

let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-')))
})

const tool = (name: string, args: Record<string, string>): string => {
  if (name === 'write_file') return `<write_file path="${args.path ?? args.file_path}">${args.content ?? args.contents}</write_file>`
  if (name === 'edit_file') return `<edit_file path="${args.path}"><old>${args.old_string}</old><new>${args.new_string}</new></edit_file>`
  if (name === 'run_command') return `<run_command>${args.command}</run_command>`
  return `<${name} path="${args.path}"/>`
}
const reply = (content: string, tags: string[] = []): string => content + tags.join('')
const result = (content: string): ModelResult => ({ content, toolCalls: [], finishReason: 'stop', waitSeconds: 0, tokens: 1, tokensPerSecond: 30, promptTokens: 1 })
const clean: CheckResult = { ran: false, errors: [], fixedImports: [], fixedCount: 0 }

function setup(answers: string[], over: Partial<AgentDeps> = {}) {
  const items: UiItem[] = []
  const seen: ChatMessage[][] = []
  const temps: number[] = []
  const tracker = new ChangeTracker(root)
  const agent = new Agent({
    root, tracker,
    client: { stream: async (req, cb) => {
      seen.push(JSON.parse(JSON.stringify(req.messages)))
      temps.push(req.temperature)
      const next = answers.shift()
      if (next === undefined) throw new Error('model called too many times')
      for (const c of next) if (cb.onText(c)) break
      return result(next)
    } },
    settings: () => DEFAULT_SETTINGS,
    emitItem: (i) => items.push(i),
    updateItem: () => {},
    textDelta: () => {},
    liveStats: () => {},
    changed: () => {},
    askApproval: async () => 'once' as ApprovalAnswer,
    check: () => clean,
    allowedCommands: new Set(),
    ...over
  })
  const toolMessages = () => agent.history.filter((m) => m.content.startsWith('[Result of')).map((m) => m.content)
  return { agent, tracker, items, seen, temps, toolMessages }
}

describe('Agent', () => {
  it('writes through the tracker so the change can be reviewed', async () => {
    const { agent, tracker, items } = setup([reply('', [tool('write_file', { path: 'a.ts', content: 'x\n' })]), reply('Done')])
    await agent.runTurn('make a', null)
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('x\n')
    expect(tracker.list()[0].path).toBe('a.ts')
    expect(items.some((i) => i.kind === 'checkpoint')).toBe(true)
  })

  it('auto-accept leaves nothing to review but the step can still be undone', async () => {
    const { agent, tracker } = setup([reply('', [tool('write_file', { path: 'a.ts', content: 'x\n' })]), reply('Done')], { settings: () => ({ ...DEFAULT_SETTINGS, autoAcceptEdits: true }) })
    await agent.runTurn('make a', null)
    expect(tracker.list()).toEqual([])
    tracker.undoCheckpoint(tracker.listCheckpoints()[0].id)
    expect(fs.existsSync(path.join(root, 'a.ts'))).toBe(false)
  })

  it('accepts wrong argument names', async () => {
    const { agent } = setup([reply('', [tool('write_file', { file_path: 'a.ts', contents: 'x\n' })]), reply('Done')])
    await agent.runTurn('make a', null)
    expect(fs.existsSync(path.join(root, 'a.ts'))).toBe(true)
  })

  it('refuses to write outside the project and tells the model', async () => {
    const { agent, toolMessages } = setup([reply('', [tool('write_file', { path: '../evil', content: 'x' })]), reply('Done')])
    await agent.runTurn('x', null)
    expect(toolMessages()[0]).toMatch(/outside/)
    expect(fs.existsSync(path.join(root, '../evil'))).toBe(false)
  })

  it('stops reading at the end of a tool tag, so invented results are ignored', async () => {
    const { agent } = setup([reply('', [tool('write_file', { path: 'a.ts', content: 'x' })]) + '\n[Result: fine] I am done', reply('Done')])
    await agent.runTurn('x', null)
    expect(agent.history.find((m) => m.role === 'assistant')?.content).toBe('<write_file path="a.ts">x</write_file>')
  })

  it('tells the model when an edit has no old text', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'x')
    const { agent, toolMessages } = setup(['<edit_file path="a.ts">oops</edit_file>', reply('Done')])
    await agent.runTurn('x', null)
    expect(toolMessages()[0]).toMatch(/old_string is required/)
  })

  it('stops a repeating model and raises temperature, with honest results', async () => {
    const same = () => reply('', [tool('read_file', { path: 'missing.ts' })])
    const { agent, items, temps, toolMessages } = setup([same(), same(), same(), same()])
    await agent.runTurn('x', null)
    expect(toolMessages()[1]).toMatch(/it failed/)
    expect(temps[1]).toBe(0.2)
    expect(temps[2]).toBe(0.7)
    expect(items.some((i) => i.kind === 'error' && /repeating/.test(i.text))).toBe(true)
  })

  it('a repeated read after a write is not a repeat', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'one\n')
    const { agent, toolMessages } = setup([
      reply('', [tool('read_file', { path: 'a.ts' })]),
      reply('', [tool('edit_file', { path: 'a.ts', old_string: 'one', new_string: 'two' })]),
      reply('', [tool('read_file', { path: 'a.ts' })]),
      reply('Done')
    ])
    await agent.runTurn('x', null)
    expect(toolMessages()[2]).toContain('two')
  })

  it('asks before running a command, and respects a refusal', async () => {
    let asked = ''
    const ran: string[] = []
    const { agent, toolMessages } = setup([reply('', [tool('run_command', { command: 'rm -rf x' })]), reply('ok')], {
      askApproval: async (_id, command) => { asked = command; return 'deny' },
      run: async (_c, command) => { ran.push(command); return { code: 0, output: '', timedOut: false } }
    })
    await agent.runTurn('x', null)
    expect(asked).toBe('rm -rf x')
    expect(ran).toEqual([])
    expect(toolMessages()[0]).toMatch(/declined/)
  })

  it('"always" stops asking for that exact command only', async () => {
    const asked: string[] = []
    const run = async () => ({ code: 0, output: 'ok', timedOut: false })
    const { agent } = setup([
      reply('', [tool('run_command', { command: 'npm test' })]),
      reply('', [tool('write_file', { path: 'a', content: 'a' })]),
      reply('', [tool('run_command', { command: 'npm test' })]),
      reply('', [tool('run_command', { command: 'ls' })]),
      reply('done')
    ], { askApproval: async (_i, c) => { asked.push(c); return 'always' }, run })
    await agent.runTurn('x', null)
    expect(asked).toEqual(['npm test', 'ls'])
  })

  it('sends TypeScript errors back, then reports if they stay', async () => {
    const check = (): CheckResult => ({ ran: true, errors: ['a.ts:1 TS2304: bad'], fixedImports: [], fixedCount: 0 })
    const { agent, items, seen } = setup([
      reply('', [tool('write_file', { path: 'a.ts', content: 'x' })]), reply('Done'),
      reply('', [tool('write_file', { path: 'a.ts', content: 'y' })]), reply('Done again')
    ], { check })
    await agent.runTurn('x', null)
    expect(seen[2].at(-1)?.content).toMatch(/\[Automatic check\].*errors/s)
    const last = items.filter((i) => i.kind === 'check').at(-1)
    expect(last).toMatchObject({ ok: false })
    expect((last as { text: string }).text).toMatch(/not finished/)
  })

  it('applies import fixes through the tracker', async () => {
    let calls = 0
    const check = (): CheckResult => (calls++ ? clean : { ran: true, errors: [], fixedCount: 1, fixedImports: [{ file: 'a.ts', content: 'import x\nx' }] })
    const { agent, tracker } = setup([reply('', [tool('write_file', { path: 'a.ts', content: 'x' })]), reply('Done')], { check })
    await agent.runTurn('x', null)
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toContain('import x')
    tracker.rejectFile('a.ts')
    expect(fs.existsSync(path.join(root, 'a.ts'))).toBe(false)
  })

  it('tells the model to install dependencies when they are missing', async () => {
    const { agent, seen } = setup([reply('', [tool('write_file', { path: 'package.json', content: '{}' })]), reply('Done'), reply('Fine')])
    await agent.runTurn('x', null)
    expect(seen[2].at(-1)?.content).toMatch(/npm install/)
  })

  it('drops old turns when the conversation is too long, keeping the system prompt', async () => {
    const big = 'x'.repeat(20000)
    const { agent, seen } = setup([reply(big), reply(big), reply(big), reply('ok')], { settings: () => ({ ...DEFAULT_SETTINGS, contextTokens: 12000 }) })
    for (const q of ['q1', 'q2', 'q3', 'q4']) await agent.runTurn(q, null)
    const last = seen.at(-1)!
    expect(last[0].role).toBe('system')
    expect(last.some((m) => m.content.startsWith('q1'))).toBe(false)
    expect(last.at(-1)?.content.startsWith('q4')).toBe(true)
  })

  it('frees plenty of room at once, so the model does not re-read everything on each step', async () => {
    const big = 'x'.repeat(16000)
    const { agent } = setup(Array(8).fill(reply(big)), { settings: () => ({ ...DEFAULT_SETTINGS, contextTokens: 24000 }) })
    for (let i = 0; i < 8; i++) await agent.runTurn(`q${i}`, null)
    const size = agent.history.reduce((n, m) => n + m.content.length / 3.2 + 8, 0)
    // The newest answer may be added on top. The limit applies to what is sent to the model.
    expect(size).toBeLessThan(24000 + 16000 / 3.2 + 8)
    expect(agent.history.filter((m) => m.role === 'assistant').length).toBeLessThan(8)
  })

  it('friendly message when the model is off', async () => {
    const { agent, items } = setup([], { client: { stream: async () => { throw new TypeError('fetch failed') } } })
    await agent.runTurn('x', null)
    expect(items.some((i) => i.kind === 'error' && /Could not reach/.test(i.text))).toBe(true)
  })
})

describe('modes', () => {
  it('plan mode reads but cannot write', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'x')
    const { agent, toolMessages } = setup([reply('', [tool('read_file', { path: 'a.ts' })]), reply('', [tool('write_file', { path: 'b.ts', content: 'y' })]), reply('The plan')])
    await agent.runTurn('x', null, 'plan')
    expect(toolMessages()[0]).toContain('1\tx')
    expect(toolMessages()[1]).toMatch(/read-only/)
    expect(fs.existsSync(path.join(root, 'b.ts'))).toBe(false)
  })

  it('ask mode has no tools', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'x')
    const { agent, toolMessages } = setup([reply('', [tool('read_file', { path: 'a.ts' })]), reply('Answer')])
    await agent.runTurn('x', null, 'ask')
    expect(toolMessages()[0]).toMatch(/Ask mode/)
  })
})

it('missingInstall finds the nearest package.json', () => {
  fs.mkdirSync(path.join(root, 'api/src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'api/package.json'), '{}')
  expect(missingInstall(root, ['api/src/a.ts'])).toBe('api')
  fs.mkdirSync(path.join(root, 'api/node_modules'))
  expect(missingInstall(root, ['api/src/a.ts'])).toBeNull()
  expect(missingInstall(root, ['x.ts'])).toBeNull()
})
