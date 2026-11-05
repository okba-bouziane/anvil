import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Runs the project's own ESLint and Prettier, with the project's own config, the same way VS Code does.
 * Both are looked up from the file outward, so each package in a monorepo gets its own versions and rules.
 */

export interface LintMessage {
  line: number
  column: number
  endLine: number
  endColumn: number
  message: string
  rule: string | null
  severity: 'error' | 'warning'
  fix: { start: number; end: number; text: string } | null
}

type ESLintClass = new (options: { cwd: string; fix?: boolean }) => {
  lintText(text: string, options: { filePath: string }): Promise<{ messages: { line?: number; column?: number; endLine?: number; endColumn?: number; message: string; ruleId: string | null; severity: number; fix?: { range: [number, number]; text: string } }[]; output?: string }[]>
  isPathIgnored(file: string): Promise<boolean>
}

interface Prettier {
  format(text: string, options: Record<string, unknown>): string | Promise<string>
  resolveConfig(file: string, options?: { editorconfig?: boolean }): Promise<Record<string, unknown> | null>
  getFileInfo(file: string, options?: Record<string, unknown>): Promise<{ ignored: boolean; inferredParser: string | null }>
}

export class Tooling {
  private eslints = new Map<string, { cwd: string; ESLint: ESLintClass } | null>()
  private prettiers = new Map<string, Prettier | null>()

  constructor(private root: string) {}

  /** Node's own lookup, from the file's folder. A copy installed outside the project doesn't count. */
  private locate(file: string, name: string): string | null {
    try {
      const resolved = createRequire(path.join(path.dirname(file), 'noop.js')).resolve(name)
      return fs.realpathSync(resolved).startsWith(fs.realpathSync(this.root)) ? resolved : null
    } catch {
      return null
    }
  }

  /** ESLint looks for its config from where it runs, so it runs from the folder that has the config. */
  private configFolder(file: string): string {
    let dir = path.dirname(file)
    for (;;) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((name) => /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/.test(name))) return dir
      if (dir === this.root || !dir.startsWith(this.root)) return this.root
      dir = path.dirname(dir)
    }
  }

  private eslintFor(file: string): { cwd: string; ESLint: ESLintClass } | null {
    const key = path.dirname(file)
    if (this.eslints.has(key)) return this.eslints.get(key)!
    const found = this.locate(file, 'eslint')
    let value: { cwd: string; ESLint: ESLintClass } | null = null
    if (found) {
      const module = createRequire(found)(found) as { ESLint: ESLintClass }
      if (module.ESLint) value = { cwd: this.configFolder(file), ESLint: module.ESLint }
    }
    this.eslints.set(key, value)
    return value
  }

  private async prettierFor(file: string): Promise<Prettier | null> {
    const key = path.dirname(file)
    if (this.prettiers.has(key)) return this.prettiers.get(key)!
    const found = this.locate(file, 'prettier')
    let value: Prettier | null = null
    if (found) {
      const module = (await import(/* @vite-ignore */ pathToFileURL(found).href)) as { default?: unknown; format?: unknown }
      value = (module.format ? module : module.default) as unknown as Prettier
    }
    this.prettiers.set(key, value)
    return value
  }

  /** Whether any package in the project has these tools. Reads package.json files only and runs nothing. */
  static detect(root: string, packageFiles: { path: string; text: string }[]): { eslint: boolean; prettier: boolean } {
    let eslint = false
    let prettier = false
    for (const file of packageFiles) {
      try {
        const pkg = JSON.parse(file.text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        const all = { ...pkg.dependencies, ...pkg.devDependencies }
        eslint ||= 'eslint' in all
        prettier ||= 'prettier' in all
      } catch {
        /* not valid JSON */
      }
    }
    void root
    return { eslint, prettier }
  }

  async lint(rel: string, text: string): Promise<LintMessage[]> {
    const file = path.join(this.root, rel)
    const found = this.eslintFor(file)
    if (!found) return []
    const eslint = new found.ESLint({ cwd: found.cwd })
    if (await eslint.isPathIgnored(file)) return []
    const [result] = await eslint.lintText(text, { filePath: file })
    return (result?.messages ?? []).map((m) => ({
      line: m.line ?? 1,
      column: m.column ?? 1,
      endLine: m.endLine ?? m.line ?? 1,
      endColumn: m.endColumn ?? (m.column ?? 1) + 1,
      message: m.message,
      rule: m.ruleId,
      severity: m.severity === 2 ? 'error' : 'warning',
      fix: m.fix ? { start: m.fix.range[0], end: m.fix.range[1], text: m.fix.text } : null
    }))
  }

  /** The file's text after every automatic ESLint fix. */
  async fixAll(rel: string, text: string): Promise<string | null> {
    const file = path.join(this.root, rel)
    const found = this.eslintFor(file)
    if (!found) return null
    const eslint = new found.ESLint({ cwd: found.cwd, fix: true })
    if (await eslint.isPathIgnored(file)) return null
    const [result] = await eslint.lintText(text, { filePath: file })
    return result?.output ?? null
  }

  async format(rel: string, text: string): Promise<string | null> {
    const file = path.join(this.root, rel)
    const prettier = await this.prettierFor(file)
    if (!prettier) return null
    const info = await prettier.getFileInfo(file, { resolveConfig: true })
    if (info.ignored || !info.inferredParser) return null
    const config = await prettier.resolveConfig(file, { editorconfig: true })
    return prettier.format(text, { ...config, filepath: file })
  }
}
