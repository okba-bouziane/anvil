import type { ImportedSnippet, IntelCompletion, IntelEdit, IntelLocation, IntelSymbol } from '../../shared/types'
import { monaco } from './monaco'
import { relOf, store, uriOf } from './models'

const api = window.pitoo
const LANGUAGES = ['typescript', 'javascript']
type Model = monaco.editor.ITextModel
const K = monaco.languages.CompletionItemKind

const KIND: Record<string, monaco.languages.CompletionItemKind> = {
  method: K.Method, function: K.Function, 'local function': K.Function, constructor: K.Constructor, property: K.Property, getter: K.Property, setter: K.Property,
  var: K.Variable, let: K.Variable, const: K.Constant, 'local var': K.Variable, parameter: K.Variable, class: K.Class, interface: K.Interface, type: K.Struct,
  enum: K.Enum, 'enum member': K.EnumMember, module: K.Module, keyword: K.Keyword, string: K.Value
}
const SYMBOL: Record<string, monaco.languages.SymbolKind> = {
  class: monaco.languages.SymbolKind.Class, interface: monaco.languages.SymbolKind.Interface, function: monaco.languages.SymbolKind.Function, method: monaco.languages.SymbolKind.Method,
  property: monaco.languages.SymbolKind.Property, const: monaco.languages.SymbolKind.Constant, var: monaco.languages.SymbolKind.Variable, let: monaco.languages.SymbolKind.Variable, enum: monaco.languages.SymbolKind.Enum, type: monaco.languages.SymbolKind.Struct
}

const range = (l: { line: number; column: number; endLine: number; endColumn: number }): monaco.IRange => ({ startLineNumber: l.line, startColumn: l.column, endLineNumber: l.endLine, endColumn: l.endColumn })

/** Sends the latest text first, so answers match what's on screen rather than the last pause. */
async function sync(model: Model): Promise<string | null> {
  const rel = relOf(model.uri)
  if (rel) await api.intel('update', rel, model.getValue())
  return rel
}

const quiet = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await run()
  } catch {
    return fallback
  }
}

async function locations(list: IntelLocation[]): Promise<monaco.languages.Location[]> {
  // The peek view needs each file loaded.
  await Promise.all(list.map((l) => store.ensure(l.path).catch(() => null)))
  return list.map((l) => ({ uri: uriOf(l.path), range: range(l) }))
}

interface Item extends monaco.languages.CompletionItem {
  entry: IntelCompletion
  rel: string
  at: monaco.Position
}

let registered = false

/** Connects the editor to the project-aware engine. `open` shows another file when a jump leaves this one. */
const wholeFile = (model: monaco.editor.ITextModel, text: string) => (text === model.getValue() ? [] : [{ range: model.getFullModelRange(), text }])

/* Prettier takes over formatting for these languages once a project allows it. */
let prettierProviders: monaco.IDisposable[] = []
export function registerProjectFormatter(enabled: boolean): void {
  prettierProviders.forEach((p) => p.dispose())
  prettierProviders = []
  if (!enabled) return
  for (const language of ['html', 'css', 'scss', 'less', 'json', 'markdown', 'yaml']) {
    prettierProviders.push(monaco.languages.registerDocumentFormattingEditProvider(language, {
      displayName: 'Prettier',
      provideDocumentFormattingEdits: async (model) => {
        const rel = relOf(model.uri)
        if (!rel) return []
        const formatted = await api.tooling<string | null>('format', rel, model.getValue()).catch(() => null)
        return formatted === null ? [] : wholeFile(model, formatted)
      }
    }))
  }
}

