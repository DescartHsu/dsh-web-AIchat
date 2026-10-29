export const STORAGE_KEY = 'dsh-web-aichat:config:v1'
export const DEFAULT_PROVIDERS = Object.freeze([
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', color: '#4d6bfe' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', color: '#10a37f' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/', color: '#d97757' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', color: '#4285f4' },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/', color: '#888888' },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', color: '#7357ff' },
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/', color: '#3478f6' },
  { id: 'qwen', name: '通义千问', url: 'https://www.qianwen.com/', color: '#7c4dff' },
].map(Object.freeze))

export function safeWebUrl(value, httpsOnly = false) {
  try {
    const url = new URL(value)
    if (!(httpsOnly ? ['https:'] : ['http:', 'https:']).includes(url.protocol)
      || url.username || url.password) return ''
    return url.href
  } catch { return '' }
}

export function validateCustomProvider(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 30) {
    throw new Error('网站名称需为 1–30 个字符。')
  }
  const url = safeWebUrl(value.url, true)
  if (!url) throw new Error('请输入完整的 HTTPS 官网地址，且不要包含用户名或密码。')
  if (!/^custom-[a-zA-Z0-9-]{1,80}$/.test(value.id)) throw new Error('网站标识无效。')
  return { id: value.id, name: value.name.trim(), url, color: '#64748b' }
}

export function normalizeConfig(value) {
  const custom = []
  const ids = new Set(DEFAULT_PROVIDERS.map(provider => provider.id))
  if (value?.version === 1 && Array.isArray(value.custom)) {
    for (const raw of value.custom.slice(0, 24)) {
      try {
        const provider = validateCustomProvider(raw)
        if (!ids.has(provider.id)) { custom.push(provider); ids.add(provider.id) }
      } catch { /* Ignore malformed stored entries, keeping the usable ones. */ }
    }
  }
  const hidden = value?.version === 1 && Array.isArray(value.hidden)
    ? DEFAULT_PROVIDERS.filter(provider => value.hidden.includes(provider.id)).map(provider => provider.id) : []
  for (const id of hidden) ids.delete(id)
  const order = []
  if (value?.version === 1 && Array.isArray(value.order)) {
    for (const id of value.order.slice(0, 256)) if (ids.has(id) && !order.includes(id)) order.push(id)
  }
  for (const id of ids) if (!order.includes(id)) order.push(id)
  return { version: 1, custom, hidden, order, selected: ids.has(value?.selected) ? value.selected : order[0] || '', followTheme: value?.followTheme !== false }
}

export function orderedProviders(config) {
  const remaining = new Map([...DEFAULT_PROVIDERS, ...config.custom].filter(provider => !config.hidden.includes(provider.id)).map(provider => [provider.id, provider]))
  const providers = []
  for (const id of config.order) {
    if (remaining.has(id)) { providers.push(remaining.get(id)); remaining.delete(id) }
  }
  return [...providers, ...remaining.values()]
}

export function moveProvider(config, sourceId, targetId, position = 'before') {
  const next = normalizeConfig(config)
  if (sourceId === targetId || !next.order.includes(sourceId) || !next.order.includes(targetId)
    || !['before', 'after'].includes(position)) return next
  next.order = next.order.filter(id => id !== sourceId)
  next.order.splice(next.order.indexOf(targetId) + (position === 'after' ? 1 : 0), 0, sourceId)
  return next
}

export function deleteProvider(config, id) {
  const current = normalizeConfig(config)
  const index = current.order.indexOf(id)
  if (index < 0) return current
  const remaining = current.order.filter(value => value !== id)
  return normalizeConfig({ ...current,
    hidden: DEFAULT_PROVIDERS.some(provider => provider.id === id) ? [...current.hidden, id] : current.hidden,
    custom: current.custom.filter(provider => provider.id !== id),
    selected: current.selected === id ? remaining[index] || remaining[index - 1] || '' : current.selected,
  })
}

export function readConfig(storage) {
  try { return normalizeConfig(JSON.parse(storage.getItem(STORAGE_KEY))) }
  catch { return normalizeConfig(null) }
}

export function writeConfig(storage, value) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(normalizeConfig(value))); return true }
  catch { return false }
}
