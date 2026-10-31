#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveProxyConfig } from './config.ts'
import { errorMessage } from './log.ts'
import { createTransformProxy, type TransformProxy } from './server.ts'

/** Environment variable that supplies the client token when `--token` is absent. */
export const TOKEN_ENV = 'SKAILE_TRANSFORM_PROXY_TOKEN'

const USAGE = 'usage: skaile-transform-proxy [--config <file>] [--port <n>] [--host <h>] [--token <t>]'

export interface CliEnvironment {
  readonly cwd: string
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdout: (line: string) => void
  readonly stderr: (line: string) => void
}

/** `proxy` is set only when the server started; the caller owns its shutdown. */
export interface CliRun {
  readonly code: number
  readonly proxy?: TransformProxy
}

/** Parses the arguments, loads the config and starts the proxy. Never installs signal handlers. */
export async function runCli(argv: readonly string[], io: CliEnvironment): Promise<CliRun> {
  let values: { config?: string; port?: string; host?: string; token?: string; help?: boolean }
  try {
    ;({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        config: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        token: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (err) {
    io.stderr(errorMessage(err))
    io.stderr(USAGE)
    return { code: 2 }
  }
  if (values.help === true) {
    io.stdout(USAGE)
    return { code: 0 }
  }
  const port = parsePort(values.port)
  if (port === undefined && values.port !== undefined) {
    io.stderr(`--port must be an integer from 0 to 65535, got "${values.port}"`)
    return { code: 2 }
  }

  let config: ReturnType<typeof resolveProxyConfig>
  try {
    config = resolveProxyConfig({ explicit: values.config, cwd: io.cwd, home: io.home })
  } catch (err) {
    io.stderr(errorMessage(err))
    return { code: 1 }
  }

  try {
    const proxy = await createTransformProxy({
      ...config.options,
      host: values.host,
      port,
      token: values.token ?? io.env[TOKEN_ENV],
      log: { debug: () => {}, info: () => {}, warn: (msg, ...args) => io.stderr(format('warn', msg, args)), error: (msg, ...args) => io.stderr(format('error', msg, args)) },
    })
    io.stdout(`listening ${proxy.url}`)
    return { code: 0, proxy }
  } catch (err) {
    io.stderr(errorMessage(err))
    return { code: 1 }
  }
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return port <= 65535 ? port : undefined
}

function format(level: string, msg: string, args: readonly unknown[]): string {
  return [`[transform-proxy ${level}] ${msg}`, ...args.map(String)].join(' ')
}

/** True when this module is the executed entry point (the bin, or `bun src/cli.ts`). */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const run = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    home: homedir(),
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  })
  if (run.proxy === undefined) {
    process.exitCode = run.code
  } else {
    const proxy = run.proxy
    const stop = (): void => {
      proxy.close().then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(errorMessage(err))
          process.exit(1)
        },
      )
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }
}
