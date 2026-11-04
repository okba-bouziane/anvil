import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type TS from 'typescript'
import type { IntelCompletion, IntelDiagnostic, IntelEdit, IntelLocation, IntelSymbol } from '../shared/types'
import { findTsconfig } from './tscheck'
import { toPosix } from './platform'

const SUPPORTED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SKIP_DIR = /(^|\/)(node_modules|dist|out|build|\.git|\.angular|coverage)(\/|$)/
const MAX_PROBLEMS = 500

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

interface Project {
  ts: typeof TS
  service: TS.LanguageService
  files: () => string[]
  dir: string
}

/**
 * The same engine VS Code uses for TypeScript and JavaScript. It runs in a worker thread, because building
 * a project can take seconds and must not hold up the app. It uses the project's own TypeScript if there is one.
 */
export class Intel {
  private overlays = new Map<string, { text: string; version: number }>()
  private projects = new Map<string, Project>()
  private generation = 0

  constructor(private root: string, private bundled: typeof TS) {}

  private abs(rel: string): string {
    return toPosix(path.join(this.root, rel))
  }

  private rel(file: string): string {
    return toPosix(path.relative(this.root, file))
  }

  private loadTs(from: string): typeof TS {
    try {
      return createRequire(path.join(from, 'package.json'))('typescript') as typeof TS
    } catch {
      return this.bundled
    }
  }

  private projectFor(rel: string): Project {
    const tsconfig = findTsconfig(this.root, rel)
    const key = tsconfig ?? this.root
    const existing = this.projects.get(key)
    if (existing) return existing
    const dir = tsconfig ? path.dirname(tsconfig) : this.root
    const ts = this.loadTs(dir)
    const read = (): TS.ParsedCommandLine => {
      if (tsconfig) return ts.parseJsonConfigFileContent(ts.readConfigFile(tsconfig, ts.sys.readFile).config ?? {}, ts.sys, dir)
      // A folder with no tsconfig still gets help, without complaining about its loose scripts.
      return { options: { allowJs: true, checkJs: false, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, esModuleInterop: true, skipLibCheck: true }, fileNames: [], errors: [] }
    }
    let parsed = read()
    let seen = this.generation
    const current = () => {
      if (seen !== this.generation) {
        parsed = read()
        seen = this.generation
      }
      return parsed
    }
    const inScope = (f: string) => !tsconfig || toPosix(f).startsWith(toPosix(dir))
    const readFile = (f: string) => this.overlays.get(toPosix(f))?.text ?? ts.sys.readFile(f)
    const service = ts.createLanguageService({
      getScriptFileNames: () => [...new Set([...current().fileNames.map(toPosix), ...[...this.overlays.keys()].filter(inScope)])],
      getScriptVersion: (f) => {
        const overlay = this.overlays.get(toPosix(f))
        if (overlay) return `o${overlay.version}`
        if (f.includes('/node_modules/')) return '0'
        try {
          return String(fs.statSync(f).mtimeMs)
        } catch {
          return 'gone'
        }
      },
      getScriptSnapshot: (f) => {
        const text = readFile(f)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => dir,
      getCompilationSettings: () => ({ ...current().options, noEmit: true }),
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => this.overlays.has(toPosix(f)) || ts.sys.fileExists(f),
      readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
    })
    const project: Project = { ts, service, dir, files: () => current().fileNames.map(toPosix) }
    this.projects.set(key, project)
    return project
  }

  private text(file: string): string {
    return this.overlays.get(file)?.text ?? fs.readFileSync(file, 'utf8')
  }

  private offset(_ts: typeof TS, text: string, line: number, column: number): number {
    const starts = lineStarts(text)
    return (starts[Math.min(line - 1, starts.length - 1)] ?? 0) + column - 1
  }

  private position(_ts: typeof TS, text: string, offset: number): { line: number; column: number } {
    const starts = lineStarts(text)
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return { line: low + 1, column: offset - starts[low] + 1 }
  }

  update(rel: string, text: string): void {
    const file = this.abs(rel)
    const old = this.overlays.get(file)
    this.overlays.set(file, { text, version: (old?.version ?? 0) + 1 })
  }

  close(rel: string): void {
    this.overlays.delete(this.abs(rel))
  }

  /** Files were created, renamed or deleted, so each project's file list has to be read again. */
  filesChanged(): void {
    this.generation++
  }

  private toDiagnostics(ts: typeof TS, list: readonly TS.Diagnostic[], rel: string, text: string): IntelDiagnostic[] {
    return list.flatMap((d) => {
      if (d.start === undefined || d.category === ts.DiagnosticCategory.Suggestion || d.category === ts.DiagnosticCategory.Message) return []
      const start = this.position(ts, text, d.start)
      const end = this.position(ts, text, d.start + (d.length ?? 1))
      return [{
        path: rel,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        code: d.code,
        severity: d.category === ts.DiagnosticCategory.Error ? 'error' as const : 'warning' as const
      }]
    })
  }

  diagnostics(rel: string): IntelDiagnostic[] {
    if (!SUPPORTED.test(rel)) return []
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    return this.toDiagnostics(ts, [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)], rel, this.text(file))
  }

