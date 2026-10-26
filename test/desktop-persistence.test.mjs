import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { patchDesktopMain, parseArchive, readEntry, replaceEntry } from '../scripts/desktop-persistence.mjs'

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
