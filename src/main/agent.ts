import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMode, ApprovalAnswer, Settings, UiItem } from '../shared/types'
import type { ChangeTracker } from './changes'
import type { ChatMessage, ModelClient, ModelResult } from './model'
import { TOOL_NAMES, ToolTagParser, type ParsedCall } from './protocol'
import { buildUserMessage, systemPrompt } from './context'
import type { CheckResult } from './tscheck'
import { applyEdit, assertNotProtected, assertWritable, listFilesTool, readFileTool, repairArgs, runCommand, safePath, searchTool } from './tools'

const MAX_STEPS = 80
const MAX_REPEATS = 3
const MAX_CHECK_ROUNDS = 5

export interface AgentDeps {
  root: string
  tracker: ChangeTracker
  client: ModelClient
  settings: () => Settings
  emitItem(item: UiItem): void
  updateItem(id: string, patch: Partial<UiItem>): void
  textDelta(id: string, delta: string): void
  liveStats(tokens: number, tokensPerSecond: number, waiting: boolean): void
  changed(rel: string): void
  context?(tokens: number, limit: number): void
  askApproval(id: string, command: string): Promise<ApprovalAnswer>
  check(root: string, touched: string[]): CheckResult
  allowedCommands: Set<string>
  run?: typeof runCommand
}

const tokensIn = (messages: ChatMessage[]): number =>
  messages.reduce((n, m) => n + m.content.length / 3.2 + 8, 0)

const newId = () => randomUUID().slice(0, 8)
const RESULT = '[Result of '
const AUTO = '[Automatic check]'
const isTurnStart = (m: ChatMessage) => m.role === 'user' && !m.content.startsWith(RESULT) && !m.content.startsWith(AUTO)

export class Agent {
  history: ChatMessage[]
  private abort: AbortController | null = null
  private mode: AgentMode = 'agent'
  private steering: string[] = []

  constructor(private deps: AgentDeps, history?: ChatMessage[]) {
    this.history = history?.length ? history : [{ role: 'system', content: systemPrompt(deps.root) }]
  }

  cancel(): void {
    this.abort?.abort()
  }

  /** A message sent while the agent works. The model reads it before its next step. */
  steer(text: string): void {
    this.steering.push(text)
  }

  /** Drops the oldest whole turns, then the oldest tool steps, so the conversation fits the model. */
  private fit(): void {
    const limit = this.deps.settings().contextTokens
    const h = this.history
    if (tokensIn(h) <= limit) return
    // Removing anything makes a local model re-read the whole conversation, which takes minutes. Removing
    // a good amount at once means that happens rarely, not on every step.
    const target = limit * 0.65
    while (tokensIn(h) > target) {
      const turns = h.flatMap((m, i) => (isTurnStart(m) ? [i] : []))
      if (turns.length > 1) {
        h.splice(turns[0], turns[1] - turns[0])
        continue
      }
      const firstAssistant = h.findIndex((m) => m.role === 'assistant')
      if (firstAssistant < 0 || firstAssistant >= h.length - 2) break
      const end = h[firstAssistant + 1]?.content.startsWith(RESULT) ? firstAssistant + 2 : firstAssistant + 1
      h.splice(firstAssistant, end - firstAssistant)
    }
  }

