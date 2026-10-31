import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Logger, TransformFactory, TransformModule } from './contract.ts'
import { errorMessage } from './log.ts'

/** A configured transform: a module (object, npm specifier or relative path) and its config. */
export interface TransformSpec {
  readonly module: string | TransformModule
  readonly config?: unknown
}

/** Loads and opens every configured transform once. Any failure rejects with the transform id. */
export async function openTransforms(
  specs: Readonly<Record<string, TransformSpec>>,
  baseDir: string,
  log: Logger,
): Promise<Map<string, TransformFactory>> {
  const factories = new Map<string, TransformFactory>()
  for (const [id, spec] of Object.entries(specs)) {
    const module = typeof spec.module === 'string' ? await loadModule(id, spec.module, baseDir) : spec.module
    try {
      factories.set(id, await module.open(spec.config, { baseDir, log }))
    } catch (err) {
      throw new Error(`transform "${id}" failed to open: ${errorMessage(err)}`, { cause: err })
    }
  }
  return factories
}

async function loadModule(id: string, specifier: string, baseDir: string): Promise<TransformModule> {
  let exported: unknown
  try {
    const imported = (await import(resolveSpecifier(specifier, baseDir))) as { default?: unknown }
    exported = imported.default
  } catch (err) {
    throw new Error(`transform "${id}": cannot load module ${specifier}: ${errorMessage(err)}`, { cause: err })
  }
  if (!isTransformModule(exported)) throw new Error(`transform "${id}": ${specifier} has no default TransformModule export`)
  return exported
}

/**
 * Resolves a module specifier to a file URL. Relative and absolute paths resolve against `baseDir`.
 * Package names resolve from `baseDir` by the `require` conditions first, then by the `import` condition.
 */
export function resolveSpecifier(specifier: string, baseDir: string): string {
  const root = resolve(baseDir)
  if (specifier.startsWith('.') || isAbsolute(specifier)) return pathToFileURL(resolve(root, specifier)).href
  try {
    return pathToFileURL(createRequire(join(root, 'noop.cjs')).resolve(specifier)).href
  } catch (err) {
    const fallback = resolveImportCondition(specifier, root)
    if (fallback === undefined) throw err
    return pathToFileURL(fallback).href
  }
}

/** Walks up node_modules from `root` and resolves a package entry through its `import` condition. */
function resolveImportCondition(specifier: string, root: string): string | undefined {
  const parts = specifier.split('/')
  const nameParts = specifier.startsWith('@') ? 2 : 1
  const name = parts.slice(0, nameParts).join('/')
  const subpath = parts.length > nameParts ? `./${parts.slice(nameParts).join('/')}` : '.'
  let dir = root
  for (;;) {
    const pkgDir = join(dir, 'node_modules', name)
    const pkgJson = join(pkgDir, 'package.json')
    if (existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { exports?: unknown; main?: string }
      const target = pkg.exports === undefined ? (subpath === '.' ? (pkg.main ?? 'index.js') : undefined) : exportTarget(pkg.exports, subpath)
      return target === undefined ? undefined : join(pkgDir, target)
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function exportTarget(exports: unknown, subpath: string): string | undefined {
  const map = isRecord(exports) && Object.keys(exports).some((key) => key.startsWith('.')) ? exports : { '.': exports }
  return conditionTarget(map[subpath])
}

function conditionTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (!isRecord(entry)) return undefined
  return conditionTarget(entry.import) ?? conditionTarget(entry.default)
}

function isTransformModule(value: unknown): value is TransformModule {
  return isRecord(value) && typeof value.id === 'string' && typeof value.open === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
