import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModelOption, ProviderId, Settings } from '../shared/types'
import { createOpenAiClient, type ModelClient, type ModelResult } from './model'

// Set explicitly so an ANTHROPIC_BASE_URL in the environment cannot send code somewhere else.
const ANTHROPIC_URL = 'https://api.anthropic.com'
/** Models that take the server-side refusal fallback. */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/
const NO_EFFORT = /^claude-(haiku-4-5|sonnet-4-5)/
const CHAT_MODEL = /^(gpt|chatgpt|o\d)/
const NOT_CHAT = /(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct)/

export function createAnthropicClient(getSettings: () => Settings, getKey: () => string | null): ModelClient {
  return {
    async stream(request, callbacks) {
      const settings = getSettings()
      const apiKey = getKey()
      if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.')
      const client = new Anthropic({ apiKey, baseURL: settings.baseUrls.anthropic || ANTHROPIC_URL })
      const model = settings.models.anthropic
      const started = Date.now()
      let first = 0
      let tokens = 0
      let outputTokens = 0
      let promptTokens = 0
      let content = ''
      let stopped = false
      let stopReason: string | null = null
      let refusal: string | null = null

      const system = request.messages.find((m) => m.role === 'system')?.content
      const messages = request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      const fallback = FALLBACK_MODELS.test(model)
      const stream = client.beta.messages.stream({
        model,
        max_tokens: request.maxTokens,
        ...(system ? { system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }] } : {}),
        messages,
        ...(NO_EFFORT.test(model) ? {} : { output_config: { effort: settings.effort } }),
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {})
      } as unknown as Parameters<typeof client.beta.messages.stream>[0], { signal: request.signal })

      try {
        for await (const event of stream) {
          if (event.type === 'message_start') promptTokens = event.message.usage.input_tokens + (event.message.usage.cache_read_input_tokens ?? 0) + (event.message.usage.cache_creation_input_tokens ?? 0)
          if (event.type === 'message_delta') {
            outputTokens = event.usage.output_tokens
            stopReason = event.delta.stop_reason ?? stopReason
            refusal = (event.delta as { stop_details?: { explanation?: string } | null }).stop_details?.explanation ?? refusal
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            first ||= Date.now()
            tokens++
            callbacks.onProgress(tokens, tokens / Math.max((Date.now() - first) / 1000, 0.1))
            content += event.delta.text
            if (callbacks.onText(event.delta.text)) {
              stopped = true
              stream.abort()
              break
            }
          }
        }
      } catch (err) {
        if (stopped) {
          /* ending the stream early on purpose */
        } else if (request.signal.aborted) {
          throw new DOMException('Stopped', 'AbortError')
        } else if (err instanceof Anthropic.AuthenticationError) {
          throw new Error('Anthropic rejected the API key. Check it in Settings.')
        } else if (err instanceof Anthropic.RateLimitError) {
          throw new Error('Anthropic rate limit reached. Wait a moment and try again.')
        } else if (err instanceof Anthropic.NotFoundError) {
          throw new Error(`Anthropic does not recognize the model ${model}. Pick another in Settings.`)
        } else if (err instanceof Anthropic.APIConnectionError) {
          throw new Error('Could not reach Anthropic. Check your internet connection.')
        } else if (err instanceof Anthropic.APIError) {
          throw new Error(`Anthropic answered ${err.status}: ${err.message}`)
        } else throw err
      }

      if (stopReason === 'refusal') throw new Error(`The model declined this request.${refusal ? ` ${refusal}` : ''}`)
      if (stopReason === 'max_tokens') callbacks.onText('\n\n[The answer reached the output limit and was cut off.]')
      const finalTokens = outputTokens || tokens
      const result: ModelResult = {
        content,
        toolCalls: [],
        finishReason: stopReason,
        waitSeconds: ((first || Date.now()) - started) / 1000,
        tokens: finalTokens,
        tokensPerSecond: finalTokens / Math.max((Date.now() - (first || started)) / 1000, 0.1),
        promptTokens
      }
      return result
    }
  }
}

