import { monaco } from './monaco'
import { lspKindOf, relOf, store, uriOf, type LspKind } from './models'

const api = window.anvil

type Pos = { line: number; character: number }
type LRange = { start: Pos; end: Pos }

const toRange = (r: LRange): monaco.IRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 })
const toPos = (p: monaco.IPosition): Pos => ({ line: p.lineNumber - 1, character: p.column - 1 })

const K = monaco.languages.CompletionItemKind
const COMPLETION: Record<number, monaco.languages.CompletionItemKind> = { 1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter }

const docsOf = (doc: unknown): monaco.IMarkdownString | string | undefined => {
  if (!doc) return undefined
  if (typeof doc === 'string') return doc
  const d = doc as { kind?: string; value?: string }
  return d.kind === 'markdown' ? { value: d.value ?? '' } : d.value
}

const hoverContents = (contents: unknown): monaco.IMarkdownString[] => {
  const list = Array.isArray(contents) ? contents : [contents]
  return list.filter(Boolean).map((c) => {
    if (typeof c === 'string') return { value: c }
    const m = c as { language?: string; value?: string }
    return { value: m.language ? `\`\`\`${m.language}\n${m.value}\n\`\`\`` : (m.value ?? '') }
  })
}

interface LItem {
  label: string
  kind?: number
  detail?: string
  documentation?: unknown
  insertText?: string
  insertTextFormat?: number
  filterText?: string
  sortText?: string
  textEdit?: { newText: string; range?: LRange; insert?: LRange }
  additionalTextEdits?: { range: LRange; newText: string }[]
  data?: unknown
}

const toLocations = async (result: unknown): Promise<monaco.languages.Location[]> => {
  const list = (Array.isArray(result) ? result : result ? [result] : []) as { path?: string | null; uri?: string; range?: LRange; targetRange?: LRange; targetSelectionRange?: LRange }[]
  const inProject = list.filter((l) => l.path)
  await Promise.all(inProject.map((l) => store.ensure(l.path!).catch(() => null)))
  return inProject.map((l) => ({ uri: uriOf(l.path!), range: toRange((l.targetSelectionRange ?? l.range ?? l.targetRange)!) }))
}

