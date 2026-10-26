/** Use the site's own close action for its specific, dismissible environment notice. */
export function installDeepseekNoticeDismissal() {
  if (location.origin !== 'https://chat.deepseek.com') return false
  if (window.__DSH_AICHAT_DEEPSEEK_NOTICE_V1__) return true
  let stopped = false
  let queued = false
  const scan = () => {
    queued = false
    if (stopped || location.origin !== 'https://chat.deepseek.com') return
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (dialog.hidden || dialog.getAttribute('aria-hidden') === 'true') continue
      const style = getComputedStyle(dialog)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const text = dialog.textContent.replace(/\s+/g, '')
      if (!text.includes('使用环境异常')
        || !text.includes('当前页面的使用环境可能存在数据和隐私泄露风险')) continue
      const closeButtons = [...dialog.querySelectorAll('button,[role="button"]')].filter(button => {
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false
        const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim()
        const content = button.textContent.trim()
        return /^(?:关闭|close|close dialog)$/i.test(label)
          || /^[×✕✖]$/.test(content)
          || (!content && !!button.querySelector('svg'))
      })
      // An unfamiliar or ambiguous dialog is left untouched.
      if (closeButtons.length === 1) closeButtons[0].click()
    }
  }
  const schedule = () => {
    if (queued || stopped) return
    queued = true
    queueMicrotask(scan)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'style', 'class'],
  })
  const stop = () => {
    stopped = true
    observer.disconnect()
    window.removeEventListener('pagehide', stop)
    delete window.__DSH_AICHAT_DEEPSEEK_NOTICE_V1__
  }
  window.__DSH_AICHAT_DEEPSEEK_NOTICE_V1__ = { stop }
  window.addEventListener('pagehide', stop, { once: true })
  scan()
  return true
}
