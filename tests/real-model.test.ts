import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { Agent } from '../src/main/agent'
import { ChangeTracker } from '../src/main/changes'
import { createOpenAiClient } from '../src/main/model'
import { checkFiles } from '../src/main/tscheck'
import { DEFAULT_SETTINGS, type UiItem } from '../src/shared/types'

// Needs the model running. Run with: REAL_MODEL=1 npx vitest run tests/real-model.test.ts
const real = process.env.REAL_MODEL ? it : it.skip

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-real-')))
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.symlinkSync(path.resolve('node_modules/typescript'), path.join(root, 'node_modules/typescript'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo","type":"module"}\n')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true, types: [] }, include: ['src'] }))
  fs.writeFileSync(path.join(root, 'src/math.ts'), 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  fs.writeFileSync(path.join(root, 'src/index.ts'), "import { add } from './math.js'\n\nconsole.log(add(2, 3))\n")
  return root
}

real('the real model changes two files through the tags', async () => {
  const root = project()
  const items: UiItem[] = []
  const tracker = new ChangeTracker(root)
  const live: Record<string, number> = {}
  let peak = 0
  const agent = new Agent({
    root, tracker, client: createOpenAiClient(() => ({ baseUrl: DEFAULT_SETTINGS.baseUrls.local, model: DEFAULT_SETTINGS.models.local, apiKey: null, strictOpenAi: false })), settings: () => DEFAULT_SETTINGS,
    emitItem: (i) => {
      items.push(i)
      if (i.kind === 'tool') console.log('TOOL', i.name, i.summary, i.status)
      if (i.kind === 'check' || i.kind === 'error' || i.kind === 'note') console.log(i.kind.toUpperCase(), i.text)
    },
    updateItem: (id, p) => { if ('status' in p) console.log('  ->', p.status, String((p as { output?: string }).output ?? '').slice(0, 120)) },
    textDelta: (id, d) => { live[id] = (live[id] ?? 0) + d.length },
    liveStats: (_t, s) => { peak = Math.max(peak, s) },
    changed: () => {}, askApproval: async () => 'deny', check: checkFiles, allowedCommands: new Set()
  })
  await agent.runTurn('Add a subtract function to src/math.ts, then use it in src/index.ts to log subtract(5, 2).', null)
  for (const m of agent.history.slice(1)) console.log(`[${m.role}]`, m.content.slice(0, 300).replace(/\n/g, ' | '))
  const math = fs.readFileSync(path.join(root, 'src/math.ts'), 'utf8')
  const index = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')
  console.log(math, index, 'peak tokens/s', peak.toFixed(1))
  expect(math).toMatch(/subtract/)
  expect(index).toMatch(/subtract\(5, 2\)/)
  expect(checkFiles(root, ['src/math.ts', 'src/index.ts']).errors).toEqual([])
  expect(tracker.list().map((c) => c.path)).toEqual(['src/index.ts', 'src/math.ts'])
}, 280000)
