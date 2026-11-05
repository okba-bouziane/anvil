import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

/** A small client for language servers, the engines VS Code uses for most languages. */

export type LspKind = 'python' | 'angular'

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  message: string
  severity?: number
  code?: string | number
  source?: string
}

const require = createRequire(__filename)
// Packaged apps keep these servers outside the archive, because they start as separate programs.
const onDisk = (file: string) => file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)

interface ServerCommand {
  script: string
  args: string[]
}

export function serverCommand(kind: LspKind): ServerCommand {
  if (kind === 'python') return { script: onDisk(require.resolve('pyright/langserver.index.js')), args: ['--stdio'] }
  const tsDir = path.dirname(path.dirname(onDisk(require.resolve('typescript/package.json'))))
  const ngDir = path.dirname(path.dirname(path.dirname(onDisk(require.resolve('@angular/language-service/package.json')))))
  return {
    script: onDisk(require.resolve('@angular/language-server/index.js')),
    args: ['--stdio', '--tsProbeLocations', tsDir, '--ngProbeLocations', ngDir, '--includeCompletionsWithSnippetText', '--includeAutomaticOptionalChainCompletions']
  }
}

export const toUri = (root: string, rel: string) => pathToFileURL(path.join(root, rel)).href

export function fromUri(root: string, uri: string): string | null {
  if (!uri.startsWith('file:')) return null
  const rel = path.relative(fs.realpathSync(root), fs.existsSync(fileURLToPath(uri)) ? fs.realpathSync(fileURLToPath(uri)) : fileURLToPath(uri))
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/')
}

/** The Python to analyze against. A project's own environment runs only if you trust the project. */
export function pythonFor(root: string, trusted: boolean): string | null {
  if (!trusted) return null
  for (const dir of ['.venv', 'venv', 'env']) {
    for (const bin of ['bin/python', 'Scripts/python.exe']) {
      const file = path.join(root, dir, bin)
      if (fs.existsSync(file)) return file
    }
  }
  return null
}

export class LspClient {
  private child: ChildProcess | null = null
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private ready: Promise<void> | null = null
  private versions = new Map<string, number>()
  capabilities: Record<string, unknown> = {}

  constructor(
    private kind: LspKind,
    private root: string,
    private python: string | null,
    private onDiagnostics: (rel: string, list: LspDiagnostic[]) => void,
    private onExit: () => void
  ) {}

  start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = this.launch()
    return this.ready
  }

  private async launch(): Promise<void> {
    const { script, args } = serverCommand(this.kind)
    const child = spawn(process.execPath, [script, ...args], {
      cwd: this.root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
    this.child = child
    child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk))
    child.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('The language server stopped.'))
      this.pending.clear()
      this.child = null
      this.onExit()
    })
    child.on('error', () => {})
    child.stdin!.on('error', () => {})
    const rootUri = pathToFileURL(this.root).href
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      initializationOptions: {},
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, applyEdit: false, workspaceEdit: { documentChanges: true }, didChangeWatchedFiles: { dynamicRegistration: false } },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail'] }, insertReplaceSupport: false } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
          definition: {},
          references: {},
          rename: { prepareSupport: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true }
        },
        window: { workDoneProgress: false }
      }
    }) as { capabilities: Record<string, unknown> }
    this.capabilities = result.capabilities ?? {}
    this.notify('initialized', {})
    if (this.kind === 'python') this.notify('workspace/didChangeConfiguration', { settings: {} })
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const length = Number(this.buffer.subarray(0, headerEnd).toString().match(/Content-Length: (\d+)/i)?.[1] ?? -1)
      if (length < 0 || this.buffer.length < headerEnd + 4 + length) return
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()
      this.buffer = this.buffer.subarray(headerEnd + 4 + length)
      try {
        this.handle(JSON.parse(body))
      } catch {
        /* a message we can't read shouldn't stop the others */
      }
    }
  }

  private handle(message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
    if (message.method && message.id !== undefined) return this.answer(message.id, message.method, message.params)
    if (message.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = message.params as { uri: string; diagnostics: LspDiagnostic[] }
      const rel = fromUri(this.root, uri)
      if (rel) this.onDiagnostics(rel, diagnostics)
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending?.reject(new Error(message.error.message))
      else pending?.resolve(message.result)
    }
  }

  /** Servers ask the client questions too. */
  private answer(id: number, method: string, params: unknown): void {
    let result: unknown = null
    if (method === 'workspace/configuration') {
      const items = (params as { items: { section?: string }[] }).items
      result = items.map(({ section }) => {
        if (section === 'python') return this.python ? { pythonPath: this.python } : {}
        if (section === 'python.analysis') return { typeCheckingMode: 'basic', diagnosticMode: 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true }
        return {}
      })
    } else if (method === 'workspace/workspaceFolders') {
      result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }]
    }
    this.write({ jsonrpc: '2.0', id, result })
  }

  private write(message: unknown): void {
    if (!this.child?.stdin?.writable) return
    const body = Buffer.from(JSON.stringify(message))
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.child.stdin.write(body)
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  request(method: string, params: unknown, timeout = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} took too long`))
      }, timeout)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  async open(rel: string, languageId: string, text: string): Promise<void> {
    await this.start()
    const uri = toUri(this.root, rel)
    if (this.versions.has(rel)) return this.change(rel, text)
    this.versions.set(rel, 1)
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } })
  }

  async change(rel: string, text: string): Promise<void> {
    await this.start()
    const version = (this.versions.get(rel) ?? 0) + 1
    this.versions.set(rel, version)
    this.notify('textDocument/didChange', { textDocument: { uri: toUri(this.root, rel), version }, contentChanges: [{ text }] })
  }

  close(rel: string): void {
    if (!this.versions.delete(rel)) return
    this.notify('textDocument/didClose', { textDocument: { uri: toUri(this.root, rel) } })
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (!child) return
    this.notify('shutdown', null)
    child.kill()
  }
}

/** Whether a folder tree has an Angular app in it. Only reads package.json files. */
export function hasAngular(packages: { text: string }[]): boolean {
  return packages.some((p) => {
    try {
      const pkg = JSON.parse(p.text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      return '@angular/core' in { ...pkg.dependencies, ...pkg.devDependencies }
    } catch {
      return false
    }
  })
}
