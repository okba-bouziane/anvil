// Opens every panel, popup and menu in the app and takes a screenshot of each, for checking the design by eye.
// Usage: npm run build && node e2e/design-tour.mjs <output-folder> [dark|light]
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const out = path.resolve(process.argv[2] ?? 'test-results/tour')
const theme = process.argv[3] ?? 'dark'
fs.mkdirSync(out, { recursive: true })

const answers = [
  '<edit_file path="src/invoice.ts"><old>  return roundCents(sub)</old><new>  const tax = roundCents(sub * taxRate)\n  return roundCents(sub + tax)</new></edit_file>',
  'I added tax to the total and kept the rounding in one place.',
  `<write_file path="src/discount.ts">import { roundCents } from './money'

export interface Discount {
  code: string
  percent: number
}

// Takes a percentage off, then rounds to cents.
export function applyDiscount(amount: number, discount: Discount): number {
  const off = amount * (discount.percent / 100)
  return roundCents(amount - off)
}
</write_file>`,
  'Added the discount helper.',
  '<run_command>npm run build</run_command>',
  'Skipped it.'
]
let answerDelay = 5
const server = http.createServer((req, res) => {
  if (req.url?.endsWith('/models')) return void res.end('{"data":[{"id":"mlx-community/Qwen3.5-9B-4bit"}]}')
  req.resume()
  req.on('end', async () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const chunk of (answers.shift() ?? 'Done.').match(/[\s\S]{1,12}/g) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`)
      await new Promise((r) => setTimeout(r, answerDelay))
    }
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const modelUrl = `http://127.0.0.1:${server.address().port}/v1`

const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-tour-project-'))), 'invoice-api')
fs.mkdirSync(path.join(root, 'src'), { recursive: true })
fs.mkdirSync(path.join(root, 'node_modules'))
fs.symlinkSync(path.resolve('node_modules/typescript'), path.join(root, 'node_modules/typescript'))
fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n')
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'invoice-api', scripts: { build: 'tsc', test: 'vitest run', dev: 'node server.js' } }, null, 2))
fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' } }, null, 2))
fs.writeFileSync(path.join(root, 'src/money.ts'), 'export const roundCents = (n: number): number => Math.round(n * 100) / 100\n')
fs.writeFileSync(path.join(root, 'src/invoice.ts'), `import { roundCents } from './money'

export interface Line {
  price: number
  quantity: number
}

// Adds up every line on the invoice.
export function total(lines: Line[], taxRate: number): number {
  const sub = lines.reduce((sum, line) => sum + line.price * line.quantity, 0)
  return roundCents(sub)
}
`)
fs.writeFileSync(path.join(root, 'src/report.ts'), `import { total } from './invoice'

// The line below has a type error on purpose, so the screenshots can show one.
const label: string = total([], 0.2)

export const summary = label
`)
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
git('init', '-b', 'main')
git('config', 'user.email', 'dev@example.com')
git('config', 'user.name', 'Amina')
git('add', '.')
git('commit', '-m', 'Add invoices')
git('switch', '-c', 'checkout')
fs.appendFileSync(path.join(root, 'src/money.ts'), 'export const zero = 0\n')
git('commit', '-am', 'Add a zero value')
git('switch', 'main')
fs.appendFileSync(path.join(root, 'src/money.ts'), 'export const one = 1\n')
git('commit', '-am', 'Add a one value')
git('merge', '--no-edit', '-X', 'ours', 'checkout')
git('tag', 'v1.0')
fs.appendFileSync(path.join(root, 'tsconfig.json'), '\n')

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-tour-'))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ provider: 'local', theme, inlineSuggest: false, baseUrls: { local: modelUrl, anthropic: modelUrl.replace('/v1', ''), openai: modelUrl }, models: { local: 'mlx-community/Qwen3.5-9B-4bit' }, recentProjects: [root, '/Users/you/projects/storefront', '/Users/you/projects/billing-service'] }))
const app = await electron.launch({ args: ['.'], env: { ...process.env, PITOO_DATA_DIR: data, PITOO_MEMORY_SECRETS: '1' } })
const page = await app.firstWindow()
const failed = []
let shotNumber = 0
const shot = async (name) => {
  await page.waitForTimeout(220)
  await page.screenshot({ path: path.join(out, `${String(++shotNumber).padStart(2, '0')}-${name}.png`) })
}
const step = async (name, run) => {
  try {
    await run()
    await shot(name)
  } catch (error) {
    failed.push(`${name}: ${String(error.message).split('\n')[0]}`)
    await page.keyboard.press('Escape').catch(() => {})
  }
}
const button = (name, exact = true) => page.getByRole('button', { name, exact })
const sidebar = (name) => page.getByRole('tab', { name }).click({ timeout: 4000 })
const event = (payload) => app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('pitoo:event', p), payload)
const openFile = async (name) => {
  await page.keyboard.press('ControlOrMeta+p')
  await page.locator('#quick-open').fill(name)
  await page.waitForTimeout(150)
  await page.locator('#quick-open').press('Enter')
  await page.waitForSelector('.monaco-editor')
  await page.waitForTimeout(500)
}

