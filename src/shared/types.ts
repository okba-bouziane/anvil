import type { KeybindingImport, KeyMap } from './keybindings'

export interface EditorSettings {
  fontSize: number
  tabSize: number
  wordWrap: boolean
  minimap: boolean
  autoSave: boolean
  formatOnSave: boolean
  blame: boolean
}

export type ProviderId = 'local' | 'anthropic' | 'openai' | 'custom'
export type AgentMode = 'agent' | 'plan' | 'ask'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type OpenAiEffort = 'default' | 'minimal' | 'low' | 'medium' | 'high'

export interface Settings {
  provider: ProviderId
  models: Record<ProviderId, string>
  baseUrls: Record<ProviderId, string>
  effort: Effort
  openaiEffort: OpenAiEffort
  autoAcceptEdits: boolean
  autoRunCommands: boolean
  contextTokens: number
  maxOutputTokens: number
  temperature: number
  theme: 'system' | 'dark' | 'light'
  editor: EditorSettings
  keybindings: KeyMap
  showAgent: boolean
  showSide: boolean
  sideWidth: number
  chatWidth: number
  inlineSuggest: boolean
  fileIcons: boolean
  leaveGpuToModel: boolean
  windowBounds: { x?: number; y?: number; width: number; height: number } | null
  trustedProjects: string[]
  fixOnSave: boolean
  cursorStyle: 'line' | 'block' | 'underline'
  stickyScroll: boolean
  checkUpdates: boolean
  editorTheme?: string
  lastProject?: string
  recentProjects: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'local',
  models: { local: 'mlx-community/Qwen3.5-9B-4bit', anthropic: 'claude-opus-5-5', openai: '', custom: '' },
  baseUrls: { local: 'http://127.0.0.1:8080/v1', anthropic: '', openai: 'https://api.openai.com/v1', custom: 'http://127.0.0.1:1234/v1' },
  keybindings: {},
  effort: 'high',
  openaiEffort: 'default',
  autoAcceptEdits: false,
  autoRunCommands: false,
  contextTokens: 24000,
  maxOutputTokens: 4096,
  temperature: 0.2,
  theme: 'system',
  editor: { fontSize: 13, tabSize: 2, wordWrap: false, minimap: false, autoSave: true, formatOnSave: false, blame: true },
  showAgent: true,
  showSide: true,
  sideWidth: 248,
  chatWidth: 440,
  inlineSuggest: true,
  fileIcons: true,
  leaveGpuToModel: false,
  windowBounds: null,
  trustedProjects: [],
  fixOnSave: false,
  cursorStyle: 'line',
  stickyScroll: true,
  checkUpdates: true,
  recentProjects: []
}

export const PROVIDER_LABEL: Record<ProviderId, string> = { local: 'Local', anthropic: 'Anthropic', openai: 'OpenAI', custom: 'Custom server' }
/** Providers that send the code you share with them over the internet. */
export const isCloud = (settings: Pick<Settings, 'provider' | 'baseUrls'>): boolean =>
  settings.provider !== 'local' && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(settings.baseUrls[settings.provider] || 'https://cloud')

export interface ModelOption {
  id: string
  /** Size on disk, for local models. */
  sizeGb?: number
  warning?: string
}

