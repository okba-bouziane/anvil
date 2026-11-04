import fs from 'node:fs'
import path from 'node:path'
import { killTree, spawnShell, toPosix } from './platform'

const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.angular', '.next', 'coverage', '.venv', '__pycache__', '.DS_Store'])
const READ_LIMIT_LINES = 400
const READ_LIMIT_CHARS = 16000
const OUTPUT_LIMIT = 12000
export const COMMAND_TIMEOUT_MS = 180_000

const ALIASES: Record<string, string> = {
  file_path: 'path', filepath: 'path', filePath: 'path', filename: 'path', file: 'path', dir: 'path', dirPath: 'path', directory: 'path',
  contents: 'content', text: 'content', file_content: 'content',
  old_str: 'old_string', oldString: 'old_string', search: 'old_string',
  new_str: 'new_string', newString: 'new_string', replace: 'new_string',
  cmd: 'command', pattern: 'query', startLine: 'start_line'
}

/** Small models often use a slightly wrong argument name, so accept the common ones. */
export function repairArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) out[ALIASES[key] ?? key] = value
  return out
}

/** Resolves a model-supplied path and refuses anything outside the project, including through symlinks. */
export function safePath(root: string, input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('A path is required')
  const realRoot = fs.realpathSync(root)
  let given = input.trim()
  if (given.startsWith('~/') || given === '~') throw new Error('Use a path relative to the project root, not ~')
  if (path.isAbsolute(given) && (given === root || given.startsWith(root + path.sep))) given = path.relative(root, given) || '.'
  if (process.platform === 'win32') given = given.replace(/\\/g, '/')
  const full = path.resolve(realRoot, given)
  let existing = full
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  const real = fs.realpathSync(existing)
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep)
  if (!inside(full) || !inside(real)) throw new Error(`${input} is outside the project`)
  return toPosix(path.relative(realRoot, full)) || '.'
}

export function assertWritable(rel: string): void {
  if (rel === '.git' || rel.startsWith('.git/')) throw new Error('.git cannot be changed with this tool')
}

export function readFileTool(root: string, rel: string, startLine = 1): string {
  const stat = fs.statSync(path.join(root, rel))
  if (stat.isDirectory()) throw new Error(`${rel} is a folder. Use list_files.`)
  if (stat.size > 2_000_000) throw new Error(`${rel} is too large to read (${stat.size} bytes)`)
  const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n')
  const from = Math.max(1, Math.floor(startLine))
  const out: string[] = []
  let chars = 0
  let last = from - 1
  for (let i = from - 1; i < lines.length && out.length < READ_LIMIT_LINES; i++) {
    const row = `${i + 1}\t${lines[i]}`
    if (chars + row.length > READ_LIMIT_CHARS && out.length) break
    out.push(row)
    chars += row.length + 1
    last = i + 1
  }
  if (last < lines.length) out.push(`[Lines ${from}-${last} of ${lines.length}. Call read_file with start_line ${last + 1} for more.]`)
  return out.join('\n')
}

const stripLineNumbers = (text: string) => (/^\d+\t/.test(text) ? text.replace(/^\d+\t/gm, '') : text)

/** Small models often change indentation or trailing spaces, or copy line numbers, when quoting code. */
function looseMatch(lines: string[], wanted: string[]): number[] {
  const norm = (l: string) => l.trim()
  const found: number[] = []
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (wanted.every((w, j) => norm(lines[i + j]) === norm(w))) found.push(i)
  }
  return found
}