/** For a TypeScript file in an Angular project, only the inside of an inline `template:` belongs to Angular. */
function angularApplies(model: monaco.editor.ITextModel, position: monaco.IPosition): boolean {
  if (model.getLanguageId() !== 'typescript') return true
  const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column })
  const start = before.lastIndexOf('template:')
  if (start < 0) return false
  const after = before.slice(start)
  return (after.match(/`/g) ?? []).length % 2 === 1
}

function kindFor(model: monaco.editor.ITextModel, position?: monaco.IPosition): { kind: LspKind; rel: string } | null {
  const rel = relOf(model.uri)
  if (!rel) return null
  const kind = lspKindOf(rel)
  if (!kind) return null
  if (kind === 'angular' && position && !angularApplies(model, position)) return null
  return { kind, rel }
}

const quiet = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await run()
  } catch {
    return fallback
  }
}

let registered = false

export function registerLsp(): void {
  if (registered) return
  registered = true
  for (const language of ['python', 'html', 'typescript']) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: language === 'python' ? ['.', '[', '"', "'"] : ['.', '<', '(', '[', '*', '#', '@', ' ', '|'],
      provideCompletionItems: (model, position) => quiet(async () => {
        const target = kindFor(model, position)
        if (!target) return { suggestions: [] }
        const result = await api.lspRequest<{ isIncomplete?: boolean; items?: LItem[] } | LItem[] | null>(target.kind, 'textDocument/completion', target.rel, { position: toPos(position) })
        const items = Array.isArray(result) ? result : result?.items ?? []
        const word = model.getWordUntilPosition(position)
        const fallback = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
        return {
          incomplete: !Array.isArray(result) && !!result?.isIncomplete,
          suggestions: items.slice(0, 400).map((item) => {
            const edit = item.textEdit
            const editRange = edit?.range ?? edit?.insert
            return {
              label: item.label,
              kind: COMPLETION[item.kind ?? 1] ?? K.Text,
              detail: item.detail,
              documentation: docsOf(item.documentation),
              insertText: edit?.newText ?? item.insertText ?? item.label,
              insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              filterText: item.filterText,
              sortText: item.sortText,
              range: editRange ? toRange(editRange) : fallback,
              additionalTextEdits: item.additionalTextEdits?.map((e) => ({ range: toRange(e.range), text: e.newText })),
              lsp: { item, kind: target.kind, rel: target.rel }
            } as monaco.languages.CompletionItem
          })
        }
      }, { suggestions: [] }),
      resolveCompletionItem: (item) => quiet(async () => {
        const source = (item as unknown as { lsp?: { item: LItem; kind: LspKind; rel: string } }).lsp
        if (!source) return item
        const full = await api.lspRequest<LItem>(source.kind, 'completionItem/resolve', source.rel, source.item as unknown as Record<string, unknown>)
        return { ...item, detail: full.detail ?? item.detail, documentation: docsOf(full.documentation) ?? item.documentation, additionalTextEdits: full.additionalTextEdits?.map((e) => ({ range: toRange(e.range), text: e.newText })) ?? item.additionalTextEdits }
      }, item)
    })

    monaco.languages.registerHoverProvider(language, {
      provideHover: (model, position) => quiet(async () => {
        const target = kindFor(model, position)
        if (!target) return null
        const result = await api.lspRequest<{ contents: unknown; range?: LRange } | null>(target.kind, 'textDocument/hover', target.rel, { position: toPos(position) })
        if (!result) return null
        return { contents: hoverContents(result.contents), range: result.range ? toRange(result.range) : undefined }
      }, null)
    })

    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: (model, position) => quiet(async () => {
        const target = kindFor(model, position)
        if (!target) return []
        return toLocations(await api.lspRequest(target.kind, 'textDocument/definition', target.rel, { position: toPos(position) }))
      }, [])
    })

    monaco.languages.registerReferenceProvider(language, {
      provideReferences: (model, position, context) => quiet(async () => {
        const target = kindFor(model, position)
        if (!target) return []
        return toLocations(await api.lspRequest(target.kind, 'textDocument/references', target.rel, { position: toPos(position), context }))
      }, [])
    })

    monaco.languages.registerRenameProvider(language, {
      provideRenameEdits: async (model, position, newName) => {
        const target = kindFor(model, position)
        if (!target) return { edits: [] }
        const result = await api.lspRequest<{ changes?: Record<string, { range: LRange; newText: string }[]>; documentChanges?: { textDocument: { path?: string | null }; edits: { range: LRange; newText: string }[] }[] } | null>(target.kind, 'textDocument/rename', target.rel, { position: toPos(position), newName })
        const edits: monaco.languages.IWorkspaceTextEdit[] = []
        // The app only hears about Python and Angular through `documentChanges` or `changes`, whichever the server sends.
        for (const change of result?.documentChanges ?? []) {
          const file = change.textDocument.path
          if (!file) continue
          await store.ensure(file).catch(() => null)
          for (const e of change.edits) edits.push({ resource: uriOf(file), versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } })
        }
        return { edits }
      }
    })

    if (language !== 'typescript') {
      monaco.languages.registerDocumentSymbolProvider(language, {
        provideDocumentSymbols: (model) => quiet(async () => {
          const target = kindFor(model)
          if (!target) return []
          type Sym = { name: string; detail?: string; kind: number; range: LRange; selectionRange?: LRange; children?: Sym[]; location?: { range: LRange } }
          const convert = (s: Sym): monaco.languages.DocumentSymbol => {
            const range = toRange(s.range ?? s.location!.range)
            return { name: s.name, detail: s.detail ?? '', kind: (s.kind - 1) as monaco.languages.SymbolKind, tags: [], range, selectionRange: s.selectionRange ? toRange(s.selectionRange) : range, children: s.children?.map(convert) }
          }
          const list = await api.lspRequest<Sym[] | null>(target.kind, 'textDocument/documentSymbol', target.rel, {})
          return (list ?? []).map(convert)
        }, [])
      })

      monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: ['(', ','],
        provideSignatureHelp: (model, position) => quiet(async () => {
          const target = kindFor(model, position)
          if (!target) return null
          const help = await api.lspRequest<{ signatures: { label: string; documentation?: unknown; parameters?: { label: string | [number, number]; documentation?: unknown }[] }[]; activeSignature?: number; activeParameter?: number } | null>(target.kind, 'textDocument/signatureHelp', target.rel, { position: toPos(position) })
          if (!help?.signatures.length) return null
          return {
            value: {
              signatures: help.signatures.map((s) => ({ label: s.label, documentation: docsOf(s.documentation), parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: docsOf(p.documentation) })) })),
              activeSignature: help.activeSignature ?? 0,
              activeParameter: help.activeParameter ?? 0
            },
            dispose() {}
          }
        }, null)
      })
    }
  }
}
