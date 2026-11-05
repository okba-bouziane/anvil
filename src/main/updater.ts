import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const LATEST = 'https://api.github.com/repos/okba-bouziane/anvil/releases/latest'
const DOWNLOADS = 'https://github.com/okba-bouziane/anvil/releases/download/'

export interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
}

export interface Release {
  version: string
  url: string
  assets: ReleaseAsset[]
}

export interface Machine {
  platform: string
  arch: string
  /** Set by the AppImage runtime to the file it was started from. */
  appImage?: string
}

export interface Installer {
  /** What the button says once the download is ready. */
  label: string
  /** Whether Anvil has to close first. */
  quits: boolean
  run(): void
}

export const newer = (a: string, b: string): boolean => {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** Only asks GitHub for the latest version. Nothing about you or your code is sent. */
export async function latestRelease(): Promise<Release | null> {
  const response = await fetch(LATEST, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) return null
  const release = (await response.json()) as { tag_name?: string; html_url?: string; assets?: ReleaseAsset[] }
  if (!release.tag_name || !release.html_url) return null
  return { version: release.tag_name, url: release.html_url, assets: release.assets ?? [] }
}

/** The installer for this computer. Null means there isn't one, so the person gets the release page instead. */
export function assetFor(assets: ReleaseAsset[], machine: Machine): ReleaseAsset | null {
  const name = machine.platform === 'darwin' && machine.arch === 'arm64' ? 'Anvil-mac-arm64.zip'
    : machine.platform === 'win32' && machine.arch === 'x64' ? 'Anvil-win-x64.exe'
    : machine.platform === 'linux' && machine.arch === 'x64' ? (machine.appImage ? 'Anvil-linux-x86_64.AppImage' : 'Anvil-linux-amd64.deb')
    : null
  const asset = assets.find((a) => a.name === name)
  return asset && asset.browser_download_url.startsWith(DOWNLOADS) ? asset : null
}

/** Saves a release file into `dir`, and refuses it unless every byte arrived. */
export async function downloadAsset(asset: Pick<ReleaseAsset, 'name' | 'size' | 'browser_download_url'>, dir: string, onPercent: (percent: number) => void): Promise<string> {
  const response = await fetch(asset.browser_download_url)
  if (!response.ok || !response.body) throw new Error(`The download failed with status ${response.status}.`)
  const file = path.join(dir, path.basename(asset.name))
  const out = fs.openSync(file, 'w')
  let received = 0
  let shown = -1
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      fs.writeSync(out, value)
      received += value.length
      const percent = Math.floor((received / asset.size) * 100)
      if (percent !== shown) onPercent((shown = percent))
    }
  } finally {
    fs.closeSync(out)
  }
  if (received !== asset.size) {
    fs.rmSync(file, { force: true })
    throw new Error('The download was incomplete. Try again.')
  }
  return file
}

/** Waits for Anvil to close, swaps the new copy in, puts the old one back if that fails, then starts it. */
export const SWAP_SCRIPT = `
pid=$1; target=$2; new=$3; shift 3
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
backup="$target.old.$$"
mv "$target" "$backup" || exit 1
if mv "$new" "$target"; then rm -rf "$backup"; else mv "$backup" "$target"; fi
[ "$(uname)" = Darwin ] && xattr -cr "$target"
"$@"
`

function swapLater(pid: number, target: string, replacement: string, relaunch: string[]): void {
  spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', String(pid), target, replacement, ...relaunch], { detached: true, stdio: 'ignore' }).unref()
}

const writable = (dir: string) => {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function prepareInstall(file: string, machine: Machine, execPath: string, pid: number, openFile: (file: string) => void): Installer {
  if (machine.platform === 'darwin') {
    const target = path.resolve(execPath, '../../..')
    if (!target.endsWith('.app') || target.includes('/AppTranslocation/') || !writable(path.dirname(target))) throw new Error('Move Anvil to your Applications folder, then update again.')
    const dir = path.dirname(file)
    execFileSync('ditto', ['-x', '-k', file, dir])
    const replacement = path.join(dir, 'Anvil.app')
    if (!fs.existsSync(path.join(replacement, 'Contents/MacOS/Anvil'))) throw new Error('The download did not contain Anvil.')
    return { label: 'Restart to update', quits: true, run: () => swapLater(pid, target, replacement, ['open', target]) }
  }
  if (machine.platform === 'win32') {
    return { label: 'Install update', quits: true, run: () => spawn(file, [], { detached: true, stdio: 'ignore' }).unref() }
  }
  if (machine.appImage) {
    const target = machine.appImage
    if (!writable(path.dirname(target))) throw new Error(`Anvil can't write to ${path.dirname(target)}. Download the new version from the release page.`)
    fs.chmodSync(file, 0o755)
    return { label: 'Restart to update', quits: true, run: () => swapLater(pid, target, file, [target]) }
  }
  return { label: 'Install update', quits: false, run: () => openFile(file) }
}
