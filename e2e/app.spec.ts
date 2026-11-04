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
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
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
  const { page, root, close } = await launch([edit(3, 'THREE'), edit(25, 'TWENTY-FIVE'), '<write_file path="src/new.ts">export const a = 1</write_file>', 'All done.'])
  const notes = path.join(root, 'notes.txt')

  await ask(page, 'change the notes')
  await expect(page.locator('.msg.assistant').last()).toContainText('All done.')
  await expect(page.locator('.badge')).toHaveText('2')
  expect(fs.readFileSync(notes, 'utf8')).toContain('THREE')
  expect(fs.existsSync(path.join(root, 'src/new.ts'))).toBe(true)

  // Block by block: undo one, keep the other.
  await page.locator('.change-row', { hasText: 'notes.txt' }).click()
  await expect(page.locator('.hunk-actions')).toHaveCount(2)
  await page.screenshot({ path: 'test-results/review.png' })
  await page.locator('.hunk-actions .undo').first().click()
  await expect(page.locator('.hunk-actions')).toHaveCount(1)
  expect(fs.readFileSync(notes, 'utf8')).toContain('line 3\n')
  expect(fs.readFileSync(notes, 'utf8')).toContain('TWENTY-FIVE')
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
  expect(fs.readFileSync(notes, 'utf8')).not.toContain('TWENTY-FIVE')
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
  await page.getByRole('tab', { name: 'Changes' }).click()
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
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
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
  await page.locator('#branch-select').selectOption('feature/x')
  await expect.poll(() => execFileSync('git', ['branch', '--show-current'], { cwd: root }).toString().trim()).toBe('feature/x')
  await close()
})

test('chat and pending changes survive a restart', async () => {
  const first = await launch(['<write_file path="a.txt">hello</write_file>', 'Done.'])
  await ask(first.page, 'write it')
  await expect(first.page.locator('.msg.assistant').last()).toContainText('Done.')
  const data = (await first.app.evaluate(() => process.env.ANVIL_DATA_DIR))!
  await first.app.close()

  const app = await electron.launch({ args: ['.'], env: { ...process.env, ANVIL_DATA_DIR: data, ANVIL_MEMORY_SECRETS: '1' } })
  const page = await app.firstWindow()
  await expect(page.locator('.msg.user')).toHaveText('write it')
  await expect(page.locator('.badge')).toHaveText('1')
  await app.close()
})
