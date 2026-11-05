import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { DebugConfig, DebugEvent } from '../shared/types'

/**
 * Speaks the Debug Adapter Protocol, the same one VS Code uses. JavaScript and TypeScript run on Microsoft's
 * js-debug, and Python on debugpy. A session can have children: js-debug gives each process or page its own.
 */

type Message = { seq?: number; type: string; command?: string; event?: string; request_seq?: number; success?: boolean; message?: string; body?: Record<string, unknown>; arguments?: Record<string, unknown> }

class Channel {
  private seq = 1
  private buffer = Buffer.alloc(0)
  private pending = new Map<number, { resolve(body: Record<string, unknown>): void; reject(e: Error): void }>()
  onEvent: (event: string, body: Record<string, unknown>) => void = () => {}
  onRequest: (command: string, args: Record<string, unknown>, reply: (body?: Record<string, unknown>) => void) => void = () => {}
  onClose: () => void = () => {}

  constructor(input: Readable, private output: Writable) {
    input.on('data', (chunk: Buffer) => this.receive(chunk))
    input.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('The debugger stopped.'))
      this.pending.clear()
      this.onClose()
    })
    input.on('error', () => {})
    output.on('error', () => {})
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const length = Number(this.buffer.subarray(0, end).toString().match(/Content-Length: (\d+)/i)?.[1] ?? -1)
      if (length < 0 || this.buffer.length < end + 4 + length) return
      const text = this.buffer.subarray(end + 4, end + 4 + length).toString()
      this.buffer = this.buffer.subarray(end + 4 + length)
      this.dispatch(JSON.parse(text) as Message)
    }
  }

  private dispatch(m: Message): void {
    if (m.type === 'event') return this.onEvent(m.event!, m.body ?? {})
    if (m.type === 'request') {
      return this.onRequest(m.command!, m.arguments ?? {}, (body) => this.write({ type: 'response', request_seq: m.seq, success: true, command: m.command, body }))
    }
    if (m.type === 'response') {
      const pending = this.pending.get(m.request_seq!)
      this.pending.delete(m.request_seq!)
      if (m.success) pending?.resolve(m.body ?? {})
      else pending?.reject(new Error(m.message ?? 'The debugger refused that.'))
    }
  }

  private write(message: Message): void {
    const body = Buffer.from(JSON.stringify({ seq: this.seq++, ...message }))
    if (!this.output.writable) return
    this.output.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.output.write(body)
  }

  request(command: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const seq = this.seq
      this.pending.set(seq, { resolve, reject })
      this.write({ type: 'request', command, arguments: args })
    })
  }
}

interface Session {
  id: number
  channel: Channel
  socket?: net.Socket
  capabilities: Record<string, unknown>
}

export interface BreakpointSpec {
  line: number
  condition?: string
}

export function pythonHasDebugpy(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(python, ['-m', 'debugpy', '--version'], { timeout: 8000 }, (err) => resolve(!err))
  })
}

export class Debugger {
  private adapter: ChildProcess | null = null
  private port = 0
  private sessions = new Map<number, Session>()
  private nextId = 1
  private breakpoints = new Map<string, BreakpointSpec[]>()
  private stoppedSession: Session | null = null
  private ended = false

  constructor(
    private root: string,
    private jsDebugDir: string,
    private emit: (event: DebugEvent) => void
  ) {}

  private launchArguments(config: DebugConfig): Record<string, unknown> {
    if (config.kind === 'raw') return config.raw ?? {}
    const shared = { cwd: config.cwd ? path.join(this.root, config.cwd) : this.root, __workspaceFolder: this.root }
    if (config.kind === 'node-file') return { ...shared, type: 'pwa-node', request: 'launch', name: config.name, program: path.join(this.root, config.file!), console: 'internalConsole', outputCapture: 'std', sourceMaps: true, skipFiles: ['<node_internals>/**'], runtimeExecutable: 'node' }
    if (config.kind === 'npm') return { ...shared, type: 'pwa-node', request: 'launch', name: config.name, runtimeExecutable: 'npm', runtimeArgs: ['run', config.script!], console: 'internalConsole', outputCapture: 'std', sourceMaps: true, skipFiles: ['<node_internals>/**'] }
    if (config.kind === 'node-attach') return { ...shared, type: 'pwa-node', request: 'attach', name: config.name, port: config.port, sourceMaps: true, skipFiles: ['<node_internals>/**'] }
    if (config.kind === 'chrome') return { ...shared, type: 'pwa-chrome', request: 'launch', name: config.name, url: config.url, webRoot: config.cwd ? path.join(this.root, config.cwd) : this.root, sourceMaps: true }
    return { ...shared, type: 'python', request: 'launch', name: config.name, program: path.join(this.root, config.file!), console: 'internalConsole', redirectOutput: true, justMyCode: true, python: [config.python ?? 'python3'] }
  }

