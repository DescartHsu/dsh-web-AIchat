import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
await mkdir('lib', { recursive: true })
await build({ entryPoints: ['src/client.js'], outfile: 'lib/client.js', bundle: true,
  format: 'iife', platform: 'browser', target: 'chrome130', legalComments: 'eof', loader: { '.css': 'text' } })
await copyFile('src/index.js', 'lib/index.js')
console.log('Built lib/client.js and lib/index.js')