  async runTurn(text: string, activeFile: string | null, mode: AgentMode = 'agent'): Promise<void> {
    const { deps } = this
    this.mode = mode
    this.abort = new AbortController()
    const signal = this.abort.signal
    const checkpointId = newId()
    deps.tracker.beginCheckpoint(checkpointId, text.slice(0, 80))
    this.history.push({ role: 'user', content: buildUserMessage(deps.root, text, activeFile, mode) })

    const touched = new Set<string>()
    const seen = new Map<string, string>()
    let repeats = 0
    let temperature = deps.settings().temperature
    let checkRounds = 0
    let lastErrors = ''
    let installAsked = false

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        for (const message of this.steering.splice(0)) this.history.push({ role: 'user', content: message })
        this.fit()
        deps.context?.(Math.round(tokensIn(this.history)), deps.settings().contextTokens)
        const { result, call, previewId } = await this.callModel(temperature, signal)
        temperature = deps.settings().temperature
        this.history.push({ role: 'assistant', content: call ? `${result.textBefore}${call.raw}` : result.content })

        if (!call) {
          if (this.steering.length) continue
          if (!result.content.trim()) {
            deps.emitItem({ kind: 'error', id: newId(), text: 'The model returned an empty answer.' })
            return
          }
          if (!touched.size) return
          const follow = this.afterEdits(touched, { round: checkRounds, lastErrors, installAsked })
          installAsked = follow.installAsked
          lastErrors = follow.lastErrors
          if (!follow.message) return
          checkRounds++
          this.history.push({ role: 'user', content: `${AUTO} ${follow.message}` })
          touched.clear()
          for (const rel of follow.files) touched.add(rel)
          continue
        }

        if (signal.aborted) throw new DOMException('Stopped', 'AbortError')
        const key = `${call.name}:${JSON.stringify(call.args)}`
        const earlier = seen.get(key)
        if (earlier !== undefined) {
          repeats++
          temperature = 0.7
          if (previewId) deps.emitItem({ kind: 'tool', id: previewId, name: call.name, summary: 'Repeated call, skipped', status: 'error' })
          this.toolResult(call, `You already made this exact call and nothing has changed since. Its result was: ${earlier}. Do something different, or finish and tell the user where you got stuck.`)
          if (repeats >= MAX_REPEATS) {
            deps.emitItem({ kind: 'error', id: newId(), text: 'I stopped this step because the model kept repeating the same action.' })
            return
          }
          continue
        }
        const { output, ok, wrote } = await this.execute(call, touched, signal, previewId)
        this.toolResult(call, output)
        if (wrote) seen.clear()
        seen.set(key, ok ? 'it succeeded' : `it failed (${output.slice(0, 200)})`)
      }
      deps.emitItem({ kind: 'error', id: newId(), text: `I stopped after ${MAX_STEPS} steps. Tell me to continue if you want more.` })
    } catch (err) {
      if ((err as Error).name === 'AbortError' || signal.aborted) deps.emitItem({ kind: 'note', id: newId(), text: 'Stopped.' })
      else deps.emitItem({ kind: 'error', id: newId(), text: friendlyError(err as Error) })
    } finally {
      this.abort = null
      deps.liveStats(0, 0, false)
      const done = deps.tracker.endCheckpoint()
      if (done) deps.emitItem({ kind: 'checkpoint', id: newId(), checkpointId: done.id })
    }
  }

  private toolResult(call: ParsedCall, content: string): void {
    this.history.push({ role: 'user', content: `${RESULT}${call.name}]\n${content}` })
  }

  private async callModel(temperature: number, signal: AbortSignal): Promise<{ result: ModelResult & { textBefore: string }; call: ParsedCall | null; previewId?: string }> {
    const { deps } = this
    const textId = newId()
    let textShown = false
    let textBefore = ''
    let previewId: string | undefined
    const parser = new ToolTagParser({
      onText: (delta) => {
        textBefore += delta
        if (!textShown) {
          if (!delta.trim()) return
          textShown = true
          deps.emitItem({ kind: 'assistant', id: textId, text: '' })
        }
        deps.textDelta(textId, delta)
      },
      onToolOpen: (name, attrs) => {
        previewId = newId()
        deps.emitItem({ kind: 'tool', id: previewId, name, summary: attrs.path ?? attrs.query ?? 'Writing…', status: 'running', output: '' })
      },
      onToolBody: (delta) => {
        if (previewId) deps.textDelta(previewId, delta)
      }
    })
    deps.liveStats(0, 0, true)
    const result = await deps.client.stream(
      { messages: this.history, temperature, maxTokens: deps.settings().maxOutputTokens, signal },
      { onText: (delta) => parser.feed(delta), onProgress: (tokens, speed) => deps.liveStats(tokens, speed, false) }
    )
    parser.finish()
    let call = parser.call
    const native = result.toolCalls[0]
    if (!call && native) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(native.function.arguments || '{}')
      } catch {
        /* execute() reports the missing arguments to the model */
      }
      call = { name: native.function.name, args, raw: `<${native.function.name}/>` }
    }
    const stats = { waitSeconds: result.waitSeconds, tokens: result.tokens, tokensPerSecond: result.tokensPerSecond, promptTokens: result.promptTokens }
    if (textShown) deps.updateItem(textId, { stats })
    else if (call) deps.emitItem({ kind: 'note', id: newId(), text: `${result.tokens} tokens at ${result.tokensPerSecond.toFixed(1)} tokens/s, first word after ${result.waitSeconds.toFixed(1)} s` })
    return { result: { ...result, textBefore }, call, previewId }
  }

  private async execute(call: ParsedCall, touched: Set<string>, signal: AbortSignal, previewId?: string): Promise<{ output: string; ok: boolean; wrote: boolean }> {
    const { deps } = this
    const name = call.name
    const itemId = previewId ?? newId()
    const args = repairArgs(call.args)
    const summary = String(args.path ?? args.query ?? args.command ?? '').slice(0, 120)
    deps.emitItem({ kind: 'tool', id: itemId, name, summary, status: 'running' })
    try {
      const { output, wrote } = await this.runTool(name, args, touched, signal, itemId)
      deps.updateItem(itemId, { status: 'ok', output: output.slice(0, 4000) } as Partial<UiItem>)
      return { output, ok: true, wrote }
    } catch (err) {
      const output = (err as Error).message
      deps.updateItem(itemId, { status: 'error', output } as Partial<UiItem>)
      if ((err as Error).name === 'AbortError') throw err
      return { output: `Error: ${output}`, ok: false, wrote: false }
    }
  }

  private write(rel: string, content: string, touched: Set<string>): void {
    const { deps } = this
    deps.tracker.write(rel, content)
    if (deps.settings().autoAcceptEdits) deps.tracker.acceptFile(rel)
    touched.add(rel)
    deps.changed(rel)
  }

  private async runTool(name: string, args: Record<string, unknown>, touched: Set<string>, signal: AbortSignal, itemId: string): Promise<{ output: string; wrote: boolean }> {
    const { root } = this.deps
    if (this.mode === 'ask') throw new Error('Tools are off in Ask mode. Answer directly.')
    if (this.mode === 'plan' && !['read_file', 'list_files', 'search_code'].includes(name)) throw new Error('Plan mode is read-only. Write the plan instead of changing anything.')
    switch (name) {
      case 'read_file': {
        const rel = safePath(root, args.path)
        assertNotProtected(root, rel)
        return { output: readFileTool(root, rel, Number(args.start_line) || 1), wrote: false }
      }
      case 'list_files':
        return { output: listFilesTool(root, safePath(root, args.path ?? '.')), wrote: false }
      case 'search_code':
        return { output: searchTool(root, args.query), wrote: false }
      case 'write_file': {
        const rel = safePath(root, args.path)
        assertWritable(rel)
        assertNotProtected(root, rel)
        if (typeof args.content !== 'string') throw new Error('content is required')
        const file = path.join(root, rel)
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === args.content) return { output: `${rel} already has exactly this content, so nothing changed.`, wrote: false }
        this.write(rel, args.content, touched)
        return { output: `Saved ${rel}.`, wrote: true }
      }
      case 'edit_file': {
        const rel = safePath(root, args.path)
        assertWritable(rel)
        assertNotProtected(root, rel)
        const current = fs.readFileSync(path.join(root, rel), 'utf8')
        this.write(rel, applyEdit(current, args.old_string, args.new_string), touched)
        return { output: `Edited ${rel}.`, wrote: true }
      }
      case 'run_command':
        return this.command(args.command, signal, itemId)
      default:
        throw new Error(`Unknown tool ${name}. Available tools: ${TOOL_NAMES.join(', ')}`)
    }
  }

  private async command(command: unknown, signal: AbortSignal, itemId: string): Promise<{ output: string; wrote: boolean }> {
    const { deps } = this
    if (typeof command !== 'string' || !command.trim()) throw new Error('command is required')
    if (!deps.settings().autoRunCommands && !deps.allowedCommands.has(command)) {
      const id = newId()
      deps.emitItem({ kind: 'approval', id, command, status: 'pending' })
      const answer = await deps.askApproval(id, command)
      deps.updateItem(id, { status: answer === 'deny' ? 'denied' : 'approved' } as Partial<UiItem>)
      if (answer === 'deny') return { output: 'The user declined this command. Do not run it again; continue without it or ask the user.', wrote: false }
      if (answer === 'always') deps.allowedCommands.add(command)
    }
    const result = await (deps.run ?? runCommand)(deps.root, command, signal, undefined, (text) => deps.textDelta(itemId, text))
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError')
    if (result.timedOut) throw new Error(`The command was still running after the time limit and was stopped. Do not start servers that never exit. Output so far:\n${result.output}`)
    if (result.code !== 0) throw new Error(`The command failed with exit code ${result.code}:\n${result.output}`)
    // A command can change files the review list cannot see, so the next read must not count as a repeat.
    return { output: result.output.trim() || 'The command finished with no output.', wrote: true }
  }

  private afterEdits(touched: Set<string>, state: { round: number; lastErrors: string; installAsked: boolean }): { message: string | null; files: string[]; lastErrors: string; installAsked: boolean } {
    const { deps } = this
    const files = [...touched]
    const none = { message: null, files, lastErrors: state.lastErrors, installAsked: state.installAsked }
    let result: CheckResult
    try {
      result = deps.check(deps.root, files)
    } catch (err) {
      deps.emitItem({ kind: 'check', id: newId(), ok: false, text: `The automatic check could not run: ${(err as Error).message}` })
      return none
    }
    for (const fix of result.fixedImports) this.write(fix.file, fix.content, touched)
    if (result.fixedCount) deps.emitItem({ kind: 'check', id: newId(), ok: true, text: `Added ${result.fixedCount} missing import${result.fixedCount > 1 ? 's' : ''} with TypeScript.` })

    if (!state.installAsked) {
      const missing = missingInstall(deps.root, files)
      if (missing) {
        const where = missing === '.' ? 'the project root' : missing
        return { ...none, installAsked: true, message: `package.json in ${where} has no node_modules, so the dependencies are not installed. Use run_command to run npm install${missing === '.' ? '' : ` in ${missing}`}.` }
      }
    }
    if (result.note) deps.emitItem({ kind: 'check', id: newId(), ok: false, text: result.note })
    if (!result.errors.length) {
      if (result.ran) deps.emitItem({ kind: 'check', id: newId(), ok: true, text: `TypeScript found no errors in ${files.length} changed file${files.length > 1 ? 's' : ''}.` })
      return none
    }
    const errors = result.errors.join('\n')
    const summary = `TypeScript found ${result.errors.length} error${result.errors.length > 1 ? 's' : ''}:\n${errors}`
    if (state.round >= MAX_CHECK_ROUNDS || errors === state.lastErrors) {
      deps.emitItem({ kind: 'check', id: newId(), ok: false, text: `${summary}\nThese are still there, so the work is not finished.` })
      return none
    }
    deps.emitItem({ kind: 'check', id: newId(), ok: false, text: `${summary}\nAsking the model to fix them (try ${state.round + 1} of ${MAX_CHECK_ROUNDS}).` })
    return { ...none, lastErrors: errors, message: `TypeScript found errors in the files you changed. Read the files if needed, then fix them.\n${errors}` }
  }
}

/** Finds the nearest package.json for changed files whose dependencies have not been installed. */
export function missingInstall(root: string, files: string[]): string | null {
  for (const rel of files) {
    let dir = path.dirname(rel)
    for (;;) {
      const full = path.join(root, dir)
      if (fs.existsSync(path.join(full, 'package.json'))) {
        if (!fs.existsSync(path.join(full, 'node_modules'))) return dir
        break
      }
      if (dir === '.') break
      dir = path.dirname(dir)
    }
  }
  return null
}

function friendlyError(err: Error): string {
  if (/fetch failed|ECONNREFUSED/.test(err.message)) return 'Could not reach the model. If it is a local model, press Start model. If it is a cloud model, check your internet connection.'
  return err.message
}
