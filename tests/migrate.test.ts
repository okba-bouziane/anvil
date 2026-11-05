import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrateOldData } from '../src/main/migrate'

let from: string
let to: string
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-migrate-'))
  from = path.join(base, 'Anvil')
  to = path.join(base, 'Pitoo')
  fs.mkdirSync(path.join(from, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(from, 'settings.json'), '{"theme":"dark"}')
  fs.writeFileSync(path.join(from, 'sessions', 'a.json'), '{}')
  fs.writeFileSync(path.join(from, 'secrets.json'), '{"anthropic":"encrypted"}')
  fs.writeFileSync(path.join(from, 'Cookies'), 'browser data')
})

describe('coming from the old name', () => {
  it('brings settings and chats, but not keys or browser data', () => {
    expect(migrateOldData(from, to)).toBe(true)
    expect(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).toContain('dark')
    expect(fs.existsSync(path.join(to, 'sessions', 'a.json'))).toBe(true)
    expect(fs.existsSync(path.join(to, 'secrets.json'))).toBe(false)
    expect(fs.existsSync(path.join(to, 'Cookies'))).toBe(false)
  })

  it('leaves the old folder in place, and never overwrites newer data', () => {
    fs.mkdirSync(to)
    fs.writeFileSync(path.join(to, 'settings.json'), '{"theme":"light"}')
    expect(migrateOldData(from, to)).toBe(false)
    expect(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).toContain('light')
    expect(fs.existsSync(path.join(from, 'settings.json'))).toBe(true)
  })

  it('does nothing for a new user', () => {
    expect(migrateOldData(path.join(from, 'missing'), to)).toBe(false)
    expect(fs.existsSync(to)).toBe(false)
  })
})
