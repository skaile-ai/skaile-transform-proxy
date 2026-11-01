// Modules omp serves to the extensions it loads. They are not dependencies of this package; the
// build keeps them external (tsdown.config.ts). Typed `unknown`: the extension checks their shape.

declare module '@oh-my-pi/pi-coding-agent/config/registry' {
  /** The setting handle for an id (e.g. `images.blockImages`), or `undefined` for an unknown id. */
  export function lookup(id: string): unknown
}
