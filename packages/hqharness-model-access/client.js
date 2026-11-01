window.__ModuleLoader__.load({ id: 'hqharness-model-access', factory: require => {
  const React = require('react')
  const h = React.createElement
  const NS = 'settings.teamModelAccess'
  const zh = {
    title: '团队模型 · DeepSeek-V41-Flash', description: '登录 AgentOS，领取 3 小时模型访问权限。原到期前最后 10 分钟仍在使用模型时，自动续期一次，最多 6 小时。',
    server: 'AgentOS 服务地址', test: '允许内网 HTTP 测试连接', testWarning: '仅用于测试账号与有限额度。HTTP 连接不加密；正式环境请使用 HTTPS。', save: '保存并检查连接', recover: '备份并重置团队登录',
    username: 'AgentOS 用户名', password: '密码', login: '登录', logout: '退出团队账号', claim: '领取 3 小时权限', reclaim: '重新领取 3 小时权限', refresh: '刷新状态',
    default: '设为新会话的默认模型', defaultHint: '现有会话可在输入框的模型选择器中切换到 Huaqing Desktop · AgentOS。',
    signedIn: '已登录：', active: '权限可用', expired: '权限已到期', pending: '权限申请尚未完成，请刷新状态或退出后重新登录。', noLease: '尚未领取模型权限', renewed: '已自动续期一次', remaining: '剩余约 {minutes} 分钟',
    busy: '正在处理…', desktopOnly: '请在 Huaqing Desktop 桌面客户端中申请团队模型权限。', billing: '费用和累计限额由团队统一管理；客户端费用估算不作为账单。', noVision: '当前部署尚未确认图片输入，Computer Use 的截图理解暂不可用。', noTools: '当前部署尚未确认工具调用能力，需管理员验收后启用自动化任务。',
    error: '操作失败，请重试。', NETWORK: '无法连接 AgentOS，请检查服务地址和网络。', LOGIN_REQUIRED: '登录已过期，请退出后重新登录。', ACCESS_DENIED: '账号没有团队模型权限，请联系管理员。', SERVICE_UNAVAILABLE: '服务尚未启用模型权限接口，请先部署 AgentOS 配套更新。', LEASE_CONFLICT: '已有或尚未完成的权限申请。请刷新状态，或退出后重新登录。', RATE_LIMIT: '请求频率或额度已达限制，请稍后重试。', TLS_REQUIRED: '正式连接需要 HTTPS；内网 HTTP 仅可在测试选项中显式启用。', STORE_INVALID: '系统无法解密团队凭据，原文件已保留，请恢复系统凭据访问后重试。', ENCRYPTION_UNAVAILABLE: '系统加密不可用，请解锁系统凭据存储后重试。', REVOCATION_PENDING: '本机访问已停止；远端撤销将在下次登录时重试，或由权限到期收敛。', PASSWORD_LOGIN_DISABLED: '此服务未启用密码登录，请联系管理员配置组织登录。', LOGOUT_REQUIRED: '请先退出当前团队账号，再修改服务或账号。', INVALID_RESPONSE: '服务返回的权限或模型信息不符合约定，请联系管理员。', defaultFailed: '权限已领取，但未能设为默认模型。可先在模型选择器中选择团队模型。', defaultSaved: '已设为新会话默认模型。'
  }
  const en = {
    title: 'Team model · DeepSeek-V41-Flash', description: 'Sign in to AgentOS for 3 hours of model access. If the model is still in use during the final 10 minutes, access renews once, for up to 6 hours total.',
    server: 'AgentOS service URL', test: 'Allow private HTTP test connection', testWarning: 'Use test accounts and limited quotas only. HTTP is unencrypted; use HTTPS in production.', save: 'Save and check connection', recover: 'Back up and reset team login',
    username: 'AgentOS username', password: 'Password', login: 'Sign in', logout: 'Sign out of team account', claim: 'Claim 3-hour access', reclaim: 'Claim another 3 hours', refresh: 'Refresh status',
    default: 'Use as the default for new sessions', defaultHint: 'For an existing session, choose Huaqing Desktop · AgentOS in the composer model selector.',
    signedIn: 'Signed in: ', active: 'Access available', expired: 'Access expired', pending: 'The access request is pending. Refresh, or sign out and sign in again.', noLease: 'Model access has not been claimed', renewed: 'Renewed automatically once', remaining: 'About {minutes} minutes remaining',
    busy: 'Working…', desktopOnly: 'Claim team model access in Huaqing Desktop.', billing: 'Your team manages charges and cumulative limits. Client cost estimates are not billing records.', noVision: 'Image input has not been verified for this deployment. Computer Use screenshot understanding is unavailable.', noTools: 'Tool calling has not been verified. An administrator must validate automation support.',
    error: 'The action failed. Try again.', NETWORK: 'Cannot reach AgentOS. Check the service URL and network.', LOGIN_REQUIRED: 'Your login expired. Sign out and sign in again.', ACCESS_DENIED: 'This account does not have team model access. Contact your administrator.', SERVICE_UNAVAILABLE: 'The model access API is not enabled. Deploy the matching AgentOS update first.', LEASE_CONFLICT: 'An existing or pending access request needs attention. Refresh, or sign out and sign in again.', RATE_LIMIT: 'A rate or quota limit was reached. Try again later.', TLS_REQUIRED: 'HTTPS is required. Private HTTP requires the explicit test option.', STORE_INVALID: 'System credentials could not be decrypted. The original file was preserved; restore system credential access and retry.', ENCRYPTION_UNAVAILABLE: 'System encryption is unavailable. Unlock the system credential store and retry.', REVOCATION_PENDING: 'Local access stopped. Remote revocation will retry at the next sign-in, or the grant will expire.', PASSWORD_LOGIN_DISABLED: 'Password login is disabled. Contact your administrator to configure organization sign-in.', LOGOUT_REQUIRED: 'Sign out before changing the team service or account.', INVALID_RESPONSE: 'The service returned invalid access or model metadata. Contact your administrator.', defaultFailed: 'Access was claimed, but the default could not be saved. Choose the team model in the model selector.', defaultSaved: 'Saved as the default for new sessions.'
  }
  async function saveTeamDefault() {
    const response = await fetch('/api/hqharness-team-model/default', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    return response.ok
  }
  function TeamModelCard({ t }) {
    const bridge = window.hqTeamModelAccess
    const [status, setStatus] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [message, setMessage] = React.useState('')
    const [server, setServer] = React.useState('')
    const [test, setTest] = React.useState(false)
    const [username, setUsername] = React.useState('')
    const [password, setPassword] = React.useState('')
    const [useDefault, setDefault] = React.useState(true)
    const mounted = React.useRef(false)
    const operation = React.useRef(0)
    const busyRef = React.useRef(false)
    const titleId = React.useId()
    React.useEffect(() => {
      mounted.current = true
      let initialized = false
      const read = async () => {
        if (!bridge || document.hidden) return
        const generation = operation.current
        try {
          const result = await bridge.status()
          if (!mounted.current || generation !== operation.current) return
          setStatus(result.status)
          if (!initialized) { setServer(result.status.server); setTest(result.status.insecureTest); initialized = true }
        } catch { if (mounted.current) setError('error') }
      }
      void read()
      const timer = setInterval(() => { void read() }, 15_000)
      return () => { mounted.current = false; clearInterval(timer) }
    }, [bridge])
    async function run(action, input) {
      if (!bridge || busyRef.current) return
      busyRef.current = true
      operation.current++
      setBusy(true); setError(''); setMessage('')
      try {
        const result = await bridge[action](input)
        if (!mounted.current) return
        setStatus(result.status)
        if (!result.ok) { setError(result.error || 'error'); return }
        if (action === 'claim' && useDefault) {
          const saved = await saveTeamDefault()
          if (mounted.current) saved ? setMessage(t('defaultSaved')) : setError('defaultFailed')
        }
      } catch { if (mounted.current) setError('error') }
      finally { busyRef.current = false; if (mounted.current) setBusy(false) }
    }
    const lease = status?.lease
    const problem = error || status?.error
    const explain = problem && t(Object.hasOwn(zh, problem) ? problem : 'error')
    return h('section', { className: 'hqTeamCard', 'aria-labelledby': titleId },
      h('h3', { id: titleId }, t('title')), h('p', null, t('description')),
      !bridge ? h('p', null, t('desktopOnly')) : h(React.Fragment, null,
        !status?.signedIn && h('form', { onSubmit: event => { event.preventDefault(); void run('configure', { baseUrl: server, allowInsecureTest: test }) } },
          h('label', null, t('server'), h('input', { type: 'url', value: server, onChange: e => setServer(e.target.value), placeholder: 'https://agentos.example.com', required: true, maxLength: 2048, disabled: busy, autoComplete: 'off' })),
          h('label', { className: 'hqTeamCheck' }, h('input', { type: 'checkbox', checked: test, onChange: e => setTest(e.target.checked), disabled: busy }), t('test')),
          test && h('p', { className: 'hqTeamNotice' }, t('testWarning')), h('button', { type: 'submit', disabled: busy }, t('save'))),
        status?.configured && !status.signedIn && h('form', { onSubmit: event => { event.preventDefault(); const credentials = { username, password }; setPassword(''); void run('login', credentials) } },
          h('label', null, t('username'), h('input', { value: username, onChange: e => setUsername(e.target.value), required: true, maxLength: 256, disabled: busy, autoComplete: 'username' })),
          h('label', null, t('password'), h('input', { type: 'password', value: password, onChange: e => setPassword(e.target.value), required: true, maxLength: 4096, disabled: busy, autoComplete: 'current-password' })),
          h('button', { type: 'submit', disabled: busy }, t('login'))),
        status?.signedIn && h(React.Fragment, null,
          h('p', null, t('signedIn'), status.accountName),
          h('p', { role: 'status' }, !lease ? t('noLease') : lease.status === 'expired' || !status.remainingMs ? t('expired') : lease.status === 'active' ? t('active') : t('pending'), lease?.auto_renewed ? ` · ${t('renewed')}` : ''),
          lease && status.remainingMs > 0 && h('p', null, t('remaining', { minutes: Math.ceil(status.remainingMs / 60_000) })),
          h('label', { className: 'hqTeamCheck' }, h('input', { type: 'checkbox', checked: useDefault, onChange: e => setDefault(e.target.checked), disabled: busy }), t('default')),
          h('div', { className: 'hqTeamActions' },
            h('button', { type: 'button', disabled: busy, onClick: () => run('claim') }, t(lease ? 'reclaim' : 'claim')),
            h('button', { type: 'button', disabled: busy, onClick: () => run('refresh') }, t('refresh')),
            h('button', { type: 'button', disabled: busy, onClick: () => run('logout') }, t('logout'))),
          h('p', null, t('defaultHint')),
          lease && !lease.model.input_modalities.includes('image') && h('p', null, t('noVision')),
          lease && !lease.model.tool_calls_verified && h('p', null, t('noTools'))),
        busy && h('p', { role: 'status' }, t('busy')),
        explain && h('p', { role: 'alert' }, explain),
        status?.error === 'STORE_INVALID' && h('button', { type: 'button', disabled: busy, onClick: () => run('logout') }, t('recover')),
        message && h('p', { role: 'status', 'aria-live': 'polite' }, message)),
      h('p', { className: 'hqTeamBilling' }, t('billing')))
  }
  return { inject: ['slots', 'locale'], apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'team model locale')
    ctx.effect(() => {
      if (document.getElementById('hq-team-model-style')) return
      const style = document.createElement('style')
      style.id = 'hq-team-model-style'
      style.dataset.pluginCss = 'hqharness-model-access'
      style.textContent = '.hqTeamCard{border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-panel);padding:20px;margin-top:20px;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}.hqTeamCard h3{margin:0 0 8px;font-size:16px;font-weight:600}.hqTeamCard p,.hqTeamCard label{font-size:14px;line-height:1.5}.hqTeamCard p{margin:8px 0;color:var(--dsw-alias-label-secondary)}.hqTeamCard form{display:flex;flex-direction:column;gap:12px;margin-top:16px}.hqTeamCard label{display:flex;flex-direction:column;gap:6px}.hqTeamCard input:not([type=checkbox]){font:inherit;color:inherit;min-height:36px;padding:6px 12px;border:1px solid var(--dsw-alias-ui-control-border);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);min-width:0;width:100%;box-sizing:border-box}.hqTeamCard .hqTeamCheck{flex-direction:row;align-items:center;gap:8px;margin:12px 0}.hqTeamCard input[type=checkbox]{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}.hqTeamActions{display:flex;gap:8px;flex-wrap:wrap}.hqTeamCard button{align-self:flex-start;font:inherit;font-size:14px;font-weight:500;min-height:36px;padding:6px 12px;border:1px solid var(--dsw-alias-ui-control-border);border-radius:var(--dsw-radius-md);color:inherit;background:var(--dsw-alias-bg-layer-2);cursor:pointer}.hqTeamCard button:disabled{opacity:.5;cursor:default}.hqTeamCard :is(input,button):focus-visible{outline:2px solid var(--dsw-alias-ui-focus-ring);outline-offset:2px}.hqTeamCard [role=alert],.hqTeamCard .hqTeamNotice{color:var(--dsw-alias-state-warn-primary)}.hqTeamCard .hqTeamBilling{margin-top:16px}'
      document.head.appendChild(style)
      return () => style.remove()
    }, 'team model styles')
    ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'hq-team-model', order: -100, inject: () => ({ t: ctx.locale.bind(NS) }) }, TeamModelCard))
  } }
} })
