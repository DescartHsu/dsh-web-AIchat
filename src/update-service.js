import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import manifest from '../package.json' with { type: 'json' }

const REPOSITORY = 'https://github.com/DescartHsu/dsh-web-AIchat'
const API = 'https://api.github.com/repos/DescartHsu/dsh-web-AIchat/releases?per_page=100'
const PACKAGE = 'dsh-web-aichat'
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const ACTIVE = ['downloading', 'installing']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const compareVersions = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}
function assetURL(version, name) { return `${REPOSITORY}/releases/download/v${version}/${name}` }
export function releaseRows(data) {
  if (!Array.isArray(data)) throw Error('版本列表格式不正确。')
  const rows = new Map()
  for (const release of data) {
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
    if (!VERSION.test(version) || release.draft || release.prerelease || rows.has(version)) continue
    const name = `${PACKAGE}-${version}.tgz`
    if (!Array.isArray(release.assets)) continue
    const asset = release.assets.find(item => item.name === name && item.state === 'uploaded'
      && item.browser_download_url === assetURL(version, name) && item.size > 0 && item.size <= 5 * 1024 * 1024)
    if (!asset) continue
    const checksum = release.assets.find(item => item.name === `${PACKAGE}-${version}.sha256`
      && item.browser_download_url === assetURL(version, item.name) && item.state === 'uploaded')
    const hash = /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7).toLowerCase() : null
    if (!hash && !checksum) continue
    rows.set(version, { version, name, url: asset.browser_download_url, hash, checksum: checksum?.browser_download_url,
      publishedAt: release.published_at || '', page: `${REPOSITORY}/releases/tag/v${version}` })
  }
  return [...rows.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, 30)
}

