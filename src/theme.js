/** Read computed colors, rather than copying skin CSS or touching website preferences. */
export function readHostTheme(document) {
  const view = document.defaultView
  const probe = document.createElement('span')
  Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none' })
  document.body.appendChild(probe)
  const color = (variable, fallback) => {
    probe.style.color = `var(${variable}, ${fallback})`
    return view.getComputedStyle(probe).color
  }
  const foreground = color('--dsw-alias-label-primary', 'CanvasText')
  const parts = parseColor(foreground) || [20, 20, 20]
  const scheme = (parts[0] * .2126 + parts[1] * .7152 + parts[2] * .0722) > 150 ? 'dark' : 'light'
  const opaque = (value, fallback) => {
    const rgb = parseColor(value) || parseColor(fallback) || [20, 20, 20]
    return `rgb(${rgb.slice(0, 3).map(Math.round).join(', ')})`
  }
  const base = scheme === 'dark' ? 'rgb(24, 24, 28)' : 'rgb(255, 255, 255)'
  const theme = {
    scheme,
    // Webviews cannot show the host's wallpaper; use the skin's opaque palette.
    background: opaque(color('--dsw-alias-bg-base', base), base),
    surface: opaque(color('--dsw-alias-bg-layer-1', base), base),
    foreground: opaque(foreground, scheme === 'dark' ? 'rgb(240, 240, 240)' : 'rgb(20, 20, 20)'),
    muted: opaque(color('--dsw-alias-label-secondary', foreground), foreground),
    border: color('--dsw-alias-border-l2', scheme === 'dark' ? 'rgb(70, 70, 75)' : 'rgb(210, 210, 215)'),
    accent: color('--dsw-alias-state-business-primary', foreground),
    accentText: color('--dsw-alias-label-primary-foreground', 'Canvas'),
  }
  // Only accept browser-resolved colors in the generated guest stylesheet.
  for (const key of ['border', 'accent', 'accentText']) theme[key] = opaque(theme[key], foreground)
  probe.remove()
  return theme
}

