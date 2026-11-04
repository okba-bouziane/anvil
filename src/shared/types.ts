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
  showAgent: boolean
  inlineSuggest: boolean
  checkUpdates: boolean
  editorTheme?: string
  lastProject?: string
  recentProjects: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'local',
  models: { local: 'mlx-community/Qwen3.5-9B-4bit', anthropic: 'claude-opus-5-5', openai: '', custom: '' },
  baseUrls: { local: 'http://127.0.0.1:8080/v1', anthropic: '', openai: 'https://api.openai.com/v1', custom: 'http://127.0.0.1:1234/v1' },
  effort: 'high',
  openaiEffort: 'default',
  autoAcceptEdits: false,
  autoRunCommands: false,
  contextTokens: 24000,
  maxOutputTokens: 4096,
  temperature: 0.2,
  theme: 'system',
  editor: { fontSize: 12.5, tabSize: 2, wordWrap: false, minimap: false, autoSave: true, formatOnSave: false, blame: true },
  showAgent: true,
  inlineSuggest: true,
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
  code: number
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
  | { type: 'tree' }
  | { type: 'update'; version: string; url: string }

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
  replaceInProject(query: string, options: { caseSensitive: boolean; regex: boolean }, replacement: string): Promise<{ files: number; matches: number }>
  suggest(path: string, prefix: string, suffix: string): Promise<string>
  cancelSuggest(): Promise<void>
  openRelease(url: string): Promise<void>
  importVscode(): Promise<VscodeImport>
  importedAssets(): Promise<ImportedAssets>
  createPath(path: string, isDir: boolean): Promise<void>
  renamePath(from: string, to: string): Promise<void>
  deletePath(path: string): Promise<void>
  searchProject(query: string, options: { caseSensitive: boolean; regex: boolean }): Promise<SearchHit[]>
  gitStatus(): Promise<GitStatus>
  gitInit(): Promise<void>
  gitStage(paths: string[], stage: boolean): Promise<void>
  gitDiscard(path: string): Promise<void>
  gitCommit(message: string): Promise<void>
  gitSync(action: 'pull' | 'push'): Promise<string>
  gitDiff(path: string): Promise<{ original: string; modified: string }>
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
