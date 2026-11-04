import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker&inline'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker&inline'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker&inline'
import type { ImportedTheme } from '../../shared/types'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    return new EditorWorker()
  }
}

// TypeScript and JavaScript help comes from the project-aware engine in the app, so the editor's own
// single-file version is switched off. It would show duplicates and false errors.
const off = { completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false }
monaco.languages.typescript.typescriptDefaults.setModeConfiguration(off)
monaco.languages.typescript.javascriptDefaults.setModeConfiguration(off)

monaco.editor.defineTheme('anvil', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0c0d10',
    'editorGutter.background': '#0c0d10',
    'editorLineNumber.foreground': '#3e4048',
    'editorLineNumber.activeForeground': '#8a8c96',
    'editorIndentGuide.background1': '#1c1d22',
    'editor.lineHighlightBackground': '#14151a',
    'editor.lineHighlightBorder': '#00000000',
    'scrollbarSlider.background': '#ffffff14',
    'diffEditor.insertedTextBackground': '#22c55e22',
    'diffEditor.removedTextBackground': '#ef444426',
    'diffEditor.insertedLineBackground': '#22c55e14',
    'diffEditor.removedLineBackground': '#ef444418'
  }
})

monaco.editor.defineTheme('anvil-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorLineNumber.foreground': '#b4b6c0',
    'editorLineNumber.activeForeground': '#5f616d',
    'editor.lineHighlightBackground': '#f4f4f8',
    'editor.lineHighlightBorder': '#00000000',
    'diffEditor.insertedTextBackground': '#16a34a26',
    'diffEditor.removedTextBackground': '#dc262626',
    'diffEditor.insertedLineBackground': '#16a34a14',
    'diffEditor.removedLineBackground': '#dc262614'
  }
})

export function defineImportedTheme(theme: ImportedTheme): void {
  monaco.editor.defineTheme(theme.id, {
    base: theme.dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: theme.tokens,
    colors: Object.fromEntries(Object.entries(theme.colors).filter(([key]) => key.startsWith('editor') || key.startsWith('diffEditor')))
  })
}

export { monaco }
export const OPTIONS = {
  automaticLayout: true,
  lineHeight: 20,
  renderLineHighlight: 'line',
  scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false },
  guides: { indentation: true },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  fontFamily: "'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
  scrollBeyondLastLine: false,
  padding: { top: 10 },
  inlineSuggest: { enabled: true },
  bracketPairColorization: { enabled: true },
  'semanticHighlighting.enabled': false
} as const
