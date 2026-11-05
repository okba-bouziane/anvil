import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import type { EditorSettings, ImportedAssets, ImportedSnippet, ImportedTheme, Settings, VscodeImport } from '../shared/types'

const MAX_FILE = 2_000_000

export interface VscodePaths {
  user: string
  extensions: string
}

export function vscodePaths(): VscodePaths {
  const home = os.homedir()
  const user = process.platform === 'darwin'
    ? path.join(home, 'Library/Application Support/Code/User')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'Code/User')
      : path.join(home, '.config/Code/User')
  return { user, extensions: path.join(home, '.vscode/extensions') }
}

/** VS Code's JSON files allow comments and trailing commas. These files are only read as data, never run. */
function readJsonc(file: string): any {
  try {
    if (fs.statSync(file).size > MAX_FILE) return null
    return parseJsonc(fs.readFileSync(file, 'utf8')) ?? null
  } catch {
    return null
  }
}

function insideOf(dir: string, rel: unknown): string | null {
  if (typeof rel !== 'string') return null
  const full = path.resolve(dir, rel)
  return full.startsWith(dir + path.sep) ? full : null
}

export function readSnippets(file: string, languages: string[]): ImportedSnippet[] {
  const data = readJsonc(file)
  if (!data || typeof data !== 'object') return []
  const out: ImportedSnippet[] = []
  for (const [name, raw] of Object.entries<any>(data)) {
    if (!raw?.body || !raw?.prefix) continue
    const scopes = typeof raw.scope === 'string' ? raw.scope.split(',').map((s: string) => s.trim()) : languages
    const prefixes: string[] = Array.isArray(raw.prefix) ? raw.prefix : [raw.prefix]
    const body = Array.isArray(raw.body) ? raw.body.join('\n') : String(raw.body)
    for (const language of scopes.length ? scopes : ['*']) {
      for (const prefix of prefixes) out.push({ language, name, prefix: String(prefix), body, description: String(raw.description ?? name) })
    }
  }
  return out
}

/** Editor themes name scopes differently from TextMate themes, so the main ones are matched by hand. */
const SCOPE_TO_TOKEN: [RegExp, string][] = [
  [/^comment/, 'comment'],
  [/^string/, 'string'],
  [/^constant\.numeric/, 'number'],
  [/^constant\.regexp|^string\.regexp/, 'regexp'],
  [/^keyword\.operator/, 'delimiter'],
  [/^keyword|^storage/, 'keyword'],
  [/^entity\.name\.(type|class)|^support\.(type|class)/, 'type'],
  [/^entity\.name\.tag/, 'tag'],
  [/^entity\.other\.attribute-name/, 'attribute.name'],
  [/^variable/, 'identifier']
]

export function readTheme(file: string, id: string, label: string, uiTheme: string, depth = 0): ImportedTheme | null {
  const data = readJsonc(file)
  if (!data || depth > 3) return null
  const parent = typeof data.include === 'string' && insideOf(path.dirname(path.dirname(file)), path.relative(path.dirname(path.dirname(file)), path.resolve(path.dirname(file), data.include)))
  const base = parent ? readTheme(parent, id, label, uiTheme, depth + 1) : null
  const tokens = new Map((base?.tokens ?? []).map((t) => [t.token, t]))
  for (const rule of Array.isArray(data.tokenColors) ? data.tokenColors : []) {
    const scopes: string[] = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === 'string' ? rule.scope.split(',').map((s: string) => s.trim()) : []
    for (const scope of scopes) {
      const token = SCOPE_TO_TOKEN.find(([rx]) => rx.test(scope))?.[1]
      const foreground = typeof rule.settings?.foreground === 'string' ? rule.settings.foreground.replace('#', '') : undefined
      if (token && !tokens.has(token) && (foreground || rule.settings?.fontStyle)) tokens.set(token, { token, foreground, fontStyle: rule.settings?.fontStyle })
    }
  }
  const colors: Record<string, string> = { ...base?.colors }
  for (const [key, value] of Object.entries(data.colors ?? {})) if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value)) colors[key] = value
  return { id, name: label, dark: !/light/i.test(uiTheme) || /hc-black/.test(uiTheme), colors, tokens: [...tokens.values()] }
}

