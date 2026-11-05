// electron-builder leaves out every .d.ts file, but TypeScript can't work without its own library files,
// so they are copied in beside the unpacked TypeScript after packaging.
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : path.join(context.appOutDir, 'resources')
  const from = path.join(context.packager.projectDir, 'node_modules/typescript/lib')
  const to = path.join(resources, 'app.asar.unpacked/node_modules/typescript/lib')
  fs.mkdirSync(to, { recursive: true })
  let count = 0
  for (const name of fs.readdirSync(from)) {
    if (name.endsWith('.d.ts')) {
      fs.copyFileSync(path.join(from, name), path.join(to, name))
      count++
    }
  }
  if (count < 50) throw new Error(`Only found ${count} TypeScript library files`)
}
