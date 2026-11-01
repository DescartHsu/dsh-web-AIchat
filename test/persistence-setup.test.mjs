import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { createPersistenceService, findDesktopInstall, registerPersistenceRoutes, registerAutomaticPersistence } from '../src/persistence-service.js'
import { runRepairJob } from '../lib/persistence-worker.mjs'

async function temporary(run) {
  const testRoot = resolve('work')
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'aichat-setup-'))
  try { return await run(root) }
  finally { assert.equal(dirname(resolve(root)), testRoot); await rm(root, { recursive: true, force: true }) }
}
test('detects another installation location by walking the actual runtime path', () => temporary(async root => {
  const install = join(root, 'OtherDrive', 'Apps', 'Harness')
  await mkdir(join(install, 'resources', 'runtime', 'node', 'bin'), { recursive: true })
  await writeFile(join(install, 'DeepSeek Harness.exe'), '')
  await writeFile(join(install, 'resources', 'app.asar'), '')
  assert.equal(await findDesktopInstall(join(install, 'resources', 'runtime', 'node', 'bin', 'node.exe')), install)
}))
test('a fresh installation prepares both bundled worker files without a separate download; duplicate clicks share one job', () => temporary(async root => {
  let prepared = 0, launched = 0, job
  const service = createPersistenceService({ platform: 'win32', root, assetRoot: fileURLToPath(new URL('../lib/', import.meta.url)),
    detect: async () => 'D:/Applications/Harness', prepare: async () => { prepared++; return { alreadyPatched: false } },
    launch: async (directory, worker, file) => {
      launched++; assert.equal(directory, 'D:/Applications/Harness')
      job = JSON.parse(await readFile(file, 'utf8'))
      assert.match(await readFile(worker, 'utf8'), /runRepairJob/)
      assert.match(await readFile(join(dirname(worker), 'desktop-persistence.mjs'), 'utf8'), /applyDesktopPatch/)
    },
  })
  assert.equal((await service.status()).onDiskEnabled, false)
  const [first, second] = await Promise.all([service.start(), service.start()])
  assert.equal(first.job.state, 'queued'); assert.equal(second.job.jobId, first.job.jobId)
  await service.status(); await service.start()
  assert.equal(prepared, 1); assert.equal(launched, 1)
  assert.equal(job.installDirectory, 'D:/Applications/Harness')
  assert.ok((await readdir(dirname(job.statusFile))).includes('desktop-persistence.mjs'))
}))
test('unsupported hosts do not launch repair jobs', () => temporary(async root => {
  const service = createPersistenceService({ platform: 'darwin', root, launch: async () => { throw Error('must not launch') } })
  assert.equal((await service.status()).supported, false)
  await assert.rejects(service.start(), /Windows/)
}))

test('automatic activation prepares once without a 15-minute limit and leaves failures visible', () => temporary(async root => {
  let launched = 0, job
  const service = createPersistenceService({ platform: 'win32', root, assetRoot: fileURLToPath(new URL('../lib/', import.meta.url)),
    detect: async () => 'D:/Harness', prepare: async () => ({ alreadyPatched: false }),
    launch: async (_directory, _worker, file) => { launched++; job = JSON.parse(await readFile(file, 'utf8')) },
  })
  const prepared = await service.ensureAutomatic()
  assert.equal(prepared.job.automatic, true); assert.equal(job.expiresAt, null)
  assert.equal((await service.ensureAutomatic()).job.jobId, job.id)
  assert.equal(launched, 1)
  await writeFile(job.statusFile, JSON.stringify({ jobId: job.id, state: 'failed', message: 'Access denied' }))
  assert.equal((await service.ensureAutomatic()).job.state, 'failed'); assert.equal(launched, 1)
  await service.cancel(job.id)
  assert.equal(await readFile(job.cancelFile, 'utf8'), '')
}))

