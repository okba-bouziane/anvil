import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assetFor, downloadAsset, newer, SWAP_SCRIPT } from '../src/main/updater'

const asset = (name: string, url = `https://github.com/okba-bouziane/pitoo/releases/download/v9.0.0/${name}`) => ({ name, size: 1, browser_download_url: url })
const assets = ['Pitoo-mac-arm64.zip', 'Pitoo-win-x64.exe', 'Pitoo-linux-x86_64.AppImage', 'Pitoo-linux-amd64.deb'].map((n) => asset(n))
const temp: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitoo-updater-'))
  temp.push(dir)
  return dir
}
afterEach(() => temp.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

describe('newer', () => {
  it('compares each part as a number', () => {
    expect(newer('v0.10.0', '0.9.9')).toBe(true)
    expect(newer('v0.2.1', '0.2.1')).toBe(false)
    expect(newer('v0.2.0', '0.2.1')).toBe(false)
  })
})

describe('assetFor', () => {
  it('picks the installer for each computer', () => {
    expect(assetFor(assets, { platform: 'darwin', arch: 'arm64' })?.name).toBe('Pitoo-mac-arm64.zip')
    expect(assetFor(assets, { platform: 'win32', arch: 'x64' })?.name).toBe('Pitoo-win-x64.exe')
    expect(assetFor(assets, { platform: 'linux', arch: 'x64', appImage: '/a/Pitoo.AppImage' })?.name).toBe('Pitoo-linux-x86_64.AppImage')
    expect(assetFor(assets, { platform: 'linux', arch: 'x64' })?.name).toBe('Pitoo-linux-amd64.deb')
  })

  it('offers nothing for a computer with no build', () => {
    expect(assetFor(assets, { platform: 'darwin', arch: 'x64' })).toBeNull()
    expect(assetFor(assets, { platform: 'linux', arch: 'arm64' })).toBeNull()
  })

  it('ignores a file hosted anywhere but this project', () => {
    expect(assetFor([asset('Pitoo-mac-arm64.zip', 'https://example.com/Pitoo-mac-arm64.zip')], { platform: 'darwin', arch: 'arm64' })).toBeNull()
  })
})

describe('downloadAsset', () => {
  const serve = async (body: Buffer) => {
    const server = http.createServer((_, res) => res.end(body))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`, close: () => server.close() }
  }

  it('saves the file and reports progress', async () => {
    const body = Buffer.alloc(4096, 7)
    const { url, close } = await serve(body)
    const seen: number[] = []
    const file = await downloadAsset({ name: 'Pitoo.zip', size: body.length, browser_download_url: url }, tempDir(), (p) => seen.push(p))
    close()
    expect(fs.readFileSync(file).equals(body)).toBe(true)
    expect(seen.at(-1)).toBe(100)
  })

  it('refuses a file that came up short', async () => {
    const { url, close } = await serve(Buffer.alloc(10))
    const dir = tempDir()
    await expect(downloadAsset({ name: 'Pitoo.zip', size: 20, browser_download_url: url }, dir, () => {})).rejects.toThrow('incomplete')
    close()
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('the swap', () => {
  const run = (target: string, replacement: string, relaunch: string[]) => new Promise<void>((resolve) => {
    const waitFor = spawn('/bin/sleep', ['0.4'])
    spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', String(waitFor.pid), target, replacement, ...relaunch]).on('exit', () => resolve())
  })

  it('waits for the app to close, replaces it and starts the new one', async () => {
    const dir = tempDir()
    const target = path.join(dir, 'Pitoo.app')
    const replacement = path.join(dir, 'new', 'Pitoo.app')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'version'), 'old')
    fs.mkdirSync(replacement, { recursive: true })
    fs.writeFileSync(path.join(replacement, 'version'), 'new')
    await run(target, replacement, ['touch', path.join(dir, 'started')])
    expect(fs.readFileSync(path.join(target, 'version'), 'utf8')).toBe('new')
    expect(fs.existsSync(path.join(dir, 'started'))).toBe(true)
    expect(fs.readdirSync(dir).filter((n) => n.includes('.old.'))).toEqual([])
  })

  it('puts the old copy back if the new one is missing', async () => {
    const dir = tempDir()
    const target = path.join(dir, 'Pitoo.app')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'version'), 'old')
    await run(target, path.join(dir, 'missing.app'), ['true'])
    expect(fs.readFileSync(path.join(target, 'version'), 'utf8')).toBe('old')
  })
})
