import { EventEmitter } from 'node:events'
import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { ModelAccessManager } from '../src/main/enterprise/model-access-manager'
import type { ModelLease } from '../src/shared/model-access'

const fakes = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>() }))
vi.mock('electron', () => ({
  ipcMain: { removeHandler: (name: string) => fakes.handlers.delete(name), handle: (name: string, callback: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) => fakes.handlers.set(name, callback) },
  powerMonitor: new EventEmitter(), safeStorage: {}
}))
import { DesktopModelAccessService } from '../src/main/enterprise/model-access-service'

const services: DesktopModelAccessService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())) })
async function endpoint(fetcher: typeof fetch = async () => Response.json({ choices: [{ message: { content: 'hello' } }] })) {
  const now = Date.now()
  const lease: ModelLease = { id: 'test-lease-0001', status: 'active', issued_at: new Date(now).toISOString(), initial_expires_at: new Date(now + 10800000).toISOString(), expires_at: new Date(now + 10800000).toISOString(), auto_renewed: false, server_time: new Date(now).toISOString(), test_environment: true, inference_path: '/desktop/model-access/v1', model: { id: 'leased-model', display_name: 'DeepSeek-V41-Flash', context_window: 65536, max_output_tokens: 4096, input_modalities: ['text'], tool_calls_verified: true } }
  const status = { configured: true, server: 'https://agentos.test', insecureTest: false, signedIn: true, usable: true, busy: false, remainingMs: 10800000, pendingRevocation: false, lease }
  const manager = {
    initialize: vi.fn(async () => undefined), status: vi.fn(async () => status), refresh: vi.fn(async () => status),
    configure: vi.fn(async () => status), login: vi.fn(async () => status), claim: vi.fn(async () => status), logout: vi.fn(async () => status),
    managedModel: vi.fn(async () => lease), beginRequest: vi.fn(async () => ({ lease, virtualKey: 'sk-private-virtual-key', baseUrl: 'https://agentos.test/desktop/model-access/v1', remainingMs: 10800000 })),
    finishRequest: vi.fn(), invalidate: vi.fn(), tick: vi.fn(async () => undefined)
  } satisfies Pick<ModelAccessManager, 'initialize' | 'refresh' | 'status' | 'configure' | 'login' | 'claim' | 'logout' | 'managedModel' | 'beginRequest' | 'finishRequest' | 'invalidate' | 'tick'>
  const service = new DesktopModelAccessService('/unused-test-profile', { manager, fetcher })
  services.push(service)
  await service.start()
  const env = service.environment()
  const url = env.HQHARNESS_MODEL_BRIDGE_URL
  if (!url) throw new Error('Missing model bridge')
  const headers = { Authorization: `Bearer ${env.HQHARNESS_MODEL_BRIDGE_TOKEN}`, 'Content-Type': 'application/json' }
  const post = (body: string, extra: Record<string, string> = {}) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { ...headers, ...extra }, body })
  return { service, manager, url, headers, post }
}

describe('team model main-process transport', () => {
  it('rejects browser origins, alternate hosts and stale capabilities before accessing credentials', async () => {
    const { service, url, headers, manager } = await endpoint()
    const refused: Record<string, string>[] = [{ Origin: 'https://hostile.test' }, { Origin: '' }, { Authorization: 'Bearer wrong' }]
    for (const extra of refused) {
      expect((await fetch(`${url}/managed-model`, { headers: { ...headers, ...extra } })).status).toBe(403)
    }
    const alternateHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${url}/managed-model`, { headers: { ...headers, Host: 'localhost' } }, response => { response.resume(); resolve(response.statusCode) })
      req.on('error', reject).end()
    })
    expect(alternateHost).toBe(403)
    expect(manager.managedModel).not.toHaveBeenCalled()
    service.environment()
    expect((await fetch(`${url}/managed-model`, { headers })).status).toBe(403)
  })
  it('gives Harness only the local capability and leased model metadata', async () => {
    const { url, headers } = await endpoint()
    const response = await fetch(`${url}/managed-model`, { headers })
    const value = await response.json()
    expect(value.lease.model.id).toBe('leased-model')
    expect(value.baseURL).toBe(`${url}/v1`)
    expect(value.apiKey).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(value)).not.toContain('sk-private-virtual-key')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  it('validates JSON and leased model before forwarding and uses only the real virtual key upstream', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'hello' } }] }))
    const { manager, post } = await endpoint(fetcher)
    expect((await post('{broken')).status).toBe(400)
    expect(manager.beginRequest).not.toHaveBeenCalled()
    expect((await post(JSON.stringify({ model: 'forbidden', messages: [] }))).status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
    const payload = { model: 'leased-model', messages: [{ role: 'user', content: 'hello' }], stream: false }
    const response = await post(JSON.stringify(payload))
    expect(response.status).toBe(200)
    expect((await response.json()).choices[0].message.content).toBe('hello')
    const call = fetcher.mock.calls[0]
    expect(call?.[0]).toBe('https://agentos.test/desktop/model-access/v1/chat/completions')
    expect(new Headers(call?.[1]?.headers).get('authorization')).toBe('Bearer sk-private-virtual-key')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(payload)
    expect(manager.finishRequest).toHaveBeenCalledTimes(2)
  })
  it('preserves rate limiting while redacting upstream error bodies', async () => {
    const { post } = await endpoint(async () => new Response('secret-upstream-token', { status: 429, headers: { 'Retry-After': '30' } }))
    const response = await post(JSON.stringify({ model: 'leased-model', messages: [] }))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(await response.text()).not.toContain('secret-upstream-token')
  })
  it('cancels an in-flight model call when Harness rotates its capability', async () => {
    let started: (() => void) | undefined
    const ready = new Promise<void>(resolve => { started = resolve })
    const upstreamCancelled = vi.fn()
    const { service, post, manager } = await endpoint(async (_input, init) => {
      started?.()
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => { upstreamCancelled(); reject(new Error('aborted')) }, { once: true }))
    })
    const response = post(JSON.stringify({ model: 'leased-model', messages: [] })).catch(() => undefined)
    await ready
    service.environment()
    await response
    expect(upstreamCancelled).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(manager.finishRequest).toHaveBeenCalledOnce())
  })
  it('checks the main-frame sender before invoking account operations', async () => {
    const { service, manager } = await endpoint()
    service.registerIpc(() => { throw new Error('Untrusted frame') })
    const invoke = fakes.handlers.get('hq:model-access:login')
    if (!invoke) throw new Error('Missing named login handler')
    await expect(invoke({} as IpcMainInvokeEvent, { username: 'test', password: 'test' })).rejects.toThrow('Untrusted frame')
    expect(manager.login).not.toHaveBeenCalled()
  })
})
