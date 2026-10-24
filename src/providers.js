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
  return { version: 1, custom, selected: ids.has(value?.selected) ? value.selected : 'deepseek' }
}

export function readConfig(storage) {
  try { return normalizeConfig(JSON.parse(storage.getItem(STORAGE_KEY))) }
  catch { return normalizeConfig(null) }
}

export function writeConfig(storage, value) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(normalizeConfig(value))); return true }
  catch { return false }
}
