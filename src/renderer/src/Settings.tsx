import { useEffect, useState, useRef } from 'react'
import type { EditorSettings, Effort, OpenAiEffort, ImportedAssets, LocalSetup, ModelOption, ProviderId, Settings, VscodeImport } from '../../shared/types'
import { PROVIDER_LABEL } from '../../shared/types'
import { Icon } from './Icon'

const api = window.anvil
const PROVIDERS: ProviderId[] = ['local', 'anthropic', 'openai', 'custom']
const BLURB: Record<ProviderId, string> = {
  local: 'Runs on this computer with MLX and works with no internet. Your code stays here.',
  anthropic: 'Claude models through your API key. Your code is sent to Anthropic.',
  openai: 'OpenAI models through your API key. Your code is sent to OpenAI.',
  custom: 'Any server with an OpenAI-style API. Ollama and LM Studio run on this computer, work with no internet and keep your code here.'
}

const PRESETS = [
  { label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' }
]

function LocalSetupCard({ setup, hasProject, onRun }: { setup: LocalSetup; hasProject: boolean; onRun(command: string): void }) {
  if (!setup.platformOk) return <div className="setup"><b>MLX only runs on Macs with Apple Silicon.</b><p>For a local model on this computer, install <b>Ollama</b> or <b>LM Studio</b>, download a model there, then pick it under Custom server.</p></div>
  if (setup.serverInstalled && setup.hasModels) return null
  const step = (done: boolean, title: string, command: string) => (
    <div className={`setup-step ${done ? 'done' : ''}`}>
      <span className="setup-mark">{done && <Icon name="check" size={12} />}</span>
      <div>
        <b>{title}</b>
        {!done && <pre>{command}</pre>}
        {!done && (
          <div className="row">
            {hasProject && <button className="primary" onClick={() => onRun(command)}>Run in terminal</button>}
            <button onClick={() => void navigator.clipboard.writeText(command)}>Copy</button>
          </div>
        )}
      </div>
    </div>
  )
  return (
    <div className="setup">
      <h3>Set up a local model</h3>
      {step(setup.serverInstalled, 'Install the model server (MLX)', setup.installCommand)}
      {step(setup.hasModels, 'Download a coding model (about 6 GB)', setup.downloadCommand)}
      <p>You need internet for these two steps only. After that, it all works offline.</p>
    </div>
  )
}

function UpdateRow() {
  const [version, setVersion] = useState('')
  const [note, setNote] = useState('')
  const [checking, setChecking] = useState(false)
  useEffect(() => { void api.appVersion().then(setVersion) }, [])
  const check = async () => {
    setChecking(true)
    setNote('')
    try {
      const { latest } = await api.checkUpdate()
      setNote(latest ? `${latest.replace(/^v/, '')} is available. Use the Update button at the top.` : 'You have the latest version.')
    } catch (e) {
      setNote((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="setting-row">
      <span>Anvil {version}{note && <small>{note}</small>}</span>
      <button disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check now'}</button>
    </div>
  )
}

function EditorPanel({ settings, assets, onSettings, onImported, onError }: { settings: Settings; assets: ImportedAssets; onSettings(patch: Partial<Settings>): void; onImported(): void; onError(e: unknown): void }) {
  const [result, setResult] = useState<VscodeImport | null>(null)
  const [busy, setBusy] = useState(false)
  const e = settings.editor
  const set = (patch: Partial<EditorSettings>) => onSettings({ editor: { ...e, ...patch } })
  const toggle = (label: string, hint: string, on: boolean, change: (v: boolean) => void) => (
    <div className="setting-row">
      <span>{label}<small>{hint}</small></span>
      <label className="toggle" aria-label={label}><input type="checkbox" checked={on} onChange={(ev) => change(ev.target.checked)} /><span className="switch" /></label>
    </div>
  )
  const run = () => {
    setBusy(true)
    void api.importVscode().then((r) => { setResult(r); onImported() }).catch(onError).finally(() => setBusy(false))
  }
  return (
    <>
      <div className="settings-group">
        <div className="setting-row"><span>Theme</span>
          <select id="theme" value={settings.theme} onChange={(ev) => onSettings({ theme: ev.target.value as Settings['theme'] })}>
            <option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option>
          </select>
        </div>
        {assets.themes.length > 0 && (
          <div className="setting-row"><span>Editor colors<small>Imported themes color the code, and are approximate</small></span>
            <select id="editor-theme" value={settings.editorTheme ?? ''} onChange={(ev) => onSettings({ editorTheme: ev.target.value || undefined })}>
              <option value="">Anvil</option>
              {assets.themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div className="setting-row"><span>Font size</span><input id="font-size" type="number" min={9} max={28} value={e.fontSize} onChange={(ev) => set({ fontSize: Number(ev.target.value) || 13 })} /></div>
        <div className="setting-row"><span>Tab size</span><input id="tab-size" type="number" min={1} max={8} value={e.tabSize} onChange={(ev) => set({ tabSize: Number(ev.target.value) || 2 })} /></div>
        {toggle('Auto-save', 'Saves about a second after you stop typing', e.autoSave, (v) => set({ autoSave: v }))}
        {toggle('Format on save', 'With the project\'s Prettier if it has one, otherwise TypeScript\'s formatter', e.formatOnSave, (v) => set({ formatOnSave: v }))}
        {toggle('Word wrap', 'Wraps long lines', e.wordWrap, (v) => set({ wordWrap: v }))}
        {toggle('Show who changed each line', 'Git author, date and message at the end of the current line', e.blame, (v) => set({ blame: v }))}
        <div className="setting-row"><span>Cursor</span><select id="cursor-style" value={settings.cursorStyle ?? 'line'} onChange={(ev) => onSettings({ cursorStyle: ev.target.value as Settings['cursorStyle'] })}><option value="line">Line</option><option value="block">Block</option><option value="underline">Underline</option></select></div>
        {toggle('Leave the graphics chip to the local model', 'Makes a local model faster, but scrolling less smooth. Applies after you restart Anvil', !!settings.leaveGpuToModel, (v) => onSettings({ leaveGpuToModel: v }))}
        {toggle('Sticky scroll', 'Keeps the function you are in at the top while you scroll', settings.stickyScroll !== false, (v) => onSettings({ stickyScroll: v }))}
        {toggle('Fix ESLint problems on save', 'Uses the project\'s own ESLint rules', !!settings.fixOnSave, (v) => onSettings({ fixOnSave: v }))}
        {toggle('File icons', 'Colored icons for files and folders, from Material Icon Theme', settings.fileIcons !== false, (v) => onSettings({ fileIcons: v }))}
        {toggle('Minimap', 'A small overview beside the code', e.minimap, (v) => set({ minimap: v }))}
        {toggle('Suggestions from the model', 'Grey text as you pause, Tab to accept. Local and custom local servers only', settings.inlineSuggest, (v) => onSettings({ inlineSuggest: v }))}
        {toggle('Check for updates', 'Asks GitHub for the latest version number', settings.checkUpdates, (v) => onSettings({ checkUpdates: v }))}
        <UpdateRow />
      </div>
      <div className="field"><span>Import from VS Code</span>
        <p className="blurb">Copies your settings, snippets and color themes. Extensions that are programs, like ESLint or GitLens, can't run in Anvil, and the list below will name them.</p>
        <button className="primary use" disabled={busy} onClick={run}>{busy ? 'Importing…' : 'Import from VS Code'}</button>
      </div>
      {result && !result.found && <div className="import-result"><b>VS Code wasn't found on this computer.</b></div>}
      {result?.found && (
        <div className="import-result">
          <b>Imported {result.settings.length} setting{result.settings.length === 1 ? '' : 's'}, {result.snippets} snippet{result.snippets === 1 ? '' : 's'} and {result.themes.length} theme{result.themes.length === 1 ? '' : 's'}.</b>
          {result.extensionsSkipped.length > 0 && (
            <>
              <span>These {result.extensionsSkipped.length} extensions are programs, so they weren't imported:</span>
              <ul>{result.extensionsSkipped.map((n) => <li key={n}>{n}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </>
  )
}

export type SettingsTab = ProviderId | 'editor'

export function SettingsModal({ settings, initial, assets, onImported, onSettings, onStatus, onClose, onError, hasProject, onRunInTerminal }: {
  settings: Settings
  initial: SettingsTab
  assets: ImportedAssets
  onImported(): void
  onSettings(patch: Partial<Settings>): void
  onStatus(): void
  onClose(): void
  onError(e: unknown): void
  hasProject: boolean
  onRunInTerminal(command: string): void
}) {
  const [setup, setSetup] = useState<LocalSetup | null>(null)
  useEffect(() => { void api.localSetup().then(setSetup).catch(onError) }, [onError])
  const [tab, setTab] = useState<SettingsTab>(initial)
  const [find, setFind] = useState('')
  const [noMatch, setNoMatch] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  // Works on what's on screen, so a new setting is searchable with no extra list to keep up to date.
  useEffect(() => {
    const words = find.toLowerCase().split(/\s+/).filter(Boolean)
    const rows = [...(body.current?.querySelectorAll<HTMLElement>('.setting-row') ?? [])]
    for (const row of rows) row.hidden = !words.every((w) => (row.textContent ?? '').toLowerCase().includes(w))
    setNoMatch(words.length > 0 && rows.length > 0 && rows.every((row) => row.hidden))
  })
  const [models, setModels] = useState<ModelOption[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [keys, setKeys] = useState<Record<ProviderId, boolean> | null>(null)
  const [key, setKey] = useState('')
  const [confirm, setConfirm] = useState<ModelOption | null>(null)

  const refresh = () => {
    setLoading(true)
    setListError(null)
    setModels([])
    if (tab === 'editor') return setLoading(false)
    void api.listModels(tab).then(setModels)
      .catch((e: Error) => setListError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
      .finally(() => setLoading(false))
  }
  const refreshKeys = () => void api.keyStatus().then(setKeys).catch(onError)

  useEffect(() => {
    refreshKeys()
    setKey('')
    setConfirm(null)
    if (tab === 'local' || tab === 'custom' || settings.provider === tab) refresh()
    else setModels([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    if (tab !== 'editor' && keys?.[tab]) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])

  const provider = tab === 'editor' ? 'local' : tab
  const current = settings.models[provider]
  const pick = (m: ModelOption) => {
    if (tab === 'local') {
      if (m.warning && confirm?.id !== m.id) return setConfirm(m)
      setConfirm(null)
      void api.switchLocalModel(m.id).then(() => { onSettings({ provider: 'local', models: { ...settings.models, local: m.id } }); onStatus() }).catch(onError)
      return
    }
    onSettings({ provider, models: { ...settings.models, [provider]: m.id } })
    onStatus()
  }
  const saveKey = () => {
    void api.setApiKey(provider, key).then(() => { setKey(''); refreshKeys(); onStatus() }).catch(onError)
  }

  return (
    <div className="modal-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-label="Models and settings">
        <div className="modal-head">
          <h2>Models and settings</h2>
          <input id="settings-search" className="settings-search" type="search" value={find} spellCheck={false} placeholder="Search settings" aria-label="Search settings" onChange={(e) => { setFind(e.target.value); if (e.target.value) setTab('editor') }} />
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="modal-body" ref={body}>
          {noMatch && <div className="settings-nomatch" role="status">No settings match "{find}".</div>}
          <nav className="modal-nav">
            {PROVIDERS.map((p) => (
              <button key={p} className={tab === p ? 'active' : ''} onClick={() => setTab(p)}>
                <Icon name={p === 'local' ? 'chip' : 'cloud'} size={14} />{PROVIDER_LABEL[p]}
                {settings.provider === p && <span className="in-use">In use</span>}
              </button>
            ))}
            <button className={tab === 'editor' ? 'active' : ''} onClick={() => setTab('editor')}><Icon name="gear" size={14} />Editor</button>
          </nav>
          <div className="modal-main">
            {tab === 'editor' && <EditorPanel settings={settings} assets={assets} onSettings={onSettings} onImported={onImported} onError={onError} />}
            {tab !== 'editor' && (
              <>
                <p className="blurb">{BLURB[provider]}</p>
            {tab === 'local' && setup && <LocalSetupCard setup={setup} hasProject={hasProject} onRun={onRunInTerminal} />}

            {tab === 'custom' && (
              <div className="row presets">{PRESETS.map((p) => <button key={p.label} onClick={() => onSettings({ baseUrls: { ...settings.baseUrls, custom: p.url } })}>{p.label}</button>)}</div>
            )}
            {tab === 'custom' && (
              <label className="field"><span>Server address</span>
                <input id="custom-url" value={settings.baseUrls.custom} onChange={(e) => onSettings({ baseUrls: { ...settings.baseUrls, custom: e.target.value } })} onBlur={refresh} />
              </label>
            )}

            {tab !== 'local' && (
              <div className="field"><span>API key{tab === 'custom' ? ' (if the server needs one)' : ''}</span>
                {keys?.[provider]
                  ? <div className="row key-row"><span className="key-saved"><Icon name="check" size={13} />Saved in this computer's secure storage</span><button onClick={() => void api.clearApiKey(provider).then(() => { refreshKeys(); setModels([]); onStatus() }).catch(onError)}>Remove</button></div>
                  : <div className="row key-row"><input id="api-key" type="password" autoComplete="off" spellCheck={false} value={key} placeholder="Paste your key" onChange={(e) => setKey(e.target.value)} /><button className="primary" disabled={!key.trim()} onClick={saveKey}>Save</button></div>}
              </div>
            )}

            <div className="field"><span className="row-between">Model<button className="link" onClick={refresh}>Refresh</button></span>
              <div className="model-list">
                {loading && <div className="pane-empty small">Loading…</div>}
                {listError && <div className="check bad"><Icon name="warn" size={13} /><pre>{listError}</pre></div>}
                {!loading && !listError && !models.length && <div className="pane-empty small">{tab === 'local' ? 'No downloaded MLX models found.' : 'No models listed yet.'}</div>}
                {models.map((m) => (
                  <div key={m.id} className={`model-row ${current === m.id ? 'selected' : ''}`} onClick={() => pick(m)}>
                    <span className="model-name">{m.id.split('/').pop()}<small>{m.id.includes('/') ? m.id.split('/')[0] : ''}</small></span>
                    {m.sizeGb !== undefined && <span className="size">{m.sizeGb.toFixed(1)} GB</span>}
                    {m.warning && <span className="warn-icon" title={m.warning}><Icon name="warn" size={14} /></span>}
                    {current === m.id && settings.provider === tab && <Icon name="check" size={14} />}
                  </div>
                ))}
              </div>
              {confirm && (
                <div className="approval pending"><div className="approval-title"><Icon name="warn" size={13} />{confirm.warning}</div>
                  <div className="row"><button onClick={() => pick(confirm)}>Load it anyway</button><button onClick={() => setConfirm(null)}>Cancel</button></div>
                </div>
              )}
            </div>

            {tab !== 'local' && (
              <label className="field"><span>Or type a model name</span>
                <input id="model-name" value={current} spellCheck={false} onChange={(e) => onSettings({ provider, models: { ...settings.models, [provider]: e.target.value } })} />
              </label>
            )}

            {tab === 'openai' && (
              <label className="field"><span>Effort, for models that support it</span>
                <select id="openai-effort" value={settings.openaiEffort} onChange={(e) => onSettings({ openaiEffort: e.target.value as OpenAiEffort })}>
                  {(['default', 'minimal', 'low', 'medium', 'high'] as OpenAiEffort[]).map((v) => <option key={v} value={v}>{v === 'default' ? "Model's default" : v}</option>)}
                </select>
              </label>
            )}
            {tab === 'anthropic' && (
              <label className="field"><span>Effort</span>
                <select id="effort" value={settings.effort} onChange={(e) => onSettings({ effort: e.target.value as Effort })}>
                  {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((v) => <option key={v} value={v}>{v === 'xhigh' ? 'Extra high' : v[0].toUpperCase() + v.slice(1)}</option>)}
                </select>
              </label>
            )}

            {(tab === 'local' || tab === 'custom') && (
              <div className="grid3">
                <label className="field"><span>Context tokens</span><input id="context" type="number" min={4000} step={1000} value={settings.contextTokens} onChange={(e) => onSettings({ contextTokens: Number(e.target.value) || 24000 })} /></label>
                <label className="field"><span>Answer tokens</span><input id="output" type="number" min={500} step={500} value={settings.maxOutputTokens} onChange={(e) => onSettings({ maxOutputTokens: Number(e.target.value) || 4096 })} /></label>
                <label className="field"><span>Temperature</span><input id="temperature" type="number" min={0} max={1} step={0.1} value={settings.temperature} onChange={(e) => onSettings({ temperature: Number(e.target.value) })} /></label>
              </div>
            )}

            {tab !== settings.provider && <button className="primary use" onClick={() => { onSettings({ provider }); onStatus() }}>Use {PROVIDER_LABEL[provider]}</button>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
