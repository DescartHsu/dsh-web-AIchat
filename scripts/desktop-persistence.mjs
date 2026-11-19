/** Narrow, reversible compatibility repair for verified DSH Desktop builds. */
import * as nodeFiles from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

// Electron treats app.asar as a virtual directory. Inspect/replace the physical
// archive through original-fs; the bundled Node worker uses the normal API.
export let nativeFileSystem = nodeFiles
try { nativeFileSystem = createRequire(import.meta.url)('original-fs').promises } catch { /* Regular Node.js. */ }
const { readFile, writeFile, rename } = nativeFileSystem

const MARKER = '/* dsh-web-aichat: persistent partitions v1 */'
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
  const assignment = /partition = `dsh-sidebar-browser-\$\{([a-zA-Z_$][\w$]*)\(\)\}`;/
  const replacement = randomUUID => `${MARKER}\n\t\t\tpartition = /^dsh-web-aichat:[a-z0-9-]{1,100}$/.test(workspace)\n\t\t\t\t? \`persist:\${workspace.replace(":", "-")}\`\n\t\t\t\t: \`dsh-sidebar-browser-\${${randomUUID}()}\`;`
  // Validate the original and installed repair against the same exact partition
  // selection and session configuration sequence before changing the archive.
  const legacy = /\/\* dsh-web-aichat: persistent partitions v1 \*\/\n\t{3}partition = \/\^dsh-web-aichat:\[a-z0-9-\]\{1,100\}\$\/\.test\(workspace\)\n\t{4}\? `persist:\$\{workspace\.replace\(":", "-"\)\}`\n\t{4}: `dsh-sidebar-browser-\$\{([a-zA-Z_$][\w$]*)\(\)\}`;/g
  const alreadyPatched = source.includes(MARKER)
  const original = source.replace(legacy, (_, randomUUID) => 'partition = `dsh-sidebar-browser-${' + randomUUID + '()}`;')
  const block = /let partition = this\.partitions\.get\(workspace\);\s*if \(partition === (?:void 0|undefined)\) \{\s*partition = `dsh-sidebar-browser-\$\{[a-zA-Z_$][\w$]*\(\)\}`;\s*this\.configureSession\(session\.fromPartition\(partition\)\);\s*this\.partitions\.set\(workspace, partition\);\s*\}/g
  const matches = [...original.matchAll(block)]
  if (matches.length !== 1) throw Error('无法识别 DSH 的网页存储实现，已暂停自动配置。')
  const old = matches[0][0]
  const patched = original.replace(old, old.replace(assignment, (_, randomUUID) => replacement(randomUUID)))
  if (alreadyPatched && (original.includes(MARKER) || patched !== source)) throw Error('DSH 的旧登录存储修改无法验证，已暂停自动配置。')
  return patched
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
  if (pkg.name !== '@deepseek-ai/dsh-desktop' || typeof pkg.version !== 'string' || !pkg.version || pkg.main !== 'lib/main.js') {
    throw Error(`Unsupported DSH Desktop build: ${pkg.version}`)
  }
  const executable = await readFile(join(directory, 'DeepSeek Harness.exe'))
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
  const position = executable.indexOf(sentinel)
  const fuseCount = executable[position + sentinel.length + 1]
  if (position < 0 || executable[position + sentinel.length] !== 1 || fuseCount < 5
    || position + sentinel.length + 2 + fuseCount > executable.length) throw Error('Unknown Electron fuse format')
  if (executable[position + sentinel.length + 2 + 4] !== 48) throw Error('Embedded archive validation is enabled; refusing to alter or disable it')
  const source = readEntry(archive, pkg.main).toString('utf8')
  const patched = patchDesktopMain(source)
  const output = patched === source ? bytes : replaceEntry(bytes, pkg.main, patched)
  return { file, bytes, output, executableHash: sha256(executable), desktopVersion: pkg.version, alreadyPatched: patched === source, before: sha256(bytes), after: sha256(output), main: pkg.main }
}

// Prepare side files while Desktop is running. Only commit() changes the live archive.
async function fileRevision(path) {
  const s = await nativeFileSystem.stat(path, { bigint: true })
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join('/')
}