export interface IntelLocation {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

export interface IntelDiagnostic extends IntelLocation {
  message: string
  code: number | string
  severity: 'error' | 'warning'
}

export interface IntelEdit extends IntelLocation {
  text: string
}

export interface IntelCompletion {
  name: string
  kind: string
  sortText: string
  source?: string
  data?: unknown
  insertText?: string
}

export interface IntelSymbol extends Omit<IntelLocation, 'path'> {
  name: string
  kind: string
  container: string
}

export interface ImportedSnippet {
  language: string
  name: string
  prefix: string
  body: string
  description: string
}

export interface ImportedTheme {
  id: string
  name: string
  dark: boolean
  colors: Record<string, string>
  tokens: { token: string; foreground?: string; fontStyle?: string }[]
}

export interface ExtensionSupport {
  level: 'full' | 'partial' | 'none'
  note: string
}

export interface ExtensionInfo {
  id: string
  namespace: string
  name: string
  displayName: string
  description: string
  version: string
  downloads: number
  icon: string | null
  support: ExtensionSupport
}

export interface ImportedAssets {
  snippets: ImportedSnippet[]
  themes: ImportedTheme[]
}

export interface VscodeImport {
  found: boolean
  settings: string[]
  snippets: number
  themes: string[]
  extensionsUsed: string[]
  /** Extensions that are programs. Anvil can't run them. */
  extensionsSkipped: string[]
}

export interface ScriptEntry {
  dir: string
  name: string
  command: string
}

export interface ChatSummary {
  id: string
  title: string
  updatedAt: number
}

export interface Hunk {
  index: number
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  firstChangedLine: number
  added: number
  removed: number
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  hunks: Hunk[]
}

export interface Checkpoint {
  id: string
  title: string
  files: string[]
  undone: boolean
}

export interface Stats {
  waitSeconds: number
  tokens: number
  tokensPerSecond: number
  promptTokens: number
}

export interface TreeEntry {
  name: string
  path: string
  isDir: boolean
}

export interface ClaudeSessionSummary {
  id: string
  title: string
  project: string
  updatedAt: number
  sizeMb: number
  inThisProject: boolean
  imported: boolean
}

export type UiItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; stats?: Stats }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; output?: string }
  | { kind: 'approval'; id: string; command: string; status: 'pending' | 'approved' | 'denied' }
  | { kind: 'check'; id: string; text: string; ok: boolean }
  | { kind: 'checkpoint'; id: string; checkpointId: string }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'note'; id: string; text: string }

export type AgentEvent =
  | { type: 'item'; item: UiItem }
  | { type: 'item-update'; id: string; patch: Partial<UiItem> }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'changes'; changes: FileChange[]; checkpoints: Checkpoint[] }
  | { type: 'live-stats'; tokens: number; tokensPerSecond: number; waiting: boolean }
  | { type: 'file-changed'; path: string }
  | { type: 'context'; tokens: number; limit: number }
  | { type: 'chats'; chats: ChatSummary[]; activeChat: string }
  | { type: 'tree'; filesChanged?: boolean }
  | { type: 'update'; version: string; url: string; canInstall: boolean }
  | { type: 'update-progress'; percent: number }
  | { type: 'menu'; id: string }
  | { type: 'debug'; event: DebugEvent }
  | { type: 'lsp-diagnostics'; kind: 'python' | 'angular'; path: string; diagnostics: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; message: string; severity?: number; code?: string | number; source?: string }[] }
  | { type: 'lsp-stopped'; kind: 'python' | 'angular' }
  | { type: 'update-ready'; label: string }

export interface SearchHit {
  path: string
  line: number
  text: string
}

export interface GitFile {
  path: string
  /** Two-letter code from git status: first letter staged, second unstaged. */
  code: string
}

export interface CommitInfo {
  sha: string
  parents: string[]
  author: string
  /** Seconds since 1970. */
  time: number
  refs: string[]
  subject: string
}

export interface CommitFile {
  status: string
  path: string
}

