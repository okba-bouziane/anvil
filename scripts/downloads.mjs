// Shows how many times each installer was downloaded, and how that has grown. Private: the snapshots stay on this computer.
// Usage: npm run downloads
// These are downloads, not people: updates and repeat downloads count too.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve('.downloads')
const history = path.join(dir, 'history.json')
const systemOf = (name) => (/mac/.test(name) ? 'Mac' : /win/.test(name) ? 'Windows' : /linux/.test(name) ? 'Linux' : 'Other')

const fetchReleases = () => {
  for (const repo of ['okba-bouziane/pitoo', 'okba-bouziane/anvil']) {
    try {
      return JSON.parse(execFileSync('gh', ['api', '--paginate', `repos/${repo}/releases`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    } catch {
      /* before the rename, only the old name exists */
    }
  }
  throw new Error('Could not read the releases. Check that gh is signed in.')
}

const releases = fetchReleases().filter((r) => !r.draft)
const versions = releases.map((r) => ({ version: r.tag_name, count: r.assets.reduce((n, a) => n + a.download_count, 0) }))
const systems = {}
for (const release of releases) for (const asset of release.assets) systems[systemOf(asset.name)] = (systems[systemOf(asset.name)] ?? 0) + asset.download_count
const total = versions.reduce((n, v) => n + v.count, 0)

fs.mkdirSync(dir, { recursive: true })
const past = fs.existsSync(history) ? JSON.parse(fs.readFileSync(history, 'utf8')) : []
const today = new Date().toISOString().slice(0, 10)
const rows = [...past.filter((s) => s.date !== today), { date: today, total, systems, versions }]
fs.writeFileSync(history, JSON.stringify(rows, null, 2))

const before = rows.length > 1 ? rows[rows.length - 2] : null
console.log(`Downloads: ${total}${before ? ` (+${total - before.total} since ${before.date})` : ''}`)
for (const [system, count] of Object.entries(systems)) console.log(`  ${system}: ${count}`)
for (const v of versions) console.log(`  ${v.version}: ${v.count}`)

const peak = Math.max(1, ...rows.map((r) => r.total))
const bars = rows.map((r) => `<tr><td>${r.date}</td><td>${r.total}</td><td><div style="height:12px;background:#f6a04d;width:${Math.round((r.total / peak) * 100)}%"></div></td></tr>`).join('')
const list = (entries) => entries.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')
fs.writeFileSync(path.join(dir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Downloads</title><body style="font:15px system-ui;max-width:640px;margin:40px auto;padding:0 20px"><h1>${total} downloads</h1><p>These are downloads, not people. Updates and repeat downloads count too.</p><h2>Growth</h2><table style="width:100%">${bars}</table><h2>By system</h2><table>${list(Object.entries(systems))}</table><h2>By version</h2><table>${list(versions.map((v) => [v.version, v.count]))}</table></body>`)
console.log(`Report: ${path.join(dir, 'report.html')}`)
