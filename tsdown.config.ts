import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'web-search-bailian'

// Host-plane only: this provider registers into `ctx.web` and has no browser
// client, so a single Node ESM bundle is emitted (no `./client` entry).
export default defineConfig([
  {
    name: PLUGIN_ID,
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
