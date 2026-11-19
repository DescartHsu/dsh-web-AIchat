/** Detached, single-use worker: patch only after Desktop has fully exited. */
import { readFile, writeFile, rename, access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopProcessIds, stageDesktopPatch } from './desktop-persistence.mjs'

export async function writeState(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, file)
}
function trackDesktop(directory) {
  const pids = desktopProcessIds(directory)
  return () => pids.some(pid => {
    try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
  })
}
export async function reopenDesktop(directory) {
  if (desktopProcessIds(directory).length) return
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(join(directory, 'DeepSeek Harness.exe'), [], {
    detached: true, windowsHide: false, stdio: 'ignore', env: environment,
  })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
export async function runRepairJob(job, dependencies = {}) {
  const stage = dependencies.stage || stageDesktopPatch
  const reopen = dependencies.reopen || reopenDesktop
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = dependencies.now || Date.now
  const save = value => writeState(job.statusFile, { jobId: job.id, automatic: !!job.automatic, updatedAt: now(), ...value })
  const cancelled = async () => {
    if (!job.cancelFile) return false
    try { await access(job.cancelFile); return true } catch { return false }
  }
  let staged
  try {
    if (await cancelled()) { await save({ state: 'cancelled', message: '插件已停用。' }); return }
    staged = await stage(job.installDirectory, { watchExit: true })
    const running = dependencies.running || trackDesktop(job.installDirectory)
    await save({ state: 'waiting', message: '已准备好，请从「应用 → 退出」完整退出 DSH。' })
    while (job.automatic || now() < job.expiresAt) {
      if (await cancelled()) { await save({ state: 'cancelled', message: '插件已停用或重新加载。' }); return }
      if (!running()) {
        await save({ state: 'applying', message: '正在完成设置…' })
        if (await cancelled()) { await save({ state: 'cancelled', message: '插件已重新加载。' }); return }
        const result = await staged.commit()
        await save({ state: 'complete', message: '已完成。', backup: result.backup || null })
        await reopen(job.installDirectory)
        return
      }
      await sleep(100)
    }
    await save({ state: 'expired', message: '等待退出超时。' })
  } catch (error) {
    await save({ state: 'failed', message: `修复未完成：${error.message}` })
    if (!job.automatic && staged && !(dependencies.running || trackDesktop(job.installDirectory))()) await reopen(job.installDirectory)
  } finally { await staged?.discard() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const job = JSON.parse(await readFile(process.argv[2], 'utf8'))
  await runRepairJob(job).catch(async error => {
    await writeState(job.statusFile, { jobId: job.id, state: 'failed', updatedAt: Date.now(), message: `修复工具未能启动：${error.message}` })
    process.exitCode = 1
  })
}
