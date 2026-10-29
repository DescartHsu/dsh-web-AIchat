import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'

async function boot(desktop = true, fetchImplementation, persistent = true, initialConfig) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url: 'https://dsh.test/', runScripts: 'outside-only' })
  const { window } = dom
  if (initialConfig) window.localStorage.setItem('dsh-web-aichat:config:v1', JSON.stringify(initialConfig))
  if (fetchImplementation) window.fetch = fetchImplementation
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
    async acquire(workspace) { return { lease: `lease-${++acquired}`, partition: persistent ? `persist:${workspace}` : workspace } },
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
    await act(async () => doc.querySelector('button[aria-label="删除 Example AI"]').click())
    assert.equal(doc.querySelectorAll('[role=tab]').length, 8)
    assert.equal(doc.querySelector(`[data-dsh-web-aichat="${saved.selected}"]`), null)
    assert.equal(JSON.parse(window.localStorage.getItem('dsh-web-aichat:config:v1')).selected, 'qwen')
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

test('fresh desktop setup needs no repair click and does not open a temporary login page', async () => {
  const calls = []
  const fixture = await boot(true, async (url, options) => {
    calls.push({ url, method: options.method })
    return { ok: true, status: 200, json: async () => ({ ok: true, supported: true, installDirectory: 'D:/Apps/Harness', onDiskEnabled: false,
      job: { state: 'waiting', automatic: true, message: '登录存储已自动准备，无需点击修复，完整退出后将自动重开一次。' } }) }
  }, false)
  try {
    const doc = fixture.window.document
    const click = async text => { const button = [...doc.querySelectorAll('button')].find(item => item.textContent === text); assert.ok(button, text); await act(async () => button.click()) }
    assert.match(doc.body.textContent, /已自动准备/)
    assert.equal(doc.querySelectorAll('webview').length, 0)
    assert.equal(calls.filter(call => call.url.endsWith('/prepare')).length, 0)
    await click('登录存储状态')
    assert.match(doc.body.textContent, /D:\/Apps\/Harness/)
    assert.equal([...doc.querySelectorAll('button')].some(item => /启用登录保留|准备修复|重试自动设置/.test(item.textContent)), false)
    assert.equal(calls.filter(call => call.url.endsWith('/prepare')).length, 0)
    assert.doesNotMatch(doc.body.textContent, /登录状态自动保留/)
  } finally { await fixture.finish() }
})

test('dragging tabs reorders built-in and custom sites, persists across reload, and preserves active chat guests', async () => {
  const fixture = await boot(true, undefined, true, { version: 1, custom: [
    { id: 'custom-example', name: 'Example', url: 'https://example.com/' },
  ] })
  let saved
  try {
    const { window } = fixture, doc = window.document
    const tab = id => doc.getElementById(`aic-tab-${id}`)
    const order = () => [...doc.querySelectorAll('[role=tab]')].map(element => element.id.replace('aic-tab-', ''))
    const transfer = { effectAllowed: '', dropEffect: '', setData() {} }
    const drag = async (type, element, x = 110) => {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      await act(async () => element.dispatchEvent(event))
    }
    const deepseek = doc.querySelector('[data-dsh-web-aichat=deepseek]')
    await act(async () => deepseek.firstChild.dispatchEvent(new window.Event('dom-ready')))
    deepseek.firstChild.draft = 'unsent draft'
    await act(async () => tab('chatgpt').click())
    const chatgpt = doc.querySelector('[data-dsh-web-aichat=chatgpt]')
    const original = order()
    tab('deepseek').getBoundingClientRect = () => ({ left: 100, width: 100, right: 200 })
    // An external drag cannot reorder tabs, even with a matching text payload.
    await drag('drop', tab('deepseek'))
    assert.deepEqual(order(), original)
    await drag('dragstart', tab('custom-example'))
    await drag('dragover', tab('deepseek'))
    assert.equal(tab('deepseek').dataset.drop, 'before')
    const nav = doc.querySelector('[role=tablist]')
    nav.getBoundingClientRect = () => ({ left: 0, right: 800 })
    await drag('dragover', nav, 790)
    assert.equal(nav.scrollLeft, 20)
    await drag('drop', tab('deepseek'))
    assert.equal(order()[0], 'custom-example')
    assert.equal(doc.querySelector('[data-dragging=true], [data-drop]'), null)
    tab('gemini').getBoundingClientRect = () => ({ left: 100, width: 100, right: 200 })
    await drag('dragstart', tab('deepseek'))
    await drag('dragover', tab('gemini'), 190)
    assert.equal(tab('gemini').dataset.drop, 'after')
    await drag('drop', tab('gemini'), 190)
    assert.deepEqual(order().slice(0, 5), ['custom-example', 'chatgpt', 'claude', 'gemini', 'deepseek'])
    const completed = order()
    await drag('dragstart', tab('grok'))
    await drag('dragover', tab('deepseek'))
    await drag('dragend', tab('grok'))
    assert.deepEqual(order(), completed)
    assert.equal(tab('chatgpt').getAttribute('aria-selected'), 'true')
    assert.equal(doc.querySelector('[data-dsh-web-aichat=deepseek]'), deepseek)
    assert.equal(doc.querySelector('[data-dsh-web-aichat=chatgpt]'), chatgpt)
    assert.equal(deepseek.firstChild.loads.length, 1); assert.equal(deepseek.firstChild.draft, 'unsent draft')
    assert.equal(fixture.released.length, 0)
    saved = JSON.parse(window.localStorage.getItem('dsh-web-aichat:config:v1'))
    assert.deepEqual(saved.order, completed); assert.equal(saved.selected, 'chatgpt')
  } finally { await fixture.finish() }
  const restored = await boot(true, undefined, true, saved)
  try {
    assert.deepEqual([...restored.window.document.querySelectorAll('[role=tab]')].map(element => element.id.replace('aic-tab-', '')), saved.order)
    assert.equal(restored.window.document.getElementById('aic-tab-chatgpt').getAttribute('aria-selected'), 'true')
  } finally { await restored.finish() }
})