/** ESLint's own fixes, offered from the light bulb. */
function registerLintActions(): void {
  for (const language of ['typescript', 'javascript', 'html']) {
    monaco.languages.registerCodeActionProvider(language, {
      provideCodeActions: (model, range) => {
        const rel = relOf(model.uri)
        if (!rel) return { actions: [], dispose() {} }
        const all = store.lintFixes(rel)
        const here = all.filter((m) => m.fix && m.line <= range.endLineNumber && m.endLine >= range.startLineNumber)
        const edit = (fix: NonNullable<typeof all[number]['fix']>) => {
          const from = model.getPositionAt(fix.start)
          const to = model.getPositionAt(fix.end)
          return { resource: model.uri, versionId: undefined, textEdit: { range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: fix.text } }
        }
        const actions: monaco.languages.CodeAction[] = here.map((m) => ({ title: `Fix: ${m.rule ?? m.message}`, kind: 'quickfix', edit: { edits: [edit(m.fix!)] } }))
        if (all.some((m) => m.fix)) actions.push({ title: 'Fix all ESLint problems in this file', kind: 'source.fixAll', command: { id: 'pitoo.eslintFixAll', title: 'Fix all' } })
        return { actions, dispose() {} }
      }
    })
  }
  monaco.editor.registerCommand('pitoo.eslintFixAll', () => {
    const model = monaco.editor.getModels().find((m) => m.isAttachedToEditor() && relOf(m.uri) === store.activePath())
    if (model) void fixAllLint(model)
  })
}

export async function fixAllLint(model: monaco.editor.ITextModel): Promise<void> {
  const rel = relOf(model.uri)
  if (!rel) return
  const fixed = await api.tooling<string | null>('fixAll', rel, model.getValue()).catch(() => null)
  if (fixed !== null && fixed !== model.getValue()) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: fixed }], () => null)
}

