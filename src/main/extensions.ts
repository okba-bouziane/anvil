import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import type { ExtensionInfo, ExtensionSupport, ImportedAssets } from '../shared/types'
import { readSnippets, readTheme } from './vscode-import'

/**
 * Extensions come from Open VSX, the open registry Kiro and others use. Anvil keeps only an extension's data files:
 * its code is never unpacked and never runs. What a program-style extension does therefore isn't available yet.
 */

const REGISTRY = 'https://open-vsx.org/api'
const KEEP = /\.(json|code-snippets|tmTheme|png|md)$/i
const MAX_UNPACKED = 80_000_000

interface Manifest {
  name?: string
  displayName?: string
  main?: string
  browser?: string
  contributes?: { themes?: { path?: string; label?: string; uiTheme?: string; id?: string }[]; snippets?: { path?: string; language?: string }[]; grammars?: unknown[]; iconThemes?: unknown[] }
}

/** What Anvil can use from an extension, judged from its manifest alone. */
export function supportOf(manifest: Manifest): ExtensionSupport {
  const themes = manifest.contributes?.themes?.length ?? 0
  const snippets = manifest.contributes?.snippets?.length ?? 0
  const parts = [themes ? 'color themes' : '', snippets ? 'snippets' : ''].filter(Boolean)
  const program = !!(manifest.main || manifest.browser)
  if (!parts.length) return { level: 'none', note: program ? 'This extension is a program, and Anvil can\'t run those yet.' : 'It adds nothing Anvil can use yet.' }
  if (program) return { level: 'partial', note: `Its ${parts.join(' and ')} work. The rest of it is a program, which Anvil can't run yet.` }
  return { level: 'full', note: `Adds ${parts.join(' and ')}.` }
}

/** Unpacks only data files, and refuses any path that would land outside the extension's folder. */
export function unpackExtension(zip: Uint8Array, target: string): Manifest {
  const files = unzipSync(zip, { filter: (f) => f.name.startsWith('extension/') && KEEP.test(f.name) })
  const total = Object.values(files).reduce((n, f) => n + f.length, 0)
  if (total > MAX_UNPACKED) throw new Error('This extension is too large.')
  const manifest = files['extension/package.json']
  if (!manifest) throw new Error('This file is not an extension.')
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    const file = path.resolve(target, name.slice('extension/'.length))
    if (!file.startsWith(target + path.sep)) throw new Error('This extension contains an unsafe file path.')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
  }
  return JSON.parse(Buffer.from(manifest).toString('utf8')) as Manifest
}

export function assetsOf(dir: string, id: string): ImportedAssets {
  const assets: ImportedAssets = { snippets: [], themes: [] }
  let manifest: Manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest
  } catch {
    return assets
  }
  const inside = (rel: unknown) => {
    if (typeof rel !== 'string') return null
    const full = path.resolve(dir, rel)
    return full.startsWith(dir + path.sep) && fs.existsSync(full) ? full : null
  }
  for (const s of manifest.contributes?.snippets ?? []) {
    const file = inside(s.path)
    if (file) assets.snippets.push(...readSnippets(file, s.language ? [s.language] : []))
  }
  for (const t of manifest.contributes?.themes ?? []) {
    const file = inside(t.path)
    const label = t.label ?? t.id ?? manifest.displayName ?? id
    const theme = file && readTheme(file, `ext:${id}:${label}`, label, t.uiTheme ?? 'vs-dark')
    if (theme) assets.themes.push(theme)
  }
  return assets
}

async function json<T>(url: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20000) })
  } catch {
    throw new Error("Couldn't reach the extension store. Check your connection and try again.")
  }
  if (!response.ok) throw new Error(`The extension store answered ${response.status}.`)
  return response.json() as Promise<T>
}

interface StoreEntry {
  namespace: string
  name: string
  displayName?: string
  description?: string
  version: string
  downloadCount?: number
  files?: { icon?: string; download?: string; manifest?: string; sha256?: string }
}

export class Extensions {
  private manifests = new Map<string, Manifest | null>()

  constructor(private dir: string, private registry = REGISTRY) {}

  private stateFile = () => path.join(this.dir, 'installed.json')