/** Returns the new contents, or throws with a message the model can act on. */
export function applyEdit(current: string, oldString: unknown, newString: unknown): string {
  if (typeof oldString !== 'string' || !oldString) throw new Error('old_string is required')
  if (typeof newString !== 'string') throw new Error('new_string is required')
  const oldClean = stripLineNumbers(oldString)
  const newClean = stripLineNumbers(newString)
  if (oldClean === newClean) throw new Error('old_string and new_string are the same, so nothing would change')
  const first = current.indexOf(oldClean)
  if (first >= 0) {
    if (current.indexOf(oldClean, first + 1) >= 0) throw new Error('old_string appears more than once. Include more surrounding lines.')
    return current.slice(0, first) + newClean + current.slice(first + oldClean.length)
  }
  const lines = current.split('\n')
  const wanted = oldClean.split('\n')
  while (wanted.length > 1 && !wanted[wanted.length - 1].trim()) wanted.pop()
  const matches = looseMatch(lines, wanted)
  if (matches.length > 1) throw new Error('old_string appears more than once. Include more surrounding lines.')
  if (matches.length === 1) {
    lines.splice(matches[0], wanted.length, ...newClean.replace(/\n$/, '').split('\n'))
    return lines.join('\n')
  }
  const firstLine = wanted.find((l) => l.trim())?.trim() ?? ''
  const near = lines.findIndex((l) => l.trim() === firstLine)
  const hint = near >= 0 ? ` Its first line is at line ${near + 1}, but a later line differs. The file there says:\n${lines.slice(near, near + wanted.length).join('\n')}` : ' Read the file and copy the exact text.'
  throw new Error(`old_string was not found in the file.${hint}`)
}

export function listFilesTool(root: string, rel: string): string {
  const entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    .filter((e) => !IGNORED.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
  return entries.join('\n') || '(empty folder)'
}

export function* walkFiles(root: string, rel = '.'): Generator<string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(e.name) || e.isSymbolicLink()) continue
    const child = rel === '.' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) yield* walkFiles(root, child)
    else yield child
  }
}

export function searchTool(root: string, query: unknown): string {
  if (typeof query !== 'string' || !query) throw new Error('query is required')
  const out: string[] = []
  for (const rel of walkFiles(root)) {
    const file = path.join(root, rel)
    if (fs.statSync(file).size > 500_000) continue
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes('\0') || !text.includes(query)) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && out.length < 60; i++) {
      if (lines[i].includes(query)) out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
    }
    if (out.length >= 60) {
      out.push('[More matches not shown. Search for something more specific.]')
      break
    }
  }
  return out.join('\n') || 'No matches.'
}

export interface SearchOptions {
  caseSensitive: boolean
  regex: boolean
}

/** Project-wide search for the Search panel. */
export function searchProject(root: string, query: string, options: SearchOptions, limit = 500): { path: string; line: number; text: string }[] {
  if (!query) return []
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(source, options.caseSensitive ? '' : 'i')
  const out: { path: string; line: number; text: string }[] = []
  for (const rel of walkFiles(root)) {
    const file = path.join(root, rel)
    if (fs.statSync(file).size > 1_000_000) continue
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes('\0')) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        out.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 240) })
        if (out.length >= limit) return out
      }
    }
  }
  return out
}

/** Keeps the end of long output, where errors usually are. */
export function trimOutput(text: string, limit = OUTPUT_LIMIT): string {
  return text.length <= limit ? text : `[Earlier output not shown]\n${text.slice(-limit)}`
}

export interface CommandResult {
  code: number | null
  output: string
  timedOut: boolean
}

export function runCommand(cwd: string, command: string, signal: AbortSignal, timeoutMs = COMMAND_TIMEOUT_MS, onOutput?: (text: string) => void): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnShell(command, cwd, ['ignore', 'pipe', 'pipe'])
    let output = ''
    let timedOut = false
    const kill = () => killTree(child)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    signal.addEventListener('abort', kill, { once: true })
    const add = (data: Buffer) => {
      output = trimOutput(output + data.toString(), OUTPUT_LIMIT * 2)
      onOutput?.(data.toString())
    }
    child.stdout!.on('data', add)
    child.stderr!.on('data', add)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', kill)
      resolve({ code, output: trimOutput(output), timedOut })
    })
  })
}
