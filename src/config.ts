import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { TransformSpec } from './modules.ts'

export const CONFIG_FILE_NAME = 'transform-proxy.yaml'

/** The YAML-backed subset of the proxy options. `baseDir` is the config file's directory. */
export interface ProxyConfig {
  readonly baseDir: string
  readonly transforms: Record<string, TransformSpec>
  readonly pipelines: Record<string, readonly string[]>
  readonly defaultPipeline?: string
  readonly allowUpstreams?: readonly string[]
}

export interface ResolvedProxyConfig {
  readonly path: string
  readonly options: ProxyConfig
}

export interface ConfigLookup {
  /** The `--config` value, relative to `cwd`. When set, it is the only candidate. */
  readonly explicit?: string
  readonly cwd: string
  readonly home: string
}

/** The implicit lookup locations, in order: `./.skaile/` then `~/.config/skaile/`. */
export function configCandidates(cwd: string, home: string): readonly string[] {
  return [join(cwd, '.skaile', CONFIG_FILE_NAME), join(home, '.config', 'skaile', CONFIG_FILE_NAME)]
}

/**
 * Finds the config file: the explicit path when given (it must exist), otherwise the first
 * existing implicit candidate. Returns `undefined` when no implicit candidate exists.
 */
export function findProxyConfig(lookup: ConfigLookup): string | undefined {
  if (lookup.explicit !== undefined) {
    const path = resolve(lookup.cwd, lookup.explicit)
    if (!existsSync(path)) throw new Error(`transform proxy config not found: ${path}`)
    return path
  }
  return configCandidates(lookup.cwd, lookup.home).find((candidate) => existsSync(candidate))
}

/** Finds and loads the config. Throws, naming the searched paths, when none is found. */
export function resolveProxyConfig(lookup: ConfigLookup): ResolvedProxyConfig {
  const path = findProxyConfig(lookup)
  if (path === undefined) {
    const searched = configCandidates(lookup.cwd, lookup.home).join(', ')
    throw new Error(`no transform proxy config found (pass --config, or create one at ${searched})`)
  }
  return { path, options: loadProxyConfig(path) }
}

const TOP_LEVEL_KEYS: Record<string, true> = { transforms: true, pipelines: true, defaultPipeline: true, allowUpstreams: true }

/** Reads and validates a YAML config file. Unknown keys are rejected so that typos fail loudly. */
export function loadProxyConfig(path: string): ProxyConfig {
  const source = parse(readFileSync(path, 'utf8')) as unknown
  try {
    return parseProxyConfig(source ?? {}, dirname(path))
  } catch (err) {
    throw new Error(`invalid transform proxy config ${path}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }
}

/** Validates an already-parsed config object. Exported for hosts that load YAML themselves. */
export function parseProxyConfig(source: unknown, baseDir: string): ProxyConfig {
  if (!isRecord(source)) throw new Error('the document must be a mapping')
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(TOP_LEVEL_KEYS, key)) throw new Error(`unknown key "${key}"`)
  }
  return {
    baseDir,
    transforms: parseTransforms(source.transforms),
    pipelines: parsePipelines(source.pipelines),
    ...(source.defaultPipeline === undefined ? {} : { defaultPipeline: requireString(source.defaultPipeline, 'defaultPipeline') }),
    ...(source.allowUpstreams === undefined ? {} : { allowUpstreams: requireStringList(source.allowUpstreams, 'allowUpstreams') }),
  }
}

function parseTransforms(value: unknown): Record<string, TransformSpec> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('transforms must be a mapping of transform id to { module, config }')
  const out: Record<string, TransformSpec> = {}
  for (const [id, spec] of Object.entries(value)) {
    if (!isRecord(spec)) throw new Error(`transforms.${id} must be a mapping with a module`)
    const module = requireString(spec.module, `transforms.${id}.module`)
    out[id] = spec.config === undefined ? { module } : { module, config: spec.config }
  }
  return out
}

function parsePipelines(value: unknown): Record<string, readonly string[]> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('pipelines must be a mapping of pipeline id to a list of transform ids')
  const out: Record<string, readonly string[]> = {}
  for (const [id, stages] of Object.entries(value)) {
    out[id] = requireStringList(stages, `pipelines.${id}`)
  }
  return out
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${field} must be a non-empty string`)
  return value
}

function requireStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new Error(`${field} must be a list of non-empty strings`)
  }
  return value as string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