export interface BlameLine {
  sha: string
  line: number
  author: string
  time: number
  subject: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface GitBranch {
  name: string
  upstream: string | null
  current: boolean
  ahead: number
  behind: number
  time: number
  subject: string
}

export interface GitStash {
  index: number
  message: string
  time: number
}

export interface GitDetails {
  operation: GitOperation
  conflicts: string[]
  branches: GitBranch[]
  remoteBranches: string[]
  stashes: GitStash[]
  remotes: string[]
  lastMessage: string
}

export interface PullRequest {
  number: number
  title: string
  branch: string
  author: string
  url: string
  draft: boolean
  review: string
  updated: number
}

export interface DebugConfig {
  kind: 'node-file' | 'npm' | 'node-attach' | 'chrome' | 'python' | 'raw'
  raw?: Record<string, unknown>
  name: string
  file?: string
  script?: string
  cwd?: string
  port?: number
  url?: string
  python?: string
}

export interface DebugFrame {
  id: number
  name: string
  line: number
  column: number
  path: string | null
  source: string
}

export type DebugEvent =
  | { kind: 'state'; state: 'starting'; name: string }
  | { kind: 'state'; state: 'running' | 'stopped' }
  | { kind: 'state'; state: 'paused'; threadId: number; reason: string; description?: string; frames: DebugFrame[] }
  | { kind: 'output'; category: string; text: string }
  | { kind: 'breakpoint-changed' }

export interface DebugVariable {
  name: string
  value: string
  type?: string
  variablesReference: number
}

export interface LintMessage {
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  rule: string | null
  severity: 'error' | 'warning'
  fix: { start: number; end: number; text: string } | null
}

export interface SearchOptions {
  caseSensitive: boolean
  regex: boolean
  wholeWord?: boolean
  include?: string
  exclude?: string
}

export type TerminalEvent = { type: 'data'; id: string; data: string } | { type: 'exit'; id: string }

export interface LocalSetup {
  platformOk: boolean
  serverInstalled: boolean
  hasModels: boolean
  installCommand: string
  downloadCommand: string
}

export type ApprovalAnswer = 'once' | 'always' | 'deny'

export interface ProjectState {
  root: string
  name: string
  folders: string[] | null
  workspaceFile: string | null
  repos: string[]
  activeRepo: string | null
  vscodeEditor: Partial<EditorSettings>
  branch: string | null
  items: UiItem[]
  changes: FileChange[]
  checkpoints: Checkpoint[]
  chats: ChatSummary[]
  activeChat: string
}

export type ModelStatus = 'online' | 'offline' | 'starting' | 'nokey'

export interface AnvilApi {
  platform: string
  getSettings(): Promise<Settings>
  localSetup(): Promise<LocalSetup>
  intel<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  listScripts(): Promise<ScriptEntry[]>
  replaceInProject(query: string, options: SearchOptions, replacement: string): Promise<{ files: number; matches: number }>
  suggest(path: string, prefix: string, suffix: string): Promise<string>
  cancelSuggest(): Promise<void>
  openRelease(url: string): Promise<void>
  uiGet<T = unknown>(key: string): Promise<T | null>
  uiSet(key: string, value: unknown): Promise<void>
  closeProject(): Promise<void>
  workspaceAddFolder(): Promise<ProjectState | null>
  workspaceRemoveFolder(path: string): Promise<ProjectState>
  workspaceSave(): Promise<ProjectState | null>
  workspaceOpen(): Promise<ProjectState | null>
  openFileDialog(): Promise<string | null>
  gitClone(url: string): Promise<ProjectState | null>
  gitSelectRepo(repo: string): Promise<string>
  gitStatusAll(): Promise<Record<string, string>>
  vscodeTasks(): Promise<{ label: string; command: string; cwd: string }[]>
  vscodeLaunch(active: string | null): Promise<{ name: string; folder: string; config: Record<string, unknown> }[]>
  extensionsSearch(query: string): Promise<ExtensionInfo[]>
  extensionsInstalled(): Promise<ExtensionInfo[]>
  extensionsInstall(namespace: string, name: string): Promise<ExtensionInfo>
  extensionsUninstall(id: string): Promise<void>
  newWindow(folder?: string): Promise<void>
  installCommand(): Promise<string>
  debugStart(config: DebugConfig, breakpoints: Record<string, { line: number; condition?: string }[]>): Promise<void>
  debugStop(): Promise<void>
  debugBreakpoints(path: string, list: { line: number; condition?: string }[]): Promise<void>
  debugControl(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause', threadId: number): Promise<void>
  debugScopes(frameId: number): Promise<{ name: string; variablesReference: number; expensive?: boolean }[]>
  debugVariables(reference: number): Promise<DebugVariable[]>
  debugEvaluate(expression: string, frameId: number | null, context: 'watch' | 'repl'): Promise<{ result: string; variablesReference: number }>
  debugPython(): Promise<string>
  lspStatus(): Promise<{ angular: boolean }>
  lspOpen(kind: 'python' | 'angular', path: string, languageId: string, text: string): Promise<void>
  lspChange(kind: 'python' | 'angular', path: string, text: string): Promise<void>
  lspClose(kind: 'python' | 'angular', path: string): Promise<void>
  lspRequest<T = unknown>(kind: 'python' | 'angular', method: string, path: string, params: Record<string, unknown>): Promise<T>
  toolingStatus(): Promise<{ eslint: boolean; prettier: boolean; trusted: boolean }>
  toolingTrust(): Promise<void>
  tooling<T = unknown>(method: 'lint' | 'fixAll' | 'format', path: string, text: string): Promise<T>
  revealPath(path: string): Promise<void>
  readImage(path: string): Promise<string>
  gitHead(path: string): Promise<string>
  gitDetails(): Promise<GitDetails>
  gitPullRequests(): Promise<{ state: 'ok' | 'no-gh' | 'error'; message?: string; list: PullRequest[] }>
  gitOp(name: string, ...args: unknown[]): Promise<unknown>
  appVersion(): Promise<string>
  checkUpdate(): Promise<{ current: string; latest: string | null }>
  downloadUpdate(): Promise<void>
  applyUpdate(): Promise<void>
  importVscode(): Promise<VscodeImport>
  importedAssets(): Promise<ImportedAssets>
  createPath(path: string, isDir: boolean): Promise<void>
  renamePath(from: string, to: string): Promise<void>
  deletePath(path: string): Promise<void>
  searchProject(query: string, options: SearchOptions): Promise<SearchHit[]>
  filesExist(paths: string[]): Promise<string[]>
  steer(text: string): Promise<void>
  claudeCodeCommand(): Promise<string | null>
  openClaudeCodeGuide(): Promise<void>
  importVscodeKeybindings(known: string[]): Promise<KeybindingImport>
  recoverySave(path: string, text: string): Promise<void>
  recoveryClear(path: string): Promise<void>
  recoveryList(): Promise<{ path: string; text: string }[]>
  gitStatus(): Promise<GitStatus>
  gitInit(): Promise<void>
  gitStage(paths: string[], stage: boolean): Promise<void>
  gitDiscard(path: string): Promise<void>
  gitCommit(message: string): Promise<void>
  gitSync(action: 'pull' | 'push'): Promise<string>
  gitDiff(path: string, mode?: 'worktree' | 'staged'): Promise<{ original: string; modified: string }>
  gitLog(limit: number, path?: string): Promise<CommitInfo[]>
  gitCommitFiles(sha: string): Promise<CommitFile[]>
  gitCommitDiff(sha: string, path: string): Promise<{ original: string; modified: string }>
  gitBlame(path: string): Promise<BlameLine[]>
  gitBranches(): Promise<{ current: string | null; all: string[] }>
  gitCheckout(name: string, create: boolean): Promise<void>
  terminalCreate(): Promise<string>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalKill(id: string): Promise<void>
  onTerminal(listener: (event: TerminalEvent) => void): () => void
  setSettings(patch: Partial<Settings>): Promise<Settings>
  modelStatus(): Promise<ModelStatus>
  startModel(): Promise<ModelStatus>
  stopModel(): Promise<ModelStatus>
  listModels(provider: ProviderId): Promise<ModelOption[]>
  switchLocalModel(id: string): Promise<ModelStatus>
  keyStatus(): Promise<Record<ProviderId, boolean>>
  setApiKey(provider: ProviderId, key: string): Promise<void>
  clearApiKey(provider: ProviderId): Promise<void>
  initialProject(): Promise<ProjectState | null>
  openProject(): Promise<ProjectState | null>
  openProjectPath(path: string): Promise<ProjectState>
  listDir(path: string): Promise<TreeEntry[]>
  listFiles(): Promise<string[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  send(text: string, activeFile: string | null, mode: AgentMode): Promise<void>
  cancel(): Promise<void>
  answerApproval(id: string, answer: ApprovalAnswer): Promise<void>
  newChat(): Promise<ProjectState>
  claudeSessions(): Promise<ClaudeSessionSummary[]>
  importClaudeSessions(ids: string[]): Promise<ProjectState>
  switchChat(id: string): Promise<ProjectState>
  deleteChat(id: string): Promise<ProjectState>
  getDiff(path: string): Promise<{ original: string; modified: string; change: FileChange | null }>
  acceptFile(path: string): Promise<void>
  rejectFile(path: string): Promise<void>
  acceptHunk(path: string, index: number): Promise<void>
  rejectHunk(path: string, index: number): Promise<void>
  acceptAll(): Promise<void>
  rejectAll(): Promise<void>
  undoCheckpoint(id: string): Promise<void>
  onEvent(listener: (event: AgentEvent) => void): () => void
}
