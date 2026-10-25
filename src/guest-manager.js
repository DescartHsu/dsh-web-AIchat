import { safeWebUrl } from './providers.js'
import { guestThemeCSS, installGuestTheme } from './theme.js'

/** Owns leases independently of React mounts, so switching panels preserves pages. */
export function createGuestManager({ bridge, document, onChange = () => {} }) {
  const entries = new Map()
  const pending = new Map()
  const cancelled = new Set()
  const statuses = new Map()
  let disposed = false
  let visibleId = null
  let viewport = null
  let disposePromise
  let theme = null
  let themeFingerprint = 'null'
  const available = !!bridge && typeof bridge.acquire === 'function' && typeof bridge.release === 'function'

  function notify(id, patch) {
    if (disposed) return
    statuses.set(id, { ...statuses.get(id), ...patch })
    onChange()
  }
  async function release(lease) {
    try { await bridge.release(lease) }
    catch { /* Desktop also releases window-owned leases when the window closes. */ }
  }
  function cleanup(entry) {
    entry.closed = true
    entry.unsubscribe?.()
    for (const [event, listener] of entry.listeners) entry.element.removeEventListener(event, listener)
    entry.container.remove()
    return release(entry.lease)
  }
  function reposition() {
    const rect = viewport?.isConnected !== false ? viewport?.getBoundingClientRect() : null
    for (const [id, entry] of entries) {
      const visible = !disposed && id === visibleId && rect && rect.width > 0 && rect.height > 0
      Object.assign(entry.container.style, {
        display: visible ? 'block' : 'none',
        ...(visible ? { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` } : {}),
      })
    }
  }
  function show(id, host) { visibleId = id; viewport = host; reposition() }
  function syncTheme(id, entry) {
    entry.themeRevision = (entry.themeRevision || 0) + 1
    if (entry.themeTask || !entry.ready || typeof entry.element.executeJavaScript !== 'function'
      || typeof entry.element.insertCSS !== 'function' || typeof entry.element.removeInsertedCSS !== 'function') return
    entry.themeTask = Promise.resolve().then(async () => {
      while (!disposed && !entry.closed && entries.get(id) === entry) {
        const revision = entry.themeRevision
        const palette = theme
        try {
          const active = await entry.element.executeJavaScript(`(${installGuestTheme.toString()})(${JSON.stringify(entry.origin)}, ${!!palette})`)
          if (disposed || entry.closed) return
          const key = active && palette ? await entry.element.insertCSS(guestThemeCSS(palette), { cssOrigin: 'user' }) : null
          const old = entry.cssKey
          entry.cssKey = key
          if (old) await entry.element.removeInsertedCSS(old).catch(() => {})
          if (!disposed && !entry.closed) notify(id, { themeError: '' })
        } catch {
          if (!disposed && !entry.closed && revision === entry.themeRevision) {
            notify(id, { themeError: '官网配色同步未完成，可点“重新打开”重试。' })
          }
        }
        entry.themeApplied = revision
        if (revision === entry.themeRevision) break
      }
    }).finally(() => {
      entry.themeTask = null
      if (!disposed && !entry.closed && entry.themeApplied !== entry.themeRevision) syncTheme(id, entry)
    })
  }
  function setTheme(palette) {
    const fingerprint = JSON.stringify(palette)
    if (themeFingerprint === fingerprint) return
    themeFingerprint = fingerprint
    theme = palette
    for (const [id, entry] of entries) syncTheme(id, entry)
  }
  function hide(host) {
    // A stale React cleanup cannot hide a newer mount's guest.
    if (host && viewport !== host) return
    visibleId = null; viewport = null; reposition()
  }
  function ensure(provider) {
    if (disposed || !available) return Promise.resolve(null)
    if (entries.has(provider.id)) return Promise.resolve(entries.get(provider.id))
    if (pending.has(provider.id)) return pending.get(provider.id)
    const url = safeWebUrl(provider.url, true)
    if (!url) return Promise.resolve(null)
    const token = {}
    notify(provider.id, { title: provider.name, url, loading: true, ready: false, error: '', popup: '' })
    const operation = Promise.resolve().then(async () => {
      let lease
      let entry
      try {
        const reservation = await bridge.acquire(`dsh-web-aichat:${provider.id}`)
        lease = reservation.lease
        if (disposed || cancelled.has(token)) { await release(lease); return null }
        const element = document.createElement('webview')
        const container = document.createElement('div')
        entry = { element, container, lease, listeners: [], ready: false, origin: new URL(url).origin }
        container.setAttribute('data-dsh-web-aichat', provider.id)
        Object.assign(container.style, { position: 'fixed', display: 'none', zIndex: '20' })
        Object.assign(element.style, { width: '100%', height: '100%', display: 'flex', border: '0' })
        for (const [key, value] of Object.entries({ name: lease, partition: reservation.partition,
          allowpopups: '', 'data-sidebar-browser-frame': '', src: `about:blank#${lease}` })) {
          element.setAttribute(key, value)
        }
        const listen = (event, handler) => {
          const listener = value => { if (!disposed && entries.get(provider.id) === entry) handler(value) }
          element.addEventListener(event, listener)
          entry.listeners.push([event, listener])
        }
        let booted = false
        listen('dom-ready', () => {
          entry.ready = true
          notify(provider.id, { ready: true })
          if (!booted) {
            booted = true
            Promise.resolve(element.loadURL(url)).catch(() => notify(provider.id, { loading: false, error: '官网加载失败，请重试或在浏览器中打开。' }))
          }
          // Each new document needs its own stylesheet, even if the palette is unchanged.
          entry.cssKey = null
          syncTheme(provider.id, entry)
        })
        listen('did-start-loading', () => notify(provider.id, { loading: true, error: '' }))
        listen('did-stop-loading', () => notify(provider.id, { loading: false }))
        listen('page-title-updated', event => notify(provider.id, { title: event.title || provider.name }))
        const navigated = event => {
          if (event.isMainFrame === false) return
          const current = safeWebUrl(event.url)
          if (current) notify(provider.id, { url: current })
          if (entry.ready) syncTheme(provider.id, entry)
        }
        listen('did-navigate', navigated)
        listen('did-navigate-in-page', navigated)
        listen('did-fail-load', event => {
          if (event.isMainFrame === false || event.errorCode === -3) return
          notify(provider.id, { loading: false, error: `网页暂时无法加载（${event.errorDescription || event.errorCode}）。` })
        })
        listen('render-process-gone', () => notify(provider.id, { loading: false, ready: false, error: '网页进程已退出，请点“重新打开”。' }))
        if (typeof bridge.onOpenRequested === 'function') {
          entry.unsubscribe = bridge.onOpenRequested(lease, value => {
            if (entries.get(provider.id) !== entry) return
            const popup = safeWebUrl(value)
            if (popup) notify(provider.id, { popup })
          })
        }
        entries.set(provider.id, entry)
        container.appendChild(element)
        document.body.appendChild(container)
        reposition()
        return entry
      } catch {
        if (entries.get(provider.id) === entry) entries.delete(provider.id)
        if (entry) await cleanup(entry)
        else if (lease) await release(lease)
        notify(provider.id, { loading: false, ready: false, error: '无法创建官网窗口，请确认 DSH Desktop 支持 Browser guest bridge。' })
        return null
      } finally {
        if (pending.get(provider.id)?.token === token) pending.delete(provider.id)
        cancelled.delete(token)
      }
    })
    operation.token = token
    pending.set(provider.id, operation)
    return operation
  }
  async function close(id) {
    const operation = pending.get(id)
    if (operation) { cancelled.add(operation.token); await operation }
    const entry = entries.get(id)
    entries.delete(id)
    statuses.delete(id)
    if (entry) await cleanup(entry)
    if (!disposed) onChange()
  }
  async function navigate(id, action, value) {
    const entry = entries.get(id)
    if (!entry?.ready || disposed) return
    try {
      if (action === 'reload') entry.element.reload()
      else if (action === 'back' && entry.element.canGoBack()) entry.element.goBack()
      else if (action === 'forward' && entry.element.canGoForward()) entry.element.goForward()
      else if (action === 'url') {
        const url = safeWebUrl(value)
        if (!url) return
        notify(id, { popup: '' })
        await entry.element.loadURL(url)
      }
    } catch { notify(id, { loading: false, error: '操作未完成，请重试或重新打开网页。' }) }
  }
  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    hide()
    disposePromise = (async () => {
      await Promise.allSettled([...pending.values()])
      const all = [...entries.values()]
      entries.clear(); statuses.clear()
      await Promise.allSettled(all.map(cleanup))
    })()
    return disposePromise
  }
  return { available, ensure, show, hide, reposition, close, navigate, dispose, setTheme,
    status: id => statuses.get(id) || {}, dismissPopup: id => notify(id, { popup: '' }) }
}
