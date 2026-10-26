import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PROVIDERS, normalizeConfig, validateCustomProvider, safeWebUrl, readConfig, writeConfig, orderedProviders, moveProvider } from '../src/providers.js'

test('rejects executable URLs, credentials, and insecure custom sites', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,a', 'https://user:pass@example.com']) {
    assert.equal(safeWebUrl(url), '')
  }
  assert.throws(() => validateCustomProvider({ id: 'custom-1', name: 'Example', url: 'http://example.com' }))
  assert.equal(validateCustomProvider({ id: 'custom-1', name: ' Example ', url: 'https://example.com' }).url, 'https://example.com/')
})
test('restores usable entries without allowing stored data to overwrite built-ins', () => {
  const config = normalizeConfig({ version: 1, selected: 'custom-good', custom: [
    { id: 'deepseek', name: 'Fake', url: 'https://example.com' },
    { id: 'custom-bad', name: '', url: 'https://example.com' },
    { id: 'custom-good', name: 'Example', url: 'https://example.com' },
    { id: 'custom-good', name: 'Duplicate', url: 'https://other.example.com' },
  ] })
  assert.equal(config.custom.length, 1)
  assert.equal(config.selected, 'custom-good')
  assert.equal(normalizeConfig({ selected: 'deleted' }).selected, 'deepseek')
  assert.equal(new Set(DEFAULT_PROVIDERS.map(p => p.id)).size, 8)
})
test('blocked or corrupt browser storage does not break the panel', () => {
  const blocked = { getItem() { throw Error('blocked') }, setItem() { throw Error('quota') } }
  assert.equal(readConfig(blocked).selected, 'deepseek')
  assert.equal(readConfig({ getItem: () => '{broken' }).custom.length, 0)
  assert.equal(writeConfig(blocked, normalizeConfig(null)), false)
})

test('saved order rejects stale or duplicate IDs and migrates old preferences without losing websites or selection', () => {
  const custom = { id: 'custom-example', name: 'Example', url: 'https://example.com/' }
  const old = normalizeConfig({ version: 1, custom: [custom], selected: custom.id, followTheme: false })
  assert.deepEqual(old.order, [...DEFAULT_PROVIDERS.map(item => item.id), custom.id])
  const restored = normalizeConfig({ ...old, order: ['chatgpt', 'deleted', 'chatgpt', custom.id, null, '__proto__'] })
  assert.deepEqual(restored.order.slice(0, 3), ['chatgpt', custom.id, 'deepseek'])
  assert.equal(restored.order.length, 9); assert.equal(restored.selected, custom.id); assert.equal(restored.followTheme, false)
  assert.deepEqual(orderedProviders(restored).map(item => item.id), restored.order)
  const removed = normalizeConfig({ ...restored, custom: [] })
  assert.equal(removed.order.includes(custom.id), false)
  const added = normalizeConfig({ ...removed, custom: [custom] })
  assert.equal(added.order.at(-1), custom.id)
})

test('moves sites in both directions and across built-ins, saves order, and keeps IDs and selected provider stable', () => {
  const config = normalizeConfig({ version: 1, selected: 'claude', custom: [
    { id: 'custom-example', name: 'Example', url: 'https://example.com/' },
  ] })
  const first = moveProvider(config, 'custom-example', 'deepseek')
  assert.equal(first.order[0], 'custom-example')
  const last = moveProvider(first, 'deepseek', 'qwen', 'after')
  assert.equal(last.order.at(-1), 'deepseek'); assert.equal(last.selected, 'claude')
  assert.deepEqual(last.custom, config.custom); assert.equal(config.order[0], 'deepseek')
  for (const args of [['missing', 'qwen'], ['qwen', 'missing'], ['qwen', 'qwen'], ['qwen', 'claude', 'invalid']]) {
    assert.deepEqual(moveProvider(last, ...args), last)
  }
  let stored
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value } }
  assert.equal(writeConfig(storage, last), true)
  assert.deepEqual(readConfig(storage).order, last.order)
})
