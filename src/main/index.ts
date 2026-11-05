import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type EditorSettings, type ImportedAssets, type DebugConfig, type AgentEvent, type AgentMode, type ApprovalAnswer, type ModelStatus, type ProjectState, type ProviderId, type Settings, type TreeEntry, type UiItem } from '../shared/types'
import { Agent } from './agent'
import { ChangeTracker } from './changes'
import * as git from './git'
import { importFromVscode, vscodePaths } from './vscode-import'
import { downloadCommand, INSTALL_COMMAND, isServerInstalled, modelStatus, startModel, stopModel, stopOwnServer } from './model'
import { clientFor, effectiveSettings, listModels, localModels } from './providers'
import { Secrets } from './secrets'
import { claudeFolderFor, claudeSessionFile, listClaudeSessions, readClaudeSession } from './claude-import'
import { loadSession, saveSession, type Chat } from './session'
import { canRunMlx } from './platform'
import { assertWritable, findScripts, replaceInFiles, safePath, searchProject, setScope, walkFiles, type SearchOptions } from './tools'
import { Worker } from 'node:worker_threads'
import { isCloud } from '../shared/types'
import { Terminals } from './terminal'
import { Tooling } from './tooling'
import { commonParent, findRepos, outOfRepo, readWorkspaceFile, repoOf, vscodeEditorSettings, vscodeLaunch, vscodeTasks, withinRepo, writeWorkspaceFile } from './workspace'
import { Extensions } from './extensions'
import { Debugger, type BreakpointSpec } from './debug'
import { fromUri, hasAngular, LspClient, pythonFor, toUri, type LspKind } from './lsp'
import { assetFor, downloadAsset, latestRelease, newer, prepareInstall, type Installer, type Release } from './updater'
import { checkFiles } from './tscheck'

// Drawing with the graphics chip keeps scrolling smooth. The local model also runs on that chip, so anyone who
// wants every bit of its speed can leave the chip to the model. This has to be decided before the app starts.
function savedGpuChoice(): boolean {
  try {
    const dir = process.env.ANVIL_DATA_DIR ?? app.getPath('userData')
    return (JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { leaveGpuToModel?: boolean }).leaveGpuToModel === true
  } catch {
    return false
  }
}
if (savedGpuChoice()) app.disableHardwareAcceleration()

/* Each extra window is its own copy of the app with one project. Keeping their browser data apart lets them run side by side. */
const projectArg = (() => {
  const i = process.argv.indexOf('--project')
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null
})()
if (projectArg) app.setPath('sessionData', path.join(app.getPath('userData'), 'windows', createHash('sha1').update(projectArg).digest('hex').slice(0, 16)))

function openInNewWindow(folder: string): void {
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--project', folder]
  spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }).unref()
}

/** Adds an `anvil` command for the terminal. It goes in your own ~/.local/bin, so it needs no password. */
function installCommand(): string {
  if (process.platform === 'win32') throw new Error('The anvil command is only for Mac and Linux for now.')
  const dir = path.join(os.homedir(), '.local/bin')
  const file = path.join(dir, 'anvil')
  const launch = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n# Opens a folder in Anvil.\nfolder=$(cd "\${1:-.}" && pwd) || exit 1\nnohup ${launch} --project "$folder" >/dev/null 2>&1 &\n`, { mode: 0o755 })
  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir)
  return onPath ? 'Installed. Run "anvil ." in any folder.' : `Installed to ${file}. Add ${dir} to your PATH, then run "anvil ." in any folder.`
}

let win: BrowserWindow | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
let secrets: Secrets
const terminals = new Terminals((event) => win?.webContents.send('anvil:terminal', event))

interface Project {
  root: string
  folders: string[] | null
  workspaceFile: string | null
  activeRepo: string | null
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

/* The project's ESLint and Prettier run in their own worker, and only once you allow it for this project. */
let toolingWorker: { worker: Worker; root: string } | null = null
let toolingId = 0
const toolingPending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()

function stopTooling(): void {
  void toolingWorker?.worker.terminate()
  toolingWorker = null
  for (const pending of toolingPending.values()) pending.reject(new Error('stopped'))
  toolingPending.clear()
}

function toolingCall(method: string, args: unknown[]): Promise<unknown> {
  const root = project?.root
  if (!root || !settings.trustedProjects.includes(root)) return Promise.resolve(null)
  if (!toolingWorker || toolingWorker.root !== root) {
    stopTooling()
    const worker = new Worker(path.join(__dirname, 'tooling-worker.js'), { workerData: { root } })
    worker.on('message', ({ id, result, error }) => {
      const pending = toolingPending.get(id)
      toolingPending.delete(id)
      if (error) pending?.reject(new Error(error))
      else pending?.resolve(result)
    })
    worker.on('error', () => stopTooling())
    toolingWorker = { worker, root }
  }
  return new Promise((resolve, reject) => {
    const id = ++toolingId
    toolingPending.set(id, { resolve, reject })
    toolingWorker!.worker.postMessage({ id, method, args })
  })
}

function projectPackages(root: string, folders: string[] | null): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = []
  const visit = (dir: string, depth: number) => {
    const file = path.join(dir, 'package.json')
    if (fs.existsSync(file)) found.push({ path: path.relative(root, file), text: fs.readFileSync(file, 'utf8') })
    if (depth === 0) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') visit(path.join(dir, entry.name), depth - 1)
    }
  }
  for (const folder of folders ?? ['.']) visit(path.join(root, folder), 3)
  return found
}

