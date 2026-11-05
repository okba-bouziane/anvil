import fs from 'node:fs'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'

/**
 * A workspace is several folders open together. They appear under their nearest shared folder, which is what the
 * rest of the app treats as the project, but only the chosen folders can be seen or changed.
 */

export function commonParent(folders: string[]): string {
  if (folders.length === 1) return folders[0]
  const parts = folders.map((f) => f.split(path.sep))
  const shared: string[] = []
  for (let i = 0; i < parts[0].length; i++) {
    if (parts.every((p) => p[i] === parts[0][i])) shared.push(parts[0][i])
    else break
  }
  if (!shared.length) throw new Error('All the folders in a workspace have to be on the same drive.')
  if (shared.length === 1 && !shared[0]) return path.sep
  return shared.length === 1 && /:$/.test(shared[0]) ? `${shared[0]}${path.sep}` : shared.join(path.sep)
}

/** Reads a .code-workspace file, the same format VS Code uses. Relative paths are relative to the file. */
export function readWorkspaceFile(file: string): string[] {
  const data = parseJsonc(fs.readFileSync(file, 'utf8')) as { folders?: { path?: unknown }[] } | undefined
  const folders = (data?.folders ?? []).flatMap((f) => (typeof f.path === 'string' ? [path.resolve(path.dirname(file), f.path)] : []))
  const existing = folders.filter((f) => fs.existsSync(f) && fs.statSync(f).isDirectory())
  if (!existing.length) throw new Error('This workspace has no folders that exist on this computer.')
  return [...new Set(existing.map((f) => fs.realpathSync(f)))]
}

export function writeWorkspaceFile(file: string, folders: string[]): void {
  const dir = path.dirname(file)
  fs.writeFileSync(file, `${JSON.stringify({ folders: folders.map((f) => ({ path: path.relative(dir, f) || '.' })), settings: {} }, null, 2)}\n`)
}

/** Git repositories in a project: the project itself, each workspace folder, or folders one level down. */
export function findRepos(root: string, folders: string[] | null): string[] {
  const isRepo = (rel: string) => fs.existsSync(path.join(root, rel, '.git'))
  if (folders) return folders.filter(isRepo)
  if (isRepo('.')) return ['.']
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && isRepo(e.name)).map((e) => e.name).sort()
  } catch {
    return []
  }
}

/** The repository holding a file: the longest match wins. */
export function repoOf(repos: string[], rel: string): string | null {
  let best: string | null = null
  for (const repo of repos) {
    if (repo === '.') best ??= '.'
    else if ((rel === repo || rel.startsWith(`${repo}/`)) && (!best || best === '.' || repo.length > best.length)) best = repo
  }
  return best
}

export const withinRepo = (repo: string, rel: string) => (repo === '.' ? rel : rel === repo ? '.' : rel.slice(repo.length + 1))
export const outOfRepo = (repo: string, rel: string) => (repo === '.' ? rel : `${repo}/${rel}`)

/* Project settings VS Code keeps in .vscode: Anvil follows the ones it understands. */

function readJsonc(file: string): Record<string, unknown> | null {
  try {
    return parseJsonc(fs.readFileSync(file, 'utf8')) ?? null
  } catch {
    return null
  }
}

export function vscodeEditorSettings(root: string, folders: string[] | null): Record<string, unknown> {
  const base = folders?.[0] ?? '.'
  const raw = readJsonc(path.join(root, base, '.vscode/settings.json'))
  if (!raw) return {}
  const out: Record<string, unknown> = {}
  if (typeof raw['editor.fontSize'] === 'number') out.fontSize = raw['editor.fontSize']
  if (typeof raw['editor.tabSize'] === 'number') out.tabSize = raw['editor.tabSize']
  if (typeof raw['editor.formatOnSave'] === 'boolean') out.formatOnSave = raw['editor.formatOnSave']
  if (raw['editor.wordWrap'] !== undefined) out.wordWrap = raw['editor.wordWrap'] !== 'off'
  if (typeof raw['editor.minimap.enabled'] === 'boolean') out.minimap = raw['editor.minimap.enabled']
  if (raw['files.autoSave'] !== undefined) out.autoSave = raw['files.autoSave'] !== 'off'
  return out
}

export interface VscodeTask {
  label: string
  command: string
  cwd: string
}

export function vscodeTasks(root: string, folders: string[] | null): VscodeTask[] {
  const out: VscodeTask[] = []
  for (const base of folders ?? ['.']) {
    const raw = readJsonc(path.join(root, base, '.vscode/tasks.json')) as { tasks?: { label?: string; type?: string; command?: string; script?: string; args?: unknown[]; options?: { cwd?: string } }[] } | null
    for (const t of raw?.tasks ?? []) {
      const command = t.type === 'npm' && t.script ? `npm run ${t.script}` : typeof t.command === 'string' ? [t.command, ...(t.args ?? []).map(String)].join(' ') : null
      if (command) out.push({ label: t.label ?? t.script ?? command, command, cwd: base })
    }
  }
  return out
}

export interface VscodeLaunch {
  name: string
  folder: string
  config: Record<string, unknown>
}

const substitute = (value: unknown, folder: string, file: string | null): unknown => {
  if (typeof value === 'string') return value.replaceAll('${workspaceFolder}', folder).replaceAll('${workspaceRoot}', folder).replaceAll('${file}', file ?? '')
  if (Array.isArray(value)) return value.map((v) => substitute(v, folder, file))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, folder, file)]))
  return value
}

/** Debug setups from launch.json, in the form the debug engines expect. Types Anvil has no engine for are left out. */
export function vscodeLaunch(root: string, folders: string[] | null, activeFile: string | null): VscodeLaunch[] {
  const types: Record<string, string> = { node: 'pwa-node', 'pwa-node': 'pwa-node', chrome: 'pwa-chrome', 'pwa-chrome': 'pwa-chrome', python: 'python', debugpy: 'python' }
  const out: VscodeLaunch[] = []
  for (const base of folders ?? ['.']) {
    const folder = path.join(root, base)
    const raw = readJsonc(path.join(folder, '.vscode/launch.json')) as { configurations?: Record<string, unknown>[] } | null
    for (const c of raw?.configurations ?? []) {
      const type = types[String(c.type)]
      if (!type) continue
      const config = substitute({ ...c, type, cwd: c.cwd ?? folder }, folder, activeFile ? path.join(root, activeFile) : null) as Record<string, unknown>
      out.push({ name: String(c.name ?? c.type), folder: base, config })
    }
  }
  return out
}
