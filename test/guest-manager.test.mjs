import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuestManager } from '../src/guest-manager.js'
import { DEFAULT_PROVIDERS } from '../src/providers.js'

class Element extends EventTarget {
  style = {}; attrs = {}; children = []; loads = []; isConnected = true
  setAttribute(key, value) { this.attrs[key] = value }
  appendChild(child) { this.children.push(child); child.parent = this }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this) }
  async loadURL(url) { this.loads.push(url) }
  fire(type, values = {}) { this.dispatchEvent(Object.assign(new Event(type), values)) }
  reload() { this.reloaded = true }
  canGoBack() { return true }
  goBack() { this.wentBack = true }
  getBoundingClientRect() { return { left: 200, top: 160, width: 1000, height: 700 } }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(overrides = {}) {
  let count = 0
  const released = [], callbacks = new Map(), document = { body: new Element(), createElement: () => new Element() }
  const bridge = { async acquire(workspace) { return { lease: `lease-${++count}`, partition: workspace } },
    async release(lease) { released.push(lease) },
    onOpenRequested(lease, callback) { callbacks.set(lease, callback); return () => callbacks.delete(lease) }, ...overrides }
  return { document, released, callbacks, manager: createGuestManager({ bridge, document }) }
}
test('tabs use separate partitions; switching and hiding preserve the same guest', async () => {
  const { manager, document, released } = fixture()
  const host = new Element()
  manager.show('deepseek', host)
  const a = await manager.ensure(DEFAULT_PROVIDERS[0])
  a.element.fire('dom-ready')
  const b = await manager.ensure(DEFAULT_PROVIDERS[1])
  b.element.fire('dom-ready')
  assert.notEqual(a.element.attrs.partition, b.element.attrs.partition)
  assert.equal(a.element.attrs.src, `about:blank#${a.lease}`)
  assert.equal(a.element.loads[0], DEFAULT_PROVIDERS[0].url)
  manager.show('chatgpt', host)
  assert.equal(a.container.style.display, 'none')
  assert.equal(b.container.style.display, 'block')
  manager.hide(host)
  assert.equal(b.container.style.display, 'none')
  manager.show('deepseek', host)
  assert.equal(await manager.ensure(DEFAULT_PROVIDERS[0]), a)
  assert.equal(a.element.loads.length, 1)
  assert.equal(document.body.children.length, 2)
  assert.equal(released.length, 0)
  await manager.dispose()
  assert.equal(document.body.children.length, 0)
  assert.equal(new Set(released).size, 2)
})
test('rapid repeated requests share a pending acquisition and cannot steal active visibility', async () => {
  const gate = deferred()
  const { manager } = fixture({ acquire: () => gate.promise })
  const p1 = manager.ensure(DEFAULT_PROVIDERS[0])
  assert.equal(manager.ensure(DEFAULT_PROVIDERS[0]), p1)
  manager.show('chatgpt', new Element())
  gate.resolve({ lease: 'slow', partition: 'slow' })
  const a = await p1
  assert.equal(a.container.style.display, 'none')
  await manager.dispose()
})
test('unloading while acquiring releases the late lease and never mounts a page', async () => {
  const gate = deferred()
  const { manager, document, released } = fixture({ acquire: () => gate.promise })
  const pending = manager.ensure(DEFAULT_PROVIDERS[0])
  const done = manager.dispose()
  gate.resolve({ lease: 'late', partition: 'late' })
  assert.equal(await pending, null)
  await done
  await manager.dispose()
  assert.deepEqual(released, ['late'])
  assert.equal(document.body.children.length, 0)
})
test('removing a site during acquisition cancels it, then allows a clean retry', async () => {
  const gate = deferred()
  const { manager, document, released } = fixture({ acquire: () => gate.promise })
  manager.ensure(DEFAULT_PROVIDERS[0])
  const closing = manager.close('deepseek')
  gate.resolve({ lease: 'cancelled', partition: 'cancelled' })
  await closing
  assert.deepEqual(released, ['cancelled'])
  assert.equal(document.body.children.length, 0)
  const retry = await manager.ensure(DEFAULT_PROVIDERS[0])
  assert.ok(retry)
  await manager.dispose()
})
test('a failed acquisition can be retried, including a synchronously throwing bridge', async () => {
  let attempts = 0
  const { manager } = fixture({ acquire() {
    if (++attempts === 1) throw Error('unavailable')
    return Promise.resolve({ lease: 'retry', partition: 'retry' })
  } })
  assert.equal(await manager.ensure(DEFAULT_PROVIDERS[0]), null)
  assert.match(manager.status('deepseek').error, /无法创建/)
  assert.ok(await manager.ensure(DEFAULT_PROVIDERS[0]))
  await manager.dispose()
})
test('stale mount cleanup does not hide the new mount; zero-sized hosts hide guests', async () => {
  const { manager } = fixture()
  const a = await manager.ensure(DEFAULT_PROVIDERS[0])
  const oldHost = new Element(), host = new Element()
  manager.show('deepseek', host)
  manager.hide(oldHost)
  assert.equal(a.container.style.display, 'block')
  host.getBoundingClientRect = () => ({ width: 0, height: 0 })
  manager.reposition()
  assert.equal(a.container.style.display, 'none')
  await manager.dispose()
})
test('popups require an explicit action and reject unsafe protocols; failure stays visible', async () => {
  const { manager, callbacks } = fixture()
  const a = await manager.ensure(DEFAULT_PROVIDERS[0])
  a.element.fire('dom-ready')
  callbacks.get(a.lease)('javascript:alert(1)')
  assert.equal(manager.status('deepseek').popup, '')
  callbacks.get(a.lease)('https://accounts.example.com/login')
  assert.equal(a.element.loads.length, 1)
  await manager.navigate('deepseek', 'url', manager.status('deepseek').popup)
  assert.equal(a.element.loads[1], 'https://accounts.example.com/login')
  a.element.fire('did-fail-load', { isMainFrame: true, errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED' })
  a.element.fire('did-stop-loading')
  assert.match(manager.status('deepseek').error, /ERR_NAME_NOT_RESOLVED/)
  a.element.fire('did-fail-load', { isMainFrame: true, errorCode: -3 })
  assert.match(manager.status('deepseek').error, /ERR_NAME_NOT_RESOLVED/)
  await manager.dispose()
  assert.equal(callbacks.size, 0)
  a.element.fire('did-start-loading')
  assert.deepEqual(manager.status('deepseek'), {})
})
test('missing Desktop bridge reports unavailable without trying iframe fallback', async () => {
  const manager = createGuestManager({ document: { createElement() { throw Error('must not create') } } })
  assert.equal(manager.available, false)
  assert.equal(await manager.ensure(DEFAULT_PROVIDERS[0]), null)
  await manager.dispose()
})

test('guest palette updates serialize, keep the latest skin, and remove styles when switched off', async () => {
  const { manager } = fixture()
  const a = await manager.ensure(DEFAULT_PROVIDERS[0])
  const inserted = [], removed = []
  const gate = deferred()
  a.element.executeJavaScript = async source => !/, false\)$/.test(source)
  a.element.insertCSS = async css => {
    const key = `css-${inserted.length}`
    inserted.push(css)
    if (inserted.length === 1) await gate.promise
    return key
  }
  a.element.removeInsertedCSS = async key => { removed.push(key) }
  const first = { scheme: 'light', background: 'rgb(250, 240, 230)' }
  const second = { scheme: 'dark', background: 'rgb(10, 20, 30)' }
  manager.setTheme(first)
  a.element.fire('dom-ready')
  await new Promise(resolve => setImmediate(resolve))
  manager.setTheme(second)
  gate.resolve()
  await a.themeTask
  assert.match(inserted.at(-1), /rgb\(10, 20, 30\)/)
  assert.deepEqual(removed, ['css-0'])
  manager.setTheme(null)
  await a.themeTask
  assert.deepEqual(removed, ['css-0', 'css-1'])
  assert.equal(a.cssKey, null)
  await manager.dispose()
})

test('DeepSeek notice handling runs without theme sync and is not injected into other providers', async () => {
  const { manager } = fixture()
  const deepseek = await manager.ensure(DEFAULT_PROVIDERS[0])
  const chatgpt = await manager.ensure(DEFAULT_PROVIDERS[1])
  const deepseekCalls = [], otherCalls = []
  deepseek.element.executeJavaScript = async code => { deepseekCalls.push(code) }
  chatgpt.element.executeJavaScript = async code => { otherCalls.push(code) }
  deepseek.element.fire('dom-ready')
  chatgpt.element.fire('dom-ready')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deepseekCalls.length, 1)
  assert.match(deepseekCalls[0], /installDeepseekNoticeDismissal/)
  assert.equal(otherCalls.length, 0)
  deepseek.element.fire('did-finish-load')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deepseekCalls.length, 2)
  await manager.dispose()
  deepseek.element.fire('dom-ready')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deepseekCalls.length, 2)
})
