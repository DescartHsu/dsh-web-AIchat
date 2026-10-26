import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { prepareDesktopPatch, nativeFileSystem } from '../scripts/desktop-persistence.mjs'

async function exists(file) { try { await nativeFileSystem.access(file); return true } catch { return false } }
export async function findDesktopInstall(executable = process.execPath) {
  let directory = dirname(resolve(executable))
  for (let level = 0; level < 9; level++) {
    if (await exists(join(directory, 'DeepSeek Harness.exe')) && await exists(join(directory, 'resources', 'app.asar'))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw Error('未找到当前 DSH Desktop 的安装位置，请在官方 Windows 桌面客户端中使用。')
}
function repairDirectory() {
  const configured = process.env.DSH_HOME?.trim()
  const root = !configured ? join(homedir(), '.dsh') : configured === '~' ? homedir()
    : configured.startsWith('~/') || configured.startsWith('~\\') ? join(homedir(), configured.slice(2)) : resolve(configured)
  return join(root, 'dsh-web-aichat', 'desktop-setup')
}
async function launchWorker(directory, worker, jobFile) {
  const candidates = [join(directory, 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe'),
    join(directory, 'resources/runtime/primary-runtime/dependencies/node/node.exe')]
  let executable = process.execPath
  for (const candidate of candidates) if (await exists(candidate)) { executable = candidate; break }
  await new Promise((accept, reject) => {
    const child = spawn(executable, [worker, jobFile], { detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); accept() })
  })
}
export function createPersistenceService(options = {}) {
  const platform = options.platform || process.platform
  const detect = options.detect || findDesktopInstall
  const prepare = options.prepare || prepareDesktopPatch
  const launch = options.launch || launchWorker
  const root = options.root || repairDirectory()
  const assetRoot = options.assetRoot || dirname(fileURLToPath(import.meta.url))
  const latest = join(root, 'latest.json')
  let pending
  let capability
  let setupError = ''
  const readLatest = async () => {
    try { return JSON.parse(await readFile(latest, 'utf8')) } catch { return null }
  }
  async function status() {
    const previous = await readLatest()
    let job = null
    if (previous) { try { job = JSON.parse(await readFile(previous.statusFile, 'utf8')) } catch { /* Not started yet. */ } }
    if (platform !== 'win32') return { supported: false, message: '当前一键修复支持 Windows DSH Desktop 0.2.1-rc.3。', job }
    try {
      capability ||= (async () => {
        const installDirectory = await detect()
        const plan = await prepare(installDirectory)
        return { supported: true, installDirectory, onDiskEnabled: plan.alreadyPatched }
      })()
      const info = await capability
      if (previous?.installDirectory && resolve(previous.installDirectory).toLowerCase() !== resolve(info.installDirectory).toLowerCase()) job = null
      return { ...info, job, setupError }
    } catch (error) { return { supported: false, message: error.message, job } }
  }
  async function startOnce({ automatic = false } = {}) {
    const current = await status()
    if (!current.supported) throw Error(current.message)
    if (current.onDiskEnabled) return current
    const previous = await readLatest()
    if ((previous?.automatic || previous?.expiresAt > Date.now()) && ['waiting', 'applying', 'queued'].includes(current.job?.state)
      && !(previous.cancelFile && await exists(previous.cancelFile))) return current
    const id = randomUUID(), directory = join(root, id)
    await mkdir(directory, { recursive: true })
    const worker = join(directory, 'persistence-worker.mjs')
    // Copy both modules out of node_modules so uninstall/reload cannot interrupt the prepared job.
    await copyFile(join(assetRoot, 'persistence-worker.mjs'), worker)
    await copyFile(join(assetRoot, 'desktop-persistence.mjs'), join(directory, 'desktop-persistence.mjs'))
    const job = { id, installDirectory: current.installDirectory, statusFile: join(directory, 'status.json'),
      cancelFile: join(directory, 'cancel'), ownerPid: process.pid, automatic, expiresAt: automatic ? null : Date.now() + 15 * 60 * 1000 }
    const jobFile = join(directory, 'job.json')
    await writeFile(jobFile, JSON.stringify(job), { mode: 0o600 })
    await writeFile(job.statusFile, JSON.stringify({ jobId: id, state: 'queued', automatic,
      message: automatic ? '首次登录存储已自动准备，无需点击修复。下次完整退出 DSH 时将完成设置并自动重开一次，请重开后再登录。' : '修复工具已准备，请从“应用 → 退出”完整退出 DSH。' }), { mode: 0o600 })
    await writeFile(latest, JSON.stringify(job), { mode: 0o600 })
    try { await launch(current.installDirectory, worker, jobFile) }
    catch (error) { await writeFile(job.statusFile, JSON.stringify({ jobId: id, state: 'failed', message: '无法启动修复工具：' + error.message })); throw error }
    return { ...current, job: JSON.parse(await readFile(job.statusFile, 'utf8')) }
  }
  function start(options) {
    if (!pending) setupError = ''
    return pending ||= startOnce(options).catch(error => { setupError = error.message; throw error }).finally(() => { pending = null })
  }
  async function ensureAutomatic() {
    const current = await status()
    if (!current.supported || current.onDiskEnabled || current.job?.state === 'failed') return current
    setupError = ''
    return start({ automatic: true })
  }
  async function cancel(id) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) return
    try { await writeFile(join(root, id, 'cancel'), '', { mode: 0o600 }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { status, start, ensureAutomatic, cancel }
}

/** Prepare on plugin activation; do not interrupt work or require a UI action. */
export function registerAutomaticPersistence(ctx, service, runtime = {}) {
  const carrier = runtime.process || process
  const repeat = runtime.setInterval || setInterval
  const stop = runtime.clearInterval || clearInterval
  ctx.effect(() => {
    let disposed = false, shuttingDown = false, ownedJob, task
    // Desktop 0.2.1-rc.3 sends this IPC message before disposing its Host.
    const onMessage = message => { if (message?.type === 'shutdown') shuttingDown = true }
    carrier.on('message', onMessage)
    const run = () => {
      if (disposed) return
      return task ||= service.ensureAutomatic().then(info => { ownedJob = info.job?.jobId }).catch(() => {
        // status() exposes failures to the panel; activation must remain usable.
      }).finally(() => { task = null })
    }
    void run()
    const timer = repeat(run, 5 * 60 * 1000)
    timer.unref?.()
    return async () => {
      disposed = true; stop(timer); carrier.off('message', onMessage)
      await task
      // Disabling/reloading the plugin cancels its job. A normal Desktop quit
      // leaves the worker alive to finish after the executable has stopped.
      if (!shuttingDown) await service.cancel(ownedJob)
    }
  }, 'web-aichat: automatic login storage')
}

export function registerPersistenceRoutes(ctx, service = createPersistenceService()) {
  for (const action of ['status', 'prepare']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `/api/web-aichat/persistence/${action}`,
      handler: async (req, res) => {
        const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
        const refusal = ctx.connection.requestRejection(req)
        if (refusal !== undefined) { reply(refusal, { ok: false }); return }
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) { reply(403, { ok: false }); return }
        if (req.method !== 'POST') { reply(405, { ok: false }); return }
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { reply(415, { ok: false }); return }
        try {
          const result = action === 'status' ? await service.status() : await service.start({ automatic: true })
          reply(200, { ok: true, ...result })
        } catch (error) { reply(400, { ok: false, error: error.message }) }
      },
    }), `web-aichat: login persistence ${action}`)
  }
}