// The stand-in model is far faster than a real one, so hide its speed rather than show a number that means nothing.
await page.waitForSelector('.welcome-screen')
await page.addStyleTag({ content: '.stat,.live-bar b,.live-bar span { visibility:hidden }' })
await shot('welcome')
await page.locator('.recent button').first().click()
await page.waitForSelector('.tree-row')

await step('editor-empty', async () => {})
await step('files-menu', async () => {
  await page.locator('.tree-row', { hasText: 'package.json' }).click({ button: 'right' })
  await page.locator('.context-menu').waitFor({ timeout: 2000 })
})
await page.keyboard.press('Escape')
await page.mouse.click(700, 500)
await step('new-file-input', async () => { await button('New file').click(); await page.getByLabel('Name').waitFor({ timeout: 2000 }) })
await page.getByLabel('Name').press('Escape').catch(() => {})

await step('quick-open', async () => {
  await page.keyboard.press('ControlOrMeta+p')
  await page.locator('#quick-open').fill('inv')
})
await page.keyboard.press('Escape')
await openFile('report.ts')
await step('editor-error-underline', async () => { await page.waitForTimeout(2500) })
await step('editor-hover', async () => {
  await page.locator('.view-line span span', { hasText: 'label' }).first().hover()
  await page.waitForTimeout(1600)
})
await step('editor-completion', async () => {
  await page.locator('.monaco-editor .view-lines').click({ position: { x: 400, y: 340 } })
  await page.keyboard.press('ControlOrMeta+ArrowDown')
  await page.keyboard.type('\nlab')
  await page.keyboard.press('Control+Space')
  await page.waitForTimeout(1600)
})
await page.keyboard.press('Escape')
await page.keyboard.press('ControlOrMeta+z')
await page.keyboard.press('ControlOrMeta+z')
await step('editor-find', async () => { await page.keyboard.press('ControlOrMeta+f'); await page.keyboard.type('total') })
await page.keyboard.press('Escape')
await step('editor-context-menu', async () => {
  await page.locator('.monaco-editor .view-lines').click({ button: 'right', position: { x: 200, y: 120 } })
  await page.waitForTimeout(300)
})
await page.keyboard.press('Escape')
await step('editor-command-palette', async () => { await page.locator('.monaco-editor .view-lines').click({ position: { x: 300, y: 60 } }); await page.keyboard.press('F1'); await page.waitForTimeout(300) })
await page.keyboard.press('Escape')

await step('editor-rename', async () => {
  await page.locator('.view-line span span', { hasText: 'total' }).first().click()
  await page.keyboard.press('F2')
  await page.waitForTimeout(500)
})
await page.keyboard.press('Escape')
await step('file-history', async () => { await button('File history').click({ timeout: 3000 }); await page.waitForTimeout(500) })
await step('search', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await page.locator('#project-search').fill('roundCents')
  await page.locator('#project-search').press('Enter')
  await page.locator('.search-hit').first().waitFor({ timeout: 3000 })
})
await step('scripts', async () => { await page.locator('.side-tabs button').nth(4).click(); await page.waitForTimeout(300) })
await step('git', async () => { await sidebar('Git'); await page.waitForTimeout(500) })
await step('git-diff', async () => { await page.locator('.git-row', { hasText: 'tsconfig' }).click({ timeout: 3000 }); await page.waitForTimeout(800) })
await step('history', async () => { await page.locator('.history-btn').click({ timeout: 8000 }); await page.waitForTimeout(500) })
await step('history-commit-open', async () => { await page.locator('.commit-row').nth(1).click({ timeout: 3000 }); await page.waitForTimeout(400) })
await step('terminal', async () => {
  await button('New terminal').click({ timeout: 8000 })
  await page.waitForTimeout(1000)
})
await openFile('report.ts')
await step('problems', async () => { await page.locator('.terminal-tabs .view-tab', { hasText: 'Problems' }).click({ timeout: 3000 }); await page.waitForTimeout(1200) })
await page.keyboard.press('ControlOrMeta+j')
await sidebar('Files').catch(() => {})
await openFile('invoice.ts')

