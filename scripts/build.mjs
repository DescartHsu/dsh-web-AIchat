import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
await mkdir('lib', { recursive: true })
await build({ entryPoints: ['src/client.js'], outfile: 'lib/client.js', bundle: true,
  format: 'iife', platform: 'browser', target: 'chrome130', legalComments: 'eof', loader: { '.css': 'text' } })
await build({ entryPoints: ['src/index.js'], outfile: 'lib/index.js', bundle: true,
  format: 'esm', platform: 'node', target: 'node22', legalComments: 'eof' })
await copyFile('src/persistence-worker.mjs', 'lib/persistence-worker.mjs')
await copyFile('scripts/desktop-persistence.mjs', 'lib/desktop-persistence.mjs')
console.log('Built lib/client.js and lib/index.js')