/* Python and Angular templates are understood by language servers, started the first time you open such a file. */
const lspClients = new Map<LspKind, LspClient>()
function stopLsp(): void {
  for (const client of lspClients.values()) client.stop()
  lspClients.clear()
}
function lspClient(kind: LspKind): LspClient {
  const p = need()
  let client = lspClients.get(kind)
  if (!client) {
    client = new LspClient(kind, p.root, kind === 'python' ? pythonFor(p.root, settings.trustedProjects.includes(p.root)) : null,
      (rel, diagnostics) => send({ type: 'lsp-diagnostics', kind, path: rel, diagnostics }),
      () => { lspClients.delete(kind); send({ type: 'lsp-stopped', kind }) })
    lspClients.set(kind, client)
  }
  return client
}

let debugSession: Debugger | null = null
const jsDebugDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'js-debug') : path.join(app.getAppPath(), 'resources/js-debug'))

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

/* Changes from the terminal, `git pull` or another program show up without a manual refresh. */
let watchers: fs.FSWatcher[] = []
let watchTimer: ReturnType<typeof setTimeout> | null = null
function watchProject(root: string, folders: string[] | null): void {
  watchers.forEach((w) => w.close())
  watchers = []
  for (const folder of folders ?? ['.']) {
    try {
      const watcher = fs.watch(path.join(root, folder), { recursive: true }, (_event, name) => {
        const rel = String(name ?? '').replaceAll('\\', '/')
        if (/(^|\/)node_modules\//.test(rel) || /(^|\/)(dist|out|\.next|\.angular|coverage)\//.test(rel)) return
        if (/(^|\/)\.git\//.test(rel) && !/(^|\/)\.git\/(HEAD|index|refs\/|MERGE_HEAD|REBASE_HEAD)/.test(rel)) return
        if (watchTimer) clearTimeout(watchTimer)
        watchTimer = setTimeout(() => {
          send({ type: 'tree' })
          if (project?.tracker.list().length) sendChanges()
        }, 350)
      })
      watcher.on('error', () => watcher.close())
      watchers.push(watcher)
    } catch {
      /* This system can't watch the folder. Refreshes still happen after every action in the app. */
    }
  }
}

/* The menu bar sends each choice to the window, which runs the same command the palette would. */
function buildMenu(): void {
  const run = (id: string) => () => send({ type: 'menu', id })
  const item = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({ label, click: run(id), accelerator, registerAccelerator: false })
  const recent: MenuItemConstructorOptions[] = settings.recentProjects.map((r) => ({ label: path.basename(r, '.code-workspace'), click: run(`recent:${r}`) }))
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [
      item('New File', 'new-file', 'CmdOrCtrl+Alt+N'),
      item('New Window', 'new-window-empty', 'CmdOrCtrl+Shift+N'),
      { type: 'separator' },
      item('Open File…', 'open-file-dialog', 'CmdOrCtrl+O'),
      item('Open Folder…', 'open-folder'),
      item('Open Workspace…', 'open-workspace'),
      { label: 'Open Recent', submenu: recent.length ? recent : [{ label: 'Nothing yet', enabled: false }] },
      { type: 'separator' },
      item('Add Folder to Workspace…', 'add-folder'),
      item('Save Workspace As…', 'save-workspace'),
      item('Clone Repository…', 'clone'),
      { type: 'separator' },
      item('Save', 'save', 'CmdOrCtrl+S'),
      item('Save As…', 'save-as', 'CmdOrCtrl+Shift+S'),
      item('Save All', 'save-all', 'CmdOrCtrl+Alt+S'),
      item('Revert File', 'revert'),
      { type: 'separator' },
      item('Auto Save', 'toggle-auto-save'),
      item('Settings', 'settings', 'CmdOrCtrl+,'),
      item('Keyboard Shortcuts', 'shortcuts'),
      { type: 'separator' },
      item('Close Tab', 'close', 'CmdOrCtrl+W'),
      item('Close Folder', 'close-folder'),
      ...(process.platform === 'darwin' ? [{ role: 'close' as const, label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' }] : [{ role: 'quit' as const }])
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' },
      item('Find', 'editor:actions.find', 'CmdOrCtrl+F'),
      item('Replace', 'editor:editor.action.startFindReplaceAction', 'CmdOrCtrl+Alt+F'),
      item('Find in Project', 'search', 'CmdOrCtrl+Shift+F'),
      { type: 'separator' },
      item('Toggle Line Comment', 'editor:editor.action.commentLine', 'CmdOrCtrl+/'),
      item('Toggle Block Comment', 'editor:editor.action.blockComment', 'Shift+Alt+A')
    ] },
    { label: 'Selection', submenu: [
      { role: 'selectAll' },
      item('Expand Selection', 'editor:editor.action.smartSelect.expand'),
      item('Shrink Selection', 'editor:editor.action.smartSelect.shrink'),
      { type: 'separator' },
      item('Copy Line Up', 'editor:editor.action.copyLinesUpAction', 'Shift+Alt+Up'),
      item('Copy Line Down', 'editor:editor.action.copyLinesDownAction', 'Shift+Alt+Down'),
      item('Move Line Up', 'editor:editor.action.moveLinesUpAction', 'Alt+Up'),
      item('Move Line Down', 'editor:editor.action.moveLinesDownAction', 'Alt+Down'),
      { type: 'separator' },
      item('Add Cursor Above', 'editor:editor.action.insertCursorAbove', 'CmdOrCtrl+Alt+Up'),
      item('Add Cursor Below', 'editor:editor.action.insertCursorBelow', 'CmdOrCtrl+Alt+Down'),
      item('Add Next Occurrence', 'editor:editor.action.addSelectionToNextFindMatch', 'CmdOrCtrl+D'),
      item('Select All Occurrences', 'editor:editor.action.selectHighlights', 'CmdOrCtrl+Shift+L')
    ] },
    { label: 'View', submenu: [
      item('Command Palette…', 'palette', 'CmdOrCtrl+Shift+P'),
      { type: 'separator' },
      item('Explorer', 'files'), item('Search', 'search'), item('Source Control', 'git-panel'), item('Run and Debug', 'debug'), item('Extensions', 'extensions', 'CmdOrCtrl+Shift+X'),
      { type: 'separator' },
      item('Problems', 'problems'), item('Terminal', 'terminal', 'CmdOrCtrl+J'), item('Debug Console', 'debug-console'),
      { type: 'separator' },
      item('Side Panel', 'side', 'CmdOrCtrl+B'), item('Agent', 'agent', 'CmdOrCtrl+L'), item('Editor Side by Side', 'split', 'CmdOrCtrl+\\'),
      item('Zen Mode', 'zen'), item('Word Wrap', 'word-wrap', 'Alt+Z'), item('Minimap', 'minimap'),
      { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }
    ] },
    { label: 'Go', submenu: [
      item('Go to File…', 'open-file', 'CmdOrCtrl+P'),
      item('Go to Symbol in File…', 'symbol', 'CmdOrCtrl+Shift+O'),
      item('Go to Line…', 'line', 'Ctrl+G'),
      { type: 'separator' },
      item('Go to Definition', 'editor:editor.action.revealDefinition', 'F12'),
      item('Go to References', 'editor:editor.action.goToReferences', 'Shift+F12'),
      item('Next Problem', 'editor:editor.action.marker.next', 'F8'),
      item('Previous Problem', 'editor:editor.action.marker.prev', 'Shift+F8'),
      { type: 'separator' },
      item('Next Tab', 'next', 'Ctrl+Tab'), item('Previous Tab', 'prev', 'Ctrl+Shift+Tab'), item('Reopen Closed Tab', 'reopen', 'CmdOrCtrl+Shift+T')
    ] },
    { label: 'Run', submenu: [
      item('Run and Debug', 'debug', 'F5'),
      item('Toggle Breakpoint', 'editor:anvil.toggleBreakpoint', 'F9'),
      { type: 'separator' },
      item('Run Task…', 'tasks')
    ] },
    { label: 'Terminal', submenu: [
      item('New Terminal', 'new-terminal'), item('Split Terminal', 'split-terminal'),
      { type: 'separator' },
      item('Run Task…', 'tasks')
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Report a Problem', click: () => void shell.openExternal('https://github.com/okba-bouziane/anvil/issues') },
      { label: 'Check for Updates', click: run('check-update') },
      { type: 'separator' },
      { role: 'toggleDevTools' }
    ] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

let release: Release | null = null
let installer: Installer | null = null
let installOnQuit = false
const machine = () => ({ platform: process.platform, arch: process.arch, appImage: process.env.APPIMAGE })
const canInstall = (r: Release) => app.isPackaged && !!assetFor(r.assets, machine())

/** Quiet when offline, unless you asked, and off if you turned it off. */
async function checkForUpdate(asked = false): Promise<{ current: string; latest: string | null }> {
  const current = app.getVersion()
  if (!asked && (!settings.checkUpdates || process.env.ANVIL_DATA_DIR)) return { current, latest: null }
  try {
    const found = await latestRelease()
    if (found && newer(found.version, current)) {
      release = found
      send({ type: 'update', version: found.version, url: found.url, canInstall: canInstall(found) })
      return { current, latest: found.version }
    }
    return { current, latest: null }
  } catch (error) {
    if (asked) throw new Error("Couldn't reach GitHub. Check your connection and try again.")
    void error
    return { current, latest: null }
  }
}

async function downloadUpdate(): Promise<void> {
  const asset = release && assetFor(release.assets, machine())
  if (!asset) throw new Error('There is no installer for this computer. Open the release page instead.')
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'anvil-update-'))
  const file = await downloadAsset(asset, dir, (percent) => send({ type: 'update-progress', percent }))
  installer = prepareInstall(file, machine(), process.execPath, process.pid, (f) => void shell.openPath(f))
  send({ type: 'update-ready', label: installer.label })
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
  // 12.5 was the old default, so it moves with the new one.
  if (settings.editor.fontSize === 12.5) settings.editor.fontSize = DEFAULT_SETTINGS.editor.fontSize
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

/** Opens a folder or a .code-workspace file. */
function openTarget(target: string): ProjectState {
  if (target.endsWith('.code-workspace') && fs.existsSync(target) && fs.statSync(target).isFile()) {
    const folders = readWorkspaceFile(target)
    const root = commonParent(folders)
    return openRoot(root, folders.length > 1 ? folders.map((f) => path.relative(root, f).split(path.sep).join('/')) : null, target)
  }
  return openRoot(target, null, null)
}

function openRoot(root: string, folders: string[] | null = null, workspaceFile: string | null = null): ProjectState {
  const real = fs.realpathSync(root)
  setScope(real, folders)
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
  const repos = findRepos(real, folders)
  project = { root: real, folders, workspaceFile, activeRepo: repos[0] ?? null, tracker, chats, active, allowed, agent: makeAgent(real, tracker, active, allowed) }
  watchProject(real, folders)
  void debugSession?.stop()
  stopLsp()
  stopTooling()
  settings = { ...settings, lastProject: projectArg ? settings.lastProject : (workspaceFile ?? real), recentProjects: [workspaceFile ?? real, ...settings.recentProjects.filter((r) => r !== (workspaceFile ?? real))].slice(0, 8) }
  writeSettings()
  buildMenu()
  return projectState()
}

function projectState(): ProjectState {
  const p = project!
  return {
    root: p.root,
    name: p.workspaceFile ? path.basename(p.workspaceFile, '.code-workspace') : p.folders ? p.folders.map((f) => path.basename(f)).join(', ') : path.basename(p.root),
    folders: p.folders,
    workspaceFile: p.workspaceFile,
    repos: findRepos(p.root, p.folders),
    activeRepo: p.activeRepo,
    vscodeEditor: vscodeEditorSettings(p.root, p.folders) as Partial<EditorSettings>,
    branch: p.activeRepo ? gitBranch(path.join(p.root, p.activeRepo)) : null,
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
    const first = projectArg ?? settings.lastProject
    if (!first || !fs.existsSync(first)) return null
    return openTarget(first)
  })
  handle('openProject', async () => {
    notBusy()
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : openRoot(result.filePaths[0])
  })
  handle('openProjectPath', (root: string) => {
    notBusy()
    return openTarget(root)
  })
  handle('closeProject', () => {
    notBusy()
    if (project) save(true)
    terminals.killAll()
    stopIntel()
    stopLsp()
    stopTooling()
    void debugSession?.stop()
    watchers.forEach((w) => w.close())
    watchers = []
    project = null
    settings = { ...settings, lastProject: undefined }
    writeSettings()
  })
  const pickFolders = async (title: string) => {
    const result = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'multiSelections', 'createDirectory'] })
    return result.canceled ? [] : result.filePaths
  }
  const folderPaths = (p: Project) => (p.folders ?? ['.']).map((f) => path.join(p.root, f))
  const applyFolders = (p: Project, list: string[]) => {
    const unique = [...new Set(list.map((f) => fs.realpathSync(f)))]
    const root = commonParent(unique)
    if (p.workspaceFile) writeWorkspaceFile(p.workspaceFile, unique)
    return openRoot(root, unique.length > 1 ? unique.map((f) => path.relative(root, f).split(path.sep).join('/')) : null, p.workspaceFile)
  }
  handle('workspaceAddFolder', async () => {
    notBusy()
    const p = need()
    const added = await pickFolders('Add a folder to this workspace')
    return added.length ? applyFolders(p, [...folderPaths(p), ...added]) : null
  })
  handle('workspaceRemoveFolder', (rel: string) => {
    notBusy()
    const p = need()
    const left = folderPaths(p).filter((f) => path.relative(p.root, f).split(path.sep).join('/') !== rel)
    if (!left.length) throw new Error('A workspace needs at least one folder.')
    return applyFolders(p, left)
  })
  handle('workspaceSave', async () => {
    const p = need()
    const result = await dialog.showSaveDialog(win!, { title: 'Save workspace', defaultPath: path.join(p.root, `${path.basename(p.root)}.code-workspace`), filters: [{ name: 'Workspace', extensions: ['code-workspace'] }] })
    if (result.canceled || !result.filePath) return null
    writeWorkspaceFile(result.filePath, folderPaths(p))
    return openRoot(p.root, p.folders, result.filePath)
  })
  handle('workspaceOpen', async () => {
    notBusy()
    const result = await dialog.showOpenDialog(win!, { title: 'Open workspace', properties: ['openFile'], filters: [{ name: 'Workspace', extensions: ['code-workspace'] }] })
    return result.canceled ? null : openTarget(result.filePaths[0])
  })
  handle('openFileDialog', async () => {
    const p = need()
    const result = await dialog.showOpenDialog(win!, { title: 'Open a file', defaultPath: p.root, properties: ['openFile'] })
    if (result.canceled) return null
    try {
      return safePath(p.root, fs.realpathSync(result.filePaths[0]))
    } catch {
      // A file from somewhere else opens its folder in a new window.
      openInNewWindow(path.dirname(result.filePaths[0]))
      return null
    }
  })
  handle('gitClone', async (url: string) => {
    notBusy()
    if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url.trim())) throw new Error('Enter a repository address, like https://github.com/you/project.git')
    const parent = await dialog.showOpenDialog(win!, { title: 'Choose where to put it', properties: ['openDirectory', 'createDirectory'] })
    if (parent.canceled) return null
    return openRoot(await git.clone(parent.filePaths[0], url.trim()))
  })
  handle('gitSelectRepo', (repo: string) => {
    const p = need()
    if (!findRepos(p.root, p.folders).includes(repo)) throw new Error('That repository is not in this project.')
    p.activeRepo = repo
    send({ type: 'tree' })
    return repo
  })
  handle('gitStatusAll', async () => {
    const p = need()
    const codes: Record<string, string> = {}
    for (const repo of findRepos(p.root, p.folders)) {
      const state = await git.status(path.join(p.root, repo))
      for (const f of state.files) codes[outOfRepo(repo, f.path)] = f.code
    }
    return codes
  })
  handle('vscodeTasks', () => {
    const p = need()
    return vscodeTasks(p.root, p.folders)
  })
  handle('vscodeLaunch', (active: string | null) => {
    const p = need()
    return vscodeLaunch(p.root, p.folders, active && safePath(p.root, active))
  })
  handle('listDir', (rel: string): TreeEntry[] => {
    const p = need()
    const dir = safePath(p.root, rel)
    if (dir === '.' && p.folders) return p.folders.map((f) => ({ name: path.basename(f), path: f, isDir: true }))
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
  handle('searchProject', (query: string, options: SearchOptions) => {
    try {
      return searchProject(need().root, query, options)
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error('That search pattern is not valid')
      throw err
    }
  })
  // A repository can appear at any time, from `git init` or a clone in the terminal.
  const refreshRepo = (p: Project) => {
    const repos = findRepos(p.root, p.folders)
    if (!p.activeRepo || !repos.includes(p.activeRepo)) p.activeRepo = repos[0] ?? null
    return p.activeRepo
  }
  const repoDir = (p: Project) => {
    refreshRepo(p)
    if (!p.activeRepo) throw new Error('This project has no Git repository yet.')
    return path.join(p.root, p.activeRepo)
  }
  const repoFor = (p: Project, rel: string) => {
    const repo = repoOf(findRepos(p.root, p.folders), rel)
    return repo ? { repo, dir: path.join(p.root, repo), rel: withinRepo(repo, rel) } : null
  }
  handle('gitStatus', async () => {
    const p = need()
    if (!refreshRepo(p)) return { isRepo: false, branch: null, ahead: 0, behind: 0, files: [] }
    const state = await git.status(repoDir(p))
    return { ...state, files: state.files.map((f) => ({ ...f, path: outOfRepo(p.activeRepo!, f.path) })) }
  })
  handle('gitInit', async () => {
    const p = need()
    const target = p.folders?.[0] ?? '.'
    await git.init(path.join(p.root, target))
    p.activeRepo = target
  })
  handle('gitStage', (paths: string[], add: boolean) => {
    const p = need()
    const groups = new Map<string, string[]>()
    for (const f of paths) {
      const target = repoFor(p, safePath(p.root, f))
      if (target) groups.set(target.dir, [...(groups.get(target.dir) ?? []), target.rel])
    }
    return Promise.all([...groups].map(([dir, list]) => git.stage(dir, list, add))).then(() => undefined)
  })
  handle('gitDiscard', async (rel: string) => {
    const p = need()
    const safe = writablePath(p, rel)
    const target = repoFor(p, safe)
    if (!target || !(await git.discard(target.dir, target.rel))) await trash(path.join(p.root, safe))
    treeChanged()
  })
  handle('gitCommit', (message: string) => git.commit(repoDir(need()), message))
  handle('gitSync', (action: 'pull' | 'push') => git.sync(repoDir(need()), action))
  handle('gitDiff', async (rel: string, mode: 'worktree' | 'staged' = 'worktree') => {
    const p = need()
    const safe = safePath(p.root, rel)
    const file = path.join(p.root, safe)
    const target = repoFor(p, safe)
    if (!target) return { original: '', modified: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' }
    if (mode === 'staged') return { original: await git.headVersion(target.dir, target.rel), modified: await git.indexVersion(target.dir, target.rel) }
    return { original: await git.indexVersion(target.dir, target.rel), modified: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' }
  })
  handle('intel', (method: string, ...args: unknown[]) => intelCall(method, args))
  handle('listScripts', () => findScripts(need().root))
  handle('replaceInProject', (query: string, options: SearchOptions, replacement: string) => {
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
  handle('appVersion', () => app.getVersion())
  // Small things the window remembers: open tabs, breakpoints, watches. Every window shares this file.
  const uiFile = () => path.join(dataDir(), 'ui-state.json')
  const readUi = (): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(uiFile(), 'utf8'))
    } catch {
      return {}
    }
  }
  handle('uiGet', (key: string) => readUi()[key] ?? null)
  handle('uiSet', (key: string, value: unknown) => {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFileSync(uiFile(), JSON.stringify({ ...readUi(), [key]: value }))
  })
  const extensions = () => new Extensions(path.join(dataDir(), 'extensions'))
  handle('extensionsSearch', (query: string) => extensions().search(query))
  handle('extensionsInstalled', () => extensions().installed())
  handle('extensionsInstall', (namespace: string, name: string) => extensions().install(namespace, name))
  handle('extensionsUninstall', (id: string) => extensions().uninstall(id))
  handle('newWindow', async (folder?: string) => {
    let target = folder
    if (!target) {
      const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      if (picked.canceled || !picked.filePaths[0]) return
      target = picked.filePaths[0]
    }
    openInNewWindow(target)
  })
  handle('installCommand', () => installCommand())
  handle('debugStart', async (config: DebugConfig, breakpoints: Record<string, BreakpointSpec[]>) => {
    const p = need()
    await debugSession?.stop()
    for (const rel of [config.file, config.cwd]) if (rel) safePath(p.root, rel)
    const session = new Debugger(p.root, jsDebugDir(), (event) => {
      send({ type: 'debug', event })
      if (event.kind === 'state' && event.state === 'stopped' && debugSession === session) debugSession = null
    })
    debugSession = session
    try {
      await session.start(config, breakpoints)
    } catch (error) {
      await session.stop()
      throw error
    }
  })
  handle('debugStop', () => debugSession?.stop())
  handle('debugBreakpoints', (rel: string, list: BreakpointSpec[]) => debugSession?.setBreakpoints(safePath(need().root, rel), list))
  handle('debugControl', (action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause', threadId: number) => debugSession?.control(action, threadId))
  handle('debugScopes', (frameId: number) => debugSession?.scopes(frameId) ?? [])
  handle('debugVariables', (reference: number) => debugSession?.variables(reference) ?? [])
  handle('debugEvaluate', (expression: string, frameId: number | null, context: 'watch' | 'repl') => debugSession?.evaluate(expression, frameId, context) ?? { result: 'Nothing is running.', variablesReference: 0 })
  handle('debugPython', () => {
    const p = need()
    return pythonFor(p.root, settings.trustedProjects.includes(p.root)) ?? (process.platform === 'win32' ? 'python' : 'python3')
  })
  handle('lspStatus', () => ({ angular: hasAngular(projectPackages(need().root, need().folders)) }))
  handle('lspOpen', (kind: LspKind, rel: string, languageId: string, text: string) => lspClient(kind).open(safePath(need().root, rel), languageId, text))
  handle('lspChange', (kind: LspKind, rel: string, text: string) => lspClient(kind).change(safePath(need().root, rel), text))
  handle('lspClose', (kind: LspKind, rel: string) => lspClients.get(kind)?.close(safePath(need().root, rel)))
  handle('lspRequest', async (kind: LspKind, method: string, rel: string, params: Record<string, unknown>) => {
    if (!/^textDocument\/(completion|hover|definition|references|rename|documentSymbol|signatureHelp)$|^completionItem\/resolve$/.test(method)) throw new Error('Unknown language request')
    const p = need()
    const client = lspClient(kind)
    await client.start()
    const body = method === 'completionItem/resolve' ? params : { ...params, textDocument: { uri: toUri(p.root, safePath(p.root, rel)) } }
    const translate = (value: unknown): unknown => {
      // Paths cross back to the app relative to the project, and anything outside it stays out.
      if (Array.isArray(value)) return value.map(translate)
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value)) {
          if ((k === 'uri' || k === 'targetUri') && typeof v === 'string') out.path = fromUri(p.root, v)
          if (k === 'changes' && v && typeof v === 'object') {
            out.documentChanges = Object.entries(v).map(([uri, edits]) => ({ textDocument: { path: fromUri(p.root, uri) }, edits }))
            continue
          }
          out[k] = translate(v)
        }
        return out
      }
      return value
    }
    return translate(await client.request(method, body))
  })
  handle('toolingStatus', () => {
    const p = need()
    return { ...Tooling.detect(p.root, projectPackages(p.root, p.folders)), trusted: settings.trustedProjects.includes(p.root) }
  })
  handle('toolingTrust', () => {
    const p = need()
    if (!settings.trustedProjects.includes(p.root)) settings = { ...settings, trustedProjects: [...settings.trustedProjects, p.root] }
    writeSettings()
  })
  handle('tooling', (method: string, rel: string, text: string) => {
    if (!['lint', 'fixAll', 'format'].includes(method)) throw new Error('Unknown tool')
    const p = need()
    return toolingCall(method, [safePath(p.root, rel), text])
  })
  handle('revealPath', (rel: string) => {
    const p = need()
    shell.showItemInFolder(path.join(p.root, safePath(p.root, rel)))
  })
  handle('readImage', (rel: string) => {
    const p = need()
    const file = path.join(p.root, safePath(p.root, rel))
    if (fs.statSync(file).size > 30_000_000) throw new Error('That image is too large to preview.')
    const type: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' }
    const mime = type[path.extname(file).toLowerCase()]
    if (!mime) throw new Error('Anvil can\'t preview this kind of file.')
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
  })
  handle('gitHead', (rel: string) => {
    const p = need()
    const target = repoFor(p, safePath(p.root, rel))
    return target ? git.headVersion(target.dir, target.rel) : ''
  })
  handle('checkUpdate', () => checkForUpdate(true))
  handle('downloadUpdate', () => downloadUpdate())
  handle('applyUpdate', () => {
    if (!installer) return
    if (!installer.quits) return installer.run()
    installOnQuit = true
    app.quit()
  })
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
    let imported: ImportedAssets = { snippets: [], themes: [] }
    try {
      imported = JSON.parse(fs.readFileSync(importFile(), 'utf8'))
    } catch {
      /* nothing imported yet */
    }
    const installed = extensions().assets()
    return { snippets: [...imported.snippets, ...installed.snippets], themes: [...imported.themes, ...installed.themes] }
  })
  handle('gitLog', (limit: number, rel?: string) => {
    const p = need()
    if (rel) {
      const target = repoFor(p, safePath(p.root, rel))
      return target ? git.log(target.dir, limit, target.rel) : []
    }
    return refreshRepo(p) ? git.log(repoDir(p), limit) : []
  })
  handle('gitCommitFiles', async (sha: string) => {
    const p = need()
    return (await git.commitFiles(repoDir(p), sha)).map((f) => ({ ...f, path: outOfRepo(p.activeRepo!, f.path) }))
  })
  handle('gitCommitDiff', (sha: string, rel: string) => {
    const p = need()
    return git.commitDiff(repoDir(p), sha, withinRepo(p.activeRepo!, safePath(p.root, rel)))
  })
  handle('gitBlame', (rel: string) => {
    const p = need()
    const target = repoFor(p, safePath(p.root, rel))
    return target ? git.blame(target.dir, target.rel) : []
  })
  handle('gitBranches', () => git.branches(repoDir(need())))
  handle('gitDetails', async () => {
    const p = need()
    const info = await git.details(repoDir(p))
    return { ...info, conflicts: info.conflicts.map((f) => outOfRepo(p.activeRepo!, f)) }
  })
  handle('gitPullRequests', () => git.pullRequests(repoDir(need())))
  const gitOps: Record<string, (root: string, ...args: never[]) => Promise<unknown>> = {
    fetch: git.fetchAll, pullRebase: git.pullRebase, push: git.pushCurrent, amend: git.amend, merge: git.merge, rebase: git.rebase,
    cherryPick: git.cherryPick, revert: git.revert, abort: git.abortOperation, continue: git.continueOperation,
    deleteBranch: git.deleteBranch, renameBranch: git.renameBranch, branchAt: git.branchAt, checkoutSha: git.checkoutSha, checkoutRemote: git.checkoutRemote,
    tag: git.tag, reset: git.reset, stashPush: git.stashPush, stashApply: git.stashApply, stashPop: git.stashPop, stashDrop: git.stashDrop,
    applyPatch: git.applyPatch, checkoutPullRequest: git.checkoutPullRequest, createPullRequest: git.createPullRequest
  }
  handle('gitOp', async (name: string, ...args: unknown[]) => {
    const op = Object.hasOwn(gitOps, name) ? gitOps[name] : null
    if (!op) throw new Error('Unknown Git action')
    if (name !== 'fetch') notBusy()
    const p = need()
    // A block's patch names the file from the project. Git wants it from the repository.
    const finalArgs = name === 'applyPatch' && p.activeRepo && p.activeRepo !== '.'
      ? [String(args[0]).replaceAll(` a/${p.activeRepo}/`, ' a/').replaceAll(` b/${p.activeRepo}/`, ' b/'), ...args.slice(1)]
      : args
    const result = await (op as (root: string, ...rest: unknown[]) => Promise<unknown>)(repoDir(p), ...finalArgs)
    send({ type: 'tree' })
    sendChanges()
    return result
  })
  handle('gitCheckout', async (name: string, create: boolean) => {
    notBusy()
    await git.checkout(repoDir(need()), name, create)
    send({ type: 'tree' })
    sendChanges()
  })
  handle('terminalCreate', () => terminals.create(project ? path.join(project.root, project.folders?.[0] ?? '.') : ''))
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
  handle('claudeSessions', () => {
    const p = need()
    const own = claudeFolderFor(p.root)
    const taken = new Set(p.chats.map((c) => c.importedFrom))
    return listClaudeSessions().map((s) => ({ ...s, inThisProject: s.folder === own, imported: taken.has(s.id) }))
  })
  handle('importClaudeSessions', async (ids: string[]) => {
    const p = need()
    notBusy()
    let last: Chat | null = null
    for (const id of ids) {
      const already = p.chats.find((c) => c.importedFrom === id)
      if (already) {
        last = already
        continue
      }
      const read = await readClaudeSession(claudeSessionFile(id))
      last = { ...newChatObject(), ...read, importedFrom: id }
      p.chats.push(last)
    }
    return last ? activate(p, last) : projectState()
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
  const saved = process.env.ANVIL_DATA_DIR || !settings.windowBounds?.width ? null : settings.windowBounds
  win = new BrowserWindow({
    // Tests run hidden, so windows don't appear over whatever the person is doing.
    show: !process.env.ANVIL_HIDDEN,
    width: saved?.width ?? 1512,
    height: saved?.height ?? 920,
    ...(saved?.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#131211',
    title: 'Anvil',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : { autoHideMenuBar: true }),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.on('close', () => {
    if (projectArg || process.env.ANVIL_DATA_DIR || !win) return
    settings = { ...settings, windowBounds: win.getBounds() }
    writeSettings()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
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
  buildMenu()
  createWindow()
  setTimeout(() => void checkForUpdate(), 5000)
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
  // Another window may have changed a setting. Each window sends only what changes, so the newest file wins.
  app.on('browser-window-focus', () => loadSettings())
})

app.on('before-quit', () => {
  void debugSession?.stop()
  stopLsp()
  stopTooling()
  watchers.forEach((w) => w.close())
  project?.agent.cancel()
  terminals.killAll()
  stopIntel()
  stopOwnServer()
  save(true)
})
// Only here is it certain the close went through: an unsaved-file prompt can still cancel it before this.
app.on('will-quit', () => {
  if (installOnQuit) installer?.run()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
