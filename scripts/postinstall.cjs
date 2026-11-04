// Some npm setups skip the install scripts of dependencies, which leaves two things unfinished.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// The terminal cannot start unless node-pty's helper is executable.
const prebuilds = path.join(__dirname, '../node_modules/node-pty/prebuilds')
for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
  const helper = path.join(prebuilds, dir, 'spawn-helper')
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
}

// The app cannot start unless Electron has been unpacked.
const electron = path.join(__dirname, '../node_modules/electron')
if (fs.existsSync(electron) && !fs.existsSync(path.join(electron, 'path.txt'))) {
  execFileSync(process.execPath, ['install.js'], { cwd: electron, stdio: 'inherit' })
  if (!fs.existsSync(path.join(electron, 'dist/Electron.app/Contents/MacOS/Electron')) && process.platform === 'darwin') {
    const version = require(path.join(electron, 'package.json')).version
    const cache = path.join(require('node:os').homedir(), 'Library/Caches/electron')
    const zip = fs.readdirSync(cache, { recursive: true }).find((f) => String(f).endsWith(`electron-v${version}-darwin-${process.arch}.zip`))
    if (zip) {
      fs.rmSync(path.join(electron, 'dist'), { recursive: true, force: true })
      execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(cache, String(zip)), path.join(electron, 'dist')])
      fs.writeFileSync(path.join(electron, 'path.txt'), 'Electron.app/Contents/MacOS/Electron')
    }
  }
}
