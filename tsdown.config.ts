import { defineConfig } from 'tsdown'

export default defineConfig({
  // Keys are output paths under dist/: `omp/index` lands where package.json `omp.extensions` points.
  entry: { index: 'src/index.ts', cli: 'src/cli.ts', 'omp/index': 'src/omp/index.ts' },
  format: 'esm',
  platform: 'node',
  dts: true,
  shims: true,
  // Served by omp to the extension at runtime (src/omp/omp-runtime.d.ts); never bundled.
  deps: { neverBundle: [/^@oh-my-pi\//] }
})
