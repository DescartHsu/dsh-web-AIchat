/** Detached, single-use worker: patch only after Desktop has fully exited. */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyDesktopPatch } from './desktop-persistence.mjs'

export async function writeState(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, file)
}
export function desktopRunning(directory) {
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:DSH_AICHAT_NATIVE_TARGET -and $_.Id -ne [int]$env:DSH_AICHAT_REPAIR_PID } | Select-Object -ExpandProperty Id; exit 0'],
  { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, DSH_AICHAT_NATIVE_TARGET: join(directory, 'DeepSeek Harness.exe'), DSH_AICHAT_REPAIR_PID: String(process.pid),
  } })
  return !!output.trim()
}
export function reopenDesktop(directory) {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(join(directory, 'DeepSeek Harness.exe'), [], {
    detached: true, windowsHide: false, stdio: 'ignore', env: environment,
  })
  child.on('error', () => {})
  child.unref()
}
export async function runRepairJob(job, dependencies = {}) {
  const running = dependencies.running || desktopRunning
  const apply = dependencies.apply || applyDesktopPatch
  const reopen = dependencies.reopen || reopenDesktop
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = dependencies.now || Date.now
  const save = value => writeState(job.statusFile, { jobId: job.id, updatedAt: now(), ...value })
  await save({ state: 'waiting', message: '准备就绪，请从 DSH 的“应用 → 退出”完整退出。退出后将自动修复并重新打开。' })
  while (now() < job.expiresAt) {
    if (!running(job.installDirectory)) {
      // Avoid replacing a file while child processes are still shutting down.
      await sleep(1000)
      if (!running(job.installDirectory)) {
        await save({ state: 'applying', message: '正在备份并启用登录保留…' })
        try {
          const result = await apply(job.installDirectory)
          await save({ state: 'complete', message: '修复已完成。请在各官网重新登录一次，以后将按官网有效期保留登录。', backup: result.backup || null })
          reopen(job.installDirectory)
          return
        } catch (error) {
          await save({ state: 'failed', message: `修复未完成：${error.message}` })
          reopen(job.installDirectory)
          return
        }
      }
    }
    await sleep(1000)
  }
  await save({ state: 'expired', message: '等待退出已超时，未修改 DSH。需要时请重新准备修复。' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const job = JSON.parse(await readFile(process.argv[2], 'utf8'))
  await runRepairJob(job).catch(async error => {
    await writeState(job.statusFile, { jobId: job.id, state: 'failed', updatedAt: Date.now(), message: `修复工具未能启动：${error.message}` })
    process.exitCode = 1
  })
}
