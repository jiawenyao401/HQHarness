window.__ModuleLoader__.load({ id: 'hqharness-wps', factory: require => {
  const React = require('react')
  const h = React.createElement
  const NS = 'settings.localWps'
  const zh = {
    tab: 'WPS Office', title: '本机 WPS Office',
    description: '让当前会话通过本机加载项读取和编辑 WPS 文字、表格与演示文稿。需要已安装且支持 JS 加载项的 WPS Office。',
    prepare: '启用或修复前，请先保存文档并完全退出 WPS。重新打开后，若 WPS 提示加载项已修改，请核对 HuaqingDesktop 加载项并由你确认加载，再刷新连接状态。',
    desktopOnly: '请在 Huaqing Desktop 桌面客户端中使用。', unsupported: '当前平台不支持本机 WPS 连接。',
    loading: '正在读取 WPS 状态…', unknown: '尚未获取 WPS 连接状态。', working: '正在处理…',
    unregistered: '尚未启用 WPS 加载项。', registered: '加载项已注册，等待 WPS 文档连接。', connected: '已连接 WPS 文档。',
    restart: '请重新打开 WPS 以加载本次配置，然后刷新状态。',
    documents: '已连接文档：{count}', frozen: '暂停写入的文档：{count}',
    frozenHint: '有文档的上次操作结果尚未确认，写入已暂停。请先在 WPS 中核对实际结果，再让助手执行 recover 并由你确认恢复。重新连接不会自动解除暂停。',
    enable: '启用 WPS 连接', repair: '修复加载项注册', refresh: '刷新连接状态', stop: '停止 WPS 操作并撤销授权',
    stopHint: '停止后撤销当前会话的 WPS 授权。WPS 文档仍保持打开；已开始的操作可能继续完成，已写入的内容不会撤销。',
    enabled: '加载项注册已完成。请重新打开 WPS，再刷新连接状态。', stopped: '已请求停止 WPS 操作并撤销授权，请在 WPS 中核对已开始的操作结果。', cancelled: '已取消启用 WPS 连接。',
    failed: '操作失败，请刷新状态后重试。',
    WPS_RESTART_REQUIRED: 'WPS 仍在运行。请先保存文档并完全退出 WPS，再启用或修复连接。',
    WPS_STARTUP_FAILED: '本机 WPS 桥接未能启动。请检查安装完整性后重试。',
    WPS_INVALID_INSTALLATION: 'WPS 连接资源不完整。请修复 Huaqing Desktop 安装。',
    WPS_RECOVERY_REQUIRED: '上次加载项注册需要恢复。请保留现有注册文件和恢复副本，完成恢复后再启用。'
  }
  const en = {
    tab: 'WPS Office', title: 'Local WPS Office',
    description: 'Read and edit WPS Writer, spreadsheets and presentations from the current session through a local Add-in. Requires an installed WPS Office build that supports JS Add-ins.',
    prepare: 'Save your documents and fully quit WPS before enabling or repairing. Reopen WPS; if it reports a changed Add-in, verify the HuaqingDesktop Add-in and confirm loading yourself, then refresh the connection status.',
    desktopOnly: 'Use this capability in Huaqing Desktop.', unsupported: 'Local WPS connections are unavailable on this platform.',
    loading: 'Loading WPS status…', unknown: 'WPS connection status is not available yet.', working: 'Working…',
    unregistered: 'The WPS Add-in is not enabled.', registered: 'Add-in registered. Waiting for WPS documents to connect.', connected: 'WPS documents are connected.',
    restart: 'Reopen WPS to load the updated configuration, then refresh the status.',
    documents: 'Connected documents: {count}', frozen: 'Documents with writes paused: {count}',
    frozenHint: 'A previous operation has an unconfirmed outcome. Inspect the actual results in WPS, then ask the assistant to run recover and confirm recovery yourself. Reconnecting does not automatically resume writes.',
    enable: 'Enable WPS connection', repair: 'Repair Add-in registration', refresh: 'Refresh connection status', stop: 'Stop WPS operations and revoke access',
    stopHint: 'Stopping revokes current session access to WPS. Documents stay open. Operations already started may still complete, and changes already made are retained.',
    enabled: 'Add-in registration completed. Reopen WPS, then refresh the connection status.', stopped: 'WPS access was revoked and a stop was requested. Inspect the results of operations already started in WPS.', cancelled: 'Enabling the WPS connection was cancelled.',
    failed: 'The action failed. Refresh the status and try again.',
    WPS_RESTART_REQUIRED: 'WPS is still running. Save your documents and fully quit WPS before enabling or repairing the connection.',
    WPS_STARTUP_FAILED: 'The local WPS bridge could not start. Check the installation and try again.',
    WPS_INVALID_INSTALLATION: 'WPS connection resources are incomplete. Repair your Huaqing Desktop installation.',
    WPS_RECOVERY_REQUIRED: 'An earlier Add-in registration needs recovery. Keep the current registry files and recovery copies until recovery is complete.'
  }
  const ERROR_KEYS = ['WPS_RESTART_REQUIRED', 'WPS_STARTUP_FAILED', 'WPS_INVALID_INSTALLATION', 'WPS_RECOVERY_REQUIRED', 'WPS_DENIED']

  function errorKey(error) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    return ERROR_KEYS.find(key => message.includes(key)) || 'failed'
  }

  function readStatus(value) {
    if (!value || typeof value !== 'object'
      || typeof value.supported !== 'boolean' || typeof value.registered !== 'boolean'
      || typeof value.needsWpsRestart !== 'boolean'
      || !Number.isSafeInteger(value.connectedDocuments) || value.connectedDocuments < 0
      || !Number.isSafeInteger(value.frozenDocuments) || value.frozenDocuments < 0
      || (value.error !== undefined && typeof value.error !== 'string')) throw new Error('Invalid WPS status')
    return value
  }

  function WpsSettings({ t }) {
    const bridge = window.hqWps
    const [status, setStatus] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [message, setMessage] = React.useState('')
    const mounted = React.useRef(false)
    const operation = React.useRef(0)
    const busyRef = React.useRef(false)
    const titleId = React.useId()
    const instructionsId = React.useId()

    async function run(action) {
      if (!bridge || busyRef.current) return
      const generation = ++operation.current
      busyRef.current = true
      setBusy(true); setError(''); setMessage('')
      try {
        const response = await bridge[action]()
        if (!mounted.current || operation.current !== generation) return
        const result = readStatus(action === 'status' ? response : await bridge.status())
        if (!mounted.current || operation.current !== generation) return
        setStatus(result)
        if (!result.error && action === 'register' && result.registered) setMessage('enabled')
        if (!result.error && action === 'stop') setMessage('stopped')
      } catch (cause) {
        if (mounted.current && operation.current === generation) {
          const key = errorKey(cause)
          key === 'WPS_DENIED' ? setMessage('cancelled') : setError(key)
        }
      } finally {
        if (mounted.current && operation.current === generation) { busyRef.current = false; setBusy(false) }
      }
    }

    React.useEffect(() => {
      mounted.current = true
      busyRef.current = false
      void run('status')
      return () => { mounted.current = false; operation.current++; busyRef.current = false }
    }, [bridge])

    const statusError = status?.error ? errorKey(status.error) : ''
    const problem = error || (statusError === 'WPS_DENIED' ? '' : statusError)
    const available = !!bridge && !!status?.supported
    const state = !bridge ? 'desktopOnly' : !status ? busy ? 'loading' : 'unknown'
      : !status.supported ? 'unsupported' : status.connectedDocuments > 0 ? 'connected'
        : status.registered ? 'registered' : 'unregistered'
    return h('section', { className: 'hqWpsSettings', 'aria-labelledby': titleId, 'aria-busy': busy },
      h('h3', { id: titleId }, t('title')),
      h('p', null, t('description')),
      h('p', { className: 'hqWpsInstructions', id: instructionsId }, t('prepare')),
      h('p', { role: 'status', 'aria-live': 'polite' }, t(state)),
      status?.supported && h('div', { className: 'hqWpsCounts' },
        h('p', null, t('documents', { count: status.connectedDocuments })),
        h('p', null, t('frozen', { count: status.frozenDocuments }))),
      status?.needsWpsRestart && h('p', { role: 'status' }, t('restart')),
      status?.frozenDocuments > 0 && h('p', { role: 'alert' }, t('frozenHint')),
      h('div', { className: 'hqWpsActions' },
        h('button', { type: 'button', disabled: busy || !available, 'aria-describedby': instructionsId, onClick: () => { void run('register') } }, t(status?.registered ? 'repair' : 'enable')),
        h('button', { type: 'button', disabled: busy || !bridge, onClick: () => { void run('status') } }, t('refresh')),
        h('button', { type: 'button', disabled: busy || !available, onClick: () => { void run('stop') } }, t('stop'))),
      h('p', { className: 'hqWpsStopHint' }, t('stopHint')),
      busy && status && h('p', { role: 'status' }, t('working')),
      problem && h('p', { role: 'alert' }, t(problem)),
      message && h('p', { role: 'status', 'aria-live': 'polite' }, t(message)))
  }

  return { inject: ['slots', 'locale'], apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'WPS locale')
    ctx.effect(() => {
      if (document.getElementById('hq-wps-settings-style')) return
      const style = document.createElement('style')
      style.id = 'hq-wps-settings-style'
      style.dataset.pluginCss = 'hqharness-wps'
      style.textContent = '.hqWpsSettings{border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-panel);padding:20px;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}.hqWpsSettings h3{font-size:16px;font-weight:600;margin:0 0 8px}.hqWpsSettings p{font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:8px 0;overflow-wrap:anywhere}.hqWpsSettings .hqWpsInstructions{padding:12px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.hqWpsCounts{display:flex;gap:8px 24px;flex-wrap:wrap}.hqWpsActions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.hqWpsActions button{font:inherit;font-size:14px;font-weight:500;min-height:36px;padding:6px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-ui-control-border);border-radius:var(--dsw-radius-md);cursor:pointer}.hqWpsActions button:disabled{opacity:.5;cursor:default}.hqWpsActions button:focus-visible{outline:2px solid var(--dsw-alias-ui-focus-ring);outline-offset:2px}.hqWpsSettings [role=alert]{color:var(--dsw-alias-state-warn-primary)}.hqWpsSettings .hqWpsStopHint{margin-top:12px}'
      document.head.appendChild(style)
      return () => style.remove()
    }, 'WPS settings styles')
    const t = ctx.locale.bind(NS)
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'hq-local-wps', order: -90, locale: NS, label: () => t('tab'), inject: () => ({ t }) }, WpsSettings))
  } }
} })