/** Read the manifest without extracting or executing the downloaded archive. */
export function validateUpdatePackage(bytes, version) {
  const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 })
  let pkg
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/s, '')
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/')
    const sizeField = field(124, 136).trim()
    const size = /^[0-7]+$/.test(sizeField) ? parseInt(sizeField, 8) : NaN
    const type = String.fromCharCode(header[156])
    if (!name.startsWith('package/') || name.includes('\\') || name.split('/').includes('..')
      || !['0', '\0', '5'].includes(type) || !Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw Error('更新包归档结构不受支持。')
    if (name === 'package/package.json') {
      if (pkg || size > 65536) throw Error('更新包包含无效清单。')
      pkg = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString())
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (pkg?.name !== PACKAGE || pkg.version !== version || pkg.main !== 'lib/index.js'
    || pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw Error('更新包名称、版本或插件入口不匹配。')
  return pkg
}

export function createUpdateService(options = {}) {
  const request = options.fetch || globalThis.fetch
  const manager = options.manager || (() => undefined)
  const configured = process.env.DSH_HOME?.trim()
  const home = !configured || configured === '~' ? homedir() : configured.startsWith('~/') || configured.startsWith('~\\') ? join(homedir(), configured.slice(2)) : resolve(configured)
  const root = options.root || join(!configured ? join(home, '.dsh') : home, 'dsh-web-aichat', 'updates')
  const stateFile = join(root, 'state.json'), lockFile = join(root, 'install.lock')
  let cached = [], checkedAt = 0, attemptedAt = 0, fetchError = '', checking, task
  async function download(url, limit) {
    const signal = AbortSignal.timeout(30000)
    for (let redirects = 0; redirects < 6; redirects++) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(parsed.hostname)) throw Error('更新地址不受支持。')
      const response = await request(url, { signal, redirect: 'manual', headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-web-aichat-updater' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel()
        if (!location) throw Error('更新下载重定向无效。')
        url = new URL(location, url).href; continue
      }
      if (!response.ok) throw Error(response.status === 403 || response.status === 429 ? 'GitHub 检查过于频繁，请稍后重试。' : `获取更新失败（HTTP ${response.status}）。`)
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('更新文件超过大小限制。') }
      const chunks = []; let size = 0
      for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw Error('更新文件超过大小限制。'); chunks.push(chunk) }
      return Buffer.concat(chunks)
    }
    throw Error('更新下载重定向次数过多。')
  }
  async function releases(force = false) {
    if (!force && attemptedAt && Date.now() - attemptedAt < (fetchError ? 60000 : 5 * 60000)) return cached
    return checking ||= (async () => {
      attemptedAt = Date.now()
      try { cached = releaseRows(JSON.parse((await download(API, 4 * 1024 * 1024)).toString())); checkedAt = Date.now(); fetchError = '' }
      catch (error) { fetchError = error.message || '无法连接 GitHub，请稍后重试。' }
      return cached
    })().finally(() => { checking = null })
  }
  async function readState() { try { return JSON.parse(await readFile(stateFile, 'utf8')) } catch { return null } }
  async function save(value) {
    await mkdir(root, { recursive: true })
    const file = `${stateFile}.${randomUUID()}.tmp`
    await writeFile(file, JSON.stringify({ ...value, updatedAt: Date.now() }), { mode: 0o600 }); await rename(file, stateFile)
  }
  async function status(force = false) {
    const rows = await releases(force), installer = manager()
    let installedVersion = manifest.version
    if (installer?.listBundles) { try { installedVersion = (await installer.listBundles()).find(item => item.name === PACKAGE)?.version || installedVersion } catch { /* Keep running version visible. */ } }
    let job = await readState()
    if (ACTIVE.includes(job?.state) && job.pid !== process.pid) {
      let alive = false
      try { process.kill(job.pid, 0); alive = true } catch { /* Previous Host stopped. */ }
      if (!alive) job = { ...job, state: 'failed', message: '上次更新被中断，请重新检查后重试。' }
    }
    return { runningVersion: manifest.version, installedVersion, latestVersion: rows[0]?.version || null, checkedAt, fetchError,
      canInstall: typeof installer?.installBundle === 'function' && typeof installer?.listBundles === 'function', job,
      releases: rows.map(({ version, publishedAt, page }) => ({ version, publishedAt, page })) }
  }
  async function start(version) {
    if (typeof version !== 'string' || !VERSION.test(version)) throw Error('请选择有效的版本。')
    const installer = manager()
    if (!installer?.installBundle || !installer?.listBundles) throw Error('当前宿主不支持自动安装，请在 DSH 插件管理中安装 Release 包。')
    if (task) throw Error('已有更新正在进行。')
    await mkdir(root, { recursive: true })
    let lock
    try { lock = await open(lockFile, 'wx') }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      let previous
      try { previous = JSON.parse(await readFile(lockFile, 'utf8')) } catch { previous = {} }
      let alive = false
      if (Number.isInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); alive = true } catch { /* Previous Host stopped. */ }
      } else alive = Date.now() - (await stat(lockFile)).mtimeMs < 30000
      if (alive) throw Error('已有更新正在进行。')
      await unlink(lockFile); lock = await open(lockFile, 'wx')
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close()
    const id = randomUUID(), base = { id, pid: process.pid, version }
    try { await save({ ...base, state: 'downloading', message: `正在下载并校验 ${version}…` }) }
    catch (error) { await unlink(lockFile).catch(() => {}); throw error }
    task = (async () => {
      try {
        const rows = await releases(true)
        if (fetchError) throw Error(fetchError)
        const row = rows.find(item => item.version === version)
        if (!row) throw Error('该版本未提供可安装的官方 Release 包。')
        const bytes = await download(row.url, 5 * 1024 * 1024)
        let hash = row.hash
        if (!hash) {
          const checksum = (await download(row.checksum, 8192)).toString()
          const match = checksum.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})\s+\*?(\S+)\s*$/i)).find(item => item?.[2] === row.name)
          if (!match) throw Error('该版本缺少有效的 SHA-256 校验。')
          hash = match[1].toLowerCase()
        }
        if (digest(bytes) !== hash) throw Error('更新包校验失败，已停止安装。')
        validateUpdatePackage(bytes, version)
        const directory = join(root, id); await mkdir(directory)
        const file = join(directory, row.name); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
        await save({ ...base, state: 'installing', message: `正在由 DSH 安装 ${version}…` })
        // Use a distinct tarball source and let the native manager own package
        // locking, profile preservation, compatibility checks and activation.
        const result = await installer.installBundle(file, { saveExact: true, requestId: id })
        if (!['applied', 'restart-required'].includes(result?.application) || result.bundle !== PACKAGE || result.version !== version) {
          throw Error('DSH 未确认目标版本安装成功，请在插件管理中查看详情。')
        }
        const installed = (await installer.listBundles()).find(item => item.name === PACKAGE)
        if (installed?.version !== version) throw Error('未检测到目标版本，更新未确认完成。')
        await save({ ...base, state: result.application, message: result.application === 'restart-required'
          ? `${version} 已安装，请完成任务后完整退出并重新打开 DSH。` : `${version} 已安装并生效。` })
      } catch (error) { await save({ ...base, state: 'failed', message: error.message || '更新失败，请重试。' }) }
      finally { await unlink(lockFile).catch(() => {}); task = null }
    })()
    // The operation belongs to the native manager and survives this plugin's
    // hot reload. A new instance reads the same status file.
    void task.catch(() => {})
    return { ...base, state: 'downloading', message: `正在下载并校验 ${version}…` }
  }
  return { status, start, wait: () => task }
}

export function registerUpdateRoutes(ctx, service = createUpdateService({ manager: () => ctx.get('pluginManager') })) {
  for (const action of ['status', 'check', 'install']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `/api/web-aichat/updates/${action}`,
      handler: async (req, res) => {
        const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
        const refusal = ctx.connection.requestRejection(req)
        if (refusal !== undefined) return reply(refusal, { ok: false })
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return reply(403, { ok: false })
        if (req.method !== 'POST') return reply(405, { ok: false })
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { ok: false })
        try {
          if (action === 'install') {
            const chunks = []; let size = 0
            for await (const chunk of req) { size += chunk.length; if (size > 4096) throw Error('请求过大。'); chunks.push(Buffer.from(chunk)) }
            const body = JSON.parse(Buffer.concat(chunks).toString())
            reply(202, { ok: true, job: await service.start(body?.version) })
          } else reply(200, { ok: true, ...await service.status(action === 'check') })
        } catch (error) { reply(400, { ok: false, error: error.message }) }
      },
    }), `web-aichat: updates ${action}`)
  }
}