test('already persistent and unsupported hosts do not schedule automatic repair', () => temporary(async root => {
  for (const platform of ['win32', 'darwin']) {
    const service = createPersistenceService({ platform, root, detect: async () => 'D:/Harness',
      prepare: async () => ({ alreadyPatched: true }), launch: async () => { throw Error('must not launch') } })
    const info = await service.ensureAutomatic()
    assert.equal(info.job, null)
  }
}))

test('upgrades retry old failures and replace old pending workers, but current-version failures remain stopped', () => temporary(async root => {
  const options = { platform: 'win32', root, assetRoot: fileURLToPath(new URL('../lib/', import.meta.url)),
    detect: async () => 'D:/Harness', prepare: async () => ({ alreadyPatched: false, desktopVersion: '0.2.1-rc.5' }), launch: async () => {} }
  const service = createPersistenceService(options)
  const initial = await service.ensureAutomatic()
  const latestFile = join(root, 'latest.json'), previous = JSON.parse(await readFile(latestFile, 'utf8'))
  previous.pluginVersion = '0.1.8'; previous.desktopVersion = '0.2.1-rc.3'
  await writeFile(latestFile, JSON.stringify(previous))
  const queued = await createPersistenceService(options).ensureAutomatic()
  assert.notEqual(queued.job.jobId, initial.job.jobId)
  assert.equal(await readFile(previous.cancelFile, 'utf8'), '')
  const old = JSON.parse(await readFile(latestFile, 'utf8')); old.pluginVersion = '0.1.8'
  await writeFile(latestFile, JSON.stringify(old)); await writeFile(old.statusFile, JSON.stringify({ jobId: old.id, state: 'failed' }))
  const retried = await createPersistenceService(options).ensureAutomatic()
  assert.notEqual(retried.job.jobId, old.id)
  const current = JSON.parse(await readFile(latestFile, 'utf8'))
  await writeFile(current.statusFile, JSON.stringify({ jobId: current.id, state: 'failed' }))
  assert.equal((await createPersistenceService(options).ensureAutomatic()).job.jobId, current.id)
}))

test('different Desktop installations do not reuse each other jobs or block cancellation', () => temporary(async root => {
  const make = directory => createPersistenceService({ platform: 'win32', root,
    assetRoot: fileURLToPath(new URL('../lib/', import.meta.url)), detect: async () => directory,
    prepare: async () => ({ alreadyPatched: false }), launch: async () => {},
  })
  const first = make('D:/Harness'), second = make('E:/Harness')
  const one = await first.ensureAutomatic()
  assert.equal((await second.status()).job, null)
  const two = await second.ensureAutomatic()
  assert.notEqual(one.job.jobId, two.job.jobId)
  await first.cancel(one.job.jobId)
  assert.equal(await readFile(join(root, one.job.jobId, 'cancel'), 'utf8'), '')
  await assert.rejects(readFile(join(root, two.job.jobId, 'cancel')), { code: 'ENOENT' })
}))