await step('chat-empty', async () => { await button('New chat').click().catch(() => {}) })
await step('chat-mention-popup', async () => { await page.locator('.composer textarea').fill('@inv'); await page.locator('.mention-popover').waitFor({ timeout: 2000 }) })
await page.locator('.composer textarea').fill('')
await step('chat-agent-edit', async () => {
  await page.locator('.composer textarea').fill('Add tax to the total')
  await page.locator('.composer textarea').press('Enter')
  await page.getByText('kept the rounding').waitFor({ timeout: 15000 })
})
const finished = () => page.locator('.send.stop').waitFor({ state: 'hidden', timeout: 15000 })
await finished()
await step('review-hunks', async () => { await page.locator('.changes-toggle').click({ timeout: 4000 }); await page.locator('.change-row').first().click({ timeout: 4000 }); await page.locator('.hunk-actions').first().waitFor({ timeout: 4000 }); await page.waitForTimeout(500) })
await step('chat-writing-live', async () => {
  answerDelay = 260
  await page.locator('.composer textarea').fill('Add a discount helper')
  await page.locator('.composer textarea').press('Enter')
  await page.waitForTimeout(4200)
})
answerDelay = 5
await finished()
await step('chat-approval', async () => {
  await page.locator('.composer textarea').fill('Now build it')
  await page.locator('.composer textarea').press('Enter')
  await page.locator('.approval').waitFor({ timeout: 15000 })
})
await step('chat-approval-declined', async () => { await button("Don't run").click(); await page.getByText('Skipped it.').waitFor({ timeout: 15000 }) })
await step('chat-tool-open', async () => { await page.locator('.tool-head').first().click({ timeout: 3000 }) })
await step('chat-history-popup', async () => { await page.locator('.chat-title').click(); await page.locator('.chat-popover').waitFor({ timeout: 2000 }) })
await page.keyboard.press('Escape')
await page.mouse.click(700, 600)

await step('error-banner', async () => {
  await sidebar('Git')
  await button('Push').click({ timeout: 3000 })
  await page.locator('.banner').waitFor({ timeout: 8000 })
})
await page.locator('.banner').click().catch(() => {})
await sidebar('Files').catch(() => {})

// The newer panels, on the same project.
await step('extensions', async () => {
  await page.getByRole('tab', { name: 'Extensions' }).click({ timeout: 3000 })
  await page.locator('.ext-row').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(800)
})
fs.writeFileSync(path.join(root, 'src/calc.js'), 'function add(a, b) {\n  const sum = a + b\n  return sum\n}\nconst result = add(2, 3)\nconsole.log("the answer is", result)\n')
await step('debug-paused', async () => {
  await page.waitForTimeout(900)
  await openFile('calc.js')
  await page.locator('.view-line', { hasText: 'return sum' }).click()
  await page.keyboard.press('F9')
  await page.getByRole('tab', { name: 'Debug' }).click({ timeout: 3000 })
  await page.locator('#watch-input').fill('sum * 10')
  await page.locator('#watch-input').press('Enter')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.locator('.debug-state', { hasText: 'Paused' }).waitFor({ timeout: 30000 })
  await page.waitForTimeout(800)
})
await page.getByRole('button', { name: 'Stop', exact: true }).click().catch(() => {})
await page.waitForTimeout(800)
await step('git-history', async () => {
  await sidebar('Git')
  await page.keyboard.press('ControlOrMeta+j')
  await page.waitForTimeout(200)
  await page.locator('.history-btn').click({ timeout: 3000 })
  await page.waitForTimeout(800)
})
await sidebar('Files').catch(() => {})
await page.getByRole('button', { name: 'Settings' }).click()
for (const tab of ['Local', 'Anthropic', 'OpenAI', 'Custom', 'Editor']) {
  await step(`settings-${tab.toLowerCase().replace(' ', '-')}`, async () => { await page.locator('.modal-nav button', { hasText: tab }).first().click({ timeout: 3000 }); await page.waitForTimeout(500) })
}
await step('settings-editor-bottom', async () => { await page.locator('.modal-main').evaluate((el) => { el.scrollTop = el.scrollHeight }) })
await step('settings-check-now', async () => {
  await page.evaluate(() => { window.pitoo.checkUpdate = async () => ({ current: '0.2.1', latest: null }) })
})
await step('settings-anthropic-key', async () => {
  await page.locator('.modal-nav button', { hasText: 'Anthropic' }).click()
  await page.locator('#api-key').fill('test-key-value')
  await button('Save').click()
  await page.waitForTimeout(800)
})
await button('Close').click()

await event({ type: 'update', version: 'v0.3.0', url: 'https://github.com/okba-bouziane/pitoo/releases', canInstall: true })
await step('update-button', async () => { await page.locator('.update-btn').waitFor({ timeout: 2000 }) })
await step('update-downloading', async () => { await event({ type: 'update-progress', percent: 42 }); await page.locator('.update-btn.downloading').waitFor({ timeout: 2000 }) })
await step('update-ready', async () => { await event({ type: 'update-ready', label: 'Restart to update' }); await button('Restart to update').waitFor({ timeout: 2000 }) })


console.log(`${shotNumber} screenshots in ${out}`)
if (failed.length) console.log(`Could not reach:\n  ${failed.join('\n  ')}`)
await app.close()
server.close()