test('Alt+arrow moves a focused tab without switching chats and plain arrows follow the new order', async () => {
  const fixture = await boot(true, undefined, true, { version: 1, selected: 'chatgpt' })
  try {
    const { window } = fixture, doc = window.document
    const tab = doc.getElementById('aic-tab-chatgpt')
    tab.focus()
    const key = async (key, altKey = false) => {
      await act(async () => tab.dispatchEvent(new window.KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true })))
    }
    await key('ArrowRight', true)
    assert.deepEqual([...doc.querySelectorAll('[role=tab]')].slice(0, 3).map(element => element.textContent), ['DeepSeek', 'Claude', 'ChatGPT'])
    assert.equal(tab.getAttribute('aria-selected'), 'true'); assert.equal(doc.activeElement, tab)
    await key('ArrowLeft')
    assert.equal(doc.getElementById('aic-tab-claude').getAttribute('aria-selected'), 'true')
  } finally { await fixture.finish() }
})

test('deleting the active built-in closes only its guest, persists across reload, and can restore its entry', async () => {
  const fixture = await boot()
  let saved
  try {
    const { window } = fixture, doc = window.document
    await act(async () => doc.getElementById('aic-tab-chatgpt').click())
    await act(async () => doc.getElementById('aic-tab-deepseek').click())
    const other = doc.querySelector('[data-dsh-web-aichat=chatgpt]')
    await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === '管理网站').click())
    await act(async () => doc.querySelector('button[aria-label="删除 DeepSeek"]').click())
    assert.equal(doc.getElementById('aic-tab-deepseek'), null)
    assert.equal(doc.querySelector('[data-dsh-web-aichat=deepseek]'), null)
    assert.equal(doc.querySelector('[data-dsh-web-aichat=chatgpt]'), other)
    assert.equal(fixture.released.length, 1)
    saved = JSON.parse(window.localStorage.getItem('dsh-web-aichat:config:v1'))
    assert.equal(saved.selected, 'chatgpt'); assert.deepEqual(saved.hidden, ['deepseek'])
  } finally { await fixture.finish() }
  const restored = await boot(true, undefined, true, saved)
  try {
    const doc = restored.window.document
    assert.equal(doc.getElementById('aic-tab-deepseek'), null)
    await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === '管理网站').click())
    await act(async () => doc.querySelector('button[aria-label="恢复 DeepSeek"]').click())
    assert.ok(doc.getElementById('aic-tab-deepseek'))
    assert.equal(doc.getElementById('aic-tab-chatgpt').getAttribute('aria-selected'), 'true')
    assert.deepEqual(JSON.parse(restored.window.localStorage.getItem('dsh-web-aichat:config:v1')).hidden, [])
  } finally { await restored.finish() }
})

test('all sites can be deleted without reopening a hidden site, and the empty state can restore one', async () => {
  const fixture = await boot()
  try {
    const doc = fixture.window.document
    const clickText = async text => { await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === text).click()) }
    await clickText('管理网站')
    for (const button of [...doc.querySelectorAll('button[aria-label^="删除 "]')]) await act(async () => button.click())
    assert.equal(doc.querySelectorAll('[role=tab]').length, 0)
    assert.equal(doc.querySelectorAll('webview').length, 0)
    await clickText('返回聊天')
    assert.match(doc.body.textContent, /还没有网站/)
    assert.equal(doc.querySelectorAll('webview').length, 0)
    await clickText('添加或恢复网站')
    await act(async () => doc.querySelector('button[aria-label="恢复 Claude"]').click())
    await clickText('返回聊天')
    assert.equal(doc.querySelectorAll('[role=tab]').length, 1)
    assert.ok(doc.querySelector('[data-dsh-web-aichat=claude]'))
  } finally { await fixture.finish() }
})
