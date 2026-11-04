import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AgentEvent, type AgentMode, type ApprovalAnswer, type ModelStatus, type ProjectState, type ProviderId, type Settings, type TreeEntry, type UiItem } from '../shared/types'
import { Agent } from './agent'
import { ChangeTracker } from './changes'
import * as git from './git'
import { importFromVscode, vscodePaths } from './vscode-import'
import { downloadCommand, INSTALL_COMMAND, isServerInstalled, modelStatus, startModel, stopModel, stopOwnServer } from './model'
import { clientFor, effectiveSettings, listModels, localModels } from './providers'
import { Secrets } from './secrets'
import { loadSession, saveSession, type Chat } from './session'
import { canRunMlx } from './platform'
import { assertWritable, findScripts, replaceInFiles, safePath, searchProject, walkFiles } from './tools'
import { Worker } from 'node:worker_threads'
import { isCloud } from '../shared/types'
import { Terminals } from './terminal'
import { checkFiles } from './tscheck'

// The local model runs on the GPU. Drawing the window on the CPU leaves the GPU to the model: live text
// cost a large share of its speed otherwise.
app.disableHardwareAcceleration()

let win: BrowserWindow | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
let secrets: Secrets
const terminals = new Terminals((event) => win?.webContents.send('anvil:terminal', event))

interface Project {
  root: string
  tracker: ChangeTracker
  chats: Chat[]
  active: Chat
  agent: Agent
  allowed: Set<string>
}

let project: Project | null = null
let busy = false
let saveTimer: NodeJS.Timeout | null = null
const approvals = new Map<string, (answer: ApprovalAnswer) => void>()

/* Code intelligence runs in a worker thread, which starts with the first file and stops when idle to free memory. */
let intelWorker: { worker: Worker; root: string } | null = null
let intelTimer: NodeJS.Timeout | null = null
let intelId = 0
const intelPending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
const INTEL_IDLE_MS = 10 * 60 * 1000

function stopIntel(): void {
  intelWorker?.worker.terminate()
  intelWorker = null
  for (const pending of intelPending.values()) pending.reject(new Error('stopped'))
  intelPending.clear()
}

function intelCall(method: string, args: unknown[]): Promise<unknown> {
  const root = project?.root
  if (!root) return Promise.reject(new Error('Open a project first'))
  if (!intelWorker || intelWorker.root !== root) {
    stopIntel()
    const worker = new Worker(path.join(__dirname, 'intel-worker.js'), { workerData: { root } })
    worker.on('message', ({ id, result, error }) => {
      const pending = intelPending.get(id)
      intelPending.delete(id)
      if (error) pending?.reject(new Error(error))
      else pending?.resolve(result)
    })
    worker.on('error', () => stopIntel())
    intelWorker = { worker, root }
  }
  if (intelTimer) clearTimeout(intelTimer)
  intelTimer = setTimeout(stopIntel, INTEL_IDLE_MS)
  return new Promise((resolve, reject) => {
    const id = ++intelId
    intelPending.set(id, { resolve, reject })
    intelWorker!.worker.postMessage({ id, method, args })
  })
}

let suggestAbort: AbortController | null = null

async function suggest(file: string, prefix: string, suffix: string): Promise<string> {
  suggestAbort?.abort()
  // Only local models: suggesting as you type would send code to a cloud provider, and bill for it, on every pause.
  if (!settings.inlineSuggest || busy || isCloud(settings)) return ''
  const abort = new AbortController()
  suggestAbort = abort
  let text = ''
  const client = clientFor(() => settings, (provider) => secrets.get(provider))
  await client.stream({
    messages: [
      { role: 'system', content: 'You complete code. Reply with only the code that belongs at <CURSOR>, with no explanation and no code fences. Keep it short: finish the current line or block, at most about 6 lines. If nothing fits, reply with nothing.' },
      { role: 'user', content: `File: ${file}\n\n${prefix}<CURSOR>${suffix}` }
    ],
    temperature: 0.1,
    maxTokens: 96,
    signal: abort.signal
  }, { onText: (delta) => { text += delta; return abort.signal.aborted }, onProgress: () => {} })
  return abort.signal.aborted ? '' : text.replace(/^```[^\n]*\n/, '').replace(/\n?```\s*$/, '')
}

