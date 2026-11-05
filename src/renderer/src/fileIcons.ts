import table from './file-icons.json'

type Table = Record<string, string>
const icons = table as unknown as {
  file: string
  folder: string
  folderExpanded: string
  fileNames: Table
  fileExtensions: Table
  languageIds: Table
  folderNames: Table
  light: { fileNames: Table; fileExtensions: Table; languageIds: Table; folderNames: Table }
}

// VS Code knows these through its language list, so the theme only names the language.
const LANGUAGES: Table = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'jsonl', md: 'markdown', markdown: 'markdown', mdx: 'mdx', html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus',
  py: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', fs: 'fsharp', php: 'php', dart: 'dart', lua: 'lua', r: 'r', scala: 'scala', pl: 'perl',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'shellscript', ps1: 'powershell', bat: 'bat', cmd: 'bat', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', svg: 'xml', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  vue: 'vue', svelte: 'svelte', astro: 'astro', dockerfile: 'dockerfile', tf: 'terraform', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', clj: 'clojure', sol: 'solidity', txt: 'plaintext', log: 'log'
}

/** The icon's name, looked up the way VS Code does: exact file name, then the longest extension, then the language. */
export function iconName(name: string, isDir: boolean, open: boolean, light: boolean): string {
  const base = name.toLowerCase()
  if (isDir) {
    const icon = (light && icons.light.folderNames[base]) || icons.folderNames[base]
    if (icon) return open ? `${icon}-open` : icon
    return open ? icons.folderExpanded : icons.folder
  }
  const exact = (light && icons.light.fileNames[base]) || icons.fileNames[base]
  if (exact) return exact
  const parts = base.split('.')
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.')
    const icon = (light && icons.light.fileExtensions[ext]) || icons.fileExtensions[ext]
    if (icon) return icon
  }
  const language = parts.length > 1 ? LANGUAGES[parts[parts.length - 1]] : undefined
  if (language) {
    const icon = (light && icons.light.languageIds[language]) || icons.languageIds[language]
    if (icon) return icon
  }
  return icons.file
}

const prefs = { on: true, light: false }
export function setFileIconPrefs(on: boolean, light: boolean): void {
  prefs.on = on
  prefs.light = light
}
export const fileIconPrefs = (): { on: boolean; light: boolean } => prefs
