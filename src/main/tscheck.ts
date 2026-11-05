import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type TS from 'typescript'
import { toPosix } from './platform'

export interface CheckResult {
  ran: boolean
  note?: string
  errors: string[]
  fixedImports: { file: string; content: string }[]
  fixedCount: number
}

const FIXABLE_IMPORTS = new Set([2304, 2552, 2503, 18004])
const CODE_FILE = /\.(ts|tsx|mts|cts)$/

function loadTypescript(root: string): typeof TS | null {
  try {
    return createRequire(path.join(root, 'package.json'))('typescript') as typeof TS
  } catch {
    return null
  }
}

export function findTsconfig(root: string, rel: string): string | null {
  let dir = path.dirname(path.join(root, rel))
  while (dir === root || dir.startsWith(root + path.sep)) {
    const app = path.join(dir, 'tsconfig.app.json')
    if (fs.existsSync(app)) return app
    const plain = path.join(dir, 'tsconfig.json')
    if (fs.existsSync(plain)) return plain
    if (dir === root) break
    dir = path.dirname(dir)
  }
  return null
}

function checkProject(ts: typeof TS, root: string, tsconfig: string, touched: string[]): Omit<CheckResult, 'ran'> {
  const dir = path.dirname(tsconfig)
  const loaded = ts.readConfigFile(tsconfig, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(loaded.config ?? {}, ts.sys, dir)
  const absTouched = touched.map((rel) => toPosix(path.join(root, rel)))
  const fileNames = [...new Set([...parsed.fileNames, ...absTouched])]
  const edited = new Map<string, string>()
  const versions = new Map<string, number>()
  const read = (f: string) => edited.get(f) ?? ts.sys.readFile(f)
  const service = ts.createLanguageService({
    getScriptFileNames: () => fileNames,
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => {
      const text = read(f)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => dir,
    getCompilationSettings: () => ({ ...parsed.options, noEmit: true }),
    // In a packaged app these files sit beside the archive, not inside it.
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
    fileExists: ts.sys.fileExists,
    readFile: read,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  })
  const diagnostics = (f: string) => [...service.getSyntacticDiagnostics(f), ...service.getSemanticDiagnostics(f)]
  let fixedCount = 0
  const hints = new Map<number, string>()
  try {
    for (const file of absTouched) {
      for (let pass = 0; pass < 12; pass++) {
        const diag = diagnostics(file).find((d) => FIXABLE_IMPORTS.has(d.code) && d.start !== undefined)
        if (!diag) break
        const fixes = service
          .getCodeFixesAtPosition(file, diag.start!, diag.start! + diag.length!, [diag.code], {}, {})
          .filter((f) => f.fixName === 'import')
        // A file in this project wins over a package with the same name. Any other tie is a real choice
        // for the model, so it gets the options instead.
        const local = fixes.filter((f) => /from "\.{1,2}\//.test(f.description))
        const fix = local.length === 1 ? local[0] : !local.length && fixes.length === 1 ? fixes[0] : null
        if (!fix) {
          if (fixes.length) hints.set(diag.start!, fixes.slice(0, 4).map((f) => f.description).join('; '))
          break
        }
        const change = fix.changes.find((c) => c.fileName === file)
        if (!change || fix.changes.length !== 1) break
        const text = change.textChanges.slice().sort((a, b) => b.span.start - a.span.start)
          .reduce((t, c) => t.slice(0, c.span.start) + c.newText + t.slice(c.span.start + c.span.length), read(file) ?? '')
        edited.set(file, text)
        versions.set(file, (versions.get(file) ?? 0) + 1)
        fixedCount++
      }
    }
    const errors: string[] = []
    for (const file of absTouched) {
      for (const d of diagnostics(file)) {
        if (d.category !== ts.DiagnosticCategory.Error || errors.length >= 15) continue
        const message = ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0]
        const source = d.file?.text
        let where = toPosix(path.relative(root, file))
        let lineText = ''
        if (source !== undefined && d.start !== undefined) {
          const pos = d.file!.getLineAndCharacterOfPosition(d.start)
          where += `:${pos.line + 1}`
          lineText = source.split('\n')[pos.line]?.trim() ?? ''
        }
        const sameName = message.match(/type '(\w+)' is not assignable to .*type '\1( \| undefined)?'/)
        const hint = sameName
          ? `these are two different types both called ${sameName[1]}. One is probably a browser or Node global, because the project's own type is not imported in this file. Import it.`
          : d.start !== undefined ? hints.get(d.start) : undefined
        errors.push(`${where} TS${d.code}: ${message}${lineText ? `\n  that line is: ${lineText}` : ''}${hint ? `\n  possible fixes: ${hint}` : ''}`)
      }
    }
    return {
      errors,
      fixedCount,
      fixedImports: [...edited].map(([file, content]) => ({ file: toPosix(path.relative(root, file)), content }))
    }
  } finally {
    service.dispose()
  }
}

/** Type-checks the changed files, using the TypeScript version installed in the project. */
export function checkFiles(root: string, touched: string[]): CheckResult {
  const code = touched.filter((rel) => CODE_FILE.test(rel) && fs.existsSync(path.join(root, rel)))
  const empty = { errors: [], fixedImports: [], fixedCount: 0 }
  if (!code.length) return { ran: false, ...empty }
  const groups = new Map<string, string[]>()
  for (const rel of code) {
    const tsconfig = findTsconfig(root, rel)
    if (tsconfig) groups.set(tsconfig, [...(groups.get(tsconfig) ?? []), rel])
  }
  if (!groups.size) return { ran: false, ...empty }
  const result: CheckResult = { ran: true, ...empty, errors: [], fixedImports: [] }
  let any = false
  for (const [tsconfig, files] of groups) {
    const ts = loadTypescript(path.dirname(tsconfig)) ?? loadTypescript(root)
    if (!ts) {
      result.note = 'TypeScript is not installed in this project yet, so the files were not checked. Run npm install.'
      continue
    }
    any = true
    const one = checkProject(ts, root, tsconfig, files)
    result.errors.push(...one.errors)
    result.fixedImports.push(...one.fixedImports)
    result.fixedCount += one.fixedCount
  }
  result.ran = any
  return result
}
