import fs from 'node:fs'
import path from 'node:path'
import type { AgentMode } from '../shared/types'
import { TOOL_INSTRUCTIONS } from './protocol'
import { isProtected, readFileTool, safePath, walkFiles } from './tools'

const TREE_LIMIT = 200
const OS_NAME = process.platform === 'win32' ? 'Windows (commands run in cmd.exe)' : process.platform === 'darwin' ? 'macOS' : 'Linux'
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'add', 'make', 'fix', 'change', 'file', 'code', 'please', 'from', 'into', 'have', 'should', 'need', 'want', 'create', 'update', 'remove', 'when', 'then', 'not', 'are', 'but', 'can', 'all'])

export function projectTree(root: string): string {
  const files: string[] = []
  for (const rel of walkFiles(root)) {
    if (isProtected(root, rel)) continue
    files.push(rel)
    if (files.length > TREE_LIMIT) {
      files.pop()
      files.push('[More files not listed. Use list_files or search_code.]')
      break
    }
  }
  return files.join('\n')
}

/** Project instructions the user keeps in the repository. */
function projectRules(root: string): string {
  for (const name of ['PITOO.md', 'ANVIL.md', 'AGENTS.md']) {
    try {
      const text = fs.readFileSync(path.join(root, name), 'utf8').slice(0, 8000).trim()
      if (text) return `\n\nProject rules from ${name}:\n${text}`
    } catch {
      /* no such file */
    }
  }
  return ''
}

export const systemPrompt = (root: string): string => `You are Pitoo, a coding assistant working in a project on the user's Mac.
Project root: ${path.basename(root)}. All paths are relative to it.
The computer runs ${OS_NAME}, so write commands for that system.

Project files:
${projectTree(root)}

${TOOL_INSTRUCTIONS}

How to work:
- Read a file before changing it. Never guess what a file contains.
- Change only what the request needs. Follow the style and imports already used in the project.
- Use only packages listed in package.json. To add one, use run_command with npm install.
- When you finish changing code, run the build or tests with run_command, from the folder that has the package.json. Fix what they report.
- Do one step at a time and keep explanations short. When the work is done, say what you changed in a few lines.${projectRules(root)}`

const words = (text: string): string[] =>
  [...new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP.has(w)))]

/** Files most likely to matter for a request: names first, then contents. */
export function relatedFiles(root: string, request: string, limit = 5): string[] {
  const terms = words(request)
  if (!terms.length) return []
  const scored: { rel: string; score: number }[] = []
  for (const rel of walkFiles(root)) {
    if (isProtected(root, rel)) continue
    const name = rel.toLowerCase()
    let score = terms.reduce((n, t) => n + (name.includes(t) ? 5 : 0), 0)
    const file = path.join(root, rel)
    if (fs.statSync(file).size < 200_000) {
      const text = fs.readFileSync(file, 'utf8')
      if (!text.includes('\0')) {
        const lower = text.toLowerCase()
        score += terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0)
      }
    }
    if (score > 0) scored.push({ rel, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel)).slice(0, limit).map((s) => s.rel)
}

const MODE_NOTE: Record<AgentMode, string> = {
  agent: '',
  plan: '\n\n(Plan mode: read what you need, then write a short step-by-step plan. Do not change files or run commands.)',
  ask: '\n\n(Ask mode: answer directly without using any tool tags.)'
}

/** Files named with @path are attached to the message, so the model does not have to ask for them. */
export function attachedFiles(root: string, text: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []
  for (const m of text.matchAll(/(?:^|\s)@([\w./-]+)/g)) {
    try {
      const rel = safePath(root, m[1])
      if (!out.some((f) => f.path === rel)) out.push({ path: rel, content: readFileTool(root, rel) })
    } catch {
      /* not a file in this project, so it is just text */
    }
  }
  return out
}

export function buildUserMessage(root: string, text: string, activeFile: string | null, mode: AgentMode = 'agent'): string {
  const files = attachedFiles(root, text)
  const related = relatedFiles(root, text).filter((f) => f !== activeFile && !files.some((a) => a.path === f))
  const notes: string[] = []
  if (activeFile) notes.push(`The user has this file open: ${activeFile}`)
  if (related.length) notes.push(`Files that may be related: ${related.join(', ')}`)
  const attached = files.map((f) => `\n\nContents of ${f.path}:\n${f.content}`).join('')
  return `${text}${notes.length ? `\n\n(${notes.join('. ')})` : ''}${attached}${MODE_NOTE[mode]}`
}
