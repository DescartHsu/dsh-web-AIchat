import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PROVIDERS, normalizeConfig, validateCustomProvider, safeWebUrl, readConfig, writeConfig } from '../src/providers.js'

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
