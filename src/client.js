import { DEFAULT_PROVIDERS, readConfig, writeConfig, validateCustomProvider, normalizeConfig, orderedProviders, moveProvider, deleteProvider } from './providers.js'
import { createGuestManager } from './guest-manager.js'
import css from './styles.css'
import { watchHostTheme } from './theme.js'

window.__ModuleLoader__.load({
  id: 'dsh-web-aichat',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const PANEL = 'web-aichat'
    const listeners = new Set()
    const notify = () => { for (const listener of listeners) listener() }
    let config = readConfig(localStorage)
    let manager
    let storageNotice = ''
    let hostTheme = null
    const providers = () => orderedProviders(config)
    function save(next) {
      config = normalizeConfig(next)
      manager?.setTheme(config.followTheme ? hostTheme : null)
      storageNotice = writeConfig(localStorage, config) ? '' : '当前选择可用，但浏览器设置阻止了偏好保存。'
      notify()
      return !storageNotice
    }
    function select(id) { save({ ...config, selected: id }) }
    async function persistenceRequest(action) {
      const response = await fetch(`/api/web-aichat/persistence/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      if (!response.ok) throw Error('网页暂时无法打开。')
      const data = await response.json()
      if (!data.ok) throw Error('网页暂时无法打开。')
      return data
    }

    function PageUnavailable({ browserLink }) {
      const [info, setInfo] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [attempt, setAttempt] = React.useState(0)
      React.useEffect(() => {
        let active = true, timer
        async function check(action) {
          try {
            const data = await persistenceRequest(action)
            if (!active) return
            setInfo(data)
            if (data.supported && !data.onDiskEnabled && !data.setupError
              && (!data.job || ['queued', 'waiting', 'applying'].includes(data.job.state))) {
              timer = setTimeout(() => void check('status'), 2000)
            }
          } catch { if (active) setFailed(true) }
        }
        void check(attempt ? 'prepare' : 'status')
        return () => { active = false; clearTimeout(timer) }
      }, [attempt])
      let message = '正在打开网页…'
      const retryable = failed || (info?.supported && !info.onDiskEnabled
        && (info.setupError || ['failed', 'expired', 'cancelled', 'interrupted'].includes(info.job?.state)))
      if (retryable) {
        const detail = info?.setupError || info?.job?.message || ''
        if (/EACCES|EPERM|access denied|拒绝访问/i.test(detail)) message = 'DSH 安装目录没有写入权限，暂时无法打开内嵌网页。'
        else if (/再次启动|fully quit DSH/i.test(detail)) message = 'DSH 刚才已在切换完成前启动，请点「重试」。'
        else message = '网页暂时无法打开，请重试。'
      }
      else if (info && !info.supported) message = '当前桌面版本无法在这里打开网页。'
      else if (info?.onDiskEnabled || info?.job?.state === 'complete') message = '请从「应用 → 退出」完整退出 DSH，再打开 AI Chat。'
      else if (info?.job?.state === 'waiting') message = '已准备好，请从「应用 → 退出」完整退出，再打开 DSH。'
      return h('div', { className: 'aic-empty' },
        h('p', { role: 'status' }, message),
        retryable ? h('button', { type: 'button', className: 'aic-button', onClick: () => {
          setFailed(false); setInfo(null); setAttempt(value => value + 1)
        } }, '重试') : null,
        retryable || (info && !info.supported) ? browserLink : null)
    }

    function Icon({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
      h('rect', { x: 3, y: 3, width: 18, height: 15, rx: 5 }),
      h('path', { d: 'm7 18-1 4 6-4M8 9h8M8 13h5' }))
    }
    function WebsiteSettings({ onDone }) {
      const [name, setName] = React.useState('')
      const [url, setUrl] = React.useState('')
      const [error, setError] = React.useState('')
      const [removing, setRemoving] = React.useState(false)
      const add = event => {
        event.preventDefault()
        try {
          if (config.custom.length >= 24) throw new Error('最多添加 24 个自定义网站。')
          const entry = validateCustomProvider({ id: `custom-${crypto.randomUUID()}`, name, url })
          if (providers().some(item => item.url === entry.url)) throw new Error('这个地址已经在列表中。')
          save({ ...config, custom: [...config.custom, entry], selected: entry.id })
          onDone()
        } catch (cause) { setError(cause.message) }
      }
      const remove = async id => {
        setRemoving(true)
        await manager.close(id)
        save(deleteProvider(config, id))
        setRemoving(false)
      }
      return h('div', { className: 'aic-settings' },
        h('div', { className: 'aic-settings-heading' },
          h('div', null, h('h2', null, '添加你常用的 AI'), h('p', null, '输入官网聊天地址，它会出现在顶部标签中。')),
          h('button', { className: 'aic-button', onClick: onDone }, '返回聊天')),
        h('form', { onSubmit: add, className: 'aic-form' },
          h('label', null, '网站名称', h('input', { value: name, maxLength: 30, required: true, placeholder: '例如：Perplexity', onChange: e => setName(e.target.value) })),
          h('label', null, '官网地址', h('input', { type: 'url', value: url, required: true, placeholder: 'https://www.perplexity.ai/', onChange: e => setUrl(e.target.value) })),
          h('button', { className: 'aic-button aic-primary', type: 'submit', disabled: removing }, '添加并打开')),
        error ? h('p', { role: 'alert', className: 'aic-error' }, error) : null,
        storageNotice ? h('p', { role: 'alert', className: 'aic-error' }, storageNotice) : null,
        h('h3', null, '当前网站'),
        providers().length ? providers().map(item => h('div', { className: 'aic-site-row', key: item.id },
          h('div', null, h('strong', null, item.name), h('small', null, item.url)),
          h('button', { className: 'aic-button', disabled: removing, 'aria-label': `删除 ${item.name}`, onClick: () => void remove(item.id) }, '删除网站'))) :
          h('p', { className: 'aic-muted' }, '还没有网站，可在上方添加，或恢复下方的内置网站。'),
        config.hidden.length ? h(React.Fragment, null, h('h3', null, '已删除的内置网站'),
          DEFAULT_PROVIDERS.filter(item => config.hidden.includes(item.id)).map(item => h('div', { className: 'aic-site-row', key: item.id },
            h('strong', null, item.name), h('button', { className: 'aic-button', disabled: removing, 'aria-label': `恢复 ${item.name}`,
              onClick: () => save({ ...config, hidden: config.hidden.filter(id => id !== item.id) }) }, '恢复网站')))) : null,
        h('p', { className: 'aic-footnote' }, '删除网站会关闭对应页面并移除入口，不清除官网登录数据。内置网站可在此恢复；自定义网站可重新添加。'))
    }
    function Panel() {
      const [, rerender] = React.useReducer(value => value + 1, 0)
      const [settings, setSettings] = React.useState(false)
      const [reopening, setReopening] = React.useState(false)
      const [epoch, setEpoch] = React.useState(0)
      const [notice, setNotice] = React.useState('')
      const [dragId, setDragId] = React.useState(null)
      const [dropTarget, setDropTarget] = React.useState(null)
      const dragged = React.useRef(null)
      const keyboardFocus = React.useRef(null)
      React.useLayoutEffect(() => {
        if (!keyboardFocus.current) return
        document.getElementById(`aic-tab-${keyboardFocus.current}`)?.focus()
        keyboardFocus.current = null
      })
      const hostRef = React.useRef(null)
      const current = providers().find(item => item.id === config.selected) || providers()[0] || { id: '', name: '网站', url: '' }
      const state = manager.status(current.id)
      const storagePending = state.persistent === false
      const pageStatus = state.error || state.themeError || (reopening ? '正在重新打开…'
        : state.loading ? `正在加载 ${current.name}…` : notice || storageNotice)
      const browserLink = current.url && h('a', { className: 'aic-button', href: current.url,
        target: '_blank', rel: 'noopener noreferrer' }, '在浏览器中打开')
      React.useEffect(() => { listeners.add(rerender); rerender(); return () => listeners.delete(rerender) }, [])
      React.useEffect(() => {
        const host = hostRef.current
        if (settings || reopening || !host || !current.id) return
        let alive = true
        manager.show(current.id, host)
        void manager.ensure(current).then(() => { if (alive) manager.show(current.id, host) })
        const position = () => manager.reposition()
        const observer = new ResizeObserver(position)
        observer.observe(host)
        window.addEventListener('resize', position)
        window.addEventListener('scroll', position, true)
        return () => {
          alive = false
          observer.disconnect()
          window.removeEventListener('resize', position)
          window.removeEventListener('scroll', position, true)
          manager.hide(host)
        }
      }, [current.id, settings, reopening, epoch])
      const reopen = async () => {
        setReopening(true)
        await manager.close(current.id)
        setReopening(false)
        setEpoch(value => value + 1)
      }
      const copyUrl = async () => {
        try { await navigator.clipboard.writeText(state.url || current.url); setNotice('地址已复制。') }
        catch { setNotice('复制失败，请选中上方地址手动复制。') }
      }
      const switchTab = (event, id) => {
        const all = providers()
        let index = all.findIndex(item => item.id === id)
        if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation()
          const target = all[index + (event.key === 'ArrowLeft' ? -1 : 1)]
          if (target) { keyboardFocus.current = id; reorder(id, target.id, event.key === 'ArrowLeft' ? 'before' : 'after') }
          return
        }
        if (event.key === 'ArrowRight') index = (index + 1) % all.length
        else if (event.key === 'ArrowLeft') index = (index + all.length - 1) % all.length
        else if (event.key === 'Home') index = 0
        else if (event.key === 'End') index = all.length - 1
        else return
        event.preventDefault()
        select(all[index].id)
        document.getElementById(`aic-tab-${all[index].id}`)?.focus()
      }
      const reorder = (source, target, position) => {
        const next = moveProvider(config, source, target, position)
        if (next.order.join(',') === config.order.join(',')) return
        const name = providers().find(item => item.id === source)?.name
        const saved = save(next)
        setNotice(saved ? `已将 ${name} 移到第 ${next.order.indexOf(source) + 1} 位，顺序已保存。` : '')
      }
      const endDrag = () => { dragged.current = null; setDragId(null); setDropTarget(null) }
      const dropPosition = event => {
        const rect = event.currentTarget.getBoundingClientRect()
        return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      }
      const dragOver = (event, id) => {
        if (!dragged.current) return
        if (dragged.current === id) { setDropTarget(null); return }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const position = dropPosition(event)
        setDropTarget(previous => previous?.id === id && previous.position === position ? previous : { id, position })
      }
      const scrollDrag = event => {
        if (!dragged.current) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const nav = event.currentTarget, rect = nav.getBoundingClientRect()
        if (rect.right <= rect.left) return
        if (event.clientX < rect.left + 36) nav.scrollLeft -= 20
        else if (event.clientX > rect.right - 36) nav.scrollLeft += 20
      }
      const button = (label, title, action, disabled = !state.ready) => h('button', {
        type: 'button', className: 'aic-button', title, 'aria-label': title, onClick: action, disabled,
      }, label)
      return h('section', { className: 'aic-panel' },
        h('header', { className: 'aic-header' },
          h('div', { className: 'aic-brand' }, h(Icon, { size: 24 }), h('div', null, h('h1', null, 'AI Chat'), h('p', null, '常用 AI 官网，一个入口'))),
          h('button', { className: 'aic-button', disabled: reopening, onClick: () => setSettings(value => !value), 'aria-expanded': settings }, settings ? '返回聊天' : '管理网站')),
        h('nav', { className: 'aic-tabs', role: 'tablist', 'aria-label': 'AI Chat', onDragOver: scrollDrag,
          onDrop: event => { if (dragged.current) { event.preventDefault(); endDrag() } },
          onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(null) } },
          providers().map(item => h('button', { id: `aic-tab-${item.id}`, key: item.id, role: 'tab',
            className: 'aic-tab', type: 'button', disabled: reopening, 'aria-selected': current.id === item.id,
            draggable: !reopening, title: '拖动调整顺序；Alt + ← / → 移动标签',
            'aria-describedby': 'aic-sort-help', 'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
            'data-dragging': dragId === item.id ? 'true' : undefined,
            'data-drop': dropTarget?.id === item.id ? dropTarget.position : undefined,
            onDragStart: event => {
              dragged.current = item.id; setDragId(item.id); setDropTarget(null)
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', item.id)
            }, onDragEnd: endDrag, onDragOver: event => dragOver(event, item.id),
            onDrop: event => {
              if (!dragged.current) return
              event.preventDefault(); event.stopPropagation()
              reorder(dragged.current, item.id, dropPosition(event)); endDrag()
            },
            'aria-controls': 'aic-content', tabIndex: current.id === item.id ? 0 : -1,
            onKeyDown: event => switchTab(event, item.id), onClick: () => { select(item.id); setSettings(false); setNotice('') } },
          h('span', { className: 'aic-dot', style: { background: item.color } }), item.name))),
        h('p', { id: 'aic-sort-help', className: 'aic-sr-only' }, '拖动标签调整顺序并自动保存，也可按 Alt 加左右方向键移动当前标签。'),
        settings ? h(WebsiteSettings, { onDone: () => setSettings(false) }) : h(React.Fragment, null,
          h('div', { className: 'aic-toolbar' },
            button('←', '后退', () => void manager.navigate(current.id, 'back')),
            button('→', '前进', () => void manager.navigate(current.id, 'forward')),
            button('首页', '返回官网首页', () => void manager.navigate(current.id, 'url', current.url)),
            button('刷新', '刷新当前网页', () => void manager.navigate(current.id, 'reload')),
            h('span', { className: 'aic-address', title: state.url || current.url }, state.url || current.url),
            button('复制地址', '复制当前网址', () => void copyUrl(), !current.url),
            h('button', { type: 'button', className: 'aic-button', 'aria-pressed': config.followTheme,
              title: '同步官网内部配色；关闭可恢复官网原色',
              onClick: () => save({ ...config, followTheme: !config.followTheme }) }, config.followTheme ? '跟随皮肤' : '官网原色'),
            button('重新打开', '关闭并重新创建当前网页', () => void reopen(), !manager.available || reopening)),
          pageStatus && current.id ? h('div', { className: `aic-status${state.error ? ' aic-error' : ''}`,
            role: state.error ? 'alert' : 'status', 'aria-live': 'polite' }, pageStatus) : null,
          state.popup ? h('div', { className: 'aic-popup' },
            h('span', null, '官网请求打开：', h('code', null, state.popup)),
            button('在当前页打开', '在当前页打开该链接', () => void manager.navigate(current.id, 'url', state.popup)),
            button('忽略', '忽略该链接', () => manager.dismissPopup(current.id), false)) : null,
          h('div', { id: 'aic-content', role: 'tabpanel', 'aria-labelledby': `aic-tab-${current.id}`,
            className: 'aic-viewport', ref: hostRef },
            !current.id ? h('div', { className: 'aic-empty' }, h('h2', null, '还没有网站'),
              h('button', { className: 'aic-button', onClick: () => setSettings(true) }, '添加或恢复网站')) : !manager.available ? h('div', { className: 'aic-empty' }, h(Icon, { size: 38 }),
              h('h2', null, '在 DSH Desktop 中打开 AI Chat'),
              h('p', null, '内嵌聊天需要桌面客户端提供网页接口。'), browserLink)
              : storagePending ? h(PageUnavailable, { key: current.id, browserLink })
              : state.error && !state.ready ? h('div', { className: 'aic-empty' }, browserLink) : null)))
    }
    function apply(ctx) {
      ctx.effect(() => {
        const bridge = globalThis.dshDesktop?.protocolVersion === 1 ? globalThis.dshDesktop.browser : undefined
        const owned = createGuestManager({ bridge, document, onChange: notify })
        manager = owned
        const style = document.createElement('style')
        style.dataset.dshWebAichat = ''
        style.textContent = css
        document.head.appendChild(style)
        const stopTheme = watchHostTheme(document, theme => {
          hostTheme = theme
          owned.setTheme(config.followTheme ? theme : null)
        })
        return async () => { stopTheme(); style.remove(); await owned.dispose(); listeners.clear() }
      }, 'web-aichat: browser guests')
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL, order: -1, label: () => 'AI Chat',
      }, Icon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Panel))
    }
    return { inject: ['slots'], apply }
  },
})
