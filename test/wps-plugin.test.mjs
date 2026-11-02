import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWpsPlugin } from '../packages/hqharness-wps/index.js'
import { WPS_INPUT_SCHEMA, WPS_RAW_TOOL_NAME, WPS_TOOL_NAME } from '../packages/hqharness-wps/protocol.js'
import { isTrustedWpsExecution } from '../packages/hqharness-automation/wps-routing.js'

const result = { content: [{ type: 'text', text: '{"connected":true}' }], structuredContent: { connected: true } }
const exec = (signal = new AbortController().signal) => ({ agent: { session: { header: { id: 'session-owner' } } }, signal })
function fixture(options = {}) {
  const disposers = []
  let definition
  let policy = { mode: 'workspace-write', workspaceRoot: '/workspace' }
  const client = {
    connect: vi.fn(async () => {}),
    listTools: vi.fn(async () => ({ tools: [{ name: WPS_RAW_TOOL_NAME, inputSchema: WPS_INPUT_SCHEMA }] })),
    callTool: vi.fn(async () => result), close: vi.fn(async () => {}), ...options.client
  }
  const factory = vi.fn(() => ({ client, transport: {} }))
  const ctx = {
    tools: { register: value => { definition = value }, get: name => name === definition?.name ? definition : undefined },
    sandboxPolicy: { resolve: vi.fn(() => policy) },
    systemPrompt: { section: vi.fn() }, logger: { warn: vi.fn() },
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) }
  }
  createWpsPlugin(options.defaultConnection ? undefined : factory).apply(ctx)
  const dispose = async () => { for (const callback of disposers.reverse()) await callback() }
  return { ctx, client, factory, definition, dispose, setPolicy: value => { policy = value } }
}
afterEach(() => { vi.unstubAllEnvs() })

