import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpenAiClient } from '../src/main/model'
import { createAnthropicClient, effectiveSettings, listModels, localModels } from '../src/main/providers'
import { DEFAULT_SETTINGS, isCloud, type Settings } from '../src/shared/types'

interface Seen { headers: http.IncomingHttpHeaders; body: any; url: string }
let server: http.Server | null = null
afterEach(() => server?.close())

function serve(handler: (req: Seen, res: http.ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let data = ''
      req.on('data', (d) => (data += d))
      req.on('end', () => handler({ headers: req.headers, body: data ? JSON.parse(data) : null, url: req.url ?? '' }, res))
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`))
  })
}

const sse = (res: http.ServerResponse, events: object[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
  res.end()
}

const anthropicEvents = (text: string[], stop = 'end_turn', extra: object = {}) => [
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
  ...text.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage: { output_tokens: 9 } },
  { type: 'message_stop' }
]

const callbacks = (out: string[] = [], stopOn?: string) => ({
  onText: (d: string) => { out.push(d); return d === stopOn },
  onProgress: () => {}
})
const request = (extra = {}) => ({ messages: [{ role: 'system' as const, content: 'SYS' }, { role: 'user' as const, content: 'hi' }], temperature: 0.2, maxTokens: 64000, signal: new AbortController().signal, ...extra })
const anthropicSettings = (url: string, over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, provider: 'anthropic', baseUrls: { ...DEFAULT_SETTINGS.baseUrls, anthropic: url }, ...over })

describe('Anthropic', () => {
  it('sends a correct streaming request and reads the answer', async () => {
    let seen: Seen | undefined
    const url = await serve((req, res) => { seen = req; sse(res, anthropicEvents(['Hel', 'lo'])) })
    const out: string[] = []
    const result = await createAnthropicClient(() => anthropicSettings(url), () => 'sk-test').stream(request(), callbacks(out))
    expect(out.join('')).toBe('Hello')
    expect(result).toMatchObject({ content: 'Hello', tokens: 9, promptTokens: 7 })
    expect(seen!.headers.authorization).toBe('Bearer sk-test')
    expect(seen!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(seen!.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, max_tokens: 64000, fallbacks: 'default', output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hi' }] })
    expect(seen!.body.system[0].text).toBe('SYS')
    expect(seen!.body.temperature).toBeUndefined()
  })

  it('leaves fallbacks and effort off for models that reject them', async () => {
    let seen: Seen | undefined
    const url = await serve((req, res) => { seen = req; sse(res, anthropicEvents(['ok'])) })
    await createAnthropicClient(() => anthropicSettings(url, { models: { ...DEFAULT_SETTINGS.models, anthropic: 'claude-haiku-4-5' } }), () => 'k').stream(request(), callbacks())
    expect(seen!.body.fallbacks).toBeUndefined()
    expect(seen!.body.output_config).toBeUndefined()
  })

  it('stops early when asked', async () => {
    const url = await serve((_req, res) => sse(res, anthropicEvents(['a', 'STOP', 'never'])))
    const out: string[] = []
    const result = await createAnthropicClient(() => anthropicSettings(url), () => 'k').stream(request(), callbacks(out, 'STOP'))
    expect(result.content).toBe('aSTOP')
    expect(out).not.toContain('never')
  })

  it('reports refusals, bad keys and a missing key clearly', async () => {
    const refusing = await serve((_req, res) => sse(res, anthropicEvents([], 'refusal', { stop_details: { type: 'refusal', category: null, explanation: 'Not allowed.' } })))
    await expect(createAnthropicClient(() => anthropicSettings(refusing), () => 'k').stream(request(), callbacks())).rejects.toThrow(/declined.*Not allowed/)
    server!.close()
    const rejecting = await serve((_req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad' } })) })
    await expect(createAnthropicClient(() => anthropicSettings(rejecting), () => 'k').stream(request(), callbacks())).rejects.toThrow(/rejected the API key/)
    await expect(createAnthropicClient(() => anthropicSettings(rejecting), () => null).stream(request(), callbacks())).rejects.toThrow(/Add your Anthropic API key/)
  })
})

describe('OpenAI-style servers', () => {
  const answer = (res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  }

  it('OpenAI gets the key and its own limit field, with no temperature', async () => {
    let seen: Seen | undefined
    const url = await serve((req, res) => { seen = req; answer(res) })
    await createOpenAiClient(() => ({ baseUrl: url, model: 'gpt-x', apiKey: 'sk', strictOpenAi: true })).stream(request(), callbacks())
    expect(seen!.headers.authorization).toBe('Bearer sk')
    expect(seen!.body.max_completion_tokens).toBe(64000)
    expect(seen!.body.max_tokens).toBeUndefined()
    expect(seen!.body.temperature).toBeUndefined()
  })

  it('sends the chosen effort, and retries without it if the model refuses', async () => {
    const seen: Seen[] = []
    const url = await serve((req, res) => {
      seen.push(req)
      if (req.body.reasoning_effort) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return void res.end('{"error":{"message":"Unsupported parameter: reasoning_effort"}}')
      }
      answer(res)
    })
    const out: string[] = []
    await createOpenAiClient(() => ({ baseUrl: url, model: 'gpt-x', apiKey: 'k', strictOpenAi: true, reasoningEffort: 'high' })).stream(request(), callbacks(out))
    expect(seen.map((s) => s.body.reasoning_effort)).toEqual(['high', undefined])
    expect(out.join('')).toBe('ok')
  })

  it('sends no effort by default', async () => {
    let seen: Seen | undefined
    const url = await serve((req, res) => { seen = req; answer(res) })
    await createOpenAiClient(() => ({ baseUrl: url, model: 'gpt-x', apiKey: 'k', strictOpenAi: true })).stream(request(), callbacks())
    expect(seen!.body.reasoning_effort).toBeUndefined()
  })

  it('local servers send no key', async () => {
    let seen: Seen | undefined
    const url = await serve((req, res) => { seen = req; answer(res) })
    await createOpenAiClient(() => ({ baseUrl: url, model: 'm', apiKey: null, strictOpenAi: false })).stream(request(), callbacks())
    expect(seen!.headers.authorization).toBeUndefined()
    expect(seen!.body).toMatchObject({ max_tokens: 64000, temperature: 0.2 })
  })

  it('asks for a model when none is picked', async () => {
    await expect(createOpenAiClient(() => ({ baseUrl: 'http://x', model: '', apiKey: null, strictOpenAi: false })).stream(request(), callbacks())).rejects.toThrow(/Pick a model/)
  })

  it('lists only chat models from OpenAI', async () => {
    const url = await serve((_req, res) => res.end(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'text-embedding-3' }, { id: 'gpt-x-audio' }, { id: 'o9' }] })))
    const models = await listModels('openai', { ...DEFAULT_SETTINGS, baseUrls: { ...DEFAULT_SETTINGS.baseUrls, openai: url } }, 'k')
    expect(models.map((m) => m.id)).toEqual(['gpt-x', 'o9'])
  })
})

describe('local models', () => {
  const makeModel = (hub: string, id: string, size: number, config = true) => {
    const dir = path.join(hub, `models--${id.replace('/', '--')}`, 'snapshots/abc')
    fs.mkdirSync(dir, { recursive: true })
    if (config) fs.writeFileSync(path.join(dir, 'config.json'), '{}')
    if (size) { const f = fs.openSync(path.join(dir, 'model.safetensors'), 'w'); fs.ftruncateSync(f, size); fs.closeSync(f) }
  }

  it('lists downloaded MLX models, smallest first, and warns about big ones', () => {
    const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'))
    makeModel(hub, 'mlx-community/Big', 13.2e9)
    makeModel(hub, 'mlx-community/Small', 6e9)
    makeModel(hub, 'Systran/faster-whisper-small', 1e9)
    makeModel(hub, 'mlx-community/Broken', 0)
    const models = localModels(hub, 16)
    expect(models.map((m) => m.id)).toEqual(['mlx-community/Small', 'mlx-community/Big'])
    expect(models[0].warning).toBeUndefined()
    expect(models[1].warning).toMatch(/freeze/)
  })

  it('copes with no models folder', () => expect(localModels('/nonexistent')).toEqual([]))
})

it('limits suit the provider, and cloud use is labelled', () => {
  expect(effectiveSettings(DEFAULT_SETTINGS).contextTokens).toBe(24000)
  expect(effectiveSettings({ ...DEFAULT_SETTINGS, provider: 'anthropic' }).maxOutputTokens).toBe(64000)
  expect(isCloud(DEFAULT_SETTINGS)).toBe(false)
  expect(isCloud({ ...DEFAULT_SETTINGS, provider: 'anthropic' })).toBe(true)
  expect(isCloud({ ...DEFAULT_SETTINGS, provider: 'custom' })).toBe(false)
})
