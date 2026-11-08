export function createUpdatePanel(React, request) {
  const h = React.createElement
  return function UpdatePanel() {
    const [info, setInfo] = React.useState(null)
    const [error, setError] = React.useState('')
    const [checking, setChecking] = React.useState(false)
    const [starting, setStarting] = React.useState(false)
    const [expanded, setExpanded] = React.useState(true)
    const alive = React.useRef(true)
    const load = async (force = false) => {
      if (force) setChecking(true)
      try { const data = await request(force ? 'check' : 'status'); if (alive.current) { setInfo(data); setError('') } }
      catch (cause) { if (alive.current) setError(cause.message) }
      finally { if (alive.current) setChecking(false) }
    }
    React.useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [])
    const active = starting || ['downloading', 'installing'].includes(info?.job?.state)
    React.useEffect(() => {
      if (!active) return
      const timer = setInterval(() => void load(), 1500)
      return () => clearInterval(timer)
    }, [active])
    const install = async version => {
      setStarting(true); setError('')
      try {
        const result = await request('install', { version })
        if (alive.current) setInfo(previous => ({ ...previous, job: result.job }))
      } catch (cause) { if (alive.current) setError(cause.message) }
      finally { if (alive.current) setStarting(false) }
    }
    const date = value => /^\d{4}-\d{2}-\d{2}/.test(value || '') ? value.slice(0, 10) : '—'
    const latest = info?.releases?.[0]
    const newer = latest && compare(latest.version, info.installedVersion) > 0
    return h('section', { className: 'aic-panel aic-updates aic-detail-updates', 'aria-label': 'AI Chat 版本' },
      h('div', { className: 'aic-update-label' }, h('h2', null, '版本'),
        h('button', { className: 'aic-button', disabled: checking || active, onClick: () => void load(true) }, checking ? '检查中…' : '↻ 重新检查')),
      h('section', { className: 'aic-version-card' },
        h('button', { className: 'aic-version-summary', onClick: () => setExpanded(value => !value), 'aria-expanded': expanded, 'aria-controls': 'aic-version-list' },
          h('span', { className: 'aic-version-icon', 'aria-hidden': true }, '↓'),
          h('span', { className: 'aic-version-summary-text' }, h('strong', null, newer ? `可更新到 ${latest.version}` : latest ? '已是最新版本' : !info && !error ? '正在检查版本…' : '暂无可用版本'),
            h('span', null, latest ? `发布于 ${date(latest.publishedAt)}` : '从 GitHub Release 获取版本')),
          h('span', null, expanded ? '收起 ⌃' : '展开 ⌄')),
        expanded ? h('div', { id: 'aic-version-list' }, ...(info?.releases || []).map((release, index) => {
          const current = release.version === info.installedVersion
          return h('div', { className: 'aic-version-row', key: release.version },
            h('span', { className: 'aic-version-name' }, release.version, index === 0 ? h('span', { className: 'aic-version-badge' }, 'latest') : null),
            h('time', { dateTime: release.publishedAt }, date(release.publishedAt)),
            h('button', { className: 'aic-button', disabled: current || active || !info.canInstall,
              'aria-label': `${current ? '当前版本' : '安装版本'} ${release.version}`, onClick: () => void install(release.version) },
            current ? '当前版本' : compare(release.version, info.installedVersion) > 0 ? '更新' : '切换版本'))
        })) : null),
      info ? h('p', { className: 'aic-muted' }, `当前安装 ${info.installedVersion} · 正在运行 ${info.runningVersion}`) : null,
      info?.job?.message ? h('p', { role: info.job.state === 'failed' ? 'alert' : 'status', className: info.job.state === 'failed' ? 'aic-error' : '' }, info.job.message) : null,
      error || info?.fetchError ? h('p', { role: 'alert', className: 'aic-error' }, error || info.fetchError) : null,
      info && !info.canInstall ? h('p', null, '当前环境无法自动安装，请通过 DSH 插件管理安装 Release 包。') : null,
      h('p', { className: 'aic-footnote' }, '安装可能重新加载插件，请先保存未发送内容；需要重启时会提示。切换旧版本可能不包含此更新面板。'),
      h('a', { href: 'https://github.com/DescartHsu/dsh-web-AIchat/releases', target: '_blank', rel: 'noopener noreferrer' }, '查看 GitHub Release'))
  }
}
function compare(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}