describe('installation-owned WPS MCP plugin', () => {
  it('starts without networking, validates the exact schema, and sends session policy only as protocol metadata', async () => {
    const f = fixture()
    try {
      expect(f.factory).not.toHaveBeenCalled()
      expect(isTrustedWpsExecution(f.ctx.tools, { name: WPS_TOOL_NAME })).toBe(true)
      const value = await f.definition.execute({ action: 'status' }, exec())
      expect(value.structuredContent).toEqual({ connected: true })
      expect(f.factory).toHaveBeenCalledTimes(1)
      expect(f.client.listTools).toHaveBeenCalledTimes(1)
      expect(f.client.callTool.mock.calls[0][0]).toEqual({ name: WPS_RAW_TOOL_NAME, arguments: { action: 'status' }, _meta: { huaqing: { owner: 'session-owner', policy: { mode: 'workspace-write', workspaceRoot: '/workspace' } } } })
      f.setPolicy({ mode: 'read-only', workspaceRoot: '/new-workspace' })
      await f.definition.execute({ action: 'inspect', key: 'opaque-document' }, exec())
      expect(f.client.callTool.mock.calls[1][0]._meta.huaqing.policy).toEqual({ mode: 'read-only', workspaceRoot: '/new-workspace' })
      expect(f.client.callTool.mock.calls[1][1]).toMatchObject({ timeout: 175_000, toolDefinition: { name: WPS_RAW_TOOL_NAME } })
      expect(f.definition.timeoutMs).toBe(210_000)
      expect(f.factory).toHaveBeenCalledTimes(1)
    } finally { await f.dispose() }
    expect(isTrustedWpsExecution(f.ctx.tools, { name: WPS_TOOL_NAME })).toBe(false)
    expect(f.client.close).toHaveBeenCalled()
  })
  it('does not publish credentials, endpoint, scripts or unowned operations as model arguments', async () => {
    const f = fixture()
    try {
      for (const args of [{ action: 'status', token: 'model-token' }, { action: 'run_code', code: 'x' }, { action: 'save', key: 'k' },
        { action: 'sheet_write', key: 'k', snapshot: 's', sheet: 'S', range: 'A1', formulas: [['=WEBSERVICE("https://example.test")']] }]) {
        await expect(f.definition.execute(args, exec())).rejects.toMatchObject({ code: 'WPS_INVALID_INPUT' })
      }
      await expect(f.definition.execute({ action: 'status' }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'WPS_POLICY_REQUIRED' })
      f.setPolicy({ mode: 'unsafe', workspaceRoot: '/' })
      await expect(f.definition.execute({ action: 'status' }, exec())).rejects.toMatchObject({ code: 'WPS_POLICY_REQUIRED' })
      expect(f.factory).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('uses the owning session when a legacy caller omits the optional cancellation signal', async () => {
    const f = fixture()
    try {
      const invocation = exec()
      delete invocation.signal
      await expect(f.definition.execute({ action: 'status' }, invocation)).resolves.toMatchObject({ structuredContent: { connected: true } })
    } finally { await f.dispose() }
  })
  it('coalesces initialization and does not dispatch through a partially connected client', async () => {
    let connected
    const barrier = new Promise(resolve => { connected = resolve })
    const f = fixture({ client: { connect: vi.fn(() => barrier) } })
    try {
      const first = f.definition.execute({ action: 'status' }, exec())
      const second = f.definition.execute({ action: 'status' }, exec())
      expect(f.client.connect).toHaveBeenCalledTimes(1)
      expect(f.client.callTool).not.toHaveBeenCalled()
      connected()
      await Promise.all([first, second])
      expect(f.client.listTools).toHaveBeenCalledTimes(1)
      expect(f.client.callTool).toHaveBeenCalledTimes(2)
    } finally { await f.dispose() }
  })
  it.each([
    [], [{ name: 'other', inputSchema: WPS_INPUT_SCHEMA }],
    [{ name: WPS_RAW_TOOL_NAME, inputSchema: { type: 'object' } }],
    [{ name: WPS_RAW_TOOL_NAME, inputSchema: WPS_INPUT_SCHEMA }, { name: 'run_code', inputSchema: { type: 'object' } }]
  ])('fails closed on incompatible server tools without dispatch: %j', async tools => {
    const f = fixture({ client: { listTools: vi.fn(async () => ({ tools })) } })
    try {
      await expect(f.definition.execute({ action: 'status' }, exec())).rejects.toMatchObject({ code: 'WPS_PROTOCOL_MISMATCH' })
      expect(f.client.callTool).not.toHaveBeenCalled()
      expect(f.client.close).toHaveBeenCalledTimes(1)
    } finally { await f.dispose() }
  })
  it.each(['WPS_STOPPED', 'WPS_DENIED', 'WPS_UNKNOWN_OUTCOME', 'WPS_STALE_SNAPSHOT'])('preserves Main failure code %s through the MCP result adapter', async code => {
    const f = fixture({ client: { callTool: vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message: 'Operation did not complete.', outcome: 'unknown' }) }] })) } })
    try { await expect(f.definition.execute({ action: 'save', key: 'k', snapshot: 's' }, exec())).rejects.toMatchObject({ code }) }
    finally { await f.dispose() }
  })
  it('never retries a write after transport failure and reports unknown completion', async () => {
    const f = fixture({ client: { callTool: vi.fn(async () => { throw new Error('socket gone') }) } })
    try {
      await expect(f.definition.execute({ action: 'writer_replace', key: 'k', snapshot: 's', oldText: 'old', replaceText: 'new' }, exec())).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
      expect(f.client.callTool).toHaveBeenCalledTimes(1)
    } finally { await f.dispose() }
  })
  it('cancels an in-flight mutation on plugin disposal, closes the client and revokes trust', async () => {
    let dispatched
    const started = new Promise(resolve => { dispatched = resolve })
    const f = fixture({ client: { callTool: vi.fn(async (_params, options) => {
      dispatched()
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }) } })
    const pending = f.definition.execute({ action: 'save', key: 'k', snapshot: 's' }, exec())
    const assertion = expect(pending).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    await started
    await f.dispose()
    await assertion
    expect(f.client.close).toHaveBeenCalledTimes(1)
    expect(isTrustedWpsExecution(f.ctx.tools, { name: WPS_TOOL_NAME })).toBe(false)
  })
  it('reconnects only on a later call after a closed connection', async () => {
    const f = fixture()
    try {
      await f.definition.execute({ action: 'status' }, exec())
      f.client.onclose()
      await f.definition.execute({ action: 'status' }, exec())
      expect(f.factory).toHaveBeenCalledTimes(2)
      expect(f.client.callTool).toHaveBeenCalledTimes(2)
    } finally { await f.dispose() }
  })
  it('rejects an absent or remote endpoint before creating a network client', async () => {
    for (const endpoint of ['', 'http://remote.example/mcp', 'http://127.0.0.1:0/mcp', 'http://127.0.0.1:8000/mcp?token=model']) {
      vi.stubEnv('HQHARNESS_WPS_URL', endpoint)
      vi.stubEnv('HQHARNESS_WPS_TOKEN', 'a'.repeat(64))
      const f = fixture({ defaultConnection: true })
      try { await expect(f.definition.execute({ action: 'status' }, exec())).rejects.toMatchObject({ code: 'WPS_NOT_CONNECTED' }) }
      finally { await f.dispose() }
    }
  })
})