const SETTINGS_MAP: { key: string; label: string; apply(value: any, editor: Partial<EditorSettings>): void }[] = [
  { key: 'editor.fontSize', label: 'Font size', apply: (v, e) => { if (typeof v === 'number') e.fontSize = v } },
  { key: 'editor.tabSize', label: 'Tab size', apply: (v, e) => { if (typeof v === 'number') e.tabSize = v } },
  { key: 'editor.wordWrap', label: 'Word wrap', apply: (v, e) => { e.wordWrap = v !== 'off' } },
  { key: 'editor.minimap.enabled', label: 'Minimap', apply: (v, e) => { e.minimap = !!v } },
  { key: 'editor.formatOnSave', label: 'Format on save', apply: (v, e) => { e.formatOnSave = !!v } },
  { key: 'files.autoSave', label: 'Auto-save', apply: (v, e) => { e.autoSave = v !== 'off' } }
]

/** Copies what can work without running any code: settings, snippets and color themes. */
export function importFromVscode(paths: VscodePaths): { assets: ImportedAssets; summary: VscodeImport; settingsPatch: Partial<Settings> & { editor?: Partial<EditorSettings> } } {
  const summary: VscodeImport = { found: false, settings: [], snippets: 0, themes: [], extensionsUsed: [], extensionsSkipped: [] }
  const assets: ImportedAssets = { snippets: [], themes: [] }
  const editor: Partial<EditorSettings> = {}

  const user = readJsonc(path.join(paths.user, 'settings.json'))
  if (user) {
    summary.found = true
    for (const { key, label, apply } of SETTINGS_MAP) {
      if (key in user) {
        apply(user[key], editor)
        summary.settings.push(label)
      }
    }
  }

  let snippetDir: string[] = []
  try {
    snippetDir = fs.readdirSync(path.join(paths.user, 'snippets'))
    summary.found = true
  } catch {
    /* no user snippets */
  }
  for (const name of snippetDir) {
    const file = path.join(paths.user, 'snippets', name)
    if (name.endsWith('.code-snippets')) assets.snippets.push(...readSnippets(file, []))
    else if (name.endsWith('.json')) assets.snippets.push(...readSnippets(file, [name.slice(0, -5)]))
  }

  let extensions: string[] = []
  try {
    extensions = fs.readdirSync(paths.extensions, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    summary.found = true
  } catch {
    /* no extensions */
  }
  for (const folder of extensions) {
    const dir = path.join(paths.extensions, folder)
    const pkg = readJsonc(path.join(dir, 'package.json'))
    if (!pkg) continue
    const label = String(pkg.displayName && !String(pkg.displayName).startsWith('%') ? pkg.displayName : pkg.name ?? folder)
    let used = false
    for (const snippet of Array.isArray(pkg.contributes?.snippets) ? pkg.contributes.snippets : []) {
      const file = insideOf(dir, snippet?.path)
      if (!file) continue
      const found = readSnippets(file, snippet.language ? [snippet.language] : [])
      if (found.length) used = true
      assets.snippets.push(...found)
    }
    for (const theme of Array.isArray(pkg.contributes?.themes) ? pkg.contributes.themes : []) {
      const file = insideOf(dir, theme?.path)
      if (!file) continue
      const name = String(theme.label ?? theme.id ?? folder)
      const parsed = readTheme(file, `vscode-${assets.themes.length}`, name.startsWith('%') ? label : name, String(theme.uiTheme ?? 'vs-dark'))
      if (parsed) {
        assets.themes.push(parsed)
        summary.themes.push(parsed.name)
        used = true
      }
    }
    if (used) summary.extensionsUsed.push(label)
    if (pkg.main || pkg.browser) summary.extensionsSkipped.push(label)
  }
  summary.snippets = assets.snippets.length
  const settingsPatch: Partial<Settings> & { editor?: Partial<EditorSettings> } = { editor: editor as EditorSettings }
  const wanted = user?.['workbench.colorTheme']
  const match = assets.themes.find((t) => t.name === wanted)
  if (match) settingsPatch.editorTheme = match.id
  return { assets, summary, settingsPatch }
}
