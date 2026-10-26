import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installDeepseekNoticeDismissal } from '../src/deepseek-notice.js'

const title = '使用环境异常'
const body = '当前页面的使用环境可能存在数据和隐私泄露风险，为保障安全，建议您使用我们的官方产品。'
const flush = window => new Promise(resolve => window.setTimeout(resolve, 0))
function fixture(url = 'https://chat.deepseek.com/sign_in') {
  const dom = new JSDOM('<!doctype html><body><input id="phone" value=""><div id="dialogs"></div></body>', { url, runScripts: 'outside-only' })
  const { window } = dom, doc = window.document
  const add = (options = {}) => {
    const dialog = doc.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.innerHTML = `<h2>${options.title ?? title}</h2><p>${options.body ?? body}</p><button aria-label="关闭"><svg></svg></button>`
    let clicks = 0
    dialog.querySelector('button').onclick = () => { clicks++; dialog.remove() }
    doc.getElementById('dialogs').appendChild(dialog)
    return { dialog, clicks: () => clicks }
  }
  return { dom, window, doc, add, install: () => window.eval(`(${installDeepseekNoticeDismissal.toString()})()`) }
}

test('closes only the exact DeepSeek notice using its own close handler; leaves account storage unchanged', () => {
  const f = fixture()
  try {
    f.window.localStorage.setItem('account-token-fixture', 'unchanged')
    const notice = f.add()
    const other = f.add({ title: '请完成验证码', body: '请验证后继续登录' })
    assert.equal(f.install(), true)
    assert.equal(notice.clicks(), 1)
    assert.equal(other.clicks(), 0)
    assert.equal(other.dialog.isConnected, true)
    assert.equal(f.window.localStorage.getItem('account-token-fixture'), 'unchanged')
    assert.equal(f.doc.getElementById('phone').value, '')
  } finally { f.dom.window.close() }
})
test('handles a late React dialog once and installs idempotently', async () => {
  const f = fixture()
  try {
    f.install(); f.install()
    const notice = f.add()
    await flush(f.window)
    assert.equal(notice.clicks(), 1)
    const next = f.add()
    await flush(f.window)
    assert.equal(next.clicks(), 1)
  } finally { f.dom.window.close() }
})
test('does not act on other origins, similar warnings, ambiguous buttons, or disabled controls', () => {
  for (const origin of ['https://chatgpt.com/', 'https://chat.deepseek.com.evil.example/', 'http://chat.deepseek.com/']) {
    const f = fixture(origin)
    try { const notice = f.add(); assert.equal(f.install(), false); assert.equal(notice.clicks(), 0) }
    finally { f.dom.window.close() }
  }
  const f = fixture()
  try {
    const similar = f.add({ body: '是否退出登录？' })
    const ambiguous = f.add()
    ambiguous.dialog.appendChild(ambiguous.dialog.querySelector('button').cloneNode(true))
    const disabled = f.add()
    disabled.dialog.querySelector('button').disabled = true
    f.install()
    for (const notice of [similar, ambiguous, disabled]) assert.equal(notice.clicks(), 0)
  } finally { f.dom.window.close() }
})
test('recognizes icon-only close controls and stops pending work on pagehide', async () => {
  const f = fixture()
  try {
    f.install()
    const icon = f.add()
    icon.dialog.querySelector('button').removeAttribute('aria-label')
    await flush(f.window)
    assert.equal(icon.clicks(), 1)
    const pending = f.add()
    f.window.dispatchEvent(new f.window.Event('pagehide'))
    await flush(f.window)
    assert.equal(pending.clicks(), 0)
  } finally { f.dom.window.close() }
})
test('waits for the exact warning text and a visible dialog before closing', async () => {
  const f = fixture()
  try {
    const notice = f.add({ title: 'Loading', body: 'Loading' })
    notice.dialog.hidden = true
    f.install()
    notice.dialog.querySelector('h2').firstChild.data = title
    notice.dialog.querySelector('p').firstChild.data = body
    await flush(f.window)
    assert.equal(notice.clicks(), 0)
    notice.dialog.hidden = false
    await flush(f.window)
    assert.equal(notice.clicks(), 1)
  } finally { f.dom.window.close() }
})
