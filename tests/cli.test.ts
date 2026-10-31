import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli, type CliEnvironment, type CliRun } from '../src/cli.ts'
import { configCandidates, findProxyConfig } from '../src/config.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stp-cli-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const CONFIG = 'pipelines:\n  plain: []\ndefaultPipeline: plain\n'

function writeFile(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

interface Captured extends CliEnvironment {
  readonly out: string[]
  readonly err: string[]
}

function environment(cwd: string, home: string, env: Record<string, string | undefined> = {}): Captured {
  const out: string[] = []
  const err: string[] = []
  return { cwd, home, env, out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) }
}

async function run(args: string[], env: Captured): Promise<CliRun> {
  return runCli(args, env)
}

describe('config lookup', () => {
  test('lists ./.skaile before ~/.config/skaile', () => {
    expect(configCandidates('/work', '/home/u')).toEqual([
      join('/work', '.skaile', 'transform-proxy.yaml'),
      join('/home/u', '.config', 'skaile', 'transform-proxy.yaml'),
    ])
  })

  test('picks the project config when both exist', () => {
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    const project = writeFile(join(cwd, '.skaile', 'transform-proxy.yaml'), CONFIG)
    writeFile(join(home, '.config', 'skaile', 'transform-proxy.yaml'), CONFIG)
    expect(findProxyConfig({ cwd, home })).toBe(project)
  })

  test('falls back to ~/.config/skaile', () => {
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    const user = writeFile(join(home, '.config', 'skaile', 'transform-proxy.yaml'), CONFIG)
    expect(findProxyConfig({ cwd, home })).toBe(user)
  })

  test('returns undefined when no implicit config exists', () => {
    expect(findProxyConfig({ cwd: join(root, 'a'), home: join(root, 'b') })).toBeUndefined()
  })

  test('an explicit --config must exist', () => {
    expect(() => findProxyConfig({ explicit: 'missing.yaml', cwd: root, home: root })).toThrow(/not found/)
  })
})

describe('runCli', () => {
  test('no config anywhere: exit 1 and the searched paths are named', async () => {
    const env = environment(join(root, 'a'), join(root, 'b'))
    const result = await run([], env)
    expect(result.code).toBe(1)
    expect(result.proxy).toBeUndefined()
    expect(env.err.join('\n')).toContain(join('.skaile', 'transform-proxy.yaml'))
    expect(env.err.join('\n')).toContain(join('.config', 'skaile', 'transform-proxy.yaml'))
  })

  test('--config pointing at a missing file: exit 1', async () => {
    const env = environment(root, root)
    const result = await run(['--config', 'nope.yaml'], env)
    expect(result.code).toBe(1)
    expect(env.err.join('\n')).toContain('not found')
  })

  test('--help prints the usage and exits 0', async () => {
    const env = environment(root, root)
    const result = await run(['--help'], env)
    expect(result.code).toBe(0)
    expect(env.out.join('\n')).toContain('skaile-transform-proxy [--config')
    expect(env.out.join('\n')).toContain('[--exit-with-stdin]')
  })

  test('a non-numeric or out-of-range --port: exit 2', async () => {
    const path = writeFile(join(root, '.skaile', 'transform-proxy.yaml'), CONFIG)
    for (const port of ['abc', '70000']) {
      const env = environment(root, root)
      const result = await run(['--config', path, '--port', port], env)
      expect(result.code).toBe(2)
      expect(env.err.join('\n')).toContain('--port')
    }
  })

  test('a non-loopback host without a token: exit 1', async () => {
    const path = writeFile(join(root, '.skaile', 'transform-proxy.yaml'), CONFIG)
    const env = environment(root, root)
    const result = await run(['--config', path, '--host', '0.0.0.0', '--port', '0'], env)
    expect(result.code).toBe(1)
    expect(env.err.join('\n')).toContain('token is required')
  })

  test('an unknown config key is rejected with its name', async () => {
    const path = writeFile(join(root, '.skaile', 'transform-proxy.yaml'), 'nope: 1\n')
    const env = environment(root, root)
    const result = await run(['--config', path], env)
    expect(result.code).toBe(1)
    expect(env.err.join('\n')).toContain('unknown key "nope"')
  })

  test('starts, prints the listening line, and enforces --token', async () => {
    const path = writeFile(join(root, '.skaile', 'transform-proxy.yaml'), CONFIG)
    const env = environment(root, root)
    const result = await run(['--config', path, '--port', '0', '--token', 'secret'], env)
    try {
      expect(result.code).toBe(0)
      expect(env.out).toHaveLength(1)
      expect(env.out[0]).toMatch(/^listening http:\/\/127\.0\.0\.1:\d+$/)
      const url = env.out[0]!.slice('listening '.length)
      const missing = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })
      expect(missing.status).toBe(401)
      const withToken = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-skaile-transform-token': 'secret' },
        body: '{}',
      })
      expect(withToken.status).toBe(400)
    } finally {
      await result.proxy?.close()
    }
  })

  test('takes the token from SKAILE_TRANSFORM_PROXY_TOKEN when --token is absent', async () => {
    const path = writeFile(join(root, '.skaile', 'transform-proxy.yaml'), CONFIG)
    const env = environment(root, root, { SKAILE_TRANSFORM_PROXY_TOKEN: 'env-secret' })
    const result = await run(['--config', path, '--port', '0'], env)
    try {
      expect(result.code).toBe(0)
      const url = env.out[0]!.slice('listening '.length)
      const missing = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })
      expect(missing.status).toBe(401)
      const withToken = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-skaile-transform-token': 'env-secret' },
        body: '{}',
      })
      expect(withToken.status).toBe(400)
    } finally {
      await result.proxy?.close()
    }
  })

  test('the bin entry prints listening and exits 0 on SIGTERM', async () => {
    const path = writeFile(join(root, '.skaile', 'transform-proxy.yaml'), CONFIG)
    const proc = Bun.spawn([process.execPath, CLI, '--config', path, '--port', '0'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await readListening(proc.stdout)).toMatch(/listening http:\/\/127\.0\.0\.1:\d+\n/)
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
  })

  test('with --exit-with-stdin the bin entry exits 0 when its stdin closes', async () => {
    const path = writeFile(join(root, '.skaile', 'transform-proxy.yaml'), CONFIG)
    const proc = Bun.spawn([process.execPath, CLI, '--config', path, '--port', '0', '--exit-with-stdin'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      expect(await readListening(proc.stdout)).toMatch(/listening http:\/\/127\.0\.0\.1:\d+\n/)
      await proc.stdin.end()
      expect(await proc.exited).toBe(0)
    } finally {
      proc.kill('SIGKILL')
    }
  })
})

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

/** Reads the child's stdout up to its listening line. */
async function readListening(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!/listening http:\/\/\S+\n/.test(text)) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  reader.releaseLock()
  return text
}