const newer = (a: string, b: string) => {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** Only asks GitHub for the latest version number. Nothing about you or your code is sent, and it stays quiet offline. */
async function checkForUpdate(): Promise<void> {
  if (!settings.checkUpdates || process.env.ANVIL_DATA_DIR) return
  try {
    const response = await fetch('https://api.github.com/repos/okba-bouziane/anvil/releases/latest', { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/vnd.github+json' } })
    const release = (await response.json()) as { tag_name?: string; html_url?: string }
    if (release.tag_name && release.html_url && newer(release.tag_name, app.getVersion())) send({ type: 'update', version: release.tag_name, url: release.html_url })
  } catch {
    /* offline, which is fine */
  }
}

const dataDir = () => process.env.ANVIL_DATA_DIR ?? app.getPath('userData')
const settingsFile = () => path.join(dataDir(), 'settings.json')
const sessionsDir = () => path.join(dataDir(), 'sessions')

function loadSettings(): void {
  let saved: Partial<Settings> = {}
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    /* first run */
  }
  // MLX only runs on Apple Silicon. Everywhere else, the first choice for a local model is Ollama.
  const platformDefaults: Partial<Settings> = canRunMlx() ? {} : { provider: 'custom' }
  settings = {
    ...DEFAULT_SETTINGS,
    ...platformDefaults,
    ...saved,
    models: { ...DEFAULT_SETTINGS.models, ...saved.models },
    editor: { ...DEFAULT_SETTINGS.editor, ...saved.editor },
    baseUrls: { ...DEFAULT_SETTINGS.baseUrls, ...(canRunMlx() ? {} : { custom: 'http://127.0.0.1:11434/v1' }), ...saved.baseUrls }
  }
}

function writeSettings(): void {
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
}

/* Text arrives a token at a time. Sending it in small batches keeps the window from redrawing for each one. */
const pendingText = new Map<string, string>()
let textTimer: NodeJS.Timeout | null = null
let lastStats = 0

function flushText(): void {
  if (textTimer) clearTimeout(textTimer)
  textTimer = null
  for (const [id, delta] of pendingText) win?.webContents.send('anvil:event', { type: 'text-delta', id, delta })
  pendingText.clear()
}

function send(event: AgentEvent): void {
  flushText()
  win?.webContents.send('anvil:event', event)
}

function queueText(id: string, delta: string): void {
  pendingText.set(id, (pendingText.get(id) ?? '') + delta)
  textTimer ??= setTimeout(flushText, 90)
}

function save(now = false): void {
  if (!project) return
  if (saveTimer) clearTimeout(saveTimer)
  const p = project
  const write = () => saveSession(sessionsDir(), p.root, { chats: p.chats, activeChat: p.active.id, changes: p.tracker.toJSON() })
  if (now) write()
  else saveTimer = setTimeout(write, 500)
}

function sendChanges(): void {
  if (project) send({ type: 'changes', changes: project.tracker.list(), checkpoints: project.tracker.listCheckpoints() })
  save()
}

const summaries = (p: Project) => [...p.chats].sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))

function newChatObject(): Chat {
  return { id: randomUUID().slice(0, 8), title: 'New chat', updatedAt: Date.now(), history: [], items: [] }
}

