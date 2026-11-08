import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { createUpdateService, releaseRows, validateUpdatePackage, registerUpdateRoutes } from '../src/update-service.js'

const base = 'https://github.com/DescartHsu/dsh-web-AIchat/releases/download/'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function tarball(version, overrides = {}, type = '0') {
  const body = Buffer.from(JSON.stringify({ name: 'dsh-web-aichat', version, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...overrides }))
  const header = Buffer.alloc(512)
  header.write('package/package.json'); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write(type, 156); header.fill(32, 148, 156)
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length + 1024)]))
}
function release(version, bytes = tarball(version)) {
  const name = `dsh-web-aichat-${version}.tgz`
  return { tag_name: `v${version}`, published_at: '2026-11-09T12:00:00Z', assets: [
    { name, state: 'uploaded', size: bytes.length, browser_download_url: `${base}v${version}/${name}`, digest: `sha256:${sha(bytes)}` },
  ] }
}
async function temporary(run) {
  const parent = resolve('work'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'update-test-'))
  try { return await run(root) }
  finally { assert.equal(dirname(resolve(root)), parent); await rm(root, { recursive: true, force: true }) }
}
function fixture(root, overrides = {}) {
  const bytes = tarball('0.1.12'), row = release('0.1.12', bytes)
  let installed = '0.1.10', calls = 0, feedReads = 0
  const manager = { listBundles: async () => [{ name: 'dsh-web-aichat', version: installed }],
    installBundle: async (file, options) => {
      calls++; assert.deepEqual(await readFile(file), bytes); assert.equal(options.saveExact, true)
      assert.match(options.requestId, /^[a-f0-9-]+$/)
      installed = '0.1.12'
      return { application: 'restart-required', bundle: 'dsh-web-aichat', version: installed }
    }, ...overrides.manager }
  const fetch = overrides.fetch || (async url => {
    if (url.startsWith('https://api.github.com/')) { feedReads++; return Response.json([row, release('0.1.9'), release('0.1.10')]) }
    assert.equal(url, row.assets[0].browser_download_url); return new Response(bytes)
  })
  return { service: createUpdateService({ root, manager: () => manager, fetch }), manager, row, bytes,
    calls: () => calls, reads: () => feedReads }
}

test('version feed sorts numerically and excludes drafts, previews, missing checksums and foreign assets', () => {
  const wrong = release('9.9.9'); wrong.assets[0].browser_download_url = 'https://evil.example/pkg.tgz'
  const unsigned = release('0.1.13'); unsigned.assets[0].digest = null
  const rows = releaseRows([release('0.1.9'), release('0.1.12'), release('0.1.10'), { ...release('2.0.0'), draft: true },
    { ...release('1.0.0'), prerelease: true }, wrong, unsigned, { tag_name: '../../bad' }])
  assert.deepEqual(rows.map(row => row.version), ['0.1.12', '0.1.10', '0.1.9'])
})

test('archive inspection rejects wrong identities, versions, malformed archives and symbolic links', () => {
  assert.equal(validateUpdatePackage(tarball('0.1.12'), '0.1.12').name, 'dsh-web-aichat')
  assert.throws(() => validateUpdatePackage(tarball('0.1.12', { name: 'different' }), '0.1.12'), /不匹配/)
  assert.throws(() => validateUpdatePackage(tarball('0.1.12'), '0.1.13'), /不匹配/)
  assert.throws(() => validateUpdatePackage(tarball('0.1.12', {}, '2'), '0.1.12'), /结构/)
  assert.throws(() => validateUpdatePackage(Buffer.from('invalid'), '0.1.12'))
})

test('updater caches checks, downloads verified tarball and reports native restart requirement from disk state', () => temporary(async root => {
  const f = fixture(root)
  const before = await f.service.status(); await f.service.status()
  assert.equal(f.reads(), 1); assert.equal(before.installedVersion, '0.1.10'); assert.equal(before.latestVersion, '0.1.12')
  assert.equal((await f.service.start('0.1.12')).state, 'downloading')
  await f.service.wait()
  const after = await f.service.status()
  assert.equal(after.job.state, 'restart-required'); assert.equal(after.installedVersion, '0.1.12'); assert.equal(f.calls(), 1)
  assert.match(after.job.message, /完整退出/)
  await f.service.status(true); assert.equal(f.reads(), 3)
}))

