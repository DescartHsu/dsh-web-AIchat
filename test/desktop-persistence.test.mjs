import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { patchDesktopMain, parseArchive, readEntry, replaceEntry, prepareDesktopPatch, SUPPORTED_DESKTOP_VERSIONS } from '../scripts/desktop-persistence.mjs'

const original = `class Guests {
  partitions = new Map();
  configureSession(s) { this.lastSession = s }
  acquire(workspace) {
    let partition = this.partitions.get(workspace);
    if (partition === undefined) {
      partition = \`dsh-sidebar-browser-\${randomUUID()}\`;
      this.configureSession(session.fromPartition(partition));
      this.partitions.set(workspace, partition);
    }
    return partition;
  }
}`

test('only valid AI Chat workspaces get deterministic persistent partitions, including a new runtime', () => {
  const patched = patchDesktopMain(original)
  const context = vm.createContext({ randomUUID: () => 'random', session: { fromPartition: key => key } })
  const Guests = vm.runInContext(`${patched}; Guests`, context)
  assert.equal(new Guests().acquire('dsh-web-aichat:deepseek'), 'persist:dsh-web-aichat-deepseek')
  assert.equal(new Guests().acquire('dsh-web-aichat:deepseek'), new Guests().acquire('dsh-web-aichat:deepseek'))
  assert.notEqual(new Guests().acquire('dsh-web-aichat:chatgpt'), new Guests().acquire('dsh-web-aichat:deepseek'))
  for (const workspace of ['normal-workspace', 'dsh-web-aichat:../bad', 'dsh-web-aichat:', 'dsh-web-aichat:custom/'+ 'x']) {
    assert.equal(new Guests().acquire(workspace), 'dsh-sidebar-browser-random')
  }
  assert.equal(patchDesktopMain(patched), patched)
  assert.throws(() => patchDesktopMain('unknown implementation'), /refusing/)
})

test('ASAR replacement preserves all other files and metadata while rebuilding integrity for changed code', () => {
  const main = Buffer.from(original), other = Buffer.from('untouched asset')
  const header = { files: { lib: { files: { 'main.js': { size: main.length, offset: '0', integrity: {
    algorithm: 'SHA256', hash: 'old', blockSize: 64, blocks: [],
  } } } }, 'asset.txt': { size: other.length, offset: String(main.length) },
  'native.node': { size: 10, unpacked: true, executable: true } } }
  const json = Buffer.from(JSON.stringify(header)), aligned = Math.ceil(json.length / 4) * 4
  const prefix = Buffer.alloc(16 + aligned)
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + aligned, 4)
  prefix.writeUInt32LE(4 + aligned, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16)
  const input = Buffer.concat([prefix, main, other])
  const changed = patchDesktopMain(original)
  const output = parseArchive(replaceEntry(input, 'lib/main.js', changed))
  assert.equal(readEntry(output, 'lib/main.js').toString(), changed)
  assert.equal(readEntry(output, 'asset.txt').toString(), 'untouched asset')
  assert.deepEqual(output.header.files['native.node'], header.files['native.node'])
  const integrity = output.header.files.lib.files['main.js'].integrity
  assert.equal(integrity.hash, createHash('sha256').update(changed).digest('hex'))
  assert.ok(integrity.blocks.length > 1)
  assert.equal(integrity.blocks[0], createHash('sha256').update(Buffer.from(changed).subarray(0, 64)).digest('hex'))
})

const native = await readFile(new URL('./fixtures/desktop-acquire.js', import.meta.url), 'utf8')
test('rc.5 native acquire retains lease ownership and only persists AI Chat workspaces', () => {
  const context = vm.createContext({ randomUUID: () => 'random', session: { fromPartition: value => value } })
  const Guests = vm.runInContext(`${patchDesktopMain(native)}; Guests`, context)
  const owner = {}, guests = new Guests()
  const lease = guests.acquire(owner, 'dsh-web-aichat:deepseek')
  assert.equal(lease.partition, 'persist:dsh-web-aichat-deepseek')
  assert.equal(guests.leases.get(lease.lease).owner, owner)
  assert.equal(new Guests().acquire(owner, 'ordinary-workspace').partition, 'dsh-sidebar-browser-random')
  assert.throws(() => guests.acquire(owner, ''), /storage identity/)
})

test('verified Desktop versions pass archive checks while unknown versions, layouts, policies and fuses fail closed', async () => {
  const base = resolve('work'); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'compat-'))
  try {
    await mkdir(join(root, 'resources'))
    const exe = Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 8, ...Array(8).fill(48)])])
    const archive = async (version, source = native, main = 'lib/main.js') => {
      const pkg = Buffer.from(JSON.stringify({ version, main })), body = Buffer.from(source)
      const json = Buffer.from(JSON.stringify({ files: { 'package.json': { size: pkg.length, offset: '0' }, lib: { files: { 'main.js': { size: body.length, offset: String(pkg.length) } } } } }))
      const aligned = Math.ceil(json.length / 4) * 4, prefix = Buffer.alloc(16 + aligned)
      prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + aligned, 4); prefix.writeUInt32LE(4 + aligned, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16)
      await writeFile(join(root, 'resources/app.asar'), Buffer.concat([prefix, pkg, body]))
    }
    await writeFile(join(root, 'DeepSeek Harness.exe'), exe)
    for (const version of SUPPORTED_DESKTOP_VERSIONS) {
      await archive(version)
      const plan = await prepareDesktopPatch(root)
      assert.equal(plan.desktopVersion, version); assert.equal(plan.alreadyPatched, false)
      await writeFile(plan.file, plan.output)
      assert.equal((await prepareDesktopPatch(root)).alreadyPatched, true)
    }
    await archive('0.2.1-rc.6'); await assert.rejects(prepareDesktopPatch(root), /Unsupported.*build/)
    await archive('0.2.1-rc.5', native, 'different.js'); await assert.rejects(prepareDesktopPatch(root), /Unsupported.*build/)
    await archive('0.2.1-rc.5', 'unknown implementation'); await assert.rejects(prepareDesktopPatch(root), /refusing/)
    await archive('0.2.1-rc.5'); exe[exe.length - 4] = 49
    await writeFile(join(root, 'DeepSeek Harness.exe'), exe)
    await assert.rejects(prepareDesktopPatch(root), /validation is enabled/)
  } finally { assert.equal(dirname(resolve(root)), base); await rm(root, { recursive: true, force: true }) }
})