function makeAgent(root: string, tracker: ChangeTracker, chat: Chat, allowed: Set<string>): Agent {
  const items = chat.items
  const find = (id: string) => items.findIndex((i) => i.id === id)
  const agent = new Agent({
    root,
    tracker,
    allowedCommands: allowed,
    client: clientFor(() => settings, (provider) => secrets.get(provider)),
    settings: () => effectiveSettings(settings),
    check: checkFiles,
    emitItem: (item) => {
      const at = find(item.id)
      if (at >= 0) {
        const old = items[at]
        items[at] = item.kind === 'tool' && old.kind === 'tool' && !item.output ? { ...item, output: old.output } : item
      } else items.push(item)
      send({ type: 'item', item: items[at >= 0 ? at : items.length - 1] })
      save()
    },
    updateItem: (id, patch) => {
      const at = find(id)
      if (at >= 0) items[at] = { ...items[at], ...patch } as UiItem
      send({ type: 'item-update', id, patch })
      save()
    },
    textDelta: (id, delta) => {
      const at = find(id)
      if (at >= 0) {
        const item = items[at]
        if (item.kind === 'assistant') item.text += delta
        else if (item.kind === 'tool') item.output = (item.output ?? '') + delta
      }
      queueText(id, delta)
    },
    liveStats: (tokens, tokensPerSecond, waiting) => {
      const now = Date.now()
      if (tokens && now - lastStats < 250) return
      lastStats = now
      send({ type: 'live-stats', tokens, tokensPerSecond, waiting })
    },
    context: (tokens, limit) => send({ type: 'context', tokens, limit }),
    changed: (rel) => {
      send({ type: 'file-changed', path: rel })
      sendChanges()
    },
    askApproval: (id) => new Promise((resolve) => approvals.set(id, resolve))
  }, chat.history)
  chat.history = agent.history
  return agent
}

function gitBranch(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim() || null
  } catch {
    return null
  }
}

function openRoot(root: string): ProjectState {
  const real = fs.realpathSync(root)
  if (project) {
    save(true)
    terminals.killAll()
    stopIntel()
  }
  const saved = loadSession(sessionsDir(), real)
  const tracker = new ChangeTracker(real, saved?.changes)
  const chats = saved?.chats?.length ? saved.chats : [newChatObject()]
  for (const chat of chats) {
    chat.items = chat.items.map((item) =>
      item.kind === 'approval' && item.status === 'pending' ? { ...item, status: 'denied' as const } : item.kind === 'tool' && item.status === 'running' ? { ...item, status: 'error' as const } : item
    )
  }
  const active = chats.find((c) => c.id === saved?.activeChat) ?? chats[0]
  const allowed = new Set<string>()
  project = { root: real, tracker, chats, active, allowed, agent: makeAgent(real, tracker, active, allowed) }
  settings = { ...settings, lastProject: real, recentProjects: [real, ...settings.recentProjects.filter((r) => r !== real)].slice(0, 6) }
  writeSettings()
  return projectState()
}

function projectState(): ProjectState {
  const p = project!
  return {
    root: p.root,
    name: path.basename(p.root),
    branch: gitBranch(p.root),
    items: p.active.items,
    changes: p.tracker.list(),
    checkpoints: p.tracker.listCheckpoints(),
    chats: summaries(p),
    activeChat: p.active.id
  }
}

const need = (): Project => {
  if (!project) throw new Error('Open a project first')
  return project
}

const notBusy = () => {
  if (busy) throw new Error('Wait for the current step to finish, or press Stop')
}

const importFile = () => path.join(dataDir(), 'vscode-import.json')
const modelLog = () => path.join(dataDir(), 'model-server.log')
const status = (): Promise<ModelStatus> => modelStatus(settings, settings.provider === 'local' || secrets.has(settings.provider))

function activate(p: Project, chat: Chat): ProjectState {
  p.active = chat
  p.agent = makeAgent(p.root, p.tracker, chat, p.allowed)
  save(true)
  return projectState()
}

/** Deleted files go to the Trash, so they can be recovered. */
function trash(file: string): Promise<void> {
  if (process.env.ANVIL_DATA_DIR) {
    // Tests use throwaway folders and should not fill the real Trash.
    fs.rmSync(file, { recursive: true, force: true })
    return Promise.resolve()
  }
  return shell.trashItem(file)
}

