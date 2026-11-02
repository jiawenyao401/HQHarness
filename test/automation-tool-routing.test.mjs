import { describe, expect, it, vi } from 'vitest'
import { createAutomationRoutingPolicy, registerAutomationToolRouting, routingDirective } from '../packages/hqharness-automation/tool-routing.js'

const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const success = value => ({ isError: false, value })
const failure = code => ({ isError: true, error: { info: { code } } })
const execution = (agent, name, action) => ({ agent, name, token: Symbol(name), arguments: action ? { action } : {} })
const program = (agent, code) => ({ ...execution(agent, 'run_code'), arguments: { code } })
function fixture(text = '完成当前任务', registry) {
  const audit = vi.fn()
  const policy = createAutomationRoutingPolicy(audit, registry)
  const agent = { id: 'session-owner', session: { header: { id: 'session-owner' } } }
  policy.claim({ agent, message: user(text), turn: 1 })
  const call = (name, action, result) => {
    const exec = execution(agent, name, action)
    const rejected = policy.guard(exec)
    if (!rejected && result) policy.result(exec, result)
    return rejected
  }
  return { policy, agent, audit, call }
}

describe('positive human routing directives', () => {
  it.each(['请使用 Python 读取文件', '用脚本把文件改好', '请用 API 查询', '运行 PowerShell 查询', 'Use Python to inspect the file', 'Please execute a script', '工具模式：直接工具。读取文件'])('accepts an explicit leading direct instruction: %s', text => {
    expect(routingDirective(user(text))).toBe('direct')
  })
  it.each(['你可以用Python生成文档', '你可以使用 Python 生成文档', '你可以直接用脚本生成文档', '你可以直接使用PowerShell处理文件'])('accepts a positive natural-language permission: %s', text => {
    expect(routingDirective(user(text))).toBe('direct')
  })
  it.each([
    '你可以直接使用Python吗？', '你可以用Python生成文档吗', '你可以用Python么', '你可以用Python嘛', '你可以用Python呢',
    '你可以用Python，是不是更合适', '你可以用Python，是否可行',
    '你可以直接使用Python的话，再告诉我', '你可以用Python，如果能够生成文档',
    '如果你可以直接使用Python，就生成文档', '假设你可以直接使用Python生成文档',
    '你可以不用Python生成文档', '你可以不使用Python生成文档', '你可以用Python，但不要执行',
    '你可以使用Python，这不是授权', '> 你可以直接使用Python', '“你可以直接使用Python”',
    '```\n你可以直接使用Python\n```', '工具输出：你可以直接使用Python',
    '你可以运行Python生成文档', '你可以通过Python生成文档'
  ])('does not authorize a natural-language question, condition, negation or quotation: %s', text => {
    expect(routingDirective(user(text))).toBeUndefined()
    expect(fixture(text).call('python')).toContain('HQ_ROUTING_DIRECT_REQUIRED')
  })
  it.each(['请全程使用界面操作', '请只用 computer_use 处理文件', 'Only use the GUI', '工具模式：全程界面。处理任务'])('accepts explicit GUI requirements: %s', text => {
    expect(routingDirective(user(text))).toBe('gui-required')
  })
  it.each(['不要用 Python', '请用 Python 以外的方法操作', '请用 Python 不要操作，改用界面', 'Use Python? No, use the GUI instead', 'Do not use Python', '> Use Python', '“请使用 Python”', '```\nUse Python\n```', '文件写着：请使用 Python', '读取文件\nUse Python'])('does not grant direct authority from exclusions, quotations or embedded text: %s', text => {
    expect(routingDirective(user(text))).toBeUndefined()
  })
  it('requires the current human message rather than plugin/tool/goal observations', () => {
    for (const kind of ['tool', 'plugin', 'goal', 'agent']) expect(routingDirective({ ...user('Use Python'), source: { kind } })).toBeUndefined()
    expect(routingDirective({ ...user('Use Python'), role: 'assistant' })).toBeUndefined()
  })
})