  installed(): ExtensionInfo[] {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) as ExtensionInfo[]
    } catch {
      return []
    }
  }

  private save(list: ExtensionInfo[]): void {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.stateFile(), JSON.stringify(list, null, 2))
  }

  private async manifestOf(detail: StoreEntry): Promise<Manifest | null> {
    const key = `${detail.namespace}.${detail.name}@${detail.version}`
    if (this.manifests.has(key)) return this.manifests.get(key)!
    const value = detail.files?.manifest ? await json<Manifest>(detail.files.manifest).catch(() => null) : null
    this.manifests.set(key, value)
    return value
  }

  private async iconOf(url?: string): Promise<string | null> {
    if (!url) return null
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
      const data = Buffer.from(await response.arrayBuffer())
      const type = response.headers.get('content-type') ?? ''
      if (!response.ok || data.length > 300_000 || !/^image\/(png|jpe?g|gif|webp)/.test(type)) return null
      return `data:${type.split(';')[0]};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  }

  async search(query: string): Promise<ExtensionInfo[]> {
    const params = new URLSearchParams({ size: '24', sortBy: query.trim() ? 'relevance' : 'downloadCount', sortOrder: 'desc' })
    if (query.trim()) params.set('query', query.trim())
    const { extensions } = await json<{ extensions: StoreEntry[] }>(`${this.registry}/-/search?${params}`)
    return Promise.all(extensions.map(async (e) => {
      const detail = await json<StoreEntry>(`${this.registry}/${e.namespace}/${e.name}/latest`).catch(() => e)
      const manifest = await this.manifestOf(detail)
      return {
        id: `${e.namespace}.${e.name}`,
        namespace: e.namespace,
        name: e.name,
        displayName: e.displayName || e.name,
        description: e.description ?? '',
        version: detail.version,
        downloads: e.downloadCount ?? 0,
        icon: await this.iconOf(e.files?.icon),
        support: manifest ? supportOf(manifest) : { level: 'none' as const, note: 'Anvil couldn\'t read what this extension contains.' }
      }
    }))
  }

  async install(namespace: string, name: string): Promise<ExtensionInfo> {
    if (!/^[\w.-]+$/.test(namespace) || !/^[\w.-]+$/.test(name)) throw new Error('That is not an extension name.')
    const detail = await json<StoreEntry>(`${this.registry}/${namespace}/${name}/latest`)
    if (!detail.files?.download?.startsWith('https://') && !this.registry.startsWith('http://127.')) throw new Error('This extension has no safe download.')
    const response = await fetch(detail.files!.download!, { signal: AbortSignal.timeout(120000) }).catch(() => null)
    if (!response?.ok) throw new Error("Couldn't download this extension.")
    const zip = new Uint8Array(await response.arrayBuffer())
    if (detail.files?.sha256) {
      const expected = (await (await fetch(detail.files.sha256)).text()).trim().split(/\s+/)[0].toLowerCase()
      const actual = createHash('sha256').update(zip).digest('hex')
      if (expected !== actual) throw new Error('This download failed its integrity check, so it was not installed.')
    }
    const id = `${namespace}.${name}`
    const manifest = unpackExtension(zip, path.join(this.dir, id))
    const support = supportOf(manifest)
    if (support.level === 'none') {
      fs.rmSync(path.join(this.dir, id), { recursive: true, force: true })
      throw new Error(support.note)
    }
    const info: ExtensionInfo = {
      id, namespace, name,
      displayName: manifest.displayName && !manifest.displayName.startsWith('%') ? manifest.displayName : detail.displayName ?? name,
      description: detail.description ?? '',
      version: detail.version,
      downloads: detail.downloadCount ?? 0,
      icon: await this.iconOf(detail.files?.icon),
      support
    }
    this.save([...this.installed().filter((e) => e.id !== id), info])
    return info
  }

  uninstall(id: string): void {
    if (!/^[\w.-]+$/.test(id)) throw new Error('That is not an extension name.')
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true })
    this.save(this.installed().filter((e) => e.id !== id))
  }

  assets(): ImportedAssets {
    const all: ImportedAssets = { snippets: [], themes: [] }
    for (const e of this.installed()) {
      const found = assetsOf(path.join(this.dir, e.id), e.id)
      all.snippets.push(...found.snippets)
      all.themes.push(...found.themes)
    }
    return all
  }
}
