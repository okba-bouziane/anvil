import { useEffect, useState } from 'react'
import type { Effort, LocalSetup, ModelOption, ProviderId, Settings } from '../../shared/types'
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

export function SettingsModal({ settings, initial, onSettings, onStatus, onClose, onError, hasProject, onRunInTerminal }: {
  settings: Settings
  initial: ProviderId
  onSettings(patch: Partial<Settings>): void
  onStatus(): void
  onClose(): void
  onError(e: unknown): void
  hasProject: boolean
  onRunInTerminal(command: string): void
}) {
  const [setup, setSetup] = useState<LocalSetup | null>(null)
  useEffect(() => { void api.localSetup().then(setSetup).catch(onError) }, [onError])
  const [tab, setTab] = useState<ProviderId>(initial)
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
    if (keys?.[tab]) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])

  const current = settings.models[tab]
  const pick = (m: ModelOption) => {
    if (tab === 'local') {
      if (m.warning && confirm?.id !== m.id) return setConfirm(m)
      setConfirm(null)
      void api.switchLocalModel(m.id).then(() => { onSettings({ provider: 'local', models: { ...settings.models, local: m.id } }); onStatus() }).catch(onError)
      return
    }
    onSettings({ provider: tab, models: { ...settings.models, [tab]: m.id } })
    onStatus()
  }
  const saveKey = () => {
    void api.setApiKey(tab, key).then(() => { setKey(''); refreshKeys(); onStatus() }).catch(onError)
  }

  return (
    <div className="modal-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-label="Models and settings">
        <div className="modal-head">
          <h2>Models and settings</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="modal-body">
          <nav className="modal-nav">
            {PROVIDERS.map((p) => (
              <button key={p} className={tab === p ? 'active' : ''} onClick={() => setTab(p)}>
                <Icon name={p === 'local' ? 'chip' : 'cloud'} size={14} />{PROVIDER_LABEL[p]}
                {settings.provider === p && <span className="in-use">In use</span>}
              </button>
            ))}
          </nav>
          <div className="modal-main">
            <p className="blurb">{BLURB[tab]}</p>
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
                {keys?.[tab]
                  ? <div className="row key-row"><span className="key-saved"><Icon name="check" size={13} />Saved in this computer's secure storage</span><button onClick={() => void api.clearApiKey(tab).then(() => { refreshKeys(); setModels([]); onStatus() }).catch(onError)}>Remove</button></div>
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
                <input id="model-name" value={current} spellCheck={false} onChange={(e) => onSettings({ provider: tab, models: { ...settings.models, [tab]: e.target.value } })} />
              </label>
            )}

            {tab === 'anthropic' && (
              <label className="field"><span>Effort</span>
                <select id="effort" value={settings.effort} onChange={(e) => onSettings({ effort: e.target.value as Effort })}>
                  {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((v) => <option key={v} value={v}>{v}</option>)}
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

            {tab !== settings.provider && <button className="primary use" onClick={() => { onSettings({ provider: tab }); onStatus() }}>Use {PROVIDER_LABEL[tab]}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
