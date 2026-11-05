import { useCallback, useEffect, useState } from 'react'
import type { ExtensionInfo, ImportedAssets, Settings } from '../../shared/types'
import { Icon } from './Icon'

const api = window.pitoo

const LABEL = { full: 'Works in Pitoo', partial: 'Partly works', none: "Can't run yet" }
const count = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))

function Row({ item, installed, busy, themes, activeTheme, onInstall, onRemove, onTheme }: {
  item: ExtensionInfo
  installed: boolean
  busy: boolean
  themes: { id: string; name: string }[]
  activeTheme: string | null
  onInstall(): void
  onRemove(): void
  onTheme(id: string | null): void
}) {
  return (
    <div className="ext-row">
      {item.icon ? <img className="ext-icon" src={item.icon} alt="" /> : <span className="ext-icon blank"><Icon name="extensions" size={16} /></span>}
      <div className="ext-body">
        <div className="ext-title"><b title={item.displayName}>{item.displayName}</b>{!installed && item.downloads > 0 && <small>{count(item.downloads)}</small>}</div>
        <div className="ext-desc" title={item.description}>{item.description}</div>
        <div className={`ext-status ${item.support.level}`} title={item.support.note}>{LABEL[item.support.level]}<small>{item.namespace}</small></div>
        {installed && themes.map((t) => (
          <button key={t.id} className="link ext-theme" onClick={() => onTheme(activeTheme === t.id ? null : t.id)}>{activeTheme === t.id ? `Stop using ${t.name}` : `Use theme: ${t.name}`}</button>
        ))}
        {!installed && item.support.level === 'none' && <div className="ext-note">{item.support.note}</div>}
      </div>
      <div className="ext-action">
        {installed
          ? <button disabled={busy} onClick={onRemove}>Remove</button>
          : <button className={item.support.level === 'none' ? '' : 'primary'} disabled={busy || item.support.level === 'none'} onClick={onInstall}>{busy ? 'Installing…' : 'Install'}</button>}
      </div>
    </div>
  )
}

export function ExtensionsPanel({ assets, settings, onAssets, onSettings, onError }: { assets: ImportedAssets; settings: Settings | null; onAssets(): void; onSettings(patch: Partial<Settings>): void; onError(e: unknown): void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ExtensionInfo[] | null>(null)
  const [installed, setInstalled] = useState<ExtensionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(() => void api.extensionsInstalled().then(setInstalled).catch(onError), [onError])
  useEffect(refresh, [refresh])

  const search = useCallback((text: string) => {
    setLoading(true)
    setMessage(null)
    void api.extensionsSearch(text).then(setResults).catch((e: Error) => {
      setResults([])
      setMessage(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }).finally(() => setLoading(false))
  }, [])
  useEffect(() => { search('') }, [search])

  const install = (item: ExtensionInfo) => {
    setBusy(item.id)
    void api.extensionsInstall(item.namespace, item.name).then(() => { refresh(); onAssets() }).catch(onError).finally(() => setBusy(null))
  }
  const remove = (item: ExtensionInfo) => {
    setBusy(item.id)
    const mine = (id?: string | null) => !!id && id.startsWith(`ext:${item.id}:`)
    if (mine(settings?.editorTheme)) onSettings({ editorTheme: undefined })
    void api.extensionsUninstall(item.id).then(() => { refresh(); onAssets() }).catch(onError).finally(() => setBusy(null))
  }
  const themesOf = (item: ExtensionInfo) => assets.themes.filter((t) => t.id.startsWith(`ext:${item.id}:`))
  const installedIds = new Set(installed.map((e) => e.id))
  const row = (item: ExtensionInfo, isInstalled: boolean) => (
    <Row key={item.id} item={item} installed={isInstalled} busy={busy === item.id} themes={themesOf(item)} activeTheme={settings?.editorTheme ?? null} onInstall={() => install(item)} onRemove={() => remove(item)} onTheme={(id) => onSettings({ editorTheme: id ?? undefined })} />
  )
  return (
    <div className="panel-body ext-panel">
      <div className="search-box">
        <input id="extension-search" autoFocus value={query} spellCheck={false} placeholder="Search extensions" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(query) }} />
      </div>
      <div className="ext-list">
        {installed.length > 0 && <div className="git-title">Installed</div>}
        {installed.map((item) => row(item, true))}
        <div className="git-title">{query.trim() ? 'Results' : 'Popular'}</div>
        {loading && <div className="pane-empty small">Searching…</div>}
        {message && <div className="pane-empty small">{message}</div>}
        {!loading && results?.filter((r) => !installedIds.has(r.id)).map((item) => row(item, false))}
        {!loading && results && !results.length && !message && <div className="pane-empty small">No extensions found.</div>}
      </div>
    </div>
  )
}
