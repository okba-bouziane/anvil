import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderId } from '../shared/types'

/** API keys are encrypted with the macOS Keychain and only ever used in this process. */
export class Secrets {
  private memory = new Map<ProviderId, string>()

  constructor(private file: string, private memoryOnly = false) {}

  private read(): Partial<Record<ProviderId, string>> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  private write(data: Partial<Record<ProviderId, string>>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 })
  }

  set(provider: ProviderId, key: string): void {
    if (this.memoryOnly) return void this.memory.set(provider, key)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac cannot encrypt the key right now, so it was not saved.')
    this.write({ ...this.read(), [provider]: safeStorage.encryptString(key).toString('base64') })
  }

  get(provider: ProviderId): string | null {
    if (this.memoryOnly) return this.memory.get(provider) ?? null
    const stored = this.read()[provider]
    return stored ? safeStorage.decryptString(Buffer.from(stored, 'base64')) : null
  }

  has(provider: ProviderId): boolean {
    return this.memoryOnly ? this.memory.has(provider) : !!this.read()[provider]
  }

  clear(provider: ProviderId): void {
    if (this.memoryOnly) return void this.memory.delete(provider)
    const data = this.read()
    delete data[provider]
    this.write(data)
  }
}
