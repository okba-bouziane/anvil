// Opens Anvil on screen and types a request, so the run can be watched. Only builds and tests get approved.
import { _electron as electron } from '@playwright/test'

const [dataDir, request] = process.argv.slice(2)
const SAFE = /^(cd (backend|frontend) && )?(npm test|npm run (build|test)|npx tsc --noEmit[^;&|]*|npx ng build|npx vitest run)$/
const app = await electron.launch({ args: ['.'], env: { ...process.env, ANVIL_DATA_DIR: dataDir } })
const page = await app.firstWindow()
await page.waitForSelector('.tree-row')
await page.waitForSelector('.model.online', { timeout: 150000 })
await app.evaluate(({ app }) => app.focus({ steal: true }))
await page.locator('textarea').pressSequentially(request, { delay: 8 })
await page.locator('textarea').press('Enter')
const answered = new Set()
const timer = setInterval(async () => {
  try {
    for (const card of await page.locator('.approval:has(button)').all()) {
      const command = (await card.locator('pre').innerText()).trim()
      if (answered.has(card)) continue
      console.log('approval:', command)
      await card.getByRole('button', { name: SAFE.test(command) ? 'Run' : "Don't run", exact: true }).click()
    }
    const done = await page.locator('button.send:not(.stop)').count()
    if (done && !(await page.locator('.live-bar').count())) {
      console.log('finished', await page.locator('.check, .checkpoint, .msg.assistant').last().innerText())
      clearInterval(timer)
    }
  } catch { /* the window was closed */ }
}, 1000)
await new Promise((resolve) => app.on('close', resolve))
clearInterval(timer)
process.exit(0)
