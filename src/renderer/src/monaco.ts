import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
// @ts-expect-error This file has no type declarations.
import { language as typescriptLanguage } from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js'
import { emmetCSS, emmetHTML, emmetJSX } from 'emmet-monaco-es'
import type { ImportedTheme } from '../../shared/types'

// The built-in TypeScript and JavaScript colors are coarser than VS Code's: one color for every name, and operators
// the same as punctuation. These rules make the same distinctions VS Code's grammar makes. They run before the editor
// loads the language, and JavaScript shares them.
const common = typescriptLanguage.tokenizer.common as unknown[]
common.unshift(
  [/=>/, 'keyword'],
  [/\bthis\b/, 'variable.language'],
  [/\b(true|false|null|undefined)\b/, 'constant'],
  [/\b(console|Math|JSON)\b/, 'support.class'],
  [/#?[a-zA-Z_$][\w$]*(?=\s*(<[^<>()]*>)?\s*\()/, { cases: { '@keywords': 'keyword', '@default': 'function' } }],
  [/:(?![=:])/, 'delimiter'],
  [/\?(?![=:?.])/, 'operator']
)
// Comments that start with !, ?, TODO, * or a second // stand out, as they do with Better Comments.
;(typescriptLanguage.tokenizer.whitespace as unknown[]).unshift(
  [/\/\/\s*!.*$/, 'comment.alert'],
  [/\/\/\s*\?.*$/, 'comment.question'],
  [/\/\/\s*todo\b.*$/i, 'comment.todo'],
  [/\/\/\s*\*.*$/, 'comment.highlight'],
  [/\/\/\s*\/\/.*$/, 'comment.crossed']
)
for (const rule of common) {
  const cases = (rule as unknown[])[1] as { cases?: Record<string, string> } | undefined
  if (cases?.cases?.['@operators']) cases.cases['@operators'] = 'operator'
}

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
  // The code colors of the Andromeda theme, calmed a little.
  rules: [
    { token: '', foreground: 'd5ced9' },
    { token: 'comment', foreground: '87898f' },
    // The default colors of the Better Comments extension.
    { token: 'comment.alert', foreground: 'ef5a3c' },
    { token: 'comment.question', foreground: '5aa5dc' },
    { token: 'comment.todo', foreground: 'ee9a3a' },
    { token: 'comment.highlight', foreground: '98c379' },
    { token: 'comment.crossed', foreground: '474747', fontStyle: 'strikethrough' },
    { token: 'keyword', foreground: 'bd6fe0' },
    { token: 'operator', foreground: 'e56f5a' },
    { token: 'function', foreground: 'f2de82' },
    { token: 'type', foreground: 'bd6fe0' },
    { token: 'type.identifier', foreground: 'f2de82' },
    { token: 'identifier', foreground: '3ccfb8' },
    { token: 'variable.language', foreground: 'ec4fae' },
    { token: 'constant', foreground: 'e56f5a' },
    { token: 'support.class', foreground: 'e56f5a' },
    { token: 'string', foreground: '9dd67f' },
    { token: 'number', foreground: 'eba23c' },
    { token: 'regexp', foreground: '86b8f2' },
    { token: 'delimiter', foreground: 'd5ced9' },
    { token: 'delimiter.angle', foreground: 'e56f5a' },
    { token: 'tag', foreground: 'ec5683' },
    { token: 'attribute.name', foreground: 'f2de82' },
    { token: 'attribute.value', foreground: '9dd67f' }
  ],
  colors: {
    focusBorder: '#fff4e440',
    foreground: '#ece6db',
    'widget.border': '#fff4e422',
    'widget.shadow': '#0000004d',
    'input.background': '#131211',
    'input.foreground': '#ece6db',
    'input.border': '#fff4e422',
    'input.placeholderForeground': '#827a70',
    'inputOption.activeBackground': '#fff4e41c',
    'inputOption.activeBorder': '#00000000',
    'inputOption.activeForeground': '#ece6db',
    'menu.background': '#272420',
    'menu.foreground': '#ece6db',
    'menu.selectionBackground': '#fff4e414',
    'menu.selectionForeground': '#ece6db',
    'menu.separatorBackground': '#fff4e41a',
    'menu.border': '#fff4e422',
    'quickInput.background': '#272420',
    'quickInput.foreground': '#ece6db',
    'quickInputTitle.background': '#272420',
    'quickInputList.focusBackground': '#fff4e414',
    'quickInputList.focusForeground': '#ece6db',
    'list.activeSelectionBackground': '#fff4e414',
    'list.activeSelectionForeground': '#ece6db',
    'list.inactiveSelectionBackground': '#fff4e414',
    'list.focusBackground': '#fff4e414',
    'list.focusForeground': '#ece6db',
    'list.hoverBackground': '#fff4e414',
    'list.highlightForeground': '#fff8ee',
    'list.focusHighlightForeground': '#fff8ee',
    'keybindingLabel.background': '#00000000',
    'keybindingLabel.foreground': '#827a70',
    'keybindingLabel.border': '#fff4e41a',
    'keybindingLabel.bottomBorder': '#fff4e41a',
    'pickerGroup.foreground': '#827a70',
    'pickerGroup.border': '#fff4e41a',
    'editorSuggestWidget.background': '#272420',
    'editorSuggestWidget.border': '#fff4e422',
    'editorSuggestWidget.foreground': '#ece6db',
    'editorSuggestWidget.selectedBackground': '#fff4e414',
    'editorSuggestWidget.selectedForeground': '#ece6db',
    'editorSuggestWidget.highlightForeground': '#fff8ee',
    'editorSuggestWidget.focusHighlightForeground': '#fff8ee',
    'editorHoverWidget.background': '#272420',
    'editorHoverWidget.border': '#fff4e422',
    'editorHoverWidget.foreground': '#ece6db',
    'editorWidget.background': '#272420',
    'editorWidget.foreground': '#ece6db',
    'editorWidget.border': '#fff4e422',
    'peekView.border': '#fff4e422',
    'peekViewTitle.background': '#272420',
    'peekViewResult.background': '#272420',
    'peekViewEditor.background': '#131211',
    // Around the code, these follow the Andromeda theme.
    'editorBracketHighlight.foreground1': '#e6c94f',
    'editorBracketHighlight.foreground2': '#cf7fcb',
    'editorBracketHighlight.foreground3': '#4ea6e6',
    'editor.background': '#211f1c',
    'editor.foreground': '#d5ced9',
    'editorGutter.background': '#211f1c',
    'editorLineNumber.foreground': '#746f77',
    'editorLineNumber.activeForeground': '#d5ced9',
    'editorCursor.foreground': '#ffffff',
    'editor.selectionBackground': '#3d4352',
    'editor.selectionHighlightBackground': '#4f435580',
    'editor.wordHighlightBackground': '#4f4355',
    'editor.findMatchBackground': '#f39d1256',
    'editor.findMatchHighlightBackground': '#59b8b377',
    'editorError.foreground': '#fc644d',
    'editorWarning.foreground': '#ff9f2e',
    'editorBracketMatch.background': '#746f7766',
    'editorBracketMatch.border': '#746f77',
    'editorIndentGuide.background1': '#34312d',
    'editorIndentGuide.activeBackground1': '#4d4842',
    'editor.lineHighlightBackground': '#2b2825',
    'editor.lineHighlightBorder': '#00000000',
    'scrollbarSlider.background': '#fff4e414',
    'diffEditor.insertedTextBackground': '#93bd942e',
    'diffEditor.removedTextBackground': '#dc8f7c30',
    'diffEditor.insertedLineBackground': '#93bd9418',
    'diffEditor.removedLineBackground': '#dc8f7c1a'
  }
})

