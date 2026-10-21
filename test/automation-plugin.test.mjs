import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { callDesktop, createAutomationPlugin, apply } from '../packages/hqharness-automation/index.js'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function context() {
  const tools = []
  return { tools, ctx: { tools: { register: tool => tools.push(tool) }, attachments: { saveImage: async () => ({ attachmentId: 'image-test', mediaType: 'image/png', width: 500, height: 300, bytes: 10 }) }, systemPrompt: { section: vi.fn() }, on: vi.fn() } }
}
const ownedExecution = () => ({ agent: { session: { header: { id: 'owner' } } }, signal: new AbortController().signal })
function bridgeFixture() {
  vi.stubEnv('HQHARNESS_AUTOMATION_URL', 'http://127.0.0.1:12345/operation')
  vi.stubEnv('HQHARNESS_AUTOMATION_TOKEN', 'a'.repeat(64))
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ accepted: true }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
describe('automation bridge request budget', () => {
  it.each(['foreground_unavailable', 'session_ended'])('preserves the native SDK failure identity %s', async code => {
    const fetch = bridgeFixture()
    fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code, error: 'Native operation failed' }) })
    await expect(callDesktop('computer', 'owner', { action: 'observe' })).rejects.toMatchObject({ code, message: 'Native operation failed' })
  })
  it('keeps failure codes and only bounded numeric phase timings from the bridge', async () => {
    const fetch = bridgeFixture()
    fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'NATIVE_INPUT_REFUSED', error: 'Native input was refused', host_timing: { queue_and_consent_ms: 0, execute_ms: 50, total_ms: 50, token: 'private-bridge-data' }, token: 'private-bridge-data' }) })
    const result = callDesktop('computer', 'owner', { action: 'observe' })
    await expect(result).rejects.toBeInstanceOf(HarnessError)
    await expect(result).rejects.toMatchObject({ code: 'NATIVE_INPUT_REFUSED', message: 'Native input was refused [host_timing={"queue_and_consent_ms":0,"execute_ms":50,"total_ms":50}]' })
  })
  it.each([-1, 180_001, 0.5, '50'])('omits invalid failure timing instead of serializing untrusted response fields: %j', async executeMs => {
    const fetch = bridgeFixture()
    fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'DENIED', error: 'Access was declined', host_timing: { queue_and_consent_ms: 0, execute_ms: executeMs, total_ms: 50, secret: 'private-bridge-data' } }) })
    await expect(callDesktop('computer', 'owner', { action: 'observe' })).rejects.toMatchObject({ code: 'DENIED', message: 'Access was declined' })
  })
  it('uses a fixed failure identity when the bridge code or error message has an invalid shape', async () => {
    const fetch = bridgeFixture()
    fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'invalid bridge data', error: { token: 'private-bridge-data' }, host_timing: [] }) })
    await expect(callDesktop('computer', 'owner', { action: 'observe' })).rejects.toMatchObject({ code: 'AUTOMATION_FAILED', message: 'Desktop automation failed' })
  })
  it('sends one serialized UTF-8 body for an eight-step Chinese text plan below 64 KiB', async () => {
    const fetch = bridgeFixture()
    const operation = { action: 'run', snapshot: 's1', tab: 't1', steps: Array.from({ length: 8 }, () => ({ action: 'type', target: { name: 'Editor' }, text: '中'.repeat(2000), replace: true })) }
    await expect(callDesktop('browser', 'owner', operation)).resolves.toEqual({ accepted: true })
    const body = fetch.mock.calls[0][1].body
    expect(JSON.parse(body)).toEqual({ capability: 'browser', owner: 'owner', operation })
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(65_536)
  })
  it('accepts the exact 64 KiB transport boundary', async () => {
    const fetch = bridgeFixture()
    const operation = { action: 'type', text: '' }
    const base = JSON.stringify({ capability: 'browser', owner: 'owner', operation })
    // Exercise the transport byte boundary independently of host field limits.
    operation.text = 'x'.repeat(65_536 - Buffer.byteLength(base, 'utf8'))
    await callDesktop('browser', 'owner', operation)
    expect(Buffer.byteLength(fetch.mock.calls[0][1].body, 'utf8')).toBe(65_536)
  })
  it('rejects a body over the UTF-8 limit before fetch even when its character count fits', async () => {
    const fetch = bridgeFixture()
    const operation = { action: 'type', text: '中'.repeat(22_000) }
    expect(JSON.stringify(operation).length).toBeLessThan(65_536)
    await expect(callDesktop('computer', 'owner', operation)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('64 KiB') })
    expect(fetch).not.toHaveBeenCalled()
  })
})
describe('built-in automation tool composition', () => {
  it.each(['browser', 'computer'])('executes %s with the actual Agent session identity shape', async capability => {
    const { ctx, tools } = context()
    const request = vi.fn(async () => ({ available: true }))
    createAutomationPlugin(capability, request).apply(ctx)
    const agent = { id: 'session-runtime', session: { header: { id: 'session-runtime' } } }
    await expect(tools[0].execute({ action: 'status' }, { agent })).resolves.toEqual({ available: true })
    expect(request).toHaveBeenCalledWith(capability, 'session-runtime', { action: 'status' }, undefined)
  })
  it('composes two actual Cordis plugins and two distinct tools', () => {
    const plugins = []; apply({ plugin: value => plugins.push(value), inject() {} })
    expect(plugins.map(value => value.name)).toEqual(['browser-use', 'computer-use'])
    const { ctx, tools } = context()
    for (const plugin of plugins) plugin.apply(ctx)
    expect(tools.map(value => value.name)).toEqual(['browser_use', 'computer_use'])
  })
  it('returns durable images and maps normalized screenshot input to source coordinates', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async (_cap, _owner, args) => args.action === 'observe' ? { snapshot: 's1', display: 'd1', coordinates: { width: 2000, height: 1200 }, image: { png: 'AA==', width: 2000, height: 1200 } } : { performed: 'click' })
    createAutomationPlugin('computer', request).apply(ctx)
    const exec = { agent: { id: 'owner', session: { header: { id: 'owner' } } }, signal: new AbortController().signal }
    const image = await tools[0].execute({ action: 'observe' }, exec)
    expect(image.coordinate_width).toBe(500)
    expect(image).not.toHaveProperty('coordinates')
    const blocks = tools[0].output.render({}, image)
    expect(blocks[1]).toEqual({ type: 'image', attachment: image.image })
    expect(blocks[0].text).not.toContain('AA==')
    await tools[0].execute({ action: 'click', display: 'd1', snapshot: 's1', x: 250, y: 150 }, exec)
    expect(request.mock.calls[1][2]).toMatchObject({ x: 1000, y: 600 })
    expect(request.mock.calls[1][1]).toBe('owner')
    await expect(tools[0].execute({ action: 'click', display: 'd1', snapshot: 'old', x: 250, y: 150 }, exec)).rejects.toThrow('mapping is stale')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('requires actual Agent ownership and propagates errors/cancellation', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async () => { throw new Error('permission denied') })
    createAutomationPlugin('browser', request).apply(ctx)
    await expect(tools[0].execute({ action: 'tabs' }, { signal: new AbortController().signal })).rejects.toThrow('owning Agent')
    await expect(tools[0].execute({ action: 'open', url: 'https://example.com' }, { agent: { id: 'a', session: { header: { id: 'a' } } } })).rejects.toThrow('permission denied')
  })
  it('requests browser structure without screenshots by default and preserves an explicit image request', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async () => ({ snapshot: 's1', tab: 't1', nodes: [] }))
    createAutomationPlugin('browser', request).apply(ctx)
    const exec = ownedExecution()
    await tools[0].execute({ action: 'open', url: 'https://example.com' }, exec)
    expect(request.mock.calls[0][2]).toEqual({ action: 'open', url: 'https://example.com', screenshot: false })
    await tools[0].execute({ action: 'observe', tab: 't1', screenshot: true }, exec)
    expect(request.mock.calls[1][2].screenshot).toBe(true)
  })
  it.each(['browser', 'computer'])('retains text-only %s snapshots and refreshes them after local sequences', async capability => {
    const { ctx, tools } = context()
    const scope = capability === 'browser' ? { tab: 't1' } : { pid: 123, window: '456' }
    const request = vi.fn(async (_cap, _owner, args) => args.action === 'observe'
      ? { snapshot: 's1', ...scope, elements: [{ ref: 'e1', name: 'Search', role: 'textbox' }] }
      : { snapshot: 's2', ...scope, elements: [], sequence: { status: 'completed', completed: 2, total: 2, elapsed_ms: 50 } })
    createAutomationPlugin(capability, request).apply(ctx)
    const exec = ownedExecution()
    const first = await tools[0].execute({ action: 'observe', ...scope }, exec)
    expect(first).not.toHaveProperty('image')
    expect(first).not.toHaveProperty('coordinate_width')
    const steps = [{ action: 'type', target: { name: 'Search', role: 'textbox' }, text: '中文', replace: true }, { action: 'wait', target: { name: 'Ready' }, value: 'Ready' }]
    const result = await tools[0].execute({ action: 'run', ...scope, snapshot: first.snapshot, steps }, exec)
    expect(result.sequence.status).toBe('completed')
    expect(request.mock.calls[1][2]).toMatchObject({ snapshot: 's1', steps })
    await tools[0].execute({ action: 'click', ...scope, snapshot: result.snapshot, target: { name: 'Finish' } }, exec)
    expect(request.mock.calls[2][2]).toMatchObject({ snapshot: 's2', target: { name: 'Finish' } })
    await expect(tools[0].execute({ action: 'run', snapshot: 's1', steps }, exec)).rejects.toThrow('mapping is stale')
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
  it('advertises window discovery as a read operation and strict local step parameters', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async () => ({ windows: [{ pid: 123, window: '456', title: 'Editor' }] }))
    createAutomationPlugin('computer', request).apply(ctx)
    await expect(tools[0].execute({ action: 'windows' }, ownedExecution())).resolves.toHaveProperty('windows')
    expect(tools[0].presentCall({ action: 'windows' }).kind).toBe('read')
    const schema = tools[0].parameters.properties
    expect(schema.steps.items.additionalProperties).toBe(false)
    expect(schema.steps.items.properties).not.toHaveProperty('ref')
    expect(schema.steps.items.properties).not.toHaveProperty('x')
    expect(schema.steps.items.properties.target.properties.name.type).toBe('string')
    expect(schema.pid.type).toBe('integer')
  })
  it.each([
    { sequence: { status: 'failed', completed: 1, total: 2, elapsed_ms: 30 }, snapshot: 's2', elements: [] },
    { observation_required: true },
    new Error('Native operation interrupted')
  ])('consumes a sequence snapshot on partial failure or interrupted observation: %j', async outcome => {
    const { ctx, tools } = context()
    const request = vi.fn(async (_cap, _owner, args) => {
      if (args.action === 'observe') return { snapshot: 's1', elements: [] }
      if (outcome instanceof Error) throw outcome
      return outcome
    })
    createAutomationPlugin('computer', request).apply(ctx)
    const exec = ownedExecution()
    await tools[0].execute({ action: 'observe' }, exec)
    const args = { action: 'run', snapshot: 's1', steps: [{ action: 'click', target: { name: 'Next' } }] }
    if (outcome instanceof Error) await expect(tools[0].execute(args, exec)).rejects.toThrow(outcome.message)
    else expect(await tools[0].execute(args, exec)).toEqual(outcome)
    await expect(tools[0].execute({ action: 'click', snapshot: outcome.snapshot ?? 's1', target: { name: 'Next' } }, exec)).rejects.toThrow('mapping is stale')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('refuses a local sequence without a current observation before bridge access', async () => {
    const { ctx, tools } = context()
    const request = vi.fn()
    createAutomationPlugin('computer', request).apply(ctx)
    await expect(tools[0].execute({ action: 'run', steps: [{ action: 'click', target: { name: 'Next' } }] }, ownedExecution())).rejects.toThrow('mapping is stale')
    expect(request).not.toHaveBeenCalled()
  })
  it('requires a screenshot mapping for coordinate input after a semantic-only observation', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async () => ({ snapshot: 's1', elements: [] }))
    createAutomationPlugin('computer', request).apply(ctx)
    const exec = ownedExecution()
    await tools[0].execute({ action: 'observe' }, exec)
    await expect(tools[0].execute({ action: 'click', snapshot: 's1', x: 10, y: 20 }, exec)).rejects.toThrow('screenshot')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not authorize or publish browser coordinates when only a structural observation was returned', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async () => ({ tab: 't1', snapshot: 's1', coordinates: { width: 1100, height: 760 }, nodes: [{ ref: 'e1', name: 'Next', role: 'button' }] }))
    createAutomationPlugin('browser', request).apply(ctx)
    const exec = ownedExecution()
    const observed = await tools[0].execute({ action: 'open', url: 'https://example.com' }, exec)
    expect(observed).not.toHaveProperty('coordinates')
    expect(observed).not.toHaveProperty('coordinate_width')
    expect(observed).not.toHaveProperty('coordinate_height')
    await expect(tools[0].execute({ action: 'click', tab: 't1', snapshot: 's1', x: 10, y: 20 }, exec)).rejects.toThrow('screenshot')
    expect(request).toHaveBeenCalledTimes(1)
    await tools[0].execute({ action: 'click', tab: 't1', snapshot: 's1', ref: 'e1' }, exec)
    expect(request.mock.calls[1][2]).toMatchObject({ ref: 'e1' })
  })
  it.each([
    { action: 'click', target: { name: 'Next' }, ref: 'e1' },
    { action: 'click', target: { name: 'Next' }, x: 10, y: 20 },
    { action: 'wait', target: { name: 'Ready' }, value: false },
    { action: 'click', target: { name: 'Next', script: 'unsafe()' } }
  ])('refuses unsupported local step data before bridge execution: %j', async step => {
    const { ctx, tools } = context()
    const request = vi.fn()
    createAutomationPlugin('computer', request).apply(ctx)
    await expect(tools[0].execute({ action: 'run', snapshot: 's1', steps: [step] }, ownedExecution())).rejects.toThrow('invalid arguments')
    expect(request).not.toHaveBeenCalled()
  })
  it('refreshes semantic references after a single input without requiring another explicit observe', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async (_cap, _owner, args) => args.action === 'observe'
      ? { snapshot: 's1', elements: [{ ref: 'e1', name: 'Next' }] }
      : { snapshot: `s${request.mock.calls.length}`, elements: [{ ref: 'e2', name: 'Finish' }] })
    createAutomationPlugin('computer', request).apply(ctx)
    const exec = ownedExecution()
    await tools[0].execute({ action: 'observe', pid: 123, window: '456' }, exec)
    const updated = await tools[0].execute({ action: 'click', pid: 123, window: '456', snapshot: 's1', ref: 'e1' }, exec)
    expect(updated.snapshot).toBe('s2')
    await tools[0].execute({ action: 'click', pid: 123, window: '456', snapshot: updated.snapshot, ref: 'e2' }, exec)
    expect(request.mock.calls.map(call => call[2].action)).toEqual(['observe', 'click', 'click'])
  })
  it.each([{ id: 'agent-only' }, { sessionId: 'synthetic' }, { session: { header: { id: 42 } } }, { session: { header: { id: '' } } }])('refuses invalid session ownership before bridge access: %j', async agent => {
    const { ctx, tools } = context()
    const request = vi.fn()
    createAutomationPlugin('browser', request).apply(ctx)
    await expect(tools[0].execute({ action: 'status' }, { agent })).rejects.toThrow('owning Agent session')
    expect(request).not.toHaveBeenCalled()
  })
})
