import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker&inline'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker&inline'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker&inline'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker&inline'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    return new EditorWorker()
  }
}

// The real project check runs in the app. The editor has no project config, so its own errors would be wrong.
const off = { noSemanticValidation: true, noSyntaxValidation: true }
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(off)
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(off)

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

export { monaco }
export const OPTIONS = {
  theme: 'anvil',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 12.5,
  lineHeight: 20,
  renderLineHighlight: 'line',
  scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false },
  guides: { indentation: true },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  fontFamily: "'SF Mono', Menlo, monospace",
  scrollBeyondLastLine: false,
  padding: { top: 10 }
} as const