function parseColor(value) {
  const text = value.trim()
  if (/^rgba?\(/i.test(text)) {
    const values = text.match(/[\d.]+/g)?.map(Number)
    return values?.length >= 3 && values[3] !== 0 ? values.slice(0, 3) : null
  }
  if (/^color\(srgb /i.test(text)) {
    const values = text.slice(text.indexOf(' ') + 1).match(/[\d.]+/g)?.map(Number)
    return values?.length >= 3 ? values.slice(0, 3).map(value => value * 255) : null
  }
  return null
}

export function watchHostTheme(document, onChange) {
  const view = document.defaultView
  let previous = ''
  let scheduled = false
  let stopped = false
  const update = () => {
    if (stopped) return
    scheduled = false
    const theme = readHostTheme(document)
    const fingerprint = JSON.stringify(theme)
    if (fingerprint !== previous) { previous = fingerprint; onChange(theme) }
  }
  const schedule = () => {
    if (scheduled || stopped) return
    scheduled = true
    view.queueMicrotask(update)
  }
  const observer = new view.MutationObserver(schedule)
  observer.observe(document.documentElement, { attributes: true })
  observer.observe(document.body, { attributes: true })
  observer.observe(document.head, { attributes: true, childList: true, characterData: true, subtree: true })
  const media = view.matchMedia?.('(prefers-color-scheme: dark)')
  media?.addEventListener('change', schedule)
  // Also catches CSSStyleSheet.replaceSync and CSSOM edits, which do not emit DOM mutations.
  const timer = view.setInterval(update, 1000)
  update()
  return () => { stopped = true; observer.disconnect(); media?.removeEventListener('change', schedule); view.clearInterval(timer) }
}

export function guestThemeCSS(theme) {
  const root = 'html[data-dsh-aichat-themed]'
  return `${root} { color-scheme:${theme.scheme} !important; background-color:${theme.background} !important; color:${theme.foreground} !important; }
${root} body, ${root} [data-aic-bg="base"] { background-color:${theme.background} !important; }
${root} [data-aic-bg="surface"] { background-color:${theme.surface} !important; }
${root} [data-aic-fg="normal"] { color:${theme.foreground} !important; }
${root} [data-aic-fg="muted"] { color:${theme.muted} !important; }
${root} [data-aic-border] { border-color:${theme.border} !important; }
${root} input::placeholder, ${root} textarea::placeholder { color:${theme.muted} !important; }
${root} input, ${root} textarea { caret-color:${theme.foreground} !important; }`
}

/** Executed in a guest: inspects styles only, never text, input values, or storage. */
export function installGuestTheme(expectedOrigin, enabled = true) {
  const root = document.documentElement
  if (!enabled) {
    window.__DSH_AICHAT_THEME_V1__?.stop()
    root.removeAttribute('data-dsh-aichat-themed')
    return false
  }
  const eligible = () => location.origin === expectedOrigin
    && !/(?:^|\/)(?:login|log-in|signin|sign-in|auth|oauth|captcha|challenge|verify)(?:\/|$)/i.test(location.pathname)
  const enable = () => {
    if (eligible()) root.setAttribute('data-dsh-aichat-themed', '')
    else root.removeAttribute('data-dsh-aichat-themed')
    return eligible()
  }
  if (!enable()) return false
  if (window.__DSH_AICHAT_THEME_V1__) { window.__DSH_AICHAT_THEME_V1__.refresh(); return true }
  const skipped = 'script,style,link,head,meta,svg,math,img,video,canvas,iframe,pre,code,[role="img"],[data-sitekey],[id*="captcha" i],[class*="captcha" i],[id*="challenge" i]'
  const neutral = value => {
    if (!/^rgba?\(/.test(value)) return null
    const values = value.match(/[\d.]+/g)?.map(Number)
    if (!values || values.length < 3 || (values[3] ?? 1) < .05) return null
    const rgb = values.slice(0, 3)
    return Math.max(...rgb) - Math.min(...rgb) <= 65 ? rgb : null
  }
  const pending = new Set()
  let scheduled = false
  let stopped = false
  const classify = element => {
    if (!(element instanceof HTMLElement) || element.closest(skipped)) return
    for (const attr of ['data-aic-bg', 'data-aic-fg', 'data-aic-border']) element.removeAttribute(attr)
    const style = getComputedStyle(element)
    const background = neutral(style.backgroundColor)
    const foreground = neutral(style.color)
    if (background && style.backgroundImage === 'none') {
      const rect = element.getBoundingClientRect()
      const base = element === document.body || element === root || element.tagName === 'MAIN'
        || (rect.width >= innerWidth * .65 && rect.height >= innerHeight * .5)
      element.setAttribute('data-aic-bg', base ? 'base' : 'surface')
    }
    if (foreground) {
      // Keep text on saturated brand controls unchanged.
      if (background || !neutral(style.backgroundColor) && (style.backgroundColor === 'transparent' || /,\s*0\)/.test(style.backgroundColor))) {
        element.setAttribute('data-aic-fg', 'normal')
      }
    }
    if (style.borderTopStyle !== 'none' && neutral(style.borderTopColor)) element.setAttribute('data-aic-border', '')
  }
  const flush = () => {
    scheduled = false
    if (stopped) return
    if (!enable()) { pending.clear(); return }
    let remaining = 250
    for (const element of pending) {
      pending.delete(element)
      if (element.isConnected) classify(element)
      if (--remaining === 0) break
    }
    if (pending.size) { scheduled = true; requestAnimationFrame(flush) }
  }
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(flush) } }
  const enqueue = element => {
    if (!(element instanceof HTMLElement) || element.closest(skipped)) return
    pending.add(element)
    for (const child of element.querySelectorAll('*')) pending.add(child)
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') pending.add(record.target)
      else for (const node of record.addedNodes) enqueue(node)
    }
    schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  const refresh = () => { enable(); schedule() }
  window.addEventListener('popstate', refresh)
  window.addEventListener('hashchange', refresh)
  window.__DSH_AICHAT_THEME_V1__ = { refresh, stop() {
    stopped = true
    observer.disconnect()
    window.removeEventListener('popstate', refresh)
    window.removeEventListener('hashchange', refresh)
    pending.clear()
    root.removeAttribute('data-dsh-aichat-themed')
    delete window.__DSH_AICHAT_THEME_V1__
  } }
  enqueue(document.body)
  schedule()
  return true
}