test('automatic lifecycle starts without UI, cancels on disable even during preparation, and survives normal Desktop shutdown', async () => {
  for (const shutdown of [false, true]) {
    const carrier = new EventEmitter(), cancelled = []; let cleanup, calls = 0, complete
    const prepared = new Promise(resolve => { complete = resolve })
    registerAutomaticPersistence({ effect: fn => { cleanup = fn() } }, {
      ensureAutomatic: async () => { calls++; await prepared; return { job: { jobId: 'auto-job' } } },
      cancel: async id => { cancelled.push(id) },
    }, { process: carrier, setInterval: () => ({ unref() {} }), clearInterval() {} })
    assert.equal(calls, 1)
    if (shutdown) carrier.emit('message', { type: 'shutdown' })
    const disposing = cleanup()
    complete(); await disposing
    assert.deepEqual(cancelled, shutdown ? [] : ['auto-job'])
    assert.equal(carrier.listenerCount('message'), 0)
  }
})
test('repair worker waits for full exit, applies once, records backup and reopens Desktop', () => temporary(async root => {
  let checks = 0, applied = 0, reopened = 0, clock = 0
  const job = { id: 'fixture', installDirectory: 'D:/Harness', statusFile: join(root, 'status.json'), expiresAt: 10000 }
  await runRepairJob(job, { running: () => ++checks < 3, sleep: async ms => { clock += ms }, now: () => clock,
    apply: async directory => { assert.equal(directory, job.installDirectory); applied++; return { backup: 'verified-backup' } },
    reopen: () => { assert.equal(applied, 1); reopened++ },
  })
  const state = JSON.parse(await readFile(job.statusFile, 'utf8'))
  assert.equal(state.state, 'complete'); assert.equal(state.backup, 'verified-backup')
  assert.equal(applied, 1); assert.equal(reopened, 1)
}))
test('waiting expiry and repair failures remain visible instead of reporting login retention', () => temporary(async root => {
  let clock = 0, reopened = 0
  const job = { id: 'fixture', installDirectory: 'D:/Harness', statusFile: join(root, 'status.json'), expiresAt: 2000 }
  await runRepairJob(job, { running: () => true, sleep: async ms => { clock += ms }, now: () => clock,
    apply: async () => { throw Error('must not apply') }, reopen: () => { reopened++ },
  })
  assert.equal(JSON.parse(await readFile(job.statusFile, 'utf8')).state, 'expired')
  assert.equal(reopened, 0)
  await runRepairJob({ ...job, expiresAt: 9000 }, { running: () => false, sleep: async () => {}, now: () => 0,
    apply: async () => { throw Error('Access denied') }, reopen: () => { reopened++ },
  })
  const state = JSON.parse(await readFile(job.statusFile, 'utf8'))
  assert.equal(state.state, 'failed'); assert.match(state.message, /Access denied/); assert.equal(reopened, 1)
}))

test('automatic worker completes after long sessions, honours cancellation and does not reopen on failure', () => temporary(async root => {
  const job = { id: 'auto', automatic: true, expiresAt: null, installDirectory: 'D:/Harness',
    statusFile: join(root, 'status.json'), cancelFile: join(root, 'cancel') }
  let applied = 0, reopened = 0
  const dependencies = { running: () => false, sleep: async () => {}, now: () => 7 * 86400000,
    apply: async () => { applied++; return { backup: 'backup' } }, reopen: () => { reopened++ } }
  await runRepairJob(job, dependencies)
  assert.equal(applied, 1); assert.equal(reopened, 1)
  await runRepairJob(job, { ...dependencies, apply: async () => { throw Error('Access denied') } })
  assert.equal(JSON.parse(await readFile(job.statusFile, 'utf8')).state, 'failed'); assert.equal(reopened, 1)
  await writeFile(job.cancelFile, '')
  await runRepairJob(job, dependencies)
  assert.equal(JSON.parse(await readFile(job.statusFile, 'utf8')).state, 'cancelled')
  assert.equal(applied, 1); assert.equal(reopened, 1)
}))
test('setup routes require host authentication, loopback and explicit POST requests', async () => {
  const routes = [], callbacks = []; let calls = 0
  const ctx = { connection: { requestRejection: req => req.refusal }, effect: fn => callbacks.push(fn()),
    webServer: { register: route => { routes.push(route); return () => {} } } }
  registerPersistenceRoutes(ctx, { status: async () => ({ supported: true }), start: async () => { calls++; return { supported: true } } })
  const handler = routes.find(route => route.path.endsWith('/prepare')).handler
  const request = async overrides => {
    let code, body
    await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, ...overrides },
      { writeHead: value => { code = value }, end: value => { body = JSON.parse(value) } })
    return { code, body }
  }
  assert.equal((await request({ refusal: 401 })).code, 401)
  assert.equal((await request({ socket: { remoteAddress: '192.168.1.2' } })).code, 403)
  assert.equal((await request({ method: 'GET' })).code, 405)
  assert.equal((await request({ headers: {} })).code, 415)
  assert.equal(calls, 0)
  assert.equal((await request({})).body.ok, true)
  assert.equal(calls, 1)
})
