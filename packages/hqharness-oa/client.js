window.__ModuleLoader__.load({ id: 'hqharness-oa', factory: require => {
  const React = require('react')
  const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
  const h = React.createElement
  const NS = 'settings.hqOa'

  const zh = {
    tab: 'OA 业务',
    title: 'OA 测试环境',
    description: '连接 OA 测试内网后，可在对话中准备和保存出差、报销草稿。请填写测试环境的应用凭据与操作人的 OA 姓名。',
    account: '测试账号', chooseAccount: '选择测试账号', operatorName: 'OA 操作人姓名',
    corpid: '企业 ID', appKey: '应用 Key', appSecret: '应用 Secret', tenantKey: '租户 Key',
    loading: '正在读取 OA 配置…', unavailable: '此安装未启用 OA 测试环境。',
    empty: '尚未配置 OA。', connected: '已验证操作人 {operatorName}（{account}）',
    save: '验证并保存', checking: '正在验证 OA 凭据和操作人…',
    edit: '更换配置', cancel: '取消', clear: '移除本机配置', recover: '备份并重置配置',
    clearing: '正在移除本机配置…', refresh: '重新读取配置',
    invalidResponse: '未能读取 OA 配置，请重试。',
    INVALID_CONFIGURATION: '请检查测试账号和必填字段。',
    IDENTITY_UNVERIFIED: '无法验证操作人。请检查测试内网、应用凭据和 OA 姓名。',
    ENCRYPTION_UNAVAILABLE: '系统加密服务不可用。请解锁系统凭据存储后重试。',
    STORE_INVALID: '已保存的 OA 配置无法读取。可先备份并重置，再重新配置。',
    STORE_UNAVAILABLE: '无法访问 OA 配置文件。请检查本机存储后重试。',
    OA_RUNTIME_UNAVAILABLE: '当前安装缺少可用的 OA 运行环境。',
    OA_BUSY: 'OA 正在处理任务。请等任务结束后再更换配置。',
    failed: 'OA 配置操作失败，请重试。',
    attach: '添加 OA 原件',
    attachType: '请选择 PDF、JPG、PNG、OFD、XML、DOCX、XLSX 或 TXT 文件。',
    attachLimit: 'OA 原件最多 8 份，每份不超过 12 MiB，总计不超过 20 MiB。',
    attachFailed: '原件未加入当前对话，请重新选择。'
  }
  const en = {
    tab: 'OA workflows',
    title: 'OA test environment',
    description: 'Connect to the OA test network to prepare and save travel and reimbursement drafts in chat. Enter the test application credentials and the operator’s name in OA.',
    account: 'Test account', chooseAccount: 'Select a test account', operatorName: 'OA operator name',
    corpid: 'Corporation ID', appKey: 'Application key', appSecret: 'Application secret', tenantKey: 'Tenant key',
    loading: 'Loading OA settings…', unavailable: 'The OA test environment is unavailable in this installation.',
    empty: 'OA is not configured.', connected: 'Verified operator {operatorName} ({account})',
    save: 'Verify and save', checking: 'Verifying OA credentials and the operator…',
    edit: 'Replace configuration', cancel: 'Cancel', clear: 'Remove local configuration', recover: 'Back up and reset configuration',
    clearing: 'Removing local configuration…', refresh: 'Reload settings',
    invalidResponse: 'Could not load OA settings. Try again.',
    INVALID_CONFIGURATION: 'Check the test account and required fields.',
    IDENTITY_UNVERIFIED: 'Could not verify the operator. Check the test network, application credentials, and OA name.',
    ENCRYPTION_UNAVAILABLE: 'System encryption is unavailable. Unlock the system credential store and try again.',
    STORE_INVALID: 'Could not read the saved OA settings. Back them up and reset before configuring OA again.',
    STORE_UNAVAILABLE: 'Could not access the OA settings file. Check local storage and try again.',
    OA_RUNTIME_UNAVAILABLE: 'This installation has no usable OA runtime.',
    OA_BUSY: 'OA is processing a task. Wait for it to finish before changing the configuration.',
    failed: 'The OA settings action failed. Try again.',
    attach: 'Attach OA originals',
    attachType: 'Select PDF, JPG, PNG, OFD, XML, DOCX, XLSX, or TXT files.',
    attachLimit: 'Attach up to 8 OA originals, with a limit of 12 MiB per file and 20 MiB in total.',
    attachFailed: 'The originals were not added to this conversation. Select them again.'
  }
  const originalExtensions = ['pdf', 'jpg', 'jpeg', 'png', 'ofd', 'xml', 'docx', 'xlsx', 'txt']
  const maxOriginals = 8
  const maxOriginalBytes = 12 * 1024 * 1024
  const maxOriginalTotal = 20 * 1024 * 1024
  const fields = [
    { name: 'operatorName', maxLength: 160 },
    { name: 'corpid', maxLength: 512 },
    { name: 'tenantKey', maxLength: 512 },
    { name: 'appKey', maxLength: 512, secret: true },
    { name: 'appSecret', maxLength: 4096, secret: true }
  ]

  const css = `
    .hqOaSettings {
      min-width: 0;
      padding: 20px;
      border: 1px solid var(--dsw-alias-border-l4);
      border-radius: var(--dsw-radius-panel);
      color: var(--dsw-alias-label-primary);
      background: var(--dsw-alias-bg-layer-3);
    }
    .hqOaSettings h3 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
    .hqOaSettings p {
      margin: 8px 0;
      font-size: 14px;
      line-height: 1.55;
      overflow-wrap: anywhere;
      color: var(--dsw-alias-label-secondary);
    }
    .hqOaSettings fieldset {
      min-width: 0;
      margin: 16px 0 0;
      padding: 0;
      border: 0;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
      gap: 12px;
    }
    .hqOaSettings label { min-width: 0; display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
    .hqOaSettings select {
      min-height: 36px;
      padding: 6px 12px;
      border: 1px solid var(--dsw-alias-ui-control-border);
      border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-layer-2);
      color: inherit;
      font: inherit;
    }
    .hqOaSettings select:focus-visible { outline: 2px solid var(--dsw-alias-ui-focus-ring); outline-offset: 2px; }
    .hqOaSettings [role=alert] { color: var(--dsw-alias-state-error-primary); }
    .hqOaActions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .hqOaOriginals { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
    .hqOaOriginals [role=alert] { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
  `

  function settingsStatus(result) {
    const status = result?.status
    if (typeof result?.ok !== 'boolean' || typeof status?.available !== 'boolean' || typeof status?.configured !== 'boolean') {
      throw new Error('Invalid OA settings status')
    }
    const { account, operatorName } = status
    if (status.configured && ((account !== 'lgw' && account !== 'wwb') || typeof operatorName !== 'string' || !operatorName)) {
      throw new Error('Invalid OA operator status')
    }
    return { available: status.available, configured: status.configured, account, operatorName }
  }

  function OaSettings({ bridge, t }) {
    const titleId = React.useId()
    const [status, setStatus] = React.useState(null)
    const [pending, setPending] = React.useState('status')
    const [error, setError] = React.useState('')
    const [editing, setEditing] = React.useState(false)
    const generation = React.useRef(0)
    const busy = React.useRef(false)

    async function run(action, input) {
      if (busy.current) return
      busy.current = true
      const current = ++generation.current
      setPending(action)
      setError('')
      try {
        const result = action === 'configure' ? await bridge.configure(input) : await bridge[action]()
        if (current !== generation.current) return
        setStatus(settingsStatus(result))
        if (!result.ok) {
          setError(typeof result.error === 'string' && Object.hasOwn(en, result.error) ? result.error : 'failed')
        } else if (action !== 'status') {
          setEditing(false)
        }
      } catch {
        if (current === generation.current) setError(action === 'status' ? 'invalidResponse' : 'failed')
      } finally {
        if (current === generation.current) {
          busy.current = false
          setPending('')
        }
      }
    }

    React.useEffect(() => {
      void run('status')
      return () => { generation.current++; busy.current = false }
    }, [bridge])

    function submit(event) {
      event.preventDefault()
      if (busy.current) return
      const form = event.currentTarget
      const values = new FormData(form)
      const input = { environment: 'test', account: values.get('account') }
      for (const { name, secret } of fields) {
        input[name] = values.get(name)
        if (secret) form.elements.namedItem(name).value = ''
      }
      void run('configure', input)
    }

    const recover = error === 'STORE_INVALID'
    const canConfigure = status?.available && !recover && (!status.configured || editing)
    const statusText = pending === 'status' ? t('loading') : pending === 'configure' ? t('checking') : pending === 'clear' ? t('clearing')
      : status?.configured ? t('connected', { account: status.account, operatorName: status.operatorName })
        : status?.available ? t('empty') : status ? t('unavailable') : ''

    return h('section', { className: 'hqOaSettings', 'aria-labelledby': titleId, 'aria-busy': !!pending },
      h('h3', { id: titleId }, t('title')),
      h('p', null, t('description')),
      statusText && h('p', { role: 'status' }, statusText),
      error && h('p', { role: 'alert' }, t(error)),
      canConfigure && h('form', { autoComplete: 'off', onSubmit: submit },
        h('fieldset', { disabled: !!pending },
          h('label', null, t('account'),
            h('select', { name: 'account', defaultValue: status.account || '', required: true },
              h('option', { value: '', disabled: true }, t('chooseAccount')),
              h('option', { value: 'lgw' }, 'lgw'),
              h('option', { value: 'wwb' }, 'wwb'))),
          fields.map(({ name, maxLength, secret }) => h('label', { key: name }, t(name),
            h(Input, { name, maxLength, type: secret ? 'password' : 'text', required: true,
              defaultValue: name === 'operatorName' ? status.operatorName : undefined,
              autoComplete: secret ? 'new-password' : 'off', autoCapitalize: 'none', spellCheck: false })))),
        h('div', { className: 'hqOaActions' },
          h(Button, { type: 'submit', variant: 'primary', disabled: !!pending }, t('save')),
          editing && h(Button, { type: 'button', disabled: !!pending, onClick: () => { setEditing(false); setError('') } }, t('cancel')))),
      (!canConfigure || error) && h('div', { className: 'hqOaActions' },
        status?.available && status.configured && !editing && !recover
          && h(Button, { type: 'button', variant: 'outline', disabled: !!pending, onClick: () => { setEditing(true); setError('') } }, t('edit')),
        (status?.configured && !editing || recover)
          && h(Button, { type: 'button', variant: 'outline', disabled: !!pending, onClick: () => { void run('clear') } }, t(recover ? 'recover' : 'clear')),
        (!status || !status.available || error) && !pending
          && h(Button, { type: 'button', onClick: () => { void run('status') } }, t('refresh'))))
  }

  function OaOriginals({ bridge, conversation, session, input, inputActions, t }) {
    const [available, setAvailable] = React.useState(false)
    const [error, setError] = React.useState('')
    const picker = React.useRef(null)
    const pickerSession = React.useRef(null)
    const sessionId = session?.sessionId

    React.useEffect(() => {
      let active = true
      void bridge.status().then(result => {
        if (active) setAvailable(result?.status?.available === true)
      }, () => { if (active) setAvailable(false) })
      return () => { active = false }
    }, [bridge])

    function add(event) {
      const files = Array.from(event.currentTarget.files ?? [])
      event.currentTarget.value = ''
      if (!files.length) return
      if (pickerSession.current !== sessionId || locked) { setError('attachFailed'); return }
      if (files.some(file => !originalExtensions.includes(file.name.split('.').at(-1)?.toLowerCase())
        || file.name.lastIndexOf('.') <= 0 || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(file.name)
        || new TextEncoder().encode(file.name).length > 255)) { setError('attachType'); return }

      const existing = input?.attachmentIds ?? []
      let drafts
      try {
        const existingBytes = conversation.resolveDraftAttachments(existing).reduce((total, draft) => total + draft.file.size, 0)
        if (existing.length + files.length > maxOriginals || files.some(file => file.size <= 0 || file.size > maxOriginalBytes)
          || files.reduce((total, file) => total + file.size, existingBytes) > maxOriginalTotal) {
          setError('attachLimit')
          return
        }
        // The stock composer treats image MIME as a normalized preview. Use
        // the ordinary file receipt path to preserve the original bytes.
        const originals = files.map(file => new File([file], file.name, { type: 'application/octet-stream', lastModified: file.lastModified }))
        drafts = conversation.createDrafts(sessionId, originals)
        if (!inputActions.addAttachments(drafts.map(draft => draft.id))) throw new Error('OA attachment admission is locked')
        setError('')
      } catch {
        if (drafts) conversation.releaseDraftAttachments(drafts)
        setError('attachFailed')
      }
    }

    if (!available || !sessionId || typeof inputActions?.addAttachments !== 'function') return null
    const locked = input?.phase === 'adjudicating' || input?.phase === 'submitting'
    return h('div', { className: 'hqOaOriginals' },
      h('input', { ref: picker, type: 'file', multiple: true, hidden: true,
        accept: originalExtensions.map(extension => `.${extension}`).join(','), onChange: add }),
      h(Button, { type: 'button', size: 'sm', disabled: locked, onClick: () => {
        pickerSession.current = sessionId
        picker.current?.click()
      } }, t('attach')),
      error && h('span', { role: 'alert' }, t(error)))
  }

  return { inject: ['slots', 'locale', 'conversation'], apply(ctx) {
    const bridge = window.hqOa
    if (typeof bridge?.status !== 'function' || typeof bridge.configure !== 'function' || typeof bridge.clear !== 'function') return
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'OA settings locale')
    ctx.effect(() => {
      if (document.getElementById('hq-oa-settings-style')) return
      const style = document.createElement('style')
      style.id = 'hq-oa-settings-style'
      style.dataset.pluginCss = 'hqharness-oa'
      style.textContent = css
      document.head.appendChild(style)
      return () => style.remove()
    }, 'OA settings styles')
    const t = ctx.locale.bind(NS)
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab', id: 'hq-oa', order: -89, locale: NS, label: () => t('tab'),
      inject: () => ({ bridge, t })
    }, OaSettings))
    const conversation = ctx.get('conversation')
    if (typeof conversation?.createDrafts !== 'function' || typeof conversation.resolveDraftAttachments !== 'function'
      || typeof conversation.releaseDraftAttachments !== 'function') return
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock', id: 'hq-oa-originals', order: 10, locale: NS,
      inject: () => ({ bridge, conversation, t })
    }, OaOriginals))
  } }
} })
