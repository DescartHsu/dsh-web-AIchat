import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installGuestTheme } from '../src/theme.js'

const waitPaint = window => new Promise(resolve => window.setTimeout(resolve, 60))
function page(url = 'https://chat.example.com/') {
  const dom = new JSDOM(`<!doctype html><html><head><style>
    * { background-image:none; }
    body { background:#fff; color:#222; }
    main { background:#fafafa; }
    textarea { background:#eee; color:#222; border:1px solid #ccc; }
    .brand { background:rgb(0, 50, 240); color:white; }
    pre { background:#101010; color:#efefef; }
  </style></head><body><main><p>Sample message</p><textarea></textarea>
    <button class="brand">Brand</button><pre><code>const x = 1</code></pre>
    <div id="captcha-widget"><p>Verification</p></div></main></body></html>`,
    { url, runScripts: 'outside-only', pretendToBeVisual: true })
  const apply = enabled => dom.window.eval(`(${installGuestTheme.toString()})('https://chat.example.com', ${enabled})`)
  return { dom, apply, window: dom.window, doc: dom.window.document }
}

test('guest themes neutral chat surfaces and dynamic content while preserving media, code and challenge regions', async () => {
  const { dom, apply, window, doc } = page()
  try {
    assert.equal(apply(true), true)
    await waitPaint(window)
    assert.equal(doc.querySelector('main').getAttribute('data-aic-bg'), 'base')
    assert.equal(doc.querySelector('textarea').getAttribute('data-aic-bg'), 'surface')
    assert.equal(doc.querySelector('textarea').getAttribute('data-aic-fg'), 'normal')
    assert.equal(doc.querySelector('.brand').hasAttribute('data-aic-bg'), false)
    assert.equal(doc.querySelector('.brand').hasAttribute('data-aic-fg'), false)
    assert.equal(doc.querySelector('code').hasAttribute('data-aic-fg'), false)
    assert.equal(doc.querySelector('#captcha-widget p').hasAttribute('data-aic-fg'), false)
    const message = doc.createElement('section')
    message.style.backgroundColor = 'rgb(240, 240, 240)'
    doc.querySelector('main').appendChild(message)
    await waitPaint(window)
    assert.equal(message.getAttribute('data-aic-bg'), 'surface')
  } finally { dom.window.close() }
})

test('disabling guest theme cancels pending work and does not change input or account storage', async () => {
  const { dom, apply, window, doc } = page()
  try {
    const input = doc.querySelector('textarea')
    input.value = 'unsent draft'
    window.localStorage.setItem('session', 'untouched')
    apply(true)
    apply(false)
    await waitPaint(window)
    assert.equal(doc.documentElement.hasAttribute('data-dsh-aichat-themed'), false)
    assert.equal(input.value, 'unsent draft')
    assert.equal(window.localStorage.getItem('session'), 'untouched')
    apply(true)
    await waitPaint(window)
    assert.equal(doc.documentElement.hasAttribute('data-dsh-aichat-themed'), true)
  } finally { dom.window.close() }
})

test('guest styling does not activate on another origin or login routes, and pauses for SPA login navigation', async () => {
  for (const url of ['https://accounts.example.com/', 'https://chat.example.com/login', 'https://chat.example.com/auth/callback']) {
    const { dom, apply, doc } = page(url)
    assert.equal(apply(true), false)
    assert.equal(doc.documentElement.hasAttribute('data-dsh-aichat-themed'), false)
    dom.window.close()
  }
  const { dom, apply, window, doc } = page()
  try {
    apply(true)
    await waitPaint(window)
    window.history.pushState(null, '', '/login')
    doc.body.appendChild(doc.createElement('div'))
    await waitPaint(window)
    assert.equal(doc.documentElement.hasAttribute('data-dsh-aichat-themed'), false)
  } finally { dom.window.close() }
})