export function registerIntel(open: (path: string, line: number) => void): void {
  registerLintActions()
  if (registered) return
  registered = true

  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      const rel = relOf(resource)
      if (!rel) return false
      const line = !selection ? 1 : 'lineNumber' in selection ? selection.lineNumber : selection.startLineNumber
      open(rel, line)
      return true
    }
  })

  for (const language of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', '"', "'", '/', '@', '<'],
      provideCompletionItems: (model, position) => quiet(async () => {
        const rel = await sync(model)
        if (!rel) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        const replace: monaco.IRange = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }
        const list = await api.intel<IntelCompletion[]>('completions', rel, position.lineNumber, position.column)
        const suggestions = list.map((entry): Item => ({
          label: entry.source ? { label: entry.name, description: entry.source.replace(/^.*node_modules\//, '') } : entry.name,
          kind: KIND[entry.kind] ?? K.Text,
          insertText: entry.insertText ?? entry.name,
          sortText: entry.sortText,
          filterText: entry.name,
          range: replace,
          entry,
          rel,
          at: position
        }))
        return { suggestions }
      }, { suggestions: [] }),
      resolveCompletionItem: (item) => quiet(async () => {
        const { entry, rel, at } = item as Item
        const detail = await api.intel<{ detail: string; docs: string; edits: IntelEdit[] } | null>('completionDetail', rel, at.lineNumber, at.column, entry)
        if (!detail) return item
        return { ...item, detail: detail.detail, documentation: detail.docs, additionalTextEdits: detail.edits.map((e) => ({ range: range(e), text: e.text })) }
      }, item)
    })

    monaco.languages.registerHoverProvider(language, {
      provideHover: (model, position) => quiet(async () => {
        const rel = await sync(model)
        const info = rel && await api.intel<{ signature: string; docs: string } | null>('hover', rel, position.lineNumber, position.column)
        return info ? { contents: [{ value: `\`\`\`typescript\n${info.signature}\n\`\`\`` }, ...(info.docs ? [{ value: info.docs }] : [])] } : null
      }, null)
    })

    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: (model, position) => quiet(async () => {
        const rel = await sync(model)
        return rel ? locations(await api.intel<IntelLocation[]>('definition', rel, position.lineNumber, position.column)) : []
      }, [])
    })

    monaco.languages.registerReferenceProvider(language, {
      provideReferences: (model, position) => quiet(async () => {
        const rel = await sync(model)
        return rel ? locations(await api.intel<IntelLocation[]>('references', rel, position.lineNumber, position.column)) : []
      }, [])
    })

    monaco.languages.registerRenameProvider(language, {
      provideRenameEdits: async (model, position, name) => {
        const rel = await sync(model)
        if (!rel) return { edits: [] }
        const result = await api.intel<IntelEdit[] | { error: string }>('rename', rel, position.lineNumber, position.column, name)
        if ('error' in result) return { edits: [], rejectReason: result.error }
        await Promise.all(result.map((e) => store.ensure(e.path).catch(() => null)))
        return { edits: result.map((e) => ({ resource: uriOf(e.path), versionId: undefined, textEdit: { range: range(e), text: e.text } })) }
      }
    })

    monaco.languages.registerDocumentFormattingEditProvider(language, {
      provideDocumentFormattingEdits: (model, options) => quiet(async () => {
        const rel = await sync(model)
        if (!rel) return []
        const formatted = await api.tooling<string | null>('format', rel, model.getValue()).catch(() => null)
        if (formatted !== null) return wholeFile(model, formatted)
        const edits = await api.intel<IntelEdit[]>('format', rel, options.tabSize)
        return edits.map((e) => ({ range: range(e), text: e.text }))
      }, [])
    })

    monaco.languages.registerDocumentSymbolProvider(language, {
      provideDocumentSymbols: (model) => quiet(async () => {
        const rel = await sync(model)
        const list = rel ? await api.intel<IntelSymbol[]>('symbols', rel) : []
        return list.map((s) => ({ name: s.name, detail: '', kind: SYMBOL[s.kind] ?? monaco.languages.SymbolKind.Variable, containerName: s.container, tags: [], range: range(s), selectionRange: range(s) }))
      }, [])
    })

    monaco.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: (model, position) => quiet(async () => {
        const rel = await sync(model)
        const help = rel && await api.intel<{ label: string; docs: string; parameters: string[]; activeParameter: number } | null>('signature', rel, position.lineNumber, position.column)
        if (!help) return null
        return {
          value: { signatures: [{ label: help.label, documentation: help.docs, parameters: help.parameters.map((label) => ({ label })) }], activeSignature: 0, activeParameter: help.activeParameter },
          dispose: () => {}
        }
      }, null)
    })
  }

  // Grey suggestions from the model, as you pause. Press Tab to accept.
  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    provideInlineCompletions: async (model, position, _context, token) => {
      const rel = relOf(model.uri)
      if (!rel) return { items: [] }
      await new Promise((r) => setTimeout(r, 450))
      if (token.isCancellationRequested) return { items: [] }
      token.onCancellationRequested(() => void api.cancelSuggest().catch(() => {}))
      const offset = model.getOffsetAt(position)
      const text = model.getValue()
      const insert = await api.suggest(rel, text.slice(Math.max(0, offset - 3000)), text.slice(offset, offset + 800)).catch(() => '')
      if (!insert.trim() || token.isCancellationRequested) return { items: [] }
      return { items: [{ insertText: insert, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] }
    },
    freeInlineCompletions: () => {}
  })
}

let snippetProviders: monaco.IDisposable[] = []

export function registerSnippets(snippets: ImportedSnippet[]): void {
  snippetProviders.forEach((d) => d.dispose())
  const byLanguage = new Map<string, ImportedSnippet[]>()
  for (const s of snippets) byLanguage.set(s.language, [...(byLanguage.get(s.language) ?? []), s])
  const everywhere = byLanguage.get('*') ?? []
  const languages = monaco.languages.getLanguages().map((l) => l.id)
  snippetProviders = languages.filter((id) => everywhere.length || byLanguage.has(id)).map((id) =>
    monaco.languages.registerCompletionItemProvider(id, {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position)
        const replace = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }
        return {
          suggestions: [...(byLanguage.get(id) ?? []), ...everywhere].map((s) => ({
            label: s.prefix,
            detail: s.name,
            documentation: s.description,
            kind: K.Snippet,
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range: replace
          }))
        }
      }
    })
  )
}