  /** Every problem in a project, for the Problems panel. */
  projectProblems(rel: string): IntelDiagnostic[] {
    const { ts, service, files } = this.projectFor(rel)
    const out: IntelDiagnostic[] = []
    for (const file of files()) {
      if (out.length >= MAX_PROBLEMS) break
      const name = this.rel(file)
      if (SKIP_DIR.test(name) || name.startsWith('..') || !SUPPORTED.test(name)) continue
      out.push(...this.toDiagnostics(ts, [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)], name, this.text(file)))
    }
    return out.slice(0, MAX_PROBLEMS)
  }

  completions(rel: string, line: number, column: number): IntelCompletion[] {
    if (!SUPPORTED.test(rel)) return []
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    const text = this.text(file)
    const at = this.offset(ts, text, line, column)
    const result = service.getCompletionsAtPosition(file, at, { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true })
    // There can be thousands of names, so send only those matching what has been typed.
    const typed = text.slice(0, at).match(/[\w$]*$/)?.[0].toLowerCase() ?? ''
    return (result?.entries ?? []).filter((e) => e.name.toLowerCase().includes(typed)).slice(0, 400).map((e) => ({ name: e.name, kind: e.kind, sortText: e.sortText, source: e.source, data: e.data, insertText: e.insertText }))
  }

  completionDetail(rel: string, line: number, column: number, entry: IntelCompletion): { detail: string; docs: string; edits: IntelEdit[] } | null {
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    const at = this.offset(ts, this.text(file), line, column)
    const d = service.getCompletionEntryDetails(file, at, entry.name, {}, entry.source, {}, entry.data as TS.CompletionEntryData | undefined)
    if (!d) return null
    const edits = (d.codeActions ?? []).flatMap((a) => a.changes.filter((c) => c.fileName === file).flatMap((c) => c.textChanges)).map((c) => this.toEdit(ts, rel, file, c))
    return { detail: ts.displayPartsToString(d.displayParts), docs: ts.displayPartsToString(d.documentation), edits }
  }

  private toEdit(ts: typeof TS, rel: string, file: string, change: TS.TextChange): IntelEdit {
    const text = this.text(file)
    const start = this.position(ts, text, change.span.start)
    const end = this.position(ts, text, change.span.start + change.span.length)
    return { path: rel, line: start.line, column: start.column, endLine: end.line, endColumn: end.column, text: change.newText }
  }

  hover(rel: string, line: number, column: number): { signature: string; docs: string } | null {
    if (!SUPPORTED.test(rel)) return null
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    const info = service.getQuickInfoAtPosition(file, this.offset(ts, this.text(file), line, column))
    return info ? { signature: ts.displayPartsToString(info.displayParts), docs: ts.displayPartsToString(info.documentation) } : null
  }

  private toLocations(ts: typeof TS, spans: readonly { fileName: string; textSpan: TS.TextSpan }[]): IntelLocation[] {
    return spans.flatMap((s) => {
      const name = this.rel(toPosix(s.fileName))
      if (name.startsWith('..')) return [] // outside the project, such as TypeScript's own library files
      const text = this.text(toPosix(s.fileName))
      const start = this.position(ts, text, s.textSpan.start)
      const end = this.position(ts, text, s.textSpan.start + s.textSpan.length)
      return [{ path: name, line: start.line, column: start.column, endLine: end.line, endColumn: end.column }]
    })
  }

  definition(rel: string, line: number, column: number): IntelLocation[] {
    if (!SUPPORTED.test(rel)) return []
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    return this.toLocations(ts, service.getDefinitionAtPosition(file, this.offset(ts, this.text(file), line, column)) ?? [])
  }

  references(rel: string, line: number, column: number): IntelLocation[] {
    if (!SUPPORTED.test(rel)) return []
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    return this.toLocations(ts, service.getReferencesAtPosition(file, this.offset(ts, this.text(file), line, column)) ?? [])
  }

  rename(rel: string, line: number, column: number, name: string): IntelEdit[] | { error: string } {
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    const at = this.offset(ts, this.text(file), line, column)
    const info = service.getRenameInfo(file, at, {})
    if (!info.canRename) return { error: info.localizedErrorMessage }
    return (service.findRenameLocations(file, at, false, false, {}) ?? []).flatMap((l) => {
      const target = this.rel(toPosix(l.fileName))
      if (target.startsWith('..') || target.includes('node_modules/')) return []
      return [this.toEdit(ts, target, toPosix(l.fileName), { span: l.textSpan, newText: `${l.prefixText ?? ''}${name}${l.suffixText ?? ''}` })]
    })
  }

  format(rel: string, tabSize: number): IntelEdit[] {
    if (!SUPPORTED.test(rel)) return []
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    return service.getFormattingEditsForDocument(file, { indentSize: tabSize, tabSize, convertTabsToSpaces: true, insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true }).map((c) => this.toEdit(ts, rel, file, c))
  }

  symbols(rel: string): IntelSymbol[] {
    if (!SUPPORTED.test(rel)) return []
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    const text = this.text(file)
    const out: IntelSymbol[] = []
    const walk = (items: readonly TS.NavigationTree[], container: string) => {
      for (const item of items) {
        const span = item.spans[0]
        if (span && item.text !== '<global>') {
          const start = this.position(ts, text, span.start)
          const end = this.position(ts, text, span.start + span.length)
          out.push({ name: item.text, kind: item.kind, container, line: start.line, column: start.column, endLine: end.line, endColumn: end.column })
        }
        if (item.childItems) walk(item.childItems, item.text === '<global>' ? '' : item.text)
      }
    }
    walk([service.getNavigationTree(file)], '')
    return out
  }

  signature(rel: string, line: number, column: number): { label: string; docs: string; parameters: string[]; active: number; activeParameter: number } | null {
    if (!SUPPORTED.test(rel)) return null
    const { ts, service } = this.projectFor(rel)
    const file = this.abs(rel)
    const help = service.getSignatureHelpItems(file, this.offset(ts, this.text(file), line, column), {})
    const item = help?.items[help.selectedItemIndex]
    if (!help || !item) return null
    const parameters = item.parameters.map((p) => ts.displayPartsToString(p.displayParts))
    const label = `${ts.displayPartsToString(item.prefixDisplayParts)}${parameters.join(ts.displayPartsToString(item.separatorDisplayParts))}${ts.displayPartsToString(item.suffixDisplayParts)}`
    return { label, docs: ts.displayPartsToString(item.documentation), parameters, active: 0, activeParameter: help.argumentIndex }
  }

  dispose(): void {
    for (const p of this.projects.values()) p.service.dispose()
    this.projects.clear()
  }
}