export async function stageDesktopPatch(directory, { watchExit = false } = {}) {
  const plan = await prepareDesktopPatch(directory)
  const { file, before, after } = plan
  if (plan.alreadyPatched) return {
    commit: async () => ({ status: 'already-patched', file, sha256: after }), discard: async () => {},
  }
  const suffix = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()
  const backup = `${file}.bak-aichat-persistence-${suffix}`
  const temporary = `${file}.aichat-${suffix}.tmp`
  const executable = join(resolve(directory), 'DeepSeek Harness.exe')
  const executableHash = plan.executableHash
  const revisions = new Map()
  async function remember(path, expected) {
    const revision = await fileRevision(path)
    if (sha256(await readFile(path)) !== expected || await fileRevision(path) !== revision) {
      throw Error('DSH or staged files changed during preparation; original file retained')
    }
    revisions.set(path, revision)
  }
  let replaced = false
  let exitCheck
  async function discard() {
    exitCheck?.close()
    await nativeFileSystem.rm(temporary, { force: true })
    if (!replaced) await nativeFileSystem.rm(backup, { force: true })
  }
  try {
    await writeFile(backup, plan.bytes, { flag: 'wx' })
    await writeFile(temporary, plan.output, { flag: 'wx' })
    await remember(file, before)
    await remember(executable, executableHash)
    await remember(backup, before)
    await remember(temporary, after)
    if (watchExit && process.platform === 'win32') exitCheck = warmExitCheck(directory)
  } catch (error) { await discard(); throw error }
  // Reject replacement or modification since verification, including a host update.
  async function commit() {
    if (exitCheck) await exitCheck.check()
    else assertDesktopStopped(directory)
    for (const [path, revision] of revisions) {
      if (await fileRevision(path) !== revision) throw Error('DSH or staged files changed while waiting; original file retained')
    }
    await rename(temporary, file)
    replaced = true
    if (sha256(await readFile(file)) !== after) throw Error('Patched file verification failed; restore the verified backup')
    return { status: 'patched', file, backup, before, after }
  }
  return { commit, discard }
}

export async function applyDesktopPatch(directory) {
  assertDesktopStopped(directory)
  const staged = await stageDesktopPatch(directory)
  try { return await staged.commit() } finally { await staged.discard() }
}

const processFilter = 'Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne [int]$env:DSH_AICHAT_REPAIR_PID -and (!$_.Path -or $_.Path -eq $env:DSH_AICHAT_NATIVE_TARGET) }'
function checkEnvironment(directory) {
  return { ...process.env, DSH_AICHAT_NATIVE_TARGET: join(resolve(directory), 'DeepSeek Harness.exe'), DSH_AICHAT_REPAIR_PID: String(process.pid) }
}
// Avoid launching PowerShell in the short interval between quit and a manual relaunch.
function warmExitCheck(directory) {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `if ([Console]::ReadLine() -cne "check") { exit 2 }; if (@(${processFilter}).Count) { exit 3 }; exit 0`],
  { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: checkEnvironment(directory) })
  const ended = new Promise(resolve => {
    child.once('error', () => resolve(-1))
    child.once('exit', code => resolve(code))
  })
  child.stdin.on('error', () => {}) // The exit code also reports a failed checker.
  return {
    close: () => child.stdin.end(),
    async check() {
      child.stdin.end('check\n')
      const code = await ended
      if (code === 3) throw Error('DSH 已再次启动，文件尚未切换。')
      if (code !== 0) throw Error('无法确认 DSH 已完整退出。')
    },
  }
}

export function desktopProcessIds(directory) {
  if (process.platform !== 'win32') return []
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    processFilter + ' | Select-Object -ExpandProperty Id; exit 0'],
  { windowsHide: true, env: checkEnvironment(directory), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return output.trim() ? output.trim().split(/\s+/).map(Number) : []
}
function assertDesktopStopped(directory) {
  if (desktopProcessIds(directory).length) throw Error('Please fully quit DSH Desktop before applying or restoring this compatibility repair')
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
