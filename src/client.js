import { DEFAULT_PROVIDERS, readConfig, writeConfig, validateCustomProvider } from './providers.js'
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
    const providers = () => [...DEFAULT_PROVIDERS, ...config.custom]
    function save(next) {
      config = next
      manager?.setTheme(config.followTheme ? hostTheme : null)
      storageNotice = writeConfig(localStorage, config) ? '' : '当前选择可用，但浏览器设置阻止了偏好保存。'
      notify()
    }
    function select(id) { save({ ...config, selected: id }) }

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
        save({ ...config, custom: config.custom.filter(item => item.id !== id),
          selected: config.selected === id ? 'deepseek' : config.selected })
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
        h('h3', null, '已添加的网站'),
        config.custom.length ? config.custom.map(item => h('div', { className: 'aic-site-row', key: item.id },
          h('div', null, h('strong', null, item.name), h('small', null, item.url)),
          h('button', { className: 'aic-button', disabled: removing, onClick: () => void remove(item.id) }, '移除入口'))) :
          h('p', { className: 'aic-muted' }, '还没有自定义网站。内置的 8 个入口随时可用。'),
        h('p', { className: 'aic-footnote' }, '移除入口会关闭该页面，不会注销官网账号。网站登录与使用规则由各官网决定。'))
    }
    function Panel() {
      const [, rerender] = React.useReducer(value => value + 1, 0)
      const [settings, setSettings] = React.useState(false)
      const [reopening, setReopening] = React.useState(false)
      const [epoch, setEpoch] = React.useState(0)
      const [notice, setNotice] = React.useState('')
      const hostRef = React.useRef(null)
      const current = providers().find(item => item.id === config.selected) || DEFAULT_PROVIDERS[0]
      const state = manager.status(current.id)
      React.useEffect(() => { listeners.add(rerender); rerender(); return () => listeners.delete(rerender) }, [])
      React.useEffect(() => {
        const host = hostRef.current
        if (settings || reopening || !host) return
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
        if (event.key === 'ArrowRight') index = (index + 1) % all.length
        else if (event.key === 'ArrowLeft') index = (index + all.length - 1) % all.length
        else if (event.key === 'Home') index = 0
        else if (event.key === 'End') index = all.length - 1
        else return
        event.preventDefault()
        select(all[index].id)
        document.getElementById(`aic-tab-${all[index].id}`)?.focus()
      }
      const button = (label, title, action, disabled = !state.ready) => h('button', {
        type: 'button', className: 'aic-button', title, 'aria-label': title, onClick: action, disabled,
      }, label)
      return h('section', { className: 'aic-panel' },
        h('header', { className: 'aic-header' },
          h('div', { className: 'aic-brand' }, h(Icon, { size: 24 }), h('div', null, h('h1', null, 'AI Chat'), h('p', null, '常用 AI 官网，一个入口'))),
          h('button', { className: 'aic-button', disabled: reopening, onClick: () => setSettings(value => !value), 'aria-expanded': settings }, settings ? '返回聊天' : '管理网站')),
        h('nav', { className: 'aic-tabs', role: 'tablist', 'aria-label': 'AI Chat' },
          providers().map(item => h('button', { id: `aic-tab-${item.id}`, key: item.id, role: 'tab',
            className: 'aic-tab', type: 'button', disabled: reopening, 'aria-selected': current.id === item.id,
            'aria-controls': 'aic-content', tabIndex: current.id === item.id ? 0 : -1,
            onKeyDown: event => switchTab(event, item.id), onClick: () => { select(item.id); setSettings(false); setNotice('') } },
          h('span', { className: 'aic-dot', style: { background: item.color } }), item.name))),
        settings ? h(WebsiteSettings, { onDone: () => setSettings(false) }) : h(React.Fragment, null,
          h('div', { className: 'aic-toolbar' },
            button('←', '后退', () => void manager.navigate(current.id, 'back')),
            button('→', '前进', () => void manager.navigate(current.id, 'forward')),
            button('首页', '返回官网首页', () => void manager.navigate(current.id, 'url', current.url)),
            button('刷新', '刷新当前网页', () => void manager.navigate(current.id, 'reload')),
            h('span', { className: 'aic-address', title: state.url || current.url }, state.url || current.url),
            button('复制地址', '复制当前网址', () => void copyUrl(), false),
            h('button', { type: 'button', className: 'aic-button', 'aria-pressed': config.followTheme,
              title: '同步官网内部配色；关闭可恢复官网原色',
              onClick: () => save({ ...config, followTheme: !config.followTheme }) }, config.followTheme ? '跟随皮肤' : '官网原色'),
            button('重新打开', '关闭并重新创建当前网页', () => void reopen(), !manager.available || reopening)),
          h('div', { className: `aic-status${state.error ? ' aic-error' : ''}`, role: state.error ? 'alert' : 'status', 'aria-live': 'polite' },
            state.error || state.themeError || (reopening ? '正在重新打开…' : state.loading ? `正在加载 ${current.name}…` : notice || storageNotice ||
              (state.persistent ? '登录状态自动保留 · 官网过期或要求验证时需重新登录' : '当前桌面环境使用临时登录存储，重启会退出；需应用配套桌面修复'))),
          state.popup ? h('div', { className: 'aic-popup' },
            h('span', null, '官网请求打开：', h('code', null, state.popup)),
            button('在当前页打开', '在当前页打开该链接', () => void manager.navigate(current.id, 'url', state.popup)),
            button('忽略', '忽略该链接', () => manager.dismissPopup(current.id), false)) : null,
          h('div', { id: 'aic-content', role: 'tabpanel', 'aria-labelledby': `aic-tab-${current.id}`,
            className: 'aic-viewport', ref: hostRef },
            !manager.available ? h('div', { className: 'aic-empty' }, h(Icon, { size: 38 }),
              h('h2', null, '在 DSH Desktop 中打开 AI Chat'),
              h('p', null, '内嵌聊天需要桌面客户端的 Browser guest bridge。当前环境可使用顶部标签选择网站并复制地址。'),
              h('code', null, current.url)) : null)))
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