export function clientFor(getSettings: () => Settings, getKey: (provider: ProviderId) => string | null): ModelClient {
  const anthropic = createAnthropicClient(getSettings, () => getKey('anthropic'))
  const openAi = createOpenAiClient(() => {
    const settings = getSettings()
    const provider = settings.provider
    return {
      baseUrl: settings.baseUrls[provider],
      model: settings.models[provider],
      apiKey: provider === 'local' ? null : getKey(provider),
      // OpenAI's current models take a different limit field and no custom temperature.
      strictOpenAi: provider === 'openai',
      reasoningEffort: provider === 'openai' && settings.openaiEffort !== 'default' ? settings.openaiEffort : undefined
    }
  })
  return { stream: (request, callbacks) => (getSettings().provider === 'anthropic' ? anthropic : openAi).stream(request, callbacks) }
}

/** Limits that suit each kind of provider: local models are small, cloud models are not. */
export function effectiveSettings(settings: Settings): Settings {
  if (settings.provider === 'anthropic') return { ...settings, contextTokens: 150_000, maxOutputTokens: 64_000 }
  if (settings.provider === 'openai') return { ...settings, contextTokens: 100_000, maxOutputTokens: 16_000 }
  return settings
}

const MEMORY_LIMIT_GB = 9

/** Models already downloaded on this computer. Big ones get a warning: one crashed this kind of machine in testing. */
export function localModels(hub = path.join(os.homedir(), '.cache/huggingface/hub'), memoryGb = os.totalmem() / 1024 ** 3): ModelOption[] {
  let dirs: string[]
  try {
    dirs = fs.readdirSync(hub).filter((d) => d.startsWith('models--'))
  } catch {
    return []
  }
  const out: ModelOption[] = []
  for (const dir of dirs) {
    const id = dir.slice('models--'.length).replace('--', '/')
    if (!/mlx/i.test(id)) continue
    const snapshots = path.join(hub, dir, 'snapshots')
    let size = 0
    let hasConfig = false
    try {
      for (const snapshot of fs.readdirSync(snapshots)) {
        for (const file of fs.readdirSync(path.join(snapshots, snapshot))) {
          if (file === 'config.json') hasConfig = true
          if (file.endsWith('.safetensors')) size += fs.statSync(path.join(snapshots, snapshot, file)).size
        }
      }
    } catch {
      continue
    }
    if (!hasConfig || !size) continue
    const sizeGb = size / 1e9
    const tooBig = sizeGb > (memoryGb * MEMORY_LIMIT_GB) / 16
    out.push({ id, sizeGb, ...(tooBig ? { warning: `${sizeGb.toFixed(1)} GB is a lot for ${Math.round(memoryGb)} GB of memory. It may run slowly or freeze this computer.` } : {}) })
  }
  return out.sort((a, b) => (a.sizeGb ?? 0) - (b.sizeGb ?? 0))
}

export async function listModels(provider: ProviderId, settings: Settings, key: string | null): Promise<ModelOption[]> {
  if (provider === 'local') return localModels()
  if (provider === 'anthropic') {
    if (!key) throw new Error('Add your Anthropic API key first.')
    const client = new Anthropic({ apiKey: key, baseURL: settings.baseUrls.anthropic || ANTHROPIC_URL })
    const out: ModelOption[] = []
    try {
      for await (const model of client.models.list()) out.push({ id: model.id })
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected this API key. Check it, or remove it and paste it again.')
      if (error instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Anthropic. Check your connection and try again.")
      throw error
    }
    return out
  }
  const response = await fetch(`${settings.baseUrls[provider]}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15000)
  }).catch(() => {
    throw new Error(`Nothing answered at ${settings.baseUrls[provider]}. Check that the server is running and the address is right.`)
  })
  if (response.status === 401) throw new Error('The server rejected the API key.')
  if (!response.ok) throw new Error(`The server answered ${response.status} when listing models.`)
  const data = (await response.json()) as { data?: { id: string }[] }
  const ids = (data.data ?? []).map((m) => m.id)
  return (provider === 'openai' ? ids.filter((id) => CHAT_MODEL.test(id) && !NOT_CHAT.test(id)) : ids).sort().map((id) => ({ id }))
}