  async start(config: DebugConfig, breakpoints: Record<string, BreakpointSpec[]>): Promise<void> {
    this.breakpoints = new Map(Object.entries(breakpoints))
    const args = this.launchArguments(config)
    this.emit({ kind: 'state', state: 'starting', name: config.name })
    if (args.type === 'python') {
      const python = config.python ?? 'python3'
      if (!(await pythonHasDebugpy(python))) throw new Error(`Python debugging needs debugpy. Install it with: ${python} -m pip install debugpy`)
      const adapter = spawn(python, ['-m', 'debugpy.adapter'], { cwd: this.root, stdio: ['pipe', 'pipe', 'ignore'] })
      this.adapter = adapter
      adapter.on('error', () => this.finish())
      const session: Session = { id: this.nextId++, channel: new Channel(adapter.stdout!, adapter.stdin!), capabilities: {} }
      await this.attachSession(session, args, (args.request as string) ?? 'launch')
      return
    }
    await this.startJsDebug()
    await this.openSession(args)
  }

  private startJsDebug(): Promise<void> {
    return new Promise((resolve, reject) => {
      const adapter = spawn(process.execPath, [path.join(this.jsDebugDir, 'src/dapDebugServer.js'), '0', '127.0.0.1'], {
        cwd: this.root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.adapter = adapter
      adapter.on('error', reject)
      adapter.on('exit', () => this.finish())
      const onData = (chunk: Buffer) => {
        const port = chunk.toString().match(/listening at [^\s:]+:(\d+)/)?.[1]
        if (port) {
          this.port = Number(port)
          resolve()
        }
      }
      adapter.stdout!.on('data', onData)
      adapter.stderr!.on('data', onData)
      setTimeout(() => reject(new Error('The JavaScript debugger did not start.')), 15000).unref()
    })
  }

  private openSession(args: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, '127.0.0.1')
      socket.once('error', reject)
      socket.once('connect', () => {
        const session: Session = { id: this.nextId++, channel: new Channel(socket, socket), socket, capabilities: {} }
        this.attachSession(session, args, (args.request as string) ?? 'launch').then(resolve, reject)
      })
    })
  }

  private async attachSession(session: Session, args: Record<string, unknown>, request: string): Promise<void> {
    this.sessions.set(session.id, session)
    const { channel } = session
    channel.onEvent = (event, body) => this.onEvent(session, event, body)
    channel.onRequest = (command, requestArgs, reply) => {
      if (command === 'startDebugging') {
        reply({})
        // A child: the actual process or page. It gets its own connection and its own breakpoints.
        void this.openSession((requestArgs.configuration ?? {}) as Record<string, unknown>).catch((e: Error) => this.emit({ kind: 'output', category: 'stderr', text: `${e.message}\n` }))
      } else reply({})
    }
    channel.onClose = () => {
      this.sessions.delete(session.id)
      if (!this.sessions.size) this.finish()
    }
    let ready: () => void = () => {}
    const initialized = new Promise<void>((resolve) => { ready = resolve })
    const previous = channel.onEvent
    channel.onEvent = (event, body) => {
      if (event === 'initialized') ready()
      previous(event, body)
    }
    session.capabilities = await channel.request('initialize', {
      clientID: 'pitoo',
      clientName: 'Pitoo',
      adapterID: String(args.type ?? 'pwa-node'),
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
      locale: 'en'
    })
    // Launch answers only after configuration is done, so it isn't awaited here.
    const launched = channel.request(request === 'attach' ? 'attach' : 'launch', args)
    launched.catch((e: Error) => this.emit({ kind: 'output', category: 'stderr', text: `${e.message}\n` }))
    await Promise.race([initialized, launched.then(() => undefined, () => undefined)])
    await Promise.all([...this.breakpoints.keys()].map((rel) => this.sendBreakpoints(session, rel)))
    if (session.capabilities.supportsConfigurationDoneRequest !== false) await channel.request('configurationDone').catch(() => {})
    this.emit({ kind: 'state', state: 'running' })
  }

  private onEvent(session: Session, event: string, body: Record<string, unknown>): void {
    if (event === 'stopped') {
      this.stoppedSession = session
      void this.reportStop(session, body)
    } else if (event === 'continued') {
      this.emit({ kind: 'state', state: 'running' })
    } else if (event === 'output') {
      if (body.category !== 'telemetry') this.emit({ kind: 'output', category: String(body.category ?? 'console'), text: String(body.output ?? '') })
    } else if (event === 'terminated') {
      // One process finishing doesn't end the run. The run ends when nothing is left.
      void session.channel.request('disconnect', {}).catch(() => {})
      session.socket?.destroy()
      this.sessions.delete(session.id)
      if (this.stoppedSession === session) this.stoppedSession = null
      if (!this.sessions.size) this.finish()
    } else if (event === 'breakpoint') {
      this.emit({ kind: 'breakpoint-changed' })
    }
  }

  private toRel(file: unknown): string | null {
    if (typeof file !== 'string' || !file) return null
    const rel = path.relative(this.root, file)
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/')
  }

  private async reportStop(session: Session, body: Record<string, unknown>): Promise<void> {
    const threadId = Number(body.threadId ?? 0)
    const trace = await session.channel.request('stackTrace', { threadId, startFrame: 0, levels: 50 }).catch(() => ({ stackFrames: [] as unknown[] }))
    const frames = (trace.stackFrames as { id: number; name: string; line: number; column: number; source?: { path?: string; name?: string } }[]).map((f) => ({
      id: f.id, name: f.name, line: f.line, column: f.column, path: this.toRel(f.source?.path), source: f.source?.name ?? f.source?.path ?? ''
    }))
    this.emit({ kind: 'state', state: 'paused', threadId, reason: String(body.reason ?? 'pause'), description: body.text ? String(body.text) : undefined, frames })
  }

  private sendBreakpoints(session: Session, rel: string): Promise<unknown> {
    const list = this.breakpoints.get(rel) ?? []
    return session.channel.request('setBreakpoints', {
      source: { path: path.join(this.root, rel), name: path.basename(rel) },
      breakpoints: list.map((b) => ({ line: b.line, condition: b.condition || undefined })),
      lines: list.map((b) => b.line),
      sourceModified: false
    }).catch(() => {})
  }

  async setBreakpoints(rel: string, list: BreakpointSpec[]): Promise<void> {
    this.breakpoints.set(rel, list)
    await Promise.all([...this.sessions.values()].map((s) => this.sendBreakpoints(s, rel)))
  }

  private target(): Session | null {
    return this.stoppedSession ?? [...this.sessions.values()].at(-1) ?? null
  }

  async control(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause', threadId: number): Promise<void> {
    const session = this.target()
    if (!session) return
    if (action !== 'pause') this.emit({ kind: 'state', state: 'running' })
    await session.channel.request(action, { threadId })
  }

  async scopes(frameId: number): Promise<{ name: string; variablesReference: number; expensive?: boolean }[]> {
    const body = await this.target()?.channel.request('scopes', { frameId })
    return (body?.scopes ?? []) as { name: string; variablesReference: number; expensive?: boolean }[]
  }

  async variables(reference: number): Promise<{ name: string; value: string; type?: string; variablesReference: number }[]> {
    const body = await this.target()?.channel.request('variables', { variablesReference: reference })
    return (body?.variables ?? []) as { name: string; value: string; type?: string; variablesReference: number }[]
  }

  async evaluate(expression: string, frameId: number | null, context: 'watch' | 'repl'): Promise<{ result: string; variablesReference: number }> {
    const body = await this.target()?.channel.request('evaluate', { expression, frameId: frameId ?? undefined, context })
    return { result: String(body?.result ?? ''), variablesReference: Number(body?.variablesReference ?? 0) }
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    for (const s of this.sessions.values()) s.socket?.destroy()
    this.sessions.clear()
    this.adapter?.kill()
    this.adapter = null
    this.emit({ kind: 'state', state: 'stopped' })
  }

  async stop(): Promise<void> {
    for (const s of [...this.sessions.values()].reverse()) {
      await Promise.race([s.channel.request('disconnect', { terminateDebuggee: true }).catch(() => {}), new Promise((r) => setTimeout(r, 800))])
    }
    this.finish()
  }
}