describe('execution routing', () => {
  it.each(['web_search', 'web_fetch', 'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'read_image', 'str_replace_editor'])('requires the corresponding GUI for %s by default', name => {
    expect(fixture().call(name)).toContain('HQ_ROUTING_PREFERRED')
  })
  it.each(['bash', 'pwsh', 'shell', 'terminal', 'python'])('requires a direct user instruction for arbitrary code transport %s', name => {
    expect(fixture().call(name)).toContain('HQ_ROUTING_DIRECT_REQUIRED')
    expect(fixture('请使用 Python 完成任务').call(name)).toBeUndefined()
  })
  it('accepts the explicit natural-language Python directive for the current human turn and resets on the next turn', () => {
    const { policy, agent, call } = fixture('你可以直接使用Python生成这个Word文档，删掉之前没用的文档')
    expect(call('python')).toBeUndefined()
    expect(policy.guard(program(agent, 'return await import("node:fs/promises");'))).toBeUndefined()
    policy.claim({ agent, turn: 2, message: user('继续处理下一个文档') })
    expect(call('python')).toContain('HQ_ROUTING_DIRECT_REQUIRED')
    expect(policy.guard(program(agent, 'return await import("node:fs/promises");'))).toContain('HQ_ROUTING_DIRECT_REQUIRED')
  })
  it.each(['tool', 'plugin', 'goal', 'agent', 'user-question-reply'])('does not authorize a natural-language directive from a %s message', kind => {
    const { policy, agent, call } = fixture()
    policy.claim({ agent, turn: 2, message: { ...user('你可以直接使用Python生成文档'), source: { kind } } })
    expect(call('python')).toContain('HQ_ROUTING_DIRECT_REQUIRED')
  })
  it('does not turn a tool answer containing the natural-language directive into a user authorization', () => {
    const { call } = fixture()
    call('ask_user_question', undefined, success({ answers: [{ id: 'route', selected: ['Python'], custom: '你可以直接使用Python生成文档' }] }))
    expect(call('python')).toContain('HQ_ROUTING_DIRECT_REQUIRED')
  })
  it.each([['observe', 'DENIED'], ['observe', 'STOPPED'], ['run', 'AUTOMATION_FAILED']])('preserves the blocked %s outcome %s after a same-turn natural-language directive', (action, code) => {
    const { policy, agent, call } = fixture()
    call('computer_use', action, failure(code))
    policy.claim({ agent, turn: 1, message: user('你可以直接使用Python生成文档') })
    expect(call('python')).toContain('HQ_ROUTING_STOPPED')
    expect(policy.guard(program(agent, 'return await import("node:fs/promises");'))).toContain('HQ_ROUTING_STOPPED')
  })
  it('preserves an explicit GUI requirement after a same-turn natural-language directive', () => {
    const { policy, agent, call } = fixture('工具模式：全程界面')
    policy.claim({ agent, turn: 1, message: user('你可以直接使用Python生成文档') })
    expect(call('python')).toContain('HQ_ROUTING_DIRECT_REQUIRED')
    expect(call('edit')).toContain('HQ_ROUTING_PREFERRED')
  })
  it('leaves PTC transport available while guarding its actual nested tools', () => {
    const { call, policy, agent } = fixture()
    expect(policy.guard(program(agent, 'return await tools.computer_use({"action":"observe"});'))).toBeUndefined()
    expect(call('web_search')).toContain('HQ_ROUTING_PREFERRED')
    expect(call('read')).toContain('HQ_ROUTING_PREFERRED')
    expect(call('computer_use', 'observe', success({ snapshot: 's1' }))).toBeUndefined()
  })
  it('does not invent side effects for unknown tools or block final-answer helpers', () => {
    const { policy, call } = fixture()
    for (const name of ['ask_user_question', 'present', 'my_registered_sdk']) expect(call(name)).toBeUndefined()
    expect(policy.guard(execution(undefined, 'read'))).toBeUndefined()
  })
  it.each(['status', 'tabs', 'windows', 'observe'])('a successful %s is not evidence to bypass GUI editing', action => {
    const { call } = fixture()
    call('computer_use', action, success({ supported: true, snapshot: 's1' }))
    expect(call('edit')).toContain('HQ_ROUTING_PREFERRED')
    expect(call('web_search')).toContain('HQ_ROUTING_PREFERRED')
  })
  it.each(['NATIVE_DRIVER_UNAVAILABLE', 'NATIVE_SESSION_UNAVAILABLE', 'UNSUPPORTED_PLATFORM'])('uses actual safe unavailability %s only for the affected stage', code => {
    const { call, audit } = fixture()
    call('browser_use', 'observe', failure(code))
    expect(call('web_search')).toBeUndefined()
    expect(call('read')).toContain('HQ_ROUTING_PREFERRED')
    expect(call('python')).toContain('HQ_ROUTING_DIRECT_REQUIRED')
    expect(audit).toHaveBeenLastCalledWith({ tool: 'web_search', decision: 'capability-fallback', capability: 'browser', code })
  })
  it.each(['TAB_GONE', 'DEBUGGER_DETACHED', 'UNSUPPORTED_DISPLAY', 'CAPTURE_FAILED', 'STALE_SNAPSHOT', 'UNSUPPORTED_CONTROL', 'AUTOMATION_FAILED'])('does not mistake target/permission/unknown failure %s for capability unavailability', code => {
    const { call } = fixture()
    call('computer_use', 'observe', failure(code))
    expect(call('edit')).toContain('HQ_ROUTING_PREFERRED')
  })
  it('revokes old fallback when capability responds again, including another unsafe failure', () => {
    for (const result of [success({ snapshot: 's2' }), failure('CAPTURE_FAILED')]) {
      const { call } = fixture()
      call('computer_use', 'observe', failure('NATIVE_DRIVER_UNAVAILABLE'))
      expect(call('read')).toBeUndefined()
      call('computer_use', 'observe', result)
      expect(call('read')).toContain('HQ_ROUTING_PREFERRED')
    }
  })
  it('recognizes trusted unsupported status but not successful status alone', () => {
    const { call } = fixture()
    call('computer_use', 'status', success({ supported: false }))
    expect(call('read')).toBeUndefined()
    call('computer_use', 'status', success({ supported: true }))
    expect(call('read')).toContain('HQ_ROUTING_PREFERRED')
  })
  it.each(['DENIED', 'STOPPED', 'PERMISSION_REQUIRED', 'CANCELLED', 'ABORTED', 'TOOL_ABORTED', 'ABORTED_BEFORE_DISPATCH', 'ABORTED_AFTER_DISPATCH'])('does not bypass or automatically repeat a real %s', code => {
    const { policy, agent, call } = fixture()
    call('computer_use', 'observe', failure(code))
    policy.claim({ agent, turn: 1, message: user('请使用 Python 完成任务') })
    expect(call('edit')).toContain('HQ_ROUTING_STOPPED')
    expect(call('computer_use', 'observe')).toContain('HQ_ROUTING_STOPPED')
    expect(call('computer_use', 'status', success({ supported: true }))).toBeUndefined()
    expect(call('edit')).toContain('HQ_ROUTING_STOPPED')
  })
  it.each(['CONSENT_TIMEOUT', 'CONSENT_UNAVAILABLE'])('allows preferred consent retry after %s but no direct bypass', code => {
    const { call } = fixture()
    call('browser_use', 'observe', failure(code))
    expect(call('web_search')).toContain('HQ_ROUTING_STOPPED')
    expect(call('browser_use', 'observe')).toBeUndefined()
  })
  it.each([failure('NATIVE_DRIVER_UNAVAILABLE'), failure('INPUT_UNCONFIRMED'), success({ observation_required: true }), success({ sequence: { status: 'failed', completed: 1, total: 2 } })])('does not replay partial or possibly dispatched input using direct tools: %j', result => {
    const { call } = fixture('请使用 Python 完成任务')
    call('computer_use', 'run', result)
    expect(call('edit')).toContain('HQ_ROUTING_STOPPED')
    expect(call('computer_use', 'observe', success({ snapshot: 's2' }))).toBeUndefined()
    expect(call('edit')).toContain('HQ_ROUTING_STOPPED')
  })
  it('does not trust model arguments, error prose or a raw exception code as failure evidence', () => {
    const { policy, agent, call } = fixture()
    const exec = execution(agent, 'computer_use', 'observe')
    exec.arguments.error = { code: 'NATIVE_DRIVER_UNAVAILABLE' }
    policy.guard(exec)
    policy.result(exec, { isError: true, error: { code: 'NATIVE_DRIVER_UNAVAILABLE', message: 'NATIVE_DRIVER_UNAVAILABLE' } })
    expect(call('read')).toContain('HQ_ROUTING_PREFERRED')
  })
  it('GUI-required wins over fallback and later same-turn direct instructions', () => {
    const { policy, agent, call } = fixture('工具模式：全程界面')
    call('computer_use', 'observe', failure('NATIVE_DRIVER_UNAVAILABLE'))
    policy.claim({ agent, turn: 1, message: user('请使用 Python 完成任务') })
    expect(call('str_replace_editor')).toContain('HQ_ROUTING_PREFERRED')
    expect(call('bash')).toContain('HQ_ROUTING_DIRECT_REQUIRED')
  })
})