monaco.editor.defineTheme('anvil-light', {
  base: 'vs',
  inherit: true,
  // The same color for the same kind of code as the dark theme, deepened and calmed so it reads well on paper.
  rules: [
    { token: '', foreground: '2a2520' },
    { token: 'comment', foreground: '756e62' },
    { token: 'comment.alert', foreground: 'b5412f' },
    { token: 'comment.question', foreground: '2f6a9e' },
    { token: 'comment.todo', foreground: 'a35f0c' },
    { token: 'comment.highlight', foreground: '4f7a3a' },
    { token: 'comment.crossed', foreground: '8f887c', fontStyle: 'strikethrough' },
    { token: 'keyword', foreground: '84459f' },
    { token: 'operator', foreground: 'a8503f' },
    { token: 'function', foreground: '7f6410' },
    { token: 'type', foreground: '84459f' },
    { token: 'type.identifier', foreground: '7f6410' },
    { token: 'identifier', foreground: '1f6f64' },
    { token: 'variable.language', foreground: 'a83f7f' },
    { token: 'constant', foreground: 'a8503f' },
    { token: 'support.class', foreground: 'a8503f' },
    { token: 'string', foreground: '4a7a2e' },
    { token: 'number', foreground: 'a35f0c' },
    { token: 'regexp', foreground: '2f6a9e' },
    { token: 'delimiter', foreground: '5a5248' },
    { token: 'delimiter.angle', foreground: 'a8503f' },
    { token: 'tag', foreground: 'a83f6a' },
    { token: 'attribute.name', foreground: '7f6410' },
    { token: 'attribute.value', foreground: '4a7a2e' }
  ],
  colors: {
    'focusBorder': '#2a252066',
    'foreground': '#2a2520',
    'widget.border': '#2a252026',
    'widget.shadow': '#0000004d',
    'input.background': '#f7f3eb',
    'input.foreground': '#2a2520',
    'input.border': '#2a252026',
    'input.placeholderForeground': '#7a7266',
    'inputOption.activeBackground': '#2a252014',
    'inputOption.activeBorder': '#00000000',
    'inputOption.activeForeground': '#4a4238',
    'menu.background': '#fbf8f2',
    'menu.foreground': '#2a2520',
    'menu.selectionBackground': '#2a252014',
    'menu.selectionForeground': '#2a2520',
    'menu.separatorBackground': '#2a252022',
    'menu.border': '#2a252026',
    'quickInput.background': '#faf7f0',
    'quickInput.foreground': '#2a2520',
    'quickInputTitle.background': '#faf7f0',
    'quickInputList.focusBackground': '#2a252014',
    'quickInputList.focusForeground': '#2a2520',
    'list.activeSelectionBackground': '#2a252014',
    'list.activeSelectionForeground': '#2a2520',
    'list.inactiveSelectionBackground': '#2a252014',
    'list.focusBackground': '#2a252014',
    'list.focusForeground': '#2a2520',
    'list.hoverBackground': '#2a252014',
    'list.highlightForeground': '#4a4238',
    'list.focusHighlightForeground': '#4a4238',
    'keybindingLabel.background': '#00000000',
    'keybindingLabel.foreground': '#7a7266',
    'keybindingLabel.border': '#2a252022',
    'keybindingLabel.bottomBorder': '#2a252022',
    'pickerGroup.foreground': '#7a7266',
    'pickerGroup.border': '#2a252022',
    'editorSuggestWidget.background': '#faf7f0',
    'editorSuggestWidget.border': '#2a252026',
    'editorSuggestWidget.foreground': '#2a2520',
    'editorSuggestWidget.selectedBackground': '#2a252014',
    'editorSuggestWidget.selectedForeground': '#2a2520',
    'editorSuggestWidget.highlightForeground': '#4a4238',
    'editorSuggestWidget.focusHighlightForeground': '#4a4238',
    'editorHoverWidget.background': '#faf7f0',
    'editorHoverWidget.border': '#2a252026',
    'editorHoverWidget.foreground': '#2a2520',
    'editorWidget.background': '#faf7f0',
    'editorWidget.foreground': '#2a2520',
    'editorWidget.border': '#2a252026',
    'editor.findMatchBackground': '#d9941c40',
    'editor.findMatchHighlightBackground': '#d9941c26',
    'peekView.border': '#4a4238',
    'peekViewTitle.background': '#faf7f0',
    'peekViewResult.background': '#faf7f0',
    'peekViewEditor.background': '#f7f3eb',
    'editor.foreground': '#2a2520',
    'editor.selectionHighlightBackground': '#2a252012',
    'editor.wordHighlightBackground': '#2a252012',
    'editorError.foreground': '#b5412f',
    'editorWarning.foreground': '#a35f0c',
    'editorBracketMatch.background': '#2a252014',
    'editorBracketMatch.border': '#a8a194',
    'editorIndentGuide.background1': '#e8e2d6',
    'editorIndentGuide.activeBackground1': '#cfc8ba',
    'editorBracketHighlight.foreground1': '#7f6410',
    'editorBracketHighlight.foreground2': '#84459f',
    'editorBracketHighlight.foreground3': '#2f6a9e',
    'editor.background': '#faf7f0',
    'editorGutter.background': '#faf7f0',
    'editorLineNumber.foreground': '#a8a194',
    'editorLineNumber.activeForeground': '#5a5248',
    'editorCursor.foreground': '#2a2520',
    'editor.selectionBackground': '#2a25201f',
    'editor.lineHighlightBackground': '#f1ece2',
    'editor.lineHighlightBorder': '#00000000',
    'diffEditor.insertedTextBackground': '#3f7a4a26',
    'diffEditor.removedTextBackground': '#b34a3626',
    'diffEditor.insertedLineBackground': '#3f7a4a14',
    'diffEditor.removedLineBackground': '#b34a3614'
  }
})

