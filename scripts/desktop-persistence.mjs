/** Narrow, reversible compatibility repair for verified DSH Desktop builds. */
import * as nodeFiles from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

// Electron treats app.asar as a virtual directory. Inspect/replace the physical
// archive through original-fs; the bundled Node worker uses the normal API.
export let nativeFileSystem = nodeFiles
try { nativeFileSystem = createRequire(import.meta.url)('original-fs').promises } catch { /* Regular Node.js. */ }
const { readFile, writeFile, copyFile, rename } = nativeFileSystem

const MARKER = '/* dsh-web-aichat: persistent partitions v1 */'
export const SUPPORTED_DESKTOP_VERSIONS = Object.freeze(['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2'])
const sha256 = value => createHash('sha256').update(value).digest('hex')
export function parseArchive(bytes) {
  const length = bytes.readUInt32LE(12)
  const dataOffset = 8 + bytes.readUInt32LE(4)
  if (bytes.readUInt32LE(0) !== 4 || length < 2 || length + 16 > dataOffset || dataOffset > bytes.length) throw Error('Invalid ASAR header')
  return { header: JSON.parse(bytes.subarray(16, 16 + length).toString('utf8')), data: bytes.subarray(dataOffset) }
}
export function archiveEntry(header, path) {
  let entry = header
  for (const key of path.split('/')) {
    entry = entry.files?.[key]
    if (!entry) throw Error(`ASAR entry not found: ${path}`)
  }
  return entry
}
export function readEntry(archive, path) {
  const entry = archiveEntry(archive.header, path)
  if (entry.unpacked || entry.link || !Number.isSafeInteger(Number(entry.offset))) throw Error('Unsupported ASAR entry')
  return archive.data.subarray(Number(entry.offset), Number(entry.offset) + entry.size)
}
export function patchDesktopMain(source) {
  if (source.includes(MARKER)) return source
  const block = /let partition = this\.partitions\.get\(workspace\);[\s\S]{0,700}?this\.partitions\.set\(workspace, partition\);/g
  const matches = [...source.matchAll(block)]
  if (matches.length !== 1) throw Error('Unknown DSH browser partition implementation; refusing to patch')
  const old = matches[0][0]
  const assignment = /partition = `dsh-sidebar-browser-\$\{([a-zA-Z_$][\w$]*)\(\)\}`;/
  if (!assignment.test(old) || !old.includes('this.configureSession(session.fromPartition(partition))')) throw Error('Unknown DSH guest policy; refusing to patch')
  const changed = old.replace(assignment, (_, randomUUID) => `${MARKER}\n\t\t\tpartition = /^dsh-web-aichat:[a-z0-9-]{1,100}$/.test(workspace)\n\t\t\t\t? \`persist:\${workspace.replace(":", "-")}\`\n\t\t\t\t: \`dsh-sidebar-browser-\${${randomUUID}()}\`;`)
  return source.replace(old, changed)
}
export function replaceEntry(bytes, path, replacement) {
  const archive = parseArchive(bytes)
  const header = structuredClone(archive.header)
  const entry = archiveEntry(header, path)
  const body = Buffer.from(replacement)
  entry.offset = String(archive.data.length)
  entry.size = body.length
  if (entry.integrity) {
    const blockSize = entry.integrity.blockSize || 4 * 1024 * 1024
    if (entry.integrity.algorithm !== 'SHA256') throw Error('Unknown ASAR integrity algorithm')
    entry.integrity = { algorithm: 'SHA256', hash: sha256(body), blockSize, blocks: [] }
    for (let start = 0; start < body.length; start += blockSize) entry.integrity.blocks.push(sha256(body.subarray(start, start + blockSize)))
  }
  const json = Buffer.from(JSON.stringify(header))
  const aligned = Math.ceil(json.length / 4) * 4
  const prefix = Buffer.alloc(16 + aligned)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(8 + aligned, 4)
  prefix.writeUInt32LE(4 + aligned, 8)
  prefix.writeUInt32LE(json.length, 12)
  json.copy(prefix, 16)
  return Buffer.concat([prefix, archive.data, body])
}

