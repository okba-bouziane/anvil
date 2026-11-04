import fs from 'node:fs'
import path from 'node:path'
import { it } from 'vitest'
import { Agent } from '../src/main/agent'
import { ChangeTracker } from '../src/main/changes'
import { createOpenAiClient } from '../src/main/model'
import { checkFiles } from '../src/main/tscheck'
import { DEFAULT_SETTINGS } from '../src/shared/types'

// Adds a feature across a real project. Needs the model running and a prepared copy in FEATURE_ROOT.
const root = process.env.FEATURE_ROOT
const real = root ? it : it.skip
const SAFE = /^(cd (backend|frontend) && )?(npm run (build|test)|npx tsc --noEmit[^;&|]*|npx ng build|npx vitest run)$/
const log = (s: string) => fs.appendFileSync(process.env.FEATURE_LOG!, `${new Date().toTimeString().slice(0, 8)} ${s}\n`)

real('adds task priority across backend and frontend', async () => {
  const tracker = new ChangeTracker(root!)
  const live = { peak: 0 }
  const agent = new Agent({
    root: root!, tracker, client: createOpenAiClient(() => ({ baseUrl: DEFAULT_SETTINGS.baseUrls.local, model: DEFAULT_SETTINGS.models.local, apiKey: null, strictOpenAi: false })), settings: () => DEFAULT_SETTINGS,
    emitItem: (i) => {
      if (i.kind === 'tool') log(`${i.name} ${i.summary} [${i.status}]`)
      else if (i.kind !== 'approval' && 'text' in i) log(`${i.kind}: ${i.text.slice(0, 700)}`)
      else if (i.kind === 'approval') log(`approval asked: ${i.command}`)
    },
    updateItem: (_id, p) => { if ((p as { status?: string }).status === 'error') log(`  failed: ${String((p as { output?: string }).output).slice(0, 900)}`) },
    textDelta: () => {}, liveStats: (_t, s) => { live.peak = Math.max(live.peak, s) }, changed: () => {},
    // Builds and tests only, so the model cannot run anything else during this test.
    askApproval: async (_id, command) => (SAFE.test(command) ? 'once' : 'deny'), check: checkFiles, allowedCommands: new Set()
  })
  const start = Date.now()
  await agent.runTurn(`Add a task priority feature across the backend and the frontend.
TaskPriority is 'LOW' | 'MEDIUM' | 'HIGH'. Task.create(title, priority = 'MEDIUM') throws ValidationError for an unknown value. The API accepts an optional priority when creating a task and returns it. It is stored in the database in a column with default 'MEDIUM'. The Angular board has a select to choose the priority when creating a task, and shows the priority in each task row. Keep everything else unchanged.`, null)
  log(`END minutes=${((Date.now() - start) / 60000).toFixed(1)} peak_tokens_s=${live.peak.toFixed(1)} changed=${tracker.list().map((c) => c.path).join(',')}`)
}, 1_900_000)