// Measured text must use the bundled font, or the cursor drifts once it arrives.
void document.fonts.load("13px 'JetBrains Mono'").then(() => monaco.editor.remeasureFonts())

/** A theme from an extension can hold values the editor refuses. One bad theme must not stop the others. */
export function defineImportedTheme(theme: ImportedTheme): void {
  const hex = (value?: string) => {
    const clean = value?.replace('#', '') ?? ''
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(clean)) return clean.slice(0, 6)
    if (/^[0-9a-f]{3}$/i.test(clean)) return clean.replace(/./g, '$&$&')
    return undefined
  }
  try {
    monaco.editor.defineTheme(theme.id.replace(/[^\w-]/g, '-'), {
      base: theme.dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: theme.tokens.map((t) => ({ token: t.token, foreground: hex(t.foreground), fontStyle: t.fontStyle })),
      colors: Object.fromEntries(Object.entries(theme.colors).filter(([key]) => key.startsWith('editor') || key.startsWith('diffEditor')))
    })
  } catch {
    /* the theme simply isn't offered */
  }
}

export const importedThemeName = (id: string) => id.replace(/[^\w-]/g, '-')

emmetHTML(monaco)
emmetCSS(monaco)
emmetJSX(monaco)

export { monaco }
export const OPTIONS = {
  automaticLayout: true,
  lineHeight: 1.5,
  smoothScrolling: true,
  glyphMargin: true,
  linkedEditing: true,
  stickyScroll: { enabled: true },
  guides: { indentation: true, bracketPairs: 'active' },
  cursorBlinking: 'phase',
  cursorSmoothCaretAnimation: 'on',
  renderLineHighlight: 'line',
  scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  fontFamily: "Menlo, 'JetBrains Mono', Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
  fontLigatures: false,
  scrollBeyondLastLine: false,
  padding: { top: 10 },
  inlineSuggest: { enabled: true },
  bracketPairColorization: { enabled: true },
  'semanticHighlighting.enabled': false
} as const
