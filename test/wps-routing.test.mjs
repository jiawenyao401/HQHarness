import { describe, expect, it, vi } from 'vitest'
import { createAutomationRoutingPolicy } from '../packages/hqharness-automation/tool-routing.js'
import { markTrustedWpsDefinition, WPS_ROUTING_TOOL_NAME } from '../packages/hqharness-automation/wps-routing.js'
import { WPS_TOOL_NAME } from '../packages/hqharness-wps/protocol.js'

function fixture(message = '修改本地文档') {
  const definition = { name: WPS_TOOL_NAME }
  let visible = definition
  const release = markTrustedWpsDefinition(definition)
  const tools = { get: vi.fn(() => visible) }
  const policy = createAutomationRoutingPolicy(() => {}, undefined, tools)
  const agent = { id: 'session', session: { header: { id: 'session' } } }
  policy.claim({ agent, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: message }] }, turn: 1 })
  const exec = (name, action) => ({ agent, name, token: Symbol(), arguments: { action } })
  const call = (name, action, result) => {
    const execution = exec(name, action)
    const denial = policy.guard(execution)
    if (!denial && result) policy.result(execution, result)
    return denial
  }
  const wps = (action, result) => call(WPS_TOOL_NAME, action, result)
  const ptc = code => policy.guard({ ...exec('run_code'), arguments: { code } })
  return { policy, agent, release, tools, wps, call, ptc, shadow: () => { visible = { ...definition } } }
}
const failure = code => ({ isError: true, error: { info: { code } } })
const success = value => ({ isError: false, value })

describe('trusted WPS routing exception', () => {
  it('admits the actual definition and a single JSON PTC call', () => {
    expect(WPS_ROUTING_TOOL_NAME).toBe(WPS_TOOL_NAME)
    const f = fixture()
    expect(f.wps('inspect')).toBeUndefined()
    expect(f.tools.get).toHaveBeenLastCalledWith(WPS_TOOL_NAME, f.agent)
    expect(f.ptc('return await tools.' + WPS_TOOL_NAME + '({"action":"status"});')).toBeUndefined()
    expect(f.call('read')).toContain('HQ_ROUTING_PREFERRED')
    f.release()
    expect(f.wps('status')).toContain('HQ_ROUTING_UNTRUSTED')
  })
  it('does not trust same-name scope shadowing or a namespace prefix', () => {
    const f = fixture()
    f.shadow()
    expect(f.wps('inspect')).toContain('HQ_ROUTING_UNTRUSTED')
    for (const code of [
      'return await tools.' + WPS_TOOL_NAME + '({"action":"status"});',
      'return await tools.mcp__huaqing_wps__fake({"action":"status"});',
      'return await tools.' + WPS_TOOL_NAME + '({action:"status"});',
      'return await tools.' + WPS_TOOL_NAME + '({"action":"status"}); await import("node:fs");',
      'return await tools["' + WPS_TOOL_NAME + '"]({"action":"status"});'
    ]) expect(f.ptc(code)).toContain('HQ_ROUTING_DIRECT_REQUIRED')
    f.release()
  })
  it('preserves explicit GUI-only mode for direct and PTC WPS calls', () => {
    const f = fixture('工具模式：全程界面')
    expect(f.wps('status')).toContain('HQ_ROUTING_PREFERRED')
    expect(f.ptc('return await tools.' + WPS_TOOL_NAME + '({"action":"status"});')).toContain('HQ_ROUTING_PREFERRED')
    f.release()
  })
  it.each(['DENIED', 'STOPPED', 'INPUT_UNCONFIRMED'])('does not bypass GUI %s through WPS', code => {
    const f = fixture()
    f.call('computer_use', 'click', failure(code))
    expect(f.wps('sheet_write')).toContain('HQ_ROUTING_STOPPED')
    expect(f.wps('recover')).toContain('HQ_ROUTING_STOPPED')
    f.release()
  })
  it.each(['WPS_DENIED', 'WPS_STOPPED', 'WPS_READ_ONLY', 'WPS_CONSENT_UNAVAILABLE', 'WPS_UNSUPPORTED_PATH'])('does not bypass or recover %s automatically', code => {
    const f = fixture()
    f.wps('inspect', failure(code))
    expect(f.wps('recover')).toContain('HQ_ROUTING_STOPPED')
    expect(f.wps('inspect')).toContain('HQ_ROUTING_STOPPED')
    expect(f.wps('status')).toBeUndefined()
    expect(f.call('computer_use', 'click')).toContain('HQ_ROUTING_STOPPED')
    expect(f.call('edit')).toContain('HQ_ROUTING_STOPPED')
    expect(f.call('python')).toContain('HQ_ROUTING_STOPPED')
    f.release()
  })
  it('retains unknown outcome until an explicitly confirmed successful recover', () => {
    const f = fixture()
    f.wps('sheet_write', failure('WPS_UNKNOWN_OUTCOME'))
    expect(f.wps('inspect', success({ snapshot: 'fresh' }))).toBeUndefined()
    expect(f.wps('save')).toContain('HQ_ROUTING_STOPPED')
    expect(f.wps('documents')).toContain('HQ_ROUTING_STOPPED')
    expect(f.call('computer_use', 'observe')).toContain('HQ_ROUTING_STOPPED')
    expect(f.call('bash')).toContain('HQ_ROUTING_STOPPED')
    expect(f.wps('recover', failure('WPS_NOT_CONNECTED'))).toBeUndefined()
    expect(f.wps('save')).toContain('HQ_ROUTING_STOPPED')
    expect(f.wps('recover', success({ snapshot: 'unconfirmed' }))).toBeUndefined()
    expect(f.wps('save')).toContain('HQ_ROUTING_STOPPED')
    f.policy.claim({ agent: f.agent, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '工具模式：直接工具' }] }, turn: 2 })
    expect(f.call('python')).toContain('HQ_ROUTING_STOPPED')
    expect(f.wps('recover', success({ structuredContent: { snapshot: 'confirmed', recovered: true } }))).toBeUndefined()
    expect(f.wps('save')).toBeUndefined()
    f.release()
  })
  it.each(['WPS_NOT_CONNECTED', 'WPS_UNSUPPORTED', 'WPS_STALE_SNAPSHOT', 'WPS_STALE_DOCUMENT', 'WPS_BUSY', 'WPS_FILE_CHANGED', 'WPS_TIMEOUT', 'WPS_READ_TIMEOUT'])('does not freeze writes known not to execute: %s', code => {
    const f = fixture()
    f.wps('sheet_write', failure(code))
    expect(f.wps('inspect')).toBeUndefined()
    expect(f.call('computer_use', 'observe')).toBeUndefined()
    f.release()
  })
  it.each(['WPS_TIMEOUT', 'WPS_READ_TIMEOUT'])('does not clear an older unknown write when a read reports %s', code => {
    const f = fixture()
    f.wps('sheet_write', failure('WPS_UNKNOWN_OUTCOME'))
    expect(f.wps('inspect', failure(code))).toBeUndefined()
    expect(f.wps('sheet_write')).toContain('HQ_ROUTING_STOPPED')
    expect(f.call('computer_use', 'click')).toContain('HQ_ROUTING_STOPPED')
    f.release()
  })
})
