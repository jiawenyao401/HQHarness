window.__ModuleLoader__.load({ id: 'hqharness-automation', factory: require => {
  const React = require('react')
  const h = React.createElement
  const NS = 'settings.desktopAutomation'
  const zh = { browser: 'Browser Use · 浏览器操作', computer: 'Computer Use · 桌面操作', browserDescription: '内置独立浏览器，支持观察、点击、输入、导航及截图。复用当前会话模型。', computerDescription: '内置 Cua Driver，观察主显示器并控制鼠标和键盘，支持 macOS 与 Windows。请把目标窗口移至主显示器。复用当前会话模型。', ready: '能力已内置，首次使用将请求当前会话授权。', permissions: '需要辅助功能和屏幕录制权限。授权后按系统提示重新启动应用。', grant: '打开系统权限设置', refresh: '刷新权限状态', stop: '立即停止全部自动化', active: '当前授权数：', shortcut: '紧急停止：⌘ / Ctrl + Shift + F12', model: '截图会交给当前模型，请选择支持图片输入的模型。', stopped: '已撤销全部授权并关闭受控浏览器。', failed: '操作失败，请重试。', loading: '正在读取状态…', desktopOnly: '请在 HQHarness 桌面客户端中使用。', unsupported: '当前平台不支持桌面操作。' }
  const en = { browser: 'Browser Use', computer: 'Computer Use', browserDescription: 'Built-in isolated browser: observe, click, type, navigate and capture. Uses the current session model.', computerDescription: 'Built-in Cua Driver observes the primary display and controls mouse/keyboard on macOS and Windows. Move the target window to the primary display. Uses the current session model.', ready: 'Built in. First use requests permission for the current session.', permissions: 'Accessibility and screen recording access are required. Restart the app if requested by the OS.', grant: 'Open system permissions', refresh: 'Refresh permissions', stop: 'Stop all automation now', active: 'Active grants: ', shortcut: 'Emergency stop: Command / Ctrl + Shift + F12', model: 'Screenshots are sent to the current model. Select a model with image input.', stopped: 'All grants revoked and controlled browser windows closed.', failed: 'The action failed. Try again.', loading: 'Loading status…', desktopOnly: 'Use this capability in HQHarness Desktop.', unsupported: 'Desktop input is unavailable on this platform.' }
  function Card({ capability, t }) {
    const [status, setStatus] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [message, setMessage] = React.useState('')
    const mounted = React.useRef(false)
    const bridge = window.hqDesktopAutomation
    const run = async action => {
      if (!bridge) return
      setBusy(true); setMessage('')
      try { const result = await bridge[action](); if (mounted.current) { setStatus(result); if (action === 'stop') setMessage(t('stopped')) } }
      catch { if (mounted.current) setMessage(t('failed')) }
      finally { if (mounted.current) setBusy(false) }
    }
    React.useEffect(() => { mounted.current = true; void run('status'); return () => { mounted.current = false } }, [])
    const computer = capability === 'computer'
    return h('li', { className: 'hqAutomationCard' },
      h('h3', null, t(capability)), h('p', null, t(`${capability}Description`)),
      h('p', { role: 'status' }, !bridge ? t('desktopOnly') : !status ? t('loading') : computer && !status.supported ? t('unsupported') : computer && (!status.accessibility || !status.screenCapture) ? t('permissions') : t('ready')),
      h('p', null, t('model')), status && h('p', null, t('active'), status.activeSessions),
      status?.shortcut && h('p', null, t('shortcut')),
      h('div', { className: 'hqAutomationActions' },
        computer && h('button', { disabled: busy || !bridge, onClick: () => run('permissions') }, t('grant')),
        h('button', { disabled: busy || !bridge, onClick: () => run('status') }, t('refresh')),
        h('button', { disabled: busy || !bridge, onClick: () => run('stop') }, t('stop'))),
      message && h('p', { role: 'status', 'aria-live': 'polite' }, message))
  }
  return { inject: ['slots', 'locale'], apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'automation locale')
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.pluginCss = 'hqharness-automation'
      style.textContent = '.hqAutomationCard{list-style:none;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-panel);padding:20px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}.hqAutomationCard h3{font-size:16px;margin:0 0 8px}.hqAutomationCard p{font-size:14px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin:8px 0}.hqAutomationActions{display:flex;gap:8px;flex-wrap:wrap}.hqAutomationActions button{font:inherit;font-size:14px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);min-height:36px;padding:6px 12px;font-weight:500;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);cursor:pointer}.hqAutomationActions button:disabled{opacity:.5;cursor:default}.hqAutomationActions button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}'
      document.head.appendChild(style)
      return () => style.remove()
    }, 'automation styles')
    const t = ctx.locale.bind(NS)
    ctx.slots.inject('settings.plugins.tab', () => {
      for (const [index, capability] of ['browser', 'computer'].entries()) ctx.slots.register({ name: 'settings.plugins.tab', id: `hq-${capability}-use`, order: -95 + index, locale: NS, label: () => t(capability), inject: () => ({ capability, t }) }, Card)
    })
  } }
} })