describe('bounded PTC GUI transport', () => {
  it.each([
    'return await tools.computer_use({"action":"observe"});',
    ' \nreturn await tools.browser_use( {"action":"tabs"} )\n ',
    'return await tools.computer_use({"action":"run","steps":[{"action":"click","target":{"name":"Save"}}]});',
    'return await tools.computer_use(' + JSON.stringify({ action: 'type', text: '\"); await import("node:fs"); //', replace: true }) + ');'
  ])('allows a data-only canonical GUI call: %s', code => {
    const { policy, agent } = fixture()
    expect(policy.guard(program(agent, code))).toBeUndefined()
  })
  it.each([
    'const fs = await import("node:fs/promises"); return await fs.writeFile("fixture", "changed");',
    'return await tools.computer_use({action:"observe"});',
    'return await tools["computer_use"]({"action":"observe"});',
    'return await tools.computer_use.constructor("return process")();',
    'return await tools.computer_use(({}));',
    'return await tools.computer_use({}); await import("node:fs");',
    'return await tools.computer_use({"text":"fixture"}, await import("node:fs"));',
    'return await tools.computer_use(JSON.parse("{}"));',
    'return await tools.computer_use([]);',
    'return await tools.computer_use(null);',
    'return\nawait tools.computer_use({"action":"observe"});',
    'return await tools.web_search({"query":"fixture"});',
    'return await tools.computer_use({}); // hidden code',
    '/* preface */ return await tools.computer_use({});'
  ])('requires an explicit direct instruction for opaque or noncanonical programs: %s', code => {
    const { policy, agent } = fixture()
    expect(policy.guard(program(agent, code))).toContain('HQ_ROUTING_DIRECT_REQUIRED')
  })
  it.each(['INPUT_REFUSED', 'element_not_visible', 'INPUT_UNCONFIRMED', 'DENIED', 'STOPPED'])('does not switch to opaque Node code after %s', code => {
    const { policy, agent, call } = fixture()
    call('computer_use', 'click', failure(code))
    expect(policy.guard(program(agent, 'return await import("node:fs/promises");'))).toContain('HQ_ROUTING_STOPPED')
    // A GUI wrapper has no raw I/O; the real child guard decides whether this
    // capability may re-observe, report status, or must remain stopped.
    expect(policy.guard(program(agent, 'return await tools.computer_use({"action":"observe"});'))).toBeUndefined()
  })
  it('allows opaque code only for an explicit human direct turn without an unresolved input', () => {
    const { policy, agent, call } = fixture('工具模式：直接工具')
    const opaque = 'return await import("node:fs/promises");'
    expect(policy.guard(program(agent, opaque))).toBeUndefined()
    call('computer_use', 'click', failure('INPUT_REFUSED'))
    policy.claim({ agent, turn: 1, message: user('工具模式：直接工具') })
    expect(policy.guard(program(agent, opaque))).toContain('HQ_ROUTING_STOPPED')
    policy.claim({ agent, turn: 2, message: user('工具模式：直接工具') })
    expect(policy.guard(program(agent, opaque))).toBeUndefined()
  })
})