function handlers() {
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`anvil:${name}`, (_event, ...args) => fn(...args))
  const mutate = (fn: (p: Project) => void) => {
    fn(need())
    sendChanges()
  }

  handle('getSettings', () => settings)
  handle('setSettings', (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }
    writeSettings()
    return settings
  })
  handle('modelStatus', status)
  handle('startModel', () => {
    startModel(settings.models.local, settings.baseUrls.local, modelLog())
    return status()
  })
  handle('stopModel', () => {
    stopModel(settings.baseUrls.local)
    return 'offline'
  })
  handle('listModels', (provider: ProviderId) => listModels(provider, settings, provider === 'local' ? null : secrets.get(provider)))
  handle('switchLocalModel', (id: string) => {
    notBusy()
    settings = { ...settings, provider: 'local', models: { ...settings.models, local: id } }
    writeSettings()
    startModel(id, settings.baseUrls.local, modelLog())
    return 'starting'
  })
  handle('keyStatus', () => Object.fromEntries((['local', 'anthropic', 'openai', 'custom'] as const).map((p) => [p, secrets.has(p)])))
  handle('setApiKey', (provider: ProviderId, key: string) => secrets.set(provider, key.trim()))
  handle('clearApiKey', (provider: ProviderId) => secrets.clear(provider))
  handle('initialProject', () => {
    if (project) return projectState()
    if (!settings.lastProject || !fs.existsSync(settings.lastProject)) return null
    return openRoot(settings.lastProject)
  })
  handle('openProject', async () => {
    notBusy()
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : openRoot(result.filePaths[0])
  })
  handle('openProjectPath', (root: string) => {
    notBusy()
    return openRoot(root)
  })
  handle('listDir', (rel: string): TreeEntry[] => {
    const p = need()
    const dir = safePath(p.root, rel)
    return fs.readdirSync(path.join(p.root, dir), { withFileTypes: true })
      .filter((e) => !['.git', 'node_modules', '.DS_Store'].includes(e.name))
      .map((e) => ({ name: e.name, path: dir === '.' ? e.name : `${dir}/${e.name}`, isDir: e.isDirectory() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  })
  handle('listFiles', () => {
    const out: string[] = []
    for (const rel of walkFiles(need().root)) {
      out.push(rel)
      if (out.length >= 5000) break
    }
    return out
  })
  handle('readFile', (rel: string) => {
    const p = need()
    const file = path.join(p.root, safePath(p.root, rel))
    if (fs.statSync(file).size > 5_000_000) throw new Error(`${rel} is too large to open here`)
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes('\0')) throw new Error(`${rel} is not a text file`)
    return text
  })
  const treeChanged = () => {
    void intelCall('filesChanged', []).catch(() => {})
    send({ type: 'tree' })
    sendChanges()
  }
  /* These act on the user's own request, so they can touch any file in the project except inside .git. */
  const writablePath = (p: Project, rel: string) => {
    const safe = safePath(p.root, rel)
    assertWritable(safe)
    if (safe === '.') throw new Error('Pick a file or folder inside the project')
    return safe
  }
  handle('createPath', (rel: string, isDir: boolean) => {
    const p = need()
    const safe = writablePath(p, rel)
    const full = path.join(p.root, safe)
    if (fs.existsSync(full)) throw new Error(`${safe} already exists`)
    if (isDir) fs.mkdirSync(full, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, '')
    }
    treeChanged()
  })
  handle('renamePath', (from: string, to: string) => {
    const p = need()
    const source = writablePath(p, from)
    const target = writablePath(p, to)
    if (fs.existsSync(path.join(p.root, target))) throw new Error(`${target} already exists`)
    fs.mkdirSync(path.dirname(path.join(p.root, target)), { recursive: true })
    fs.renameSync(path.join(p.root, source), path.join(p.root, target))
    p.tracker.forgetUnder(source)
    treeChanged()
  })
  handle('deletePath', async (rel: string) => {
    const p = need()
    const safe = writablePath(p, rel)
    await trash(path.join(p.root, safe))
    p.tracker.forgetUnder(safe)
    treeChanged()
  })
  handle('searchProject', (query: string, options: { caseSensitive: boolean; regex: boolean }) => {
    try {
      return searchProject(need().root, query, options)
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error('That search pattern is not valid')
      throw err
    }
  })
  handle('gitStatus', () => git.status(need().root))
  handle('gitInit', () => git.init(need().root))
  handle('gitStage', (paths: string[], add: boolean) => {
    const p = need()
    return git.stage(p.root, paths.map((f) => safePath(p.root, f)), add)
  })
  handle('gitDiscard', async (rel: string) => {
    const p = need()
    const safe = writablePath(p, rel)
    if (!(await git.discard(p.root, safe))) await trash(path.join(p.root, safe))
    treeChanged()
  })
  handle('gitCommit', (message: string) => git.commit(need().root, message))
  handle('gitSync', (action: 'pull' | 'push') => git.sync(need().root, action))
  handle('gitDiff', async (rel: string) => {
    const p = need()
    const safe = safePath(p.root, rel)
    const file = path.join(p.root, safe)
    return { original: await git.headVersion(p.root, safe), modified: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' }
  })
  handle('intel', (method: string, ...args: unknown[]) => intelCall(method, args))
  handle('listScripts', () => findScripts(need().root))
  handle('replaceInProject', (query: string, options: { caseSensitive: boolean; regex: boolean }, replacement: string) => {
    const p = need()
    notBusy()
    let results
    try {
      results = replaceInFiles(p.root, query, options, replacement)
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error('That search pattern is not valid')
      throw err
    }
    // Replacing goes through review like any other change, so it can be undone.
    p.tracker.beginCheckpoint(randomUUID().slice(0, 8), `Replace ${query} with ${replacement}`)
    for (const r of results) {
      assertWritable(r.path)
      p.tracker.write(r.path, r.content)
    }
    const done = p.tracker.endCheckpoint()
    if (done) p.active.items.push({ kind: 'checkpoint', id: randomUUID().slice(0, 8), checkpointId: done.id })
    if (done) send({ type: 'item', item: p.active.items[p.active.items.length - 1] })
    sendChanges()
    return { files: results.length, matches: results.reduce((n, r) => n + r.matches, 0) }
  })
  handle('suggest', (file: string, prefix: string, suffix: string) => suggest(file, prefix, suffix).catch(() => ''))
  handle('cancelSuggest', () => suggestAbort?.abort())
  handle('openRelease', (url: string) => {
    if (url.startsWith('https://github.com/okba-bouziane/anvil/')) void shell.openExternal(url)
  })
  handle('importVscode', () => {
    const { assets, summary, settingsPatch } = importFromVscode(vscodePaths())
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFileSync(importFile(), JSON.stringify(assets))
    settings = { ...settings, ...settingsPatch, editor: { ...settings.editor, ...settingsPatch.editor } }
    writeSettings()
    return summary
  })
  handle('importedAssets', () => {
    try {
      return JSON.parse(fs.readFileSync(importFile(), 'utf8'))
    } catch {
      return { snippets: [], themes: [] }
    }
  })
  handle('terminalCreate', () => terminals.create(project?.root ?? ''))
  handle('terminalWrite', (id: string, data: string) => terminals.write(id, data))
  handle('terminalResize', (id: string, cols: number, rows: number) => terminals.resize(id, cols, rows))
  handle('terminalKill', (id: string) => terminals.kill(id))
  handle('localSetup', () => ({
    platformOk: canRunMlx(),
    serverInstalled: canRunMlx() && isServerInstalled(),
    hasModels: localModels().length > 0,
    installCommand: INSTALL_COMMAND,
    downloadCommand: downloadCommand(DEFAULT_SETTINGS.models.local)
  }))
  handle('writeFile', (rel: string, content: string) => {
    const p = need()
    fs.writeFileSync(path.join(p.root, safePath(p.root, rel)), content)
    sendChanges()
  })
  handle('send', async (text: string, activeFile: string | null, mode: AgentMode) => {
    const p = need()
    notBusy()
    busy = true
    send({ type: 'busy', busy: true })
    const chat = p.active
    if (!chat.items.some((i) => i.kind === 'user')) chat.title = text.slice(0, 60)
    chat.updatedAt = Date.now()
    chat.items.push({ kind: 'user', id: `u${Date.now()}`, text })
    send({ type: 'item', item: chat.items[chat.items.length - 1] })
    send({ type: 'chats', chats: summaries(p), activeChat: chat.id })
    try {
      await p.agent.runTurn(text, activeFile, mode)
    } finally {
      busy = false
      flushText()
      send({ type: 'busy', busy: false })
      sendChanges()
      save(true)
    }
  })
  handle('cancel', () => {
    project?.agent.cancel()
    for (const [id, resolve] of approvals) {
      approvals.delete(id)
      resolve('deny')
    }
  })
  handle('answerApproval', (id: string, answer: ApprovalAnswer) => {
    approvals.get(id)?.(answer)
    approvals.delete(id)
  })
  handle('newChat', () => {
    const p = need()
    notBusy()
    // An empty chat is reused, so pressing New chat twice leaves one.
    const empty = p.chats.find((c) => !c.items.length)
    const chat = empty ?? newChatObject()
    if (!empty) p.chats.push(chat)
    chat.updatedAt = Date.now()
    return activate(p, chat)
  })
  handle('switchChat', (id: string) => {
    const p = need()
    notBusy()
    const chat = p.chats.find((c) => c.id === id)
    if (!chat) throw new Error('That chat no longer exists')
    return activate(p, chat)
  })
  handle('deleteChat', (id: string) => {
    const p = need()
    notBusy()
    p.chats = p.chats.filter((c) => c.id !== id)
    if (!p.chats.length) p.chats.push(newChatObject())
    return activate(p, p.active.id === id ? p.chats[0] : p.active)
  })
  handle('getDiff', (rel: string) => {
    const p = need()
    const safe = safePath(p.root, rel)
    return { ...p.tracker.diff(safe), change: p.tracker.list().find((c) => c.path === safe) ?? null }
  })
  handle('acceptFile', (rel: string) => mutate((p) => p.tracker.acceptFile(rel)))
  handle('rejectFile', (rel: string) => mutate((p) => p.tracker.rejectFile(rel)))
  handle('acceptHunk', (rel: string, i: number) => mutate((p) => p.tracker.acceptHunk(rel, i)))
  handle('rejectHunk', (rel: string, i: number) => mutate((p) => p.tracker.rejectHunk(rel, i)))
  handle('acceptAll', () => mutate((p) => p.tracker.acceptAll()))
  handle('rejectAll', () => mutate((p) => p.tracker.rejectAll()))
  handle('undoCheckpoint', (id: string) => {
    notBusy()
    mutate((p) => p.tracker.undoCheckpoint(id))
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1512,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#0c0d10',
    title: 'Anvil',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : { autoHideMenuBar: true }),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  // The window asks first when it has unsaved edits.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win!, { type: 'warning', buttons: ['Close without saving', 'Keep editing'], defaultId: 1, cancelId: 1, message: 'You have unsaved changes.' })
    if (choice === 0) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  win.on('closed', () => { win = null })
}

app.whenReady().then(() => {
  loadSettings()
  secrets = new Secrets(path.join(dataDir(), 'secrets.json'), !!process.env.ANVIL_MEMORY_SECRETS)
  handlers()
  createWindow()
  setTimeout(() => void checkForUpdate(), 5000)
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})

app.on('before-quit', () => {
  project?.agent.cancel()
  terminals.killAll()
  stopIntel()
  stopOwnServer()
  save(true)
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
