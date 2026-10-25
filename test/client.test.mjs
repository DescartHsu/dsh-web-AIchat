import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'

async function boot(desktop = true) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url: 'https://dsh.test/', runScripts: 'outside-only' })
  const { window } = dom
  const previous = new Map()
  for (const [key, value] of Object.entries({ window, document: window.document,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  window.ResizeObserver = globalThis.ResizeObserver
  let acquired = 0
  const released = []
  if (desktop) window.dshDesktop = { protocolVersion: 1, browser: {
    async acquire(workspace) { return { lease: `lease-${++acquired}`, partition: workspace } },
    async release(lease) { released.push(lease) }, onOpenRequested() { return () => {} },
  } }
  const create = window.document.createElement.bind(window.document)
  window.document.createElement = (name, options) => {
    const element = create(name, options)
    if (name === 'webview') {
      element.loads = []
      element.loadURL = async url => { element.loads.push(url) }
      element.reload = () => {}
    }
    if (name === 'div') element.getBoundingClientRect = () => ({ left: 200, top: 150, width: 900, height: 600 })
    return element
  }
  let plugin
  window.__ModuleLoader__ = { load({ id, factory }) {
    assert.equal(id, 'dsh-web-aichat')
    plugin = factory(name => { assert.equal(name, 'react'); return React })
  } }
  window.eval(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const slots = [], cleanups = []
  plugin.apply({ effect(callback) { cleanups.push(callback()) }, slots: {
    inject(name, callback) { callback() }, register(spec, component) { slots.push({ ...spec, component }) },
  } })
  const Panel = slots.find(slot => slot.name === 'main').component
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(window.document.getElementById('root'))
  await act(async () => { root.render(React.createElement(Panel)) })
  return { window, root, Panel, released, slots,
    async finish() {
      await act(async () => root.unmount())
      for (const cleanup of cleanups.reverse()) await cleanup?.()
      dom.window.close()
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    },
  }
}

test('built client registers sidebar and main slots; UI switches, hides and restores guests', async () => {
  const fixture = await boot()
  const { window, root, Panel, slots } = fixture
  const doc = window.document
  const guest = id => doc.querySelector(`[data-dsh-web-aichat="${id}"]`)
  const click = async element => { assert.ok(element); await act(async () => element.click()) }
  try {
    assert.equal(slots.find(slot => slot.name === 'sidebar.panellist').id, 'web-aichat')
    assert.equal(slots.find(slot => slot.name === 'sidebar.panellist').label(), 'AI Chat')
    assert.equal(doc.querySelectorAll('[role=tab]').length, 8)
    const deepseek = guest('deepseek')
    assert.ok(deepseek)
    await act(async () => deepseek.firstChild.dispatchEvent(new window.Event('dom-ready')))
    await click(doc.getElementById('aic-tab-chatgpt'))
    assert.equal(deepseek.style.display, 'none')
    assert.equal(guest('chatgpt').style.display, 'block')
    await click(doc.getElementById('aic-tab-deepseek'))
    assert.equal(guest('deepseek'), deepseek)
    assert.equal(deepseek.firstChild.loads.length, 1)
    const manage = [...doc.querySelectorAll('button')].find(button => button.textContent === '管理网站')
    await click(manage)
    assert.equal(deepseek.style.display, 'none')
    assert.match(doc.body.textContent, /添加你常用的 AI/)
    await click([...doc.querySelectorAll('button')].find(button => button.textContent === '返回聊天'))
    assert.equal(guest('deepseek'), deepseek)
    assert.equal(deepseek.style.display, 'block')
    await act(async () => root.render(null))
    assert.equal(deepseek.style.display, 'none')
    await act(async () => root.render(React.createElement(Panel)))
    assert.equal(guest('deepseek'), deepseek)
    assert.equal(deepseek.style.display, 'block')
    const stored = JSON.parse(window.localStorage.getItem('dsh-web-aichat:config:v1'))
    assert.equal(stored.selected, 'deepseek')
  } finally { await fixture.finish() }
  assert.equal(fixture.released.length, 2)
})

test('custom website form adds an entry, opens it, and can remove it', async () => {
  const fixture = await boot()
  const { window } = fixture
  const doc = window.document
  const clickText = async text => {
    const button = [...doc.querySelectorAll('button')].find(item => item.textContent === text)
    assert.ok(button, text)
    await act(async () => button.click())
  }
  const fill = async (input, text) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  try {
    await clickText('管理网站')
    const inputs = doc.querySelectorAll('input')
    await fill(inputs[0], 'Example AI')
    await fill(inputs[1], 'https://example.com/chat')
    await act(async () => doc.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    assert.equal(doc.querySelectorAll('[role=tab]').length, 9)
    const saved = JSON.parse(window.localStorage.getItem('dsh-web-aichat:config:v1'))
    assert.equal(saved.custom[0].name, 'Example AI')
    assert.equal(saved.selected, saved.custom[0].id)
    assert.ok(doc.querySelector(`[data-dsh-web-aichat="${saved.selected}"]`))
    await clickText('管理网站')
    await clickText('移除入口')
    assert.equal(doc.querySelectorAll('[role=tab]').length, 8)
    assert.equal(doc.querySelector(`[data-dsh-web-aichat="${saved.selected}"]`), null)
    assert.equal(JSON.parse(window.localStorage.getItem('dsh-web-aichat:config:v1')).selected, 'deepseek')
  } finally { await fixture.finish() }
})

test('built client has a usable fallback when the Desktop bridge is absent', async () => {
  const fixture = await boot(false)
  try {
    assert.match(fixture.window.document.body.textContent, /需要桌面客户端/)
    assert.equal(fixture.window.document.querySelectorAll('webview, iframe').length, 0)
    await act(async () => fixture.window.document.getElementById('aic-tab-claude').click())
    assert.match(fixture.window.document.body.textContent, /https:\/\/claude.ai\//)
  } finally { await fixture.finish() }
})
