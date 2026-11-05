// Prepares the file icons from Material Icon Theme (MIT): a small lookup table that is kept in the repository,
// and the SVG files, which are copied from node_modules before each build.
import fs from 'node:fs'
import path from 'node:path'

const pkg = 'node_modules/material-icon-theme'
const out = 'src/renderer/public/file-icons'
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'dist/material-icons.json'), 'utf8'))

const lower = (table = {}) => Object.fromEntries(Object.entries(table).map(([key, value]) => [key.toLowerCase(), value]))
const table = {
  file: manifest.file,
  folder: manifest.folder,
  folderExpanded: manifest.folderExpanded,
  fileNames: lower(manifest.fileNames),
  fileExtensions: lower(manifest.fileExtensions),
  languageIds: manifest.languageIds,
  folderNames: lower(manifest.folderNames),
  light: {
    fileNames: lower(manifest.light?.fileNames),
    fileExtensions: lower(manifest.light?.fileExtensions),
    languageIds: manifest.light?.languageIds ?? {},
    folderNames: lower(manifest.light?.folderNames)
  }
}
fs.writeFileSync('src/renderer/src/file-icons.json', JSON.stringify(table))

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
for (const [name, { iconPath }] of Object.entries(manifest.iconDefinitions)) {
  fs.copyFileSync(path.join(pkg, 'dist', iconPath), path.join(out, `${name}.svg`))
}
fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(out, 'LICENSE.txt'))
console.log(`${Object.keys(manifest.iconDefinitions).length} file icons ready`)