export async function prepareDesktopPatch(installDirectory) {
  const directory = resolve(installDirectory)
  const file = join(directory, 'resources', 'app.asar')
  const bytes = await readFile(file)
  const archive = parseArchive(bytes)
  const pkg = JSON.parse(readEntry(archive, 'package.json').toString('utf8'))
  if (!SUPPORTED_DESKTOP_VERSIONS.includes(pkg.version) || pkg.main !== 'lib/main.js') throw Error(`Unsupported DSH Desktop build: ${pkg.version}. Verified versions: ${SUPPORTED_DESKTOP_VERSIONS.join(', ')}`)
  const executable = await readFile(join(directory, 'DeepSeek Harness.exe'))
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
  const position = executable.indexOf(sentinel)
  if (position < 0 || executable[position + sentinel.length] !== 1) throw Error('Unknown Electron fuse format')
  if (executable[position + sentinel.length + 2 + 4] !== 48) throw Error('Embedded archive validation is enabled; refusing to alter or disable it')
  const source = readEntry(archive, pkg.main).toString('utf8')
  const patched = patchDesktopMain(source)
  const output = patched === source ? bytes : replaceEntry(bytes, pkg.main, patched)
  return { file, bytes, output, desktopVersion: pkg.version, alreadyPatched: patched === source, before: sha256(bytes), after: sha256(output), main: pkg.main }
}

export async function applyDesktopPatch(directory) {
  assertDesktopStopped(directory)
  const plan = await prepareDesktopPatch(directory)
  if (plan.alreadyPatched) return { status: 'already-patched', file: plan.file, sha256: plan.after }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${plan.file}.bak-aichat-persistence-${stamp}`
  const temporary = `${plan.file}.aichat-persistence.tmp`
  await copyFile(plan.file, backup)
  if (sha256(await readFile(backup)) !== plan.before) throw Error('Backup verification failed')
  await writeFile(temporary, plan.output, { flag: 'wx' })
  if (sha256(await readFile(plan.file)) !== plan.before) throw Error('DSH changed during preparation; original file retained')
  await rename(temporary, plan.file)
  if (sha256(await readFile(plan.file)) !== plan.after) throw Error('Patched file verification failed; restore the verified backup')
  return { status: 'patched', file: plan.file, backup, before: plan.before, after: plan.after }
}

function assertDesktopStopped(directory) {
  if (process.platform !== 'win32') return
  const executable = join(resolve(directory), 'DeepSeek Harness.exe')
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:DSH_AICHAT_NATIVE_TARGET -and $_.Id -ne [int]$env:DSH_AICHAT_REPAIR_PID } | Select-Object -ExpandProperty Id; exit 0'],
  { windowsHide: true, env: { ...process.env, DSH_AICHAT_NATIVE_TARGET: executable, DSH_AICHAT_REPAIR_PID: String(process.pid) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (output.trim()) throw Error('Please fully quit DSH Desktop before applying or restoring this compatibility repair')
}

export async function restoreDesktopPatch(directory, backup) {
  assertDesktopStopped(directory)
  const plan = await prepareDesktopPatch(directory)
  const backupPath = resolve(backup)
  if (!backupPath.startsWith(`${plan.file}.bak-aichat-persistence-`)) throw Error('Backup does not belong to this installation')
  const original = await readFile(backupPath)
  const archive = parseArchive(original)
  const source = readEntry(archive, plan.main).toString('utf8')
  if (source.includes(MARKER)) throw Error('Backup is already patched')
  const expected = replaceEntry(original, plan.main, patchDesktopMain(source))
  if (sha256(expected) !== plan.before) throw Error('Desktop changed after repair; refusing to overwrite later updates')
  await writeFile(plan.file, original)
  if (sha256(await readFile(plan.file)) !== sha256(original)) throw Error('Restored file verification failed')
  return { status: 'restored', file: plan.file, sha256: sha256(original) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode = '--check', directory = 'E:/DeepSeek Harness', backup] = process.argv.slice(2)
  if (!['--check', '--apply', '--restore'].includes(mode)) throw Error('Usage: node desktop-persistence.mjs [--check|--apply|--restore] "DSH install directory" [backup]')
  if (mode === '--restore') console.log(JSON.stringify(await restoreDesktopPatch(directory, backup), null, 2))
  else if (mode === '--apply') console.log(JSON.stringify(await applyDesktopPatch(directory), null, 2))
  else {
    const plan = await prepareDesktopPatch(directory)
    console.log(JSON.stringify({ file: plan.file, status: plan.alreadyPatched ? 'already-patched' : 'ready', before: plan.before, after: plan.after, changedEntry: plan.main }, null, 2))
  }
}