test('checksum mismatch and native failure never report installation success', () => temporary(async root => {
  let calls = 0
  const corrupted = fixture(root, { fetch: async url => url.startsWith('https://api.github.com/')
    ? Response.json([release('0.1.12')]) : new Response(Buffer.from('tampered')),
    manager: { installBundle: async () => { calls++; throw Error('must not run') } } })
  await corrupted.service.start('0.1.12'); await corrupted.service.wait()
  assert.equal((await corrupted.service.status()).job.state, 'failed'); assert.equal(calls, 0)
  const refused = fixture(root, { manager: { installBundle: async () => ({ application: 'failed', error: { message: 'private diagnostic' } }) } })
  await refused.service.start('0.1.12'); await refused.service.wait()
  const result = await refused.service.status()
  assert.equal(result.job.state, 'failed'); assert.equal(result.installedVersion, '0.1.10')
  assert.doesNotMatch(result.job.message, /private diagnostic|已安装/)
}))

test('updates survive service replacement, block concurrent installs and accept checksum-file fallback', () => temporary(async root => {
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  const bytes = tarball('0.1.12'), row = release('0.1.12', bytes)
  row.assets[0].digest = null
  const name = 'dsh-web-aichat-0.1.12.sha256'
  row.assets.push({ name, state: 'uploaded', browser_download_url: `${base}v0.1.12/${name}` })
  const options = { fetch: async url => url.startsWith('https://api.github.com/') ? Response.json([row])
    : url.endsWith('.sha256') ? new Response(`${sha(bytes)}  dsh-web-aichat-0.1.12.tgz\n`) : new Response(bytes),
    manager: { installBundle: async () => { await gate; return { application: 'applied', bundle: 'dsh-web-aichat', version: '0.1.12' } },
      listBundles: async () => [{ name: 'dsh-web-aichat', version: '0.1.12' }] } }
  const first = fixture(root, options), second = fixture(root, options)
  await first.service.start('0.1.12')
  await assert.rejects(second.service.start('0.1.12'), /已有更新/)
  finish(); await first.service.wait()
  assert.equal((await second.service.status()).job.state, 'applied')
  await assert.rejects(second.service.start('../anything'), /有效/)
}))

test('unavailable hosts, network failures and untrusted redirects leave an actionable error', () => temporary(async root => {
  const service = createUpdateService({ root, fetch: async () => { throw Error('network offline') } })
  const info = await service.status()
  assert.equal(info.canInstall, false); assert.match(info.fetchError, /offline/)
  await assert.rejects(service.start('0.1.12'), /不支持/)
  const redirected = fixture(root, { fetch: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) })
  assert.match((await redirected.service.status()).fetchError, /地址不受支持/)
}))

test('an interrupted empty lock recovers after its preparation window without stealing a fresh lock', () => temporary(async root => {
  const f = fixture(root), lock = join(root, 'install.lock')
  await writeFile(lock, '')
  await assert.rejects(f.service.start('0.1.12'), /已有更新/)
  const old = new Date(Date.now() - 60000); await utimes(lock, old, old)
  await f.service.start('0.1.12'); await f.service.wait()
  assert.equal((await f.service.status()).job.state, 'restart-required')
}))

test('update routes enforce authentication, loopback, POST, JSON and version-only installation', async () => {
  const routes = []; let calls = 0
  registerUpdateRoutes({ effect: fn => fn(), connection: { requestRejection: req => req.refusal }, webServer: { register: route => { routes.push(route); return () => {} } } },
    { status: async () => ({}), start: async version => { assert.equal(version, '0.1.12'); calls++; return { state: 'downloading' } } })
  const handler = routes.find(route => route.path.endsWith('/install')).handler
  const request = async (changes = {}, body = '{"version":"0.1.12","spec":"ignored"}') => {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, ...changes })
    let code, result
    await handler(req, { writeHead: value => { code = value }, end: value => { result = JSON.parse(value) } })
    return { code, result }
  }
  assert.equal((await request({ refusal: 401 })).code, 401)
  assert.equal((await request({ socket: { remoteAddress: '192.168.1.2' } })).code, 403)
  assert.equal((await request({ method: 'GET' })).code, 405)
  assert.equal((await request({ headers: {} })).code, 415)
  assert.equal((await request({}, 'x'.repeat(5000))).code, 400)
  assert.equal(calls, 0); assert.equal((await request()).code, 202); assert.equal(calls, 1)
})
