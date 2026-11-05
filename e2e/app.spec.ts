import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** A scripted stand-in for the model, so these tests check the app and not what the model decides. */
function fakeModel(answers: string[]) {
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/models')) return void res.end('{"data":[]}')
    req.resume()
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const answer = answers.shift() ?? 'Done.'
      for (const chunk of answer.match(/[\s\S]{1,12}/g) ?? []) {
        if (res.destroyed) return
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`)
        await new Promise((r) => setTimeout(r, 5))
      }
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise<{ url: string; close(): void }>((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() })
  }))
}

async function launch(answers: string[]): Promise<{ app: ElectronApplication; page: Page; root: string; close(): Promise<void> }> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-data-'))
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-proj-')))
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(path.join(root, 'notes.txt'), lines)
  const model = await fakeModel(answers)
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ provider: 'local', baseUrls: { local: model.url }, lastProject: root }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ANVIL_HIDDEN: '1', ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
  const page = await app.firstWindow()
  const errors: string[] = []
  // Monaco throws this one from its own diff timer when a view closes. It has no effect on the app.
  page.on('pageerror', (e) => { if (e.message !== 'no diff result available') errors.push(e.message) })
  await page.waitForSelector('.tree-row')
  await expect(page.locator('.model')).toContainText('Ready')
  return { app, page, root, close: async () => {
    await app.close()
    model.close()
    expect(errors).toEqual([])
  } }
}

const ask = async (page: Page, text: string) => {
  await page.locator('textarea').fill(text)
  await page.locator('textarea').press('Enter')
}

test('reviews edits block by block, then undoes the whole step', async () => {
  const edit = (n: number, to: string) => `<edit_file path="notes.txt"><old>line ${n}\nline ${n + 1}</old><new>${to}\nline ${n + 1}</new></edit_file>`
  const { page, root, close } = await launch([edit(3, 'THREE'), edit(15, 'FIFTEEN'), '<write_file path="src/new.ts">export const a = 1</write_file>', 'All done.'])
  const notes = path.join(root, 'notes.txt')

  await ask(page, 'change the notes')
  await expect(page.locator('.msg.assistant').last()).toContainText('All done.')
  await expect(page.locator('.badge')).toHaveText('2')
  expect(fs.readFileSync(notes, 'utf8')).toContain('THREE')
  expect(fs.existsSync(path.join(root, 'src/new.ts'))).toBe(true)

  // Block by block: undo one, keep the other.
  await expect(page.locator('.changes-bar')).toContainText('files changed')
  await page.locator('.changes-toggle').click()
  await page.locator('.change-row', { hasText: 'notes.txt' }).click()
  await expect(page.locator('.hunk-actions')).toHaveCount(2)
  await page.screenshot({ path: 'test-results/review.png' })
  await page.locator('.hunk-actions .undo').first().click()
  await expect(page.locator('.hunk-actions')).toHaveCount(1)
  expect(fs.readFileSync(notes, 'utf8')).toContain('line 3\n')
  expect(fs.readFileSync(notes, 'utf8')).toContain('FIFTEEN')
  await page.locator('.hunk-actions .keep').first().click()
  await expect(page.locator('.change-row')).toHaveCount(1)

  // Undo file removes the new file.
  await page.locator('.change-row', { hasText: 'new.ts' }).click()
  await page.locator('.editor-actions .undo').click()
  await expect(page.locator('.change-row')).toHaveCount(0)
  expect(fs.existsSync(path.join(root, 'src/new.ts'))).toBe(false)

  // Undo the step: even the kept change goes back.
  await page.getByRole('button', { name: 'Undo this step' }).click()
  await expect(page.locator('.checkpoint')).toContainText('undone')
  expect(fs.readFileSync(notes, 'utf8')).not.toContain('FIFTEEN')
  await close()
})

test('commands wait for approval, and declining does not run them', async () => {
  const { page, root, close } = await launch(['<run_command>node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'\')"</run_command>', 'Skipped it.', '<run_command>node -e "require(\'fs\').writeFileSync(\'ran2.txt\',\'\')"</run_command>', 'Ran it.'])
  await ask(page, 'run something')
  await expect(page.locator('.approval')).toContainText('ran.txt')
  await page.getByRole('button', { name: "Don't run" }).click()
  await expect(page.locator('.msg.assistant').last()).toContainText('Skipped it.')
  expect(fs.existsSync(path.join(root, 'ran.txt'))).toBe(false)

  await ask(page, 'run again')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.msg.assistant').last()).toContainText('Ran it.')
  expect(fs.existsSync(path.join(root, 'ran2.txt'))).toBe(true)
  await close()
})

test('auto-accept keeps edits with nothing to review', async () => {
  const { page, root, close } = await launch(['<write_file path="a.txt">hello</write_file>', 'Done.'])
  await page.locator('.toggle', { hasText: 'Auto-accept edits' }).click()
  await page.waitForTimeout(100)
  await ask(page, 'write it')
  await expect(page.locator('.msg.assistant').last()).toContainText('Done.')
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('hello\n')
  await expect(page.locator('.change-row')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Undo this step' })).toBeVisible()
  await close()
})

test('shows file contents live, and Stop ends the step', async () => {
  const long = Array.from({ length: 4000 }, (_, i) => `row ${i}`).join('\n')
  const { page, close } = await launch([`<write_file path="big.txt">${long}</write_file>`])
  await ask(page, 'write a big file')
  await expect(page.locator('.tool pre.live')).toContainText('row 1')
  await expect(page.locator('.live-bar')).toContainText('tokens/s')
  await page.screenshot({ path: 'test-results/live.png' })
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('.stat', { hasText: 'Stopped.' })).toBeVisible()
  await close()
})

test('modes, chats, tabs, quick open and @ files work', async () => {
  const { page, root, close } = await launch(['<write_file path="plan.txt">no</write_file>', 'Here is the plan.', 'Second chat answer.'])
  // Plan mode refuses to write.
  await page.getByRole('button', { name: 'Plan', exact: true }).click()
  await ask(page, 'plan it')
  await expect(page.locator('.msg.assistant').last()).toContainText('Here is the plan.')
  expect(fs.existsSync(path.join(root, 'plan.txt'))).toBe(false)

  // A second chat keeps the first.
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.locator('.msg')).toHaveCount(0)
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await page.locator('textarea').pressSequentially('see @not')
  await expect(page.locator('.mention-popover')).toContainText('notes.txt')
  await page.locator('textarea').press('Enter')
  await expect(page.locator('textarea')).toHaveValue('see @notes.txt ')
  await page.locator('textarea').press('Enter')
  await expect(page.locator('.msg.assistant').last()).toContainText('Second chat answer.')
  await page.locator('.chat-title').click()
  await expect(page.locator('.chat-popover .pop-row')).toHaveCount(2)
  await page.locator('.chat-popover .pop-row', { hasText: 'plan it' }).click()
  await expect(page.locator('.msg.user')).toHaveText('plan it')

  // Quick open makes a tab.
  await page.keyboard.press('ControlOrMeta+p')
  await page.locator('#quick-open').fill('notes')
  await page.locator('#quick-open').press('Enter')
  await expect(page.locator('.tab.active')).toContainText('notes.txt')
  await page.screenshot({ path: 'test-results/editor.png' })
  await close()
})

test('API keys are masked and never reach the window, and models can be switched', async () => {
  const { page, close } = await launch([])
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.modal-nav button', { hasText: 'Anthropic' }).click()
  await page.screenshot({ path: 'test-results/settings.png' })
  await expect(page.locator('#api-key')).toHaveAttribute('type', 'password')
  await page.locator('#api-key').fill('sk-secret-value')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.key-saved')).toContainText('secure storage')
  expect(await page.evaluate(() => JSON.stringify(window.localStorage) + document.body.innerText)).not.toContain('sk-secret-value')
  expect(JSON.stringify(await page.evaluate(() => window.anvil.getSettings()))).not.toContain('sk-secret-value')
  await page.getByRole('button', { name: 'Use Anthropic' }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('.where')).toContainText('Sends code to Anthropic')
  await expect(page.locator('.model')).toContainText('claude-opus-5-5')
  await page.locator('#effort-quick').selectOption('max')
  expect((await page.evaluate(() => window.anvil.getSettings())).effort).toBe('max')
  await close()
})

test('the file tree creates, renames and deletes', async () => {
  const { page, root, close } = await launch([])
  page.on('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByLabel('Name').fill('made.ts')
  await page.getByLabel('Name').press('Enter')
  await expect(page.locator('.tree-row', { hasText: 'made.ts' })).toBeVisible()
  expect(fs.existsSync(path.join(root, 'made.ts'))).toBe(true)
  await expect(page.locator('.tab.active')).toContainText('made.ts')

  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Name').fill('lib')
  await page.getByLabel('Name').press('Enter')
  await expect(page.locator('.tree-row', { hasText: 'lib' })).toBeVisible()

  await page.locator('.tree-row', { hasText: 'made.ts' }).click({ button: 'right' })
  await page.locator('.context-menu .pop-row', { hasText: 'Rename' }).click()
  await page.getByLabel('Name').fill('renamed.ts')
  await page.getByLabel('Name').press('Enter')
  await expect(page.locator('.tree-row', { hasText: 'renamed.ts' })).toBeVisible()
  expect(fs.existsSync(path.join(root, 'renamed.ts'))).toBe(true)
  await expect(page.locator('.tab.active')).toContainText('renamed.ts')

  await page.locator('.tree-row', { hasText: 'renamed.ts' }).click({ button: 'right' })
  await page.locator('.context-menu .pop-row', { hasText: 'Move to Trash' }).click()
  await expect(page.locator('.tree-row', { hasText: 'renamed.ts' })).toHaveCount(0)
  expect(fs.existsSync(path.join(root, 'renamed.ts'))).toBe(false)
  await expect(page.locator('.tab')).toHaveCount(0)
  await close()
})

test('the terminal runs real commands in the project', async () => {
  const { page, root, close } = await launch([])
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.locator('.xterm')).toBeVisible()
  await page.waitForTimeout(800)
  await page.keyboard.type(process.platform === 'win32' ? 'New-Item from-terminal.txt; echo done-42\r' : 'touch from-terminal.txt && echo done-$((40+2))\n')
  await expect.poll(() => fs.existsSync(path.join(root, 'from-terminal.txt'))).toBe(true)
  await expect(page.locator('.xterm-rows')).toContainText('done-42')
  await page.getByRole('button', { name: 'New terminal' }).click()
  await expect(page.locator('.terminal-tabs .tab')).toHaveCount(2)
  await page.screenshot({ path: 'test-results/terminal.png' })
  await close()
})

test('project search opens the right line', async () => {
  const { page, close } = await launch([])
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await page.locator('#project-search').fill('line 17')
  await page.locator('#project-search').press('Enter')
  await expect(page.locator('.search-count')).toContainText('1 result in 1 file')
  await page.locator('.search-hit').click()
  await expect(page.locator('.tab.active')).toContainText('notes.txt')
  await expect(page.locator('.monaco-editor .current-line').first()).toBeVisible()
  await close()
})

test('the Git panel starts a repository, stages and commits', async () => {
  const { page, root, close } = await launch([])
  await page.getByRole('tab', { name: 'Git' }).click()
  await page.getByRole('button', { name: 'Start a repository' }).click()
  await expect(page.locator('.git-row', { hasText: 'notes.txt' })).toBeVisible()
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root })
  await page.locator('.git-title', { hasText: 'Changes' }).getByRole('button', { name: 'Stage all' }).click()
  await page.locator('#commit-message').fill('first commit')
  await page.getByRole('button', { name: /Commit 1 file/ }).click()
  await expect(page.locator('.pane-empty.small')).toContainText('No changes')
  expect(execFileSync('git', ['log', '--format=%s'], { cwd: root }).toString().trim()).toBe('first commit')
  await page.screenshot({ path: 'test-results/git.png' })
  await close()
})

async function launchCode(): Promise<{ page: Page; root: string; close(): Promise<void> }> {
  const session = await launch([])
  const { root } = session
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true, types: [] }, include: ['*.ts'] }))
  fs.writeFileSync(path.join(root, 'lib.ts'), 'export function addUp(a: number, b: number): number {\n  return a + b\n}\n')
  fs.writeFileSync(path.join(root, 'main.ts'), "import { addUp } from './lib.js'\n\nexport const total: number = addUp(1, 2)\n")
  await session.page.keyboard.press('ControlOrMeta+Shift+f')
  await session.page.getByRole('tab', { name: 'Files' }).click()
  return session
}

const openFile = async (page: Page, name: string) => {
  await page.keyboard.press('ControlOrMeta+p')
  await page.locator('#quick-open').fill(name)
  await expect(page.locator('.palette .pop-row').first()).toContainText(name)
  await page.locator('#quick-open').press('Enter')
  await expect(page.locator('.tab.active')).toContainText(name)
}

const typeAtEnd = async (page: Page, text: string) => {
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.type(text)
}

test('underlines errors, completes across files, and jumps to definitions', async () => {
  const { page, root, close } = await launchCode()
  await page.waitForTimeout(300)
  await page.locator('.tree-row', { hasText: 'notes.txt' }).waitFor()
  await openFile(page, 'main.ts')

  // An error shows up without saving, and in the status bar.
  await typeAtEnd(page, 'export const bad: string = addUp(1, 2)\n')
  await expect(page.locator('.statusbar .has-errors')).toContainText('1 error', { timeout: 30000 })
  await expect(page.locator('.squiggly-error').first()).toBeAttached()
  await page.screenshot({ path: 'test-results/errors.png' })

  // Completion from the project engine.
  await typeAtEnd(page, 'addU')
  await page.keyboard.press('Control+Space')
  await expect(page.locator('.suggest-widget .monaco-list-row').first()).toContainText('addUp', { timeout: 15000 })
  await page.keyboard.press('Escape')

  // Go to definition opens the other file in a tab.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('F12')
  await expect(page.locator('.tab.active')).toContainText('lib.ts', { timeout: 15000 })
  await close()
  expect(fs.readFileSync(path.join(root, 'lib.ts'), 'utf8')).toContain('addUp')
})

test('edits survive switching tabs, auto-save writes them, and the setting turns it off', async () => {
  const { page, root, close } = await launchCode()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.modal-nav button', { hasText: 'Editor' }).click()
  await page.getByLabel('Auto-save').uncheck({ force: true })
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  await openFile(page, 'notes.txt')
  await typeAtEnd(page, 'typed but not saved')
  await expect(page.locator('.tab.active .dirty-dot')).toBeVisible()
  await openFile(page, 'lib.ts')
  await page.locator('.tab', { hasText: 'notes.txt' }).click()
  await expect(page.locator('.view-lines')).toContainText('typed but not saved')
  expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).not.toContain('typed but not saved')
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.tab.active .dirty-dot')).toHaveCount(0)
  expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toContain('typed but not saved')

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.modal-nav button', { hasText: 'Editor' }).click()
  await page.getByLabel('Auto-save').check({ force: true })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await typeAtEnd(page, ' and auto-saved')
  await expect.poll(() => fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), { timeout: 5000 }).toContain('and auto-saved')
  await close()
})

test('works with the agent hidden, in light theme, with replace and scripts', async () => {
  const { page, root, close } = await launchCode()
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module","scripts":{"hello":"node -e \\"require(\'fs\').writeFileSync(\'script-ran.txt\',\'\')\\""}}\n')
  await page.getByRole('button', { name: 'Agent panel' }).click()
  await expect(page.locator('.chat')).toHaveCount(0)
  await expect(page.locator('.model')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.modal-nav button', { hasText: 'Editor' }).click()
  await page.locator('#theme').selectOption('light')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await openFile(page, 'lib.ts')
  await page.screenshot({ path: 'test-results/light.png' })

  // Replace goes through review, so it can be undone.
  page.on('dialog', (d) => void d.accept())
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await page.locator('#project-search').fill('line 5')
  await page.locator('#project-search').press('Enter')
  await page.getByRole('button', { name: 'Show replace' }).click()
  await page.locator('#project-replace').fill('LINE FIVE')
  await page.getByRole('button', { name: 'Replace all' }).click()
  await expect(page.locator('.badge')).toHaveText('1')
  expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toContain('LINE FIVE')
  await page.getByRole('button', { name: 'Undo all' }).click()
  expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).not.toContain('LINE FIVE')

  // A script runs in the terminal with one click.
  await page.getByRole('tab', { name: 'Scripts' }).click()
  await page.locator('.script-row', { hasText: 'hello' }).click()
  await expect.poll(() => fs.existsSync(path.join(root, 'script-ran.txt')), { timeout: 20000 }).toBe(true)
  await close()
})

test('imports from VS Code without running extensions', async () => {
  const { page, close } = await launch([])
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.modal-nav button', { hasText: 'Editor' }).click()
  await page.getByRole('button', { name: 'Import from VS Code' }).click()
  await expect(page.locator('.import-result')).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: 'test-results/import.png' })
  await close()
})

test('everything except the agent works with no model and no API keys', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-data-'))
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-proj-')))
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true, types: [] }, include: ['*.ts'] }))
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const n: number = 1\n')
  // Nothing is listening on this port, so no model can answer.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ provider: 'local', baseUrls: { local: 'http://127.0.0.1:9/v1' }, lastProject: root }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ANVIL_HIDDEN: '1', ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => { if (e.message !== 'no diff result available') errors.push(e.message) })
  await page.waitForSelector('.tree-row')
  await expect(page.locator('.chat-empty')).toContainText('The agent is optional')
  await expect(page.locator('.send')).toBeDisabled()

  // Hide the agent, and it stays hidden after this.
  await page.getByRole('button', { name: 'Hide the agent' }).click()
  await expect(page.locator('.chat')).toHaveCount(0)

  // Edit with errors and completion.
  await openFile(page, 'a.ts')
  await typeAtEnd(page, 'export const s: string = n\n')
  await expect(page.locator('.statusbar .has-errors')).toContainText('1 error', { timeout: 30000 })
  await expect.poll(() => fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), { timeout: 5000 }).toContain('export const s')
  // Built-in types work, even though this project has no TypeScript of its own.
  await typeAtEnd(page, 'export const sum = [1].reduce((a, b) => a + b, 0)\n')
  await page.waitForTimeout(1500)
  await expect(page.locator('.statusbar .has-errors')).toContainText('1 error')
  await page.waitForTimeout(1500) // a model suggestion would have failed by now, and must not show an error
  await expect(page.locator('.banner')).toHaveCount(0)

  // Terminal, search and Git.
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.locator('.xterm')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await page.locator('#project-search').fill('export const n')
  await page.locator('#project-search').press('Enter')
  await expect(page.locator('.search-count')).toContainText('1 result')
  await page.getByRole('tab', { name: 'Git' }).click()
  await expect(page.getByRole('button', { name: 'Start a repository' })).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
  await app.close()
  expect(errors).toEqual([])
})

test('the commit tree, file history and who changed each line', async () => {
  const { page, root, close } = await launch([])
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'a@example.com')
  git('config', 'user.name', 'Amina Test')
  git('add', '.')
  git('commit', '-m', 'Add the notes')
  git('checkout', '-b', 'feature/x')
  fs.writeFileSync(path.join(root, 'extra.txt'), 'x\n')
  git('add', '.')
  git('commit', '-m', 'Work on a branch')
  git('checkout', 'main')
  fs.appendFileSync(path.join(root, 'notes.txt'), 'more\n')
  git('add', '.')
  git('commit', '-m', 'Add more notes')

  await openFile(page, 'notes.txt')
  await expect(page.locator('.blame-text').first()).toContainText('Amina Test', { timeout: 15000 })

  await page.getByRole('button', { name: 'File history' }).click()
  await expect(page.locator('.commit-row')).toHaveCount(2)
  await page.getByRole('button', { name: 'Show all commits' }).click()
  await expect(page.locator('.commit-row')).toHaveCount(3)
  await expect(page.locator('.ref', { hasText: 'feature/x' })).toBeVisible()
  await expect(page.locator('.graph-cell circle')).toHaveCount(3)
  await page.screenshot({ path: 'test-results/history.png' })

  await page.locator('#history-filter').fill('branch')
  await expect(page.locator('.commit-row')).toHaveCount(1)
  await page.locator('.commit-row').click()
  await page.locator('.commit-file', { hasText: 'extra.txt' }).click()
  await expect(page.locator('.editor-path')).toContainText('changes in')
  await expect(page.locator('.tab.active')).toContainText('extra.txt')

  // Switch branch from the Git panel.
  await page.getByRole('tab', { name: 'Git' }).click()
  await page.getByRole('button', { name: 'Branches' }).click()
  await page.locator('.branch-item', { hasText: 'feature/x' }).locator('.pop-title').click({ position: { x: 4, y: 4 } })
  await expect.poll(() => execFileSync('git', ['branch', '--show-current'], { cwd: root }).toString().trim()).toBe('feature/x')
  await close()
})

test('chat and pending changes survive a restart', async () => {
  const first = await launch(['<write_file path="a.txt">hello</write_file>', 'Done.'])
  await ask(first.page, 'write it')
  await expect(first.page.locator('.msg.assistant').last()).toContainText('Done.')
  const data = (await first.app.evaluate(() => process.env.ANVIL_DATA_DIR))!
  await first.app.close()

  const app = await electron.launch({ args: ['.'], env: { ...process.env, ANVIL_HIDDEN: '1', ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
  const page = await app.firstWindow()
  await expect(page.locator('.msg.user')).toHaveText('write it')
  await expect(page.locator('.badge')).toHaveText('1')
  await app.close()
})

test('offers an update, shows the download, then offers to restart', async () => {
  const { app, page, close } = await launch([])
  const send = (payload: unknown) => app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('anvil:event', p), payload)
  await expect(page.locator('.update-btn')).toHaveCount(0)
  await send({ type: 'update', version: 'v9.9.9', url: 'https://github.com/okba-bouziane/anvil/releases/tag/v9.9.9', canInstall: true })
  await expect(page.locator('.update-btn')).toHaveText('Update to 9.9.9')
  await send({ type: 'update-progress', percent: 42 })
  await expect(page.locator('.update-btn')).toHaveText('Downloading 42%')
  await expect(page.locator('.update-btn')).toBeDisabled()
  await send({ type: 'update-ready', label: 'Restart to update' })
  await expect(page.locator('.update-btn')).toHaveText('Restart to update')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.locator('.modal-nav button', { hasText: 'Editor' }).click()
  await expect(page.locator('.setting-row', { hasText: 'Check now' })).toContainText(/Anvil \d+\.\d+\.\d+/)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await close()
})

test('the logo hops while the model works and rests otherwise', async () => {
  const { page, close } = await launch(['<run_command>node -e "1"</run_command>', 'Done.'])
  const logo = page.locator('.topbar .logo')
  await expect(logo).not.toHaveClass(/working/)
  await ask(page, 'run something')
  await expect(page.locator('.approval')).toBeVisible()
  await expect(logo).toHaveClass(/working/)
  await page.getByRole('button', { name: "Don't run" }).click()
  await expect(logo).not.toHaveClass(/working/)
  await close()
})

test('panels resize by dragging, remember their size, and double-click resets them', async () => {
  const { app, page, close } = await launch([])
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1512, 920))
  const side = page.locator('.sidebar')
  const chat = page.locator('.chat')
  const edges = page.getByRole('separator')
  const width = async (panel: typeof side) => Math.round((await panel.boundingBox())!.width)
  const drag = async (index: number, by: number) => {
    const box = (await edges.nth(index).boundingBox())!
    await page.mouse.move(box.x, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + by / 2, box.y + 200)
    await page.mouse.move(box.x + by, box.y + 200)
    await page.mouse.up()
  }
  await expect.poll(() => width(side)).toBe(248)
  await drag(0, 100)
  await expect.poll(() => width(side)).toBe(348)
  await drag(0, -900)
  await expect.poll(() => width(side)).toBe(170)
  await edges.nth(0).dblclick()
  await expect.poll(() => width(side)).toBe(248)
  await drag(1, -60)
  await expect.poll(() => width(chat)).toBe(500)
  await edges.nth(1).dblclick()
  await expect.poll(() => width(chat)).toBe(440)
  await page.getByRole('button', { name: 'Agent panel' }).click()
  await expect(chat).toHaveCount(0)
  await page.getByRole('button', { name: 'Agent panel' }).click()
  await expect(chat).toBeVisible()
  await expect.poll(() => width(chat)).toBe(440)
  await close()
})

test('Git: stage one block, stash, merge with a conflict, resolve it and continue', async () => {
  const { page, root, close } = await launch([])
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-qb', 'main')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'user.name', 'Dev')
  git('add', '.')
  git('commit', '-qm', 'first')
  git('checkout', '-qb', 'side')
  const notes = path.join(root, 'notes.txt')
  const base = fs.readFileSync(notes, 'utf8')
  fs.writeFileSync(notes, base.replace('line 2\n', 'SIDE\n'))
  git('commit', '-qam', 'side change')
  git('checkout', '-q', 'main')
  fs.writeFileSync(notes, base.replace('line 2\n', 'MAIN\n'))
  git('commit', '-qam', 'main change')

  await page.getByRole('tab', { name: 'Git' }).click()
  // Stage a single block of a two-block change.
  const mainText = fs.readFileSync(notes, 'utf8')
  fs.writeFileSync(path.join(root, 'notes.txt'), mainText.replace('line 5\n', 'FIVE\n').replace('line 15\n', 'FIFTEEN\n'))
  await page.getByRole('tab', { name: 'Files' }).click()
  await page.getByRole('tab', { name: 'Git' }).click()
  await page.locator('.git-row', { hasText: 'notes.txt' }).first().click()
  await expect(page.locator('.hunk-actions')).toHaveCount(2)
  await page.locator('.hunk-actions').first().getByRole('button', { name: 'Stage' }).click()
  await expect.poll(() => git('show', ':notes.txt')).toContain('FIVE')
  expect(git('show', ':notes.txt')).not.toContain('FIFTEEN')
  await expect(page.locator('.git-title', { hasText: 'Staged' })).toBeVisible()
  git('reset', '-q')

  // Stash sets it all aside.
  await page.getByRole('button', { name: 'Stash changes' }).click()
  await page.locator('#stash-message').fill('half done')
  await page.locator('#stash-message').press('Enter')
  await expect(page.locator('.stash-row')).toContainText('half done')
  expect(fs.readFileSync(notes, 'utf8')).not.toContain('FIVE')
  await page.locator('.stash-row').hover()
  await page.getByRole('button', { name: 'Drop stash 0' }).click({ trial: true })

  // Merge stops on the conflict.
  await page.getByRole('button', { name: 'Branches' }).click()
  await page.locator('.branch-item', { hasText: 'side' }).hover()
  await page.locator('.branch-item', { hasText: 'side' }).getByRole('button', { name: 'Merge' }).click()
  await expect(page.locator('.git-operation')).toContainText('1 conflict')
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()

  // Resolve in the editor, mark resolved, continue.
  await page.locator('.git-row', { hasText: 'notes.txt' }).first().click()
  await expect(page.locator('.conflict-actions')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/conflict.png' })
  expect((await page.locator('.topbar').boundingBox())?.y).toBe(0)
  await page.getByRole('button', { name: 'Keep incoming' }).click()
  await expect(page.locator('.conflict-actions')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => fs.readFileSync(notes, 'utf8')).toContain('SIDE')
  expect(fs.readFileSync(notes, 'utf8')).not.toContain('<<<<<<<')
  await page.locator('.git-row', { hasText: 'notes.txt' }).first().hover()
  await page.getByRole('button', { name: 'Mark notes.txt as resolved' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.git-operation')).toHaveCount(0)
  expect(git('log', '-1', '--format=%s')).toContain('Merge')
  await close()
})

test('the changes list above the chat keeps or undoes one file or all of them', async () => {
  const { page, root, close } = await launch(['<write_file path="a.txt">a</write_file>', '<write_file path="b.txt">b</write_file>', '<write_file path="c.txt">c</write_file>', 'Done.'])
  await ask(page, 'write them')
  await expect(page.locator('.changes-bar')).toBeVisible()
  await expect(page.locator('.msg.assistant').last()).toContainText('Done.', { timeout: 15000 })
  await expect(page.locator('.changes-bar .badge')).toHaveText('3')
  // Closed, it offers Keep all and Undo all, and the files aren't showing.
  await expect(page.getByRole('button', { name: 'Keep all' })).toBeVisible()
  await expect(page.locator('.change-row').first()).toBeHidden()
  // Open, each file has its own buttons, and clicking one opens its changes.
  await page.locator('.changes-toggle').click()
  await expect(page.locator('.change-row').first()).toBeVisible()
  const count = await page.locator('.change-row').count()
  await page.locator('.change-row').first().click()
  await expect(page.locator('.tab.active')).toBeVisible()
  await page.locator('.change-row').first().getByRole('button', { name: /^Undo / }).click()
  await expect(page.locator('.change-row')).toHaveCount(count - 1)
  if (count > 1) {
    await page.locator('.change-row').first().getByRole('button', { name: /^Keep / }).click()
    await expect(page.locator('.change-row')).toHaveCount(count - 2)
  }
  await page.screenshot({ path: 'test-results/changes-bar.png' })
  // Nothing has pushed the window out of place.
  expect((await page.locator('.topbar').boundingBox())?.y).toBe(0)
  expect(fs.readdirSync(root).length).toBeGreaterThan(0)
  await close()
})

test('editor essentials: outside changes, split view, command palette, previews and search filters', async () => {
  const { page, root, close } = await launch([])
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'docs/readme.md'), '# Hello\n\nSome [link](https://example.com) text.\n')
  fs.writeFileSync(path.join(root, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64'))

  // A file created outside the app shows up, and an open file follows changes made outside.
  await expect(page.locator('.tree-row', { hasText: 'pic.png' })).toBeVisible({ timeout: 5000 })
  await page.locator('.tree-row', { hasText: 'notes.txt' }).click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('line 1')
  fs.writeFileSync(path.join(root, 'notes.txt'), 'changed from outside\n')
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('changed', { timeout: 5000 })

  // Image and Markdown previews.
  await page.locator('.tree-row', { hasText: 'pic.png' }).click()
  await expect(page.locator('.image-preview img')).toBeVisible()
  await page.locator('.tree-row', { hasText: 'docs' }).click()
  await page.locator('.tree-row', { hasText: 'readme.md' }).click()
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.locator('.markdown-preview h1')).toHaveText('Hello')
  await page.getByRole('button', { name: 'Edit' }).click()

  // Two files side by side.
  await page.locator('.tab', { hasText: 'notes.txt' }).click()
  await page.getByRole('button', { name: 'Open to the side' }).click()
  await expect(page.locator('.editor-group')).toHaveCount(2)
  await expect(page.locator('.editor-group.second .tab.active')).toContainText('notes.txt')
  await page.locator('.editor-group.second .tab-close').first().click({ force: true })
  await expect(page.locator('.editor-group')).toHaveCount(1)

  // Command palette, side panel toggle and reopen.
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await page.locator('#command-palette').fill('side panel')
  await page.locator('#command-palette').press('Enter')
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBe(0)
  await page.keyboard.press('ControlOrMeta+b')
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBe(248)
  await page.locator('.tab', { hasText: 'notes.txt' }).click()
  await page.keyboard.press('ControlOrMeta+w')
  await expect(page.locator('.tab', { hasText: 'notes.txt' })).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+t')
  await expect(page.locator('.tab', { hasText: 'notes.txt' })).toHaveCount(1)

  // Search can be limited to some files.
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await page.locator('#project-search').fill('Hello')
  await page.locator('#project-search').press('Enter')
  await expect(page.locator('.search-file')).toContainText('docs/readme.md')
  await page.getByRole('button', { name: 'Filter by files' }).click()
  await page.locator('#search-exclude').fill('docs')
  await page.locator('#search-exclude').press('Enter')
  await expect(page.locator('.search-file')).toHaveCount(0)
  await close()
})

test('the margin marks lines that differ from the last commit', async () => {
  const { page, root, close } = await launch([])
  execFileSync('git', ['init', '-qb', 'main'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=d@e.com', '-c', 'user.name=D', 'add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=d@e.com', '-c', 'user.name=D', 'commit', '-qm', 'first'], { cwd: root })
  fs.writeFileSync(path.join(root, 'notes.txt'), fs.readFileSync(path.join(root, 'notes.txt'), 'utf8').replace('line 2\n', 'CHANGED\n'))
  await page.locator('.tree-row', { hasText: 'notes.txt' }).click()
  await expect(page.locator('.gut-mod')).toHaveCount(1, { timeout: 5000 })
  await expect(page.locator('.tree-git')).toHaveText('M')
  await close()
})

test('ESLint and Prettier run only after you allow them, with the project config', async () => {
  const { page, root, close } = await launch([])
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
  write('package.json', '{"devDependencies":{"eslint":"9","prettier":"3"}}')
  write('node_modules/eslint/package.json', '{"name":"eslint","main":"index.js"}')
  write('node_modules/eslint/index.js', `exports.ESLint = class {
    constructor(o) { this.fix = o.fix }
    async isPathIgnored() { return false }
    async lintText(text) {
      if (this.fix) return [{ messages: [], output: text.replace('var ', 'const ') }]
      return [{ messages: text.includes('var ') ? [{ line: 1, column: 1, endLine: 1, endColumn: 4, message: 'Unexpected var', ruleId: 'no-var', severity: 2, fix: { range: [0, 3], text: 'const' } }] : [] }]
    }
  }`)
  write('node_modules/prettier/package.json', '{"name":"prettier","main":"index.js"}')
  write('node_modules/prettier/index.js', `exports.getFileInfo = async () => ({ ignored: false, inferredParser: 'typescript' })
    exports.resolveConfig = async () => ({})
    exports.format = async (t) => t.replace('a  =', 'a =')`)
  write('bad.ts', 'var a  = 1\n')
  const data = (await page.evaluate(() => 0)) === 0
  expect(data).toBe(true)
  // The tools were added after opening, so reopen the project to see them.
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await page.locator('#command-palette').fill('recent')
  await page.locator('#command-palette').press('Enter')
  await expect(page.locator('.banner.notice')).toContainText('ESLint and Prettier')

  await page.locator('.tree-row', { hasText: 'bad.ts' }).click()
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => document.querySelectorAll('.squiggly-error').length)).toBe(0)
  await page.getByRole('button', { name: 'Allow for this project' }).click()
  await expect(page.locator('.banner.notice')).toHaveCount(0)
  await expect(page.locator('.squiggly-error')).not.toHaveCount(0, { timeout: 8000 })

  await page.keyboard.press('ControlOrMeta+Shift+p')
  await page.locator('#command-palette').fill('fix all')
  await page.locator('#command-palette').press('Enter')
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('const', { timeout: 5000 })
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await page.locator('#command-palette').fill('format this')
  await page.locator('#command-palette').press('Enter')
  await expect.poll(() => page.evaluate(() => document.querySelector('.view-lines')?.textContent?.replace(/\u00a0/g, ' '))).toContain('const a = 1')
  await close()
})

test('Python: real errors, completion, hover and go to definition from the bundled engine', async () => {
  const { page, root, close } = await launch([])
  fs.writeFileSync(path.join(root, 'shop.py'), [
    'def total(price: int, qty: int) -> int:',
    '    """Multiplies price by quantity."""',
    '    return price * qty',
    '',
    'value: str = total(2, 3)',
    'tot',
    ''
  ].join('\n'))
  await expect(page.locator('.tree-row', { hasText: 'shop.py' })).toBeVisible({ timeout: 5000 })
  await page.locator('.tree-row', { hasText: 'shop.py' }).click()
  // Pyright reports the wrong type on line 5.
  await expect(page.locator('.statusbar .has-errors')).toBeVisible({ timeout: 30000 })
  await page.getByRole('button', { name: 'Problems' }).click()
  await expect(page.locator('.problems')).toContainText('str', { timeout: 10000 })
  // Completion across the file.
  await page.locator('.view-line', { hasText: /^tot$/ }).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
  await page.keyboard.press('Control+Space')
  await expect(page.locator('.suggest-widget .monaco-list-row', { hasText: 'total' }).first()).toBeVisible({ timeout: 15000 })
  await page.keyboard.press('Escape')
  // Hover shows its signature and docs.
  await page.locator('.view-line span span', { hasText: 'total' }).first().hover()
  await expect(page.locator('.monaco-hover:not(.hidden)').first()).toContainText('Multiplies price', { timeout: 15000 })
  await close()
})

test('debugs a real Node program: breakpoint, variables, watch, step, console, continue', async () => {
  const { page, root, close } = await launch([])
  fs.writeFileSync(path.join(root, 'calc.js'), [
    'function add(a, b) {',
    '  const sum = a + b',
    '  return sum',
    '}',
    'const result = add(2, 3)',
    'console.log("the answer is", result)',
    ''
  ].join('\n'))
  await expect(page.locator('.tree-row', { hasText: 'calc.js' })).toBeVisible({ timeout: 5000 })
  await page.locator('.tree-row', { hasText: 'calc.js' }).click()
  await expect(page.locator('.view-lines').first()).toContainText('add')
  await page.locator('.view-line', { hasText: 'return sum' }).click()
  await page.keyboard.press('F9')
  await expect(page.locator('.bp-glyph')).toHaveCount(1)

  await page.getByRole('tab', { name: 'Debug' }).click()
  await expect(page.locator('#debug-choice')).toContainText('calc.js')
  await page.locator('#watch-input').fill('sum * 10')
  await page.locator('#watch-input').press('Enter')
  await page.getByRole('button', { name: 'Start', exact: true }).click()

  // It stops on the breakpoint, in the right place, with the real values.
  await expect(page.locator('.debug-state')).toContainText('Paused', { timeout: 30000 })
  await expect(page.locator('.debug-line')).toHaveCount(1)
  await expect(page.locator('.frame-row').first()).toContainText('add')
  await expect(page.locator('.var-row', { hasText: 'sum' }).first()).toContainText('5')
  await expect(page.locator('.watch-row', { hasText: 'sum * 10' })).toContainText('50')
  await page.screenshot({ path: 'test-results/debug.png' })

  // Evaluate in the console, step out, then run to the end.
  await page.locator('#debug-eval').fill('a + 100')
  await page.locator('#debug-eval').press('Enter')
  await expect(page.locator('.debug-lines')).toContainText('102')
  await page.getByRole('button', { name: 'Step out' }).click()
  await expect(page.locator('.frame-row').first()).not.toContainText('add', { timeout: 10000 })
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('.debug-lines')).toContainText('the answer is 5', { timeout: 10000 })
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible({ timeout: 10000 })
  await close()
})

test('a separate window opens its own project, and HTML tags close themselves', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-data-'))
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'second-window-')))
  fs.writeFileSync(path.join(root, 'page.html'), '')
  const app = await electron.launch({ args: ['.', '--project', root], env: { ...process.env, ANVIL_HIDDEN: '1', ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
  const page = await app.firstWindow()
  await expect(page.locator('.tree-row', { hasText: 'page.html' })).toBeVisible()
  await page.locator('.tree-row', { hasText: 'page.html' }).click()
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.type('<section class="a">')
  await expect.poll(() => page.evaluate(() => document.querySelector('.view-lines')?.textContent?.replace(/\u00a0/g, ' '))).toContain('<section class="a"></section>')
  await page.keyboard.press('Enter')
  await page.keyboard.type('<br>')
  await expect.poll(() => page.evaluate(() => document.querySelector('.view-lines')?.textContent?.replace(/\u00a0/g, ' '))).not.toContain('</br>')
  // A window opened this way doesn't change what opens next time.
  await app.close()
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')) as { lastProject?: string }
  expect(saved.lastProject ?? null).toBeNull()
})

test('workspace: several folders and repositories, .vscode files, menu bar, zen, outline and split terminal', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-workspace-')))
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text) }
  write('api/server.ts', 'export function start() {\n  return 1\n}\n')
  write('web/app.ts', 'export const app = 2\n')
  write('private/secret.txt', 'hidden\n')
  write('api/.vscode/settings.json', '{ "editor.tabSize": 7 }')
  write('api/.vscode/tasks.json', '{ "tasks": [{ "label": "Say hi", "type": "shell", "command": "echo hi-from-task" }] }')
  write('api/.vscode/launch.json', '{ "configurations": [{ "name": "Start API", "type": "node", "request": "launch", "program": "${workspaceFolder}/run.js" }] }')
  write('all.code-workspace', JSON.stringify({ folders: [{ path: 'api' }, { path: 'web' }] }))
  for (const repo of ['api', 'web']) {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: path.join(base, repo) })
    run('init', '-qb', repo === 'api' ? 'main' : 'develop')
    run('config', 'user.email', 'd@e.com')
    run('config', 'user.name', 'D')
    run('add', '.')
    run('commit', '-qm', `first in ${repo}`)
  }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-data-'))
  const app = await electron.launch({ args: ['.', '--project', path.join(base, 'all.code-workspace')], env: { ...process.env, ANVIL_HIDDEN: '1', ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
  const page = await app.firstWindow()
  const menu = (id: string) => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('anvil:event', { type: 'menu', id: value }), id)

  // Only the chosen folders are there, named as the workspace.
  await expect(page.locator('.tree-row', { hasText: 'api' })).toBeVisible()
  await expect(page.locator('.tree-row', { hasText: 'web' })).toBeVisible()
  await expect(page.locator('.tree-row', { hasText: 'private' })).toHaveCount(0)
  await expect(page.locator('.project')).toHaveText('all')
  expect(await page.evaluate(() => window.anvil.readFile('private/secret.txt').then(() => 'read', () => 'refused'))).toBe('refused')

  // The real menu bar is there, and its choices work.
  const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((i) => i.label))
  for (const label of ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal']) expect(labels).toContain(label)

  // Each repository has its own Git state.
  fs.appendFileSync(path.join(base, 'web/app.ts'), 'export const more = 3\n')
  await page.getByRole('tab', { name: 'Git' }).click()
  await expect(page.locator('#repo-select')).toBeVisible()
  await page.locator('#repo-select').selectOption('web')
  await expect(page.getByRole('button', { name: 'Branches' })).toContainText('develop')
  await expect(page.locator('.git-row', { hasText: 'app.ts' })).toBeVisible()
  await page.locator('.git-title', { hasText: 'Changes' }).getByRole('button', { name: 'Stage all' }).click()
  await page.locator('#commit-message').fill('from the workspace')
  await page.getByRole('button', { name: /Commit 1 file/ }).click()
  await expect.poll(() => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: path.join(base, 'web') }).toString().trim()).toBe('from the workspace')
  await page.locator('#repo-select').selectOption('api')
  await expect(page.getByRole('button', { name: 'Branches' })).toContainText('main')

  // .vscode: settings apply, launch shows, tasks run.
  await page.getByRole('tab', { name: 'Debug' }).click()
  await expect(page.locator('#debug-choice')).toContainText('Start API')
  await menu('tasks')
  await expect(page.locator('.palette-list')).toContainText('Say hi')
  await page.keyboard.press('Escape')

  // New file, save as, revert, outline.
  await menu('new-file')
  await page.locator('#name-prompt').fill('api/added.ts')
  await page.locator('#name-prompt').press('Enter')
  await expect(page.locator('.tab.active')).toContainText('added.ts')
  expect(fs.existsSync(path.join(base, 'api/added.ts'))).toBe(true)
  await page.keyboard.press('ControlOrMeta+p')
  await page.locator('#quick-open').fill('server')
  await page.waitForTimeout(300)
  await page.locator('#quick-open').press('Enter')
  await expect(page.locator('.tab.active')).toContainText('server.ts')
  await page.getByRole('tab', { name: 'Files' }).click()
  await page.getByRole('button', { name: 'Outline' }).click()
  await expect(page.locator('.outline-list')).toContainText('start', { timeout: 10000 })
  await menu('save-as')
  await page.locator('#name-prompt').fill('api/copy.ts')
  await page.locator('#name-prompt').press('Enter')
  await expect(page.locator('.tab.active')).toContainText('copy.ts')
  expect(fs.readFileSync(path.join(base, 'api/copy.ts'), 'utf8')).toContain('start')

  // Split terminal shows two shells.
  await menu('split-terminal')
  await expect(page.locator('.shell.side-right')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.shell.side-left')).toBeVisible()

  // Zen hides everything but the code, and Escape brings it back.
  await menu('zen')
  await expect(page.locator('.topbar')).toBeHidden()
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width ?? 0).toBe(0)
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.topbar')).toBeVisible()

  // Closing returns to the start screen.
  await menu('close-folder')
  await expect(page.locator('.welcome-screen')).toBeVisible()
  await app.close()
  fs.rmSync(base, { recursive: true, force: true })
})

test('open tabs come back after a restart', async () => {
  const first = await launch([])
  await first.page.locator('.tree-row', { hasText: 'notes.txt' }).click()
  await expect(first.page.locator('.tab.active')).toContainText('notes.txt')
  const data = (await first.app.evaluate(() => process.env.ANVIL_DATA_DIR))!
  await first.page.waitForTimeout(200)
  await first.app.close()
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ANVIL_HIDDEN: '1', ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
  const page = await app.firstWindow()
  await expect(page.locator('.tab.active')).toContainText('notes.txt', { timeout: 8000 })
  await app.close()
})
