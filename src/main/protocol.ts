/**
 * The model server holds back native tool calls until they are complete, so nothing could be shown while
 * a file is being written. Tools are written as plain tags instead, which stream like any other text.
 */
export interface ParsedCall {
  name: string
  args: Record<string, unknown>
  raw: string
}

export const TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'list_files', 'search_code', 'run_command'] as const

export const TOOL_INSTRUCTIONS = `You change the project by writing tool tags in your reply. Write one tag, then stop and wait: the result comes in the next message.

<read_file path="src/app.ts"/>
Reads a file with line numbers. Long files come in parts; add start_line="401" for the next part.

<list_files path="src"/>
Lists a folder. Use path="." for the project root.

<search_code query="createUser"/>
Finds plain text in project files.

<write_file path="src/new.ts">
the complete file contents, with no code fences
</write_file>
Creates a file or replaces a whole file. Always send the complete contents, never placeholders.

<edit_file path="src/app.ts">
<old>the exact text to replace, which must appear once</old>
<new>the new text</new>
</edit_file>
Replaces one piece of text. Prefer this for small changes.

<run_command>npm test</run_command>
Runs a shell command in the project root, such as npm install, a build or tests. Never start servers that keep running. The user may have to approve it.`

const OPEN = new RegExp(`<(${TOOL_NAMES.join('|')})\\b`)
const LONGEST_NAME = Math.max(...TOOL_NAMES.map((n) => n.length)) + 1

function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g)) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

const dropEdgeNewlines = (text: string) => text.replace(/^\r?\n/, '').replace(/\r?\n$/, '')

/** A model sometimes wraps file contents in a code fence even when told not to. */
function dropFence(text: string): string {
  const m = text.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/)
  return m ? m[1] : text
}

function buildArgs(name: string, attrs: Record<string, string>, body: string): Record<string, unknown> {
  if (name === 'write_file') {
    const content = dropFence(dropEdgeNewlines(body))
    return { ...attrs, content: content.endsWith('\n') || !content ? content : `${content}\n` }
  }
  if (name === 'edit_file') {
    const old = body.match(/<old>([\s\S]*?)<\/old>/)
    const next = body.match(/<new>([\s\S]*?)<\/new>/)
    return { ...attrs, old_string: old ? dropEdgeNewlines(old[1]) : undefined, new_string: next ? dropEdgeNewlines(next[1]) : undefined }
  }
  if (name === 'run_command') return { ...attrs, command: attrs.command ?? body.trim() }
  return attrs
}

export interface ParserEvents {
  onText(delta: string): void
  onToolOpen(name: string, attrs: Record<string, string>): void
  onToolBody(delta: string): void
}

/** Reads streamed model text. Stops at the end of the first tool tag and returns it through `call`. */
export class ToolTagParser {
  call: ParsedCall | null = null
  private pending = ''
  private name: string | null = null
  private open = ''
  private attrs: Record<string, string> = {}
  private body = ''

  constructor(private events: ParserEvents) {}

  /** Returns true once a complete tool tag has arrived. */
  feed(delta: string): boolean {
    this.pending += delta
    while (!this.call) {
      if (this.name === null && !this.open) {
        if (!this.scanText()) return false
      } else if (this.name === null) {
        if (!this.scanOpen()) return false
      } else if (!this.scanBody()) return false
    }
    return true
  }

  /** The model finished. Whatever is left is text, or a tag it never closed. */
  finish(): void {
    if (this.call) return
    if (this.name !== null) {
      this.events.onToolBody(this.pending)
      this.body += this.pending
      this.complete()
    } else {
      const rest = this.open + this.pending
      if (rest) this.events.onText(rest)
    }
    this.pending = ''
    this.open = ''
  }

  private scanText(): boolean {
    const m = OPEN.exec(this.pending)
    if (m) {
      if (m.index) this.events.onText(this.pending.slice(0, m.index))
      this.open = m[0]
      this.pending = this.pending.slice(m.index + m[0].length)
      return true
    }
    // Hold back anything that could be the start of a tag still arriving.
    const lt = this.pending.lastIndexOf('<')
    const hold = lt >= 0 && this.pending.length - lt <= LONGEST_NAME ? lt : this.pending.length
    if (hold) this.events.onText(this.pending.slice(0, hold))
    this.pending = this.pending.slice(hold)
    return false
  }

  private scanOpen(): boolean {
    let quote = ''
    for (let i = 0; i < this.pending.length; i++) {
      const c = this.pending[i]
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') {
        const inner = this.pending.slice(0, i)
        this.pending = this.pending.slice(i + 1)
        const selfClosing = inner.trimEnd().endsWith('/')
        const name = this.open.slice(1)
        this.open = ''
        this.name = name
        this.attrs = parseAttrs(selfClosing ? inner.trimEnd().slice(0, -1) : inner)
        this.events.onToolOpen(name, this.attrs)
        if (selfClosing) this.complete()
        return true
      }
    }
    return false
  }

  private scanBody(): boolean {
    const close = `</${this.name}>`
    const at = this.pending.indexOf(close)
    if (at >= 0) {
      const part = this.pending.slice(0, at)
      if (part) this.events.onToolBody(part)
      this.body += part
      this.pending = this.pending.slice(at + close.length)
      this.complete()
      return true
    }
    const lt = this.pending.lastIndexOf('<')
    const hold = lt >= 0 && this.pending.length - lt < close.length ? lt : this.pending.length
    if (hold) {
      const part = this.pending.slice(0, hold)
      this.events.onToolBody(part)
      this.body += part
    }
    this.pending = this.pending.slice(hold)
    return false
  }

  private complete(): void {
    const name = this.name!
    const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')
    this.call = {
      name,
      args: buildArgs(name, this.attrs, this.body),
      raw: this.body ? `<${name}${attrs}>${this.body}</${name}>` : `<${name}${attrs}/>`
    }
  }
}
