import { execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModelStatus, Settings } from '../shared/types'
import { canRunMlx, killTree, spawnShell } from './platform'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelRequest {
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  signal: AbortSignal
}

export interface ModelCallbacks {
  /** Return true to end the answer here. */
  onText(delta: string): boolean
  onProgress(tokens: number, tokensPerSecond: number): void
}

export interface ModelResult {
  content: string
  toolCalls: ToolCall[]
  finishReason: string | null
  waitSeconds: number
  tokens: number
  tokensPerSecond: number
  promptTokens: number
}

export interface ModelClient {
  stream(request: ModelRequest, callbacks: ModelCallbacks): Promise<ModelResult>
}

export interface OpenAiConfig {
  baseUrl: string
  model: string
  apiKey: string | null
  strictOpenAi: boolean
}

/** Works with the local server, OpenAI and anything else that speaks the same API. */
export function createOpenAiClient(getConfig: () => OpenAiConfig): ModelClient {
  return {
    async stream(request, callbacks) {
      const config = getConfig()
      if (!config.model) throw new Error('Pick a model in Settings first.')
      const started = Date.now()
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        signal: request.signal,
        body: JSON.stringify({
          model: config.model,
          messages: request.messages,
          ...(config.strictOpenAi ? { max_completion_tokens: request.maxTokens } : { temperature: request.temperature, max_tokens: request.maxTokens }),
          stream: true,
          stream_options: { include_usage: true }
        })
      })
      if (response.status === 401) throw new Error('The server rejected the API key. Check it in Settings.')
      if (!response.ok || !response.body) throw new Error(`The model server answered ${response.status}: ${(await response.text()).slice(0, 300)}`)

      let content = ''
      let finishReason: string | null = null
      let first = 0
      let tokens = 0
      let usageTokens = 0
      let promptTokens = 0
      const calls = new Map<number, ToolCall>()
      const decoder = new TextDecoder()
      let buffer = ''

      let stop = false
      const handle = (data: string) => {
        const event = JSON.parse(data)
        if (event.usage) {
          usageTokens = event.usage.completion_tokens ?? usageTokens
          promptTokens = event.usage.prompt_tokens ?? promptTokens
        }
        for (const choice of event.choices ?? []) {
          finishReason = choice.finish_reason ?? finishReason
          const delta = choice.delta ?? {}
          if (delta.content || delta.tool_calls) {
            first ||= Date.now()
            tokens++
            callbacks.onProgress(tokens, tokens / Math.max((Date.now() - first) / 1000, 0.1))
          }
          if (delta.content) {
            content += delta.content
            if (callbacks.onText(delta.content)) stop = true
          }
          // A native call still arrives whole if the model uses its own format.
          for (const part of delta.tool_calls ?? []) {
            const index = part.index ?? calls.size
            const call = calls.get(index) ?? { id: part.id ?? `call_${index}`, type: 'function' as const, function: { name: '', arguments: '' } }
            call.function.name += part.function?.name ?? ''
            call.function.arguments += part.function?.arguments ?? ''
            calls.set(index, call)
          }
        }
      }

      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        let end: number
        while (!stop && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim()
          buffer = buffer.slice(end + 1)
          if (line.startsWith('data: ') && line !== 'data: [DONE]') handle(line.slice(6))
        }
        if (stop) break // ends the request, so the model stops generating
      }

      const finalTokens = usageTokens || tokens
      const seconds = Math.max((Date.now() - (first || started)) / 1000, 0.1)
      return {
        content,
        toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c),
        finishReason,
        waitSeconds: ((first || Date.now()) - started) / 1000,
        tokens: finalTokens,
        tokensPerSecond: finalTokens / seconds,
        promptTokens
      }
    }
  }
}

let starting = false
let server: ChildProcess | null = null

export async function modelStatus(settings: Settings, hasKey: boolean): Promise<ModelStatus> {
  if (settings.provider === 'anthropic' || settings.provider === 'openai') return hasKey ? 'online' : 'nokey'
  try {
    const response = await fetch(`${settings.baseUrls[settings.provider]}/models`, { signal: AbortSignal.timeout(1500) })
    if (response.ok) {
      starting = false
      return 'online'
    }
  } catch {
    /* not reachable */
  }
  return starting ? 'starting' : 'offline'
}

/** A login shell finds tools installed for the user, even when the app was opened from Finder. */
const SHELL_PATH = `PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export function portOf(baseUrl: string): number {
  try {
    return Number(new URL(baseUrl).port) || 8080
  } catch {
    return 8080
  }
}

export function serverCommand(model: string, port: number, totalMemory = os.totalmem()): string {
  const cacheBytes = Math.round(totalMemory * 0.3)
  return `${SHELL_PATH} HF_HUB_OFFLINE=1 exec mlx_lm.server --model ${shellQuote(model)} --host 127.0.0.1 --port ${port} --temp 0.2 --max-tokens 4096 --prompt-cache-size 4 --prompt-cache-bytes ${cacheBytes} --chat-template-args ${shellQuote('{"enable_thinking":false}')}`
}

function pidsOnPort(port: number): number[] {
  try {
    if (!canRunMlx()) return []
    return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/** Only ever stops a model server, never some other program that happens to use the port. */
function stopServerOnPort(port: number): void {
  for (const pid of pidsOnPort(port)) {
    const command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)]).toString()
    if (command.includes('mlx_lm')) process.kill(pid, 'SIGTERM')
  }
}

export function startModel(model: string, baseUrl: string, logFile: string): void {
  const port = portOf(baseUrl)
  stopServerOnPort(port)
  starting = true
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const log = fs.openSync(logFile, 'a')
  server = spawnShell(serverCommand(model, port), undefined, ['ignore', log, log])
  server.on('exit', () => { server = null; starting = false })
  server.unref()
  setTimeout(() => { starting = false }, 150_000).unref?.()
}

export function stopModel(baseUrl: string): void {
  starting = false
  if (server) killTree(server)
  stopServerOnPort(portOf(baseUrl))
}

/** A model the app started should not keep holding gigabytes of memory after the app quits. */
export function stopOwnServer(): void {
  if (server) killTree(server)
}

export function isServerInstalled(): boolean {
  try {
    execFileSync('/bin/zsh', ['-lc', `${SHELL_PATH} command -v mlx_lm.server`], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export const INSTALL_COMMAND = 'command -v uv >/dev/null || brew install uv; uv tool install --python 3.12 mlx-lm'
export const downloadCommand = (model: string) =>
  `${SHELL_PATH} "$(head -1 "$(command -v mlx_lm.server)" | cut -c3-)" -c ${shellQuote(`from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(model)})`)}`