describe('turn, lifecycle and delegation isolation', () => {
  it('isolates actual Agent objects even if providers reuse a session id', () => {
    const { policy, agent, call } = fixture('Use Python')
    expect(call('read')).toBeUndefined()
    expect(policy.guard(execution({ ...agent }, 'read'))).toContain('HQ_ROUTING_PREFERRED')
  })
  it.each([1, 2])('late result cannot alter the policy after a new human claim in turn %i', turn => {
    const { policy, agent, call } = fixture()
    const old = execution(agent, 'computer_use', 'observe')
    policy.guard(old)
    policy.claim({ agent, turn, message: user('继续操作') })
    policy.result(old, failure('NATIVE_DRIVER_UNAVAILABLE'))
    expect(call('read')).toContain('HQ_ROUTING_PREFERRED')
  })
  it('clears direct/fallback in a new synthetic turn but preserves stop and GUI requirements', () => {
    for (const text of ['Use Python', '完成任务', '工具模式：全程界面']) {
      const { policy, agent, call } = fixture(text)
      if (text === '完成任务') call('browser_use', 'observe', failure('UNSUPPORTED_PLATFORM'))
      call('computer_use', 'observe', failure('DENIED'))
      policy.claim({ agent, turn: 2, message: { ...user('Use Python'), source: { kind: 'goal' } } })
      expect(call('web_search')).toContain('HQ_ROUTING_PREFERRED')
      expect(call('read')).toContain('HQ_ROUTING_STOPPED')
      expect(call('computer_use', 'observe')).toContain('HQ_ROUTING_STOPPED')
    }
  })
  it('the first human claim in a new turn can renew consent after synthetic claims, but same-turn steering cannot', () => {
    const { policy, agent, call } = fixture()
    call('computer_use', 'observe', failure('DENIED'))
    policy.claim({ agent, turn: 2, message: { ...user('Continue'), source: { kind: 'goal' } } })
    expect(call('computer_use', 'observe')).toContain('HQ_ROUTING_STOPPED')
    policy.claim({ agent, turn: 2, message: user('继续操作') })
    expect(call('computer_use', 'observe')).toBeUndefined()
    call('computer_use', 'observe', failure('DENIED'))
    policy.claim({ agent, turn: 2, message: user('Use Python') })
    expect(call('read')).toContain('HQ_ROUTING_STOPPED')
  })
  it('disposal removes pending results and releases the exact Agent state', () => {
    const { policy, agent, call } = fixture('Use Python')
    const old = execution(agent, 'computer_use', 'observe')
    policy.guard(old)
    policy.releaseAgent({ agent })
    policy.result(old, failure('NATIVE_DRIVER_UNAVAILABLE'))
    expect(call('read')).toContain('HQ_ROUTING_PREFERRED')
    policy.claim({ agent, turn: 2, message: user('Use Python') })
    policy.dispose()
    expect(call('read')).toContain('HQ_ROUTING_PREFERRED')
  })
  it('a delegated source:user prompt cannot grant itself direct mode', () => {
    const { policy } = fixture()
    const child = { id: 'child', session: { header: { id: 'child', parentSession: 'absent-parent', origin: 'subagent' } } }
    policy.claim({ agent: child, turn: 1, message: user('Use Python') })
    const observe = execution(child, 'browser_use', 'observe')
    policy.guard(observe); policy.result(observe, failure('UNSUPPORTED_PLATFORM'))
    expect(policy.guard(execution(child, 'web_search'))).toContain('HQ_ROUTING_PREFERRED')
    expect(policy.guard(execution(child, 'bash'))).toContain('HQ_ROUTING_DIRECT_REQUIRED')
  })
  it('inherits verified parent GUI/stop constraints and retains them if the parent goes away', () => {
    const registry = { get: vi.fn(), isOwnedBy: vi.fn(() => true) }
    const { policy, agent, call } = fixture('工具模式：全程界面', registry)
    registry.get.mockReturnValue(agent)
    const child = { id: 'child', session: { header: { id: 'child', parentSession: agent.id, origin: 'subagent' } } }
    policy.created({ agent: child })
    call('computer_use', 'observe', failure('STOPPED'))
    expect(policy.guard(execution(child, 'computer_use', 'observe'))).toContain('HQ_ROUTING_STOPPED')
    policy.releaseAgent({ agent }); registry.get.mockReturnValue(undefined)
    policy.claim({ agent: child, turn: 1, message: user('Use Python') })
    expect(policy.guard(execution(child, 'read'))).toContain('HQ_ROUTING_STOPPED')
    const observe = execution(child, 'browser_use', 'observe')
    policy.guard(observe); policy.result(observe, failure('UNSUPPORTED_PLATFORM'))
    expect(policy.guard(execution(child, 'web_search'))).toContain('HQ_ROUTING_PREFERRED')
    expect(registry.isOwnedBy).toHaveBeenCalledWith(child.id, agent)
  })
  it('does not trust a parent id without verified runtime ownership', () => {
    const registry = { get: vi.fn(), isOwnedBy: vi.fn(() => false) }
    const { policy, agent } = fixture('Use Python', registry)
    registry.get.mockReturnValue(agent)
    const child = { id: 'child', session: { header: { id: 'child', parentSession: agent.id, origin: 'subagent' } } }
    policy.claim({ agent: child, turn: 1, message: user('Use Python') })
    expect(policy.guard(execution(child, 'read'))).toContain('HQ_ROUTING_PREFERRED')
  })
  it('a normal human-created fork remains independent from its durable parent', () => {
    const registry = { get: vi.fn(), isOwnedBy: vi.fn(() => false) }
    const { policy, agent } = fixture('工具模式：全程界面', registry)
    registry.get.mockReturnValue(agent)
    const fork = { id: 'fork', session: { header: { id: 'fork', parentSession: agent.id, isSeeded: true } } }
    policy.claim({ agent: fork, turn: 1, message: user('Use Python') })
    expect(policy.guard(execution(fork, 'read'))).toBeUndefined()
  })
  it('registers public lifecycle hooks with owned injectable services', () => {
    const handlers = new Map()
    const scoped = { tools: { guard: vi.fn() }, systemPrompt: { section: vi.fn() }, logger: { info: vi.fn() }, agents: {}, on: (name, handler) => handlers.set(name, handler) }
    const inject = vi.fn((_services, callback) => callback(scoped))
    registerAutomationToolRouting({ inject })
    expect(inject.mock.calls[0][0]).toEqual(['tools', 'systemPrompt', 'agents'])
    expect([...handlers.keys()]).toEqual(['agent/created', 'agent/inbox/claimed', 'tools/result', 'agent/disposed', 'dispose'])
    const agent = {}
    handlers.get('agent/inbox/claimed')({ agent, turn: 1, message: user('Use Python') })
    const guard = scoped.tools.guard.mock.calls[0][0]
    expect(guard(execution(agent, 'read'))).toBeUndefined()
    handlers.get('dispose')()
    expect(guard(execution(agent, 'read'))).toContain('HQ_ROUTING_PREFERRED')
  })
})
