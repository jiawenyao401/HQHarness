import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEASE_MS, ModelAccessError, RENEW_WINDOW_MS, shouldAutoRenew, validateModelAccessConfiguration, validateModelLease, type ModelLease } from '../src/shared/model-access'
import { ModelAccessStore, type CredentialEncryption } from '../src/main/enterprise/model-access-store'
import { ModelAccessManager } from '../src/main/enterprise/model-access-manager'

const directories: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
export function leaseAt(now: number): ModelLease {
  return { id: 'lease-test-0001', status: 'active', issued_at: new Date(now).toISOString(), initial_expires_at: new Date(now + LEASE_MS).toISOString(), expires_at: new Date(now + LEASE_MS).toISOString(), auto_renewed: false, server_time: new Date(now).toISOString(), test_environment: true, inference_path: '/desktop/model-access/v1', model: { id: 'deepseek-test', display_name: 'DeepSeek-V41-Flash', context_window: 65536, max_output_tokens: 4096, input_modalities: ['text'], tool_calls_verified: true } }
}
function encryption(): CredentialEncryption {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(-16))
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8')
    }
  }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'hq-model-access-test-'))
  directories.push(directory)
  const path = join(directory, 'credentials.bin'), cipher = encryption(), store = new ModelAccessStore(path, cipher)
  let issued: ModelLease | undefined
  let key = ''
  let renewals = 0
  let failRenew = false
  let offline = false
  let rejectAccountOnce = false
  const calls: { path: string; body: Record<string, unknown>; authorization: string | null }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    if (offline) throw new Error('offline')
    const path = new URL(String(input)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    calls.push({ path, body, authorization: new Headers(init?.headers).get('authorization') })
    const auth = { access_token: 'test-account-access-token', refresh_token: 'test-account-refresh-token', expires_in_seconds: 600, user: { display_name: 'Test employee' } }
    if (path.endsWith('/auth/login-options')) return Response.json({ password_login_enabled: true, oidc_enabled: false })
    if (path.endsWith('/auth/login') || path.endsWith('/auth/refresh')) return Response.json(auth)
    if (path.endsWith('/auth/logout')) return Response.json({ ok: true })
    if (path.endsWith('/leases/current')) {
      if (rejectAccountOnce) { rejectAccountOnce = false; return Response.json({}, { status: 401 }) }
      return Response.json({ lease: issued ? { ...issued, server_time: new Date().toISOString(), ...(Date.parse(issued.expires_at) <= Date.now() ? { status: 'expired' } : {}) } : null, server_time: new Date().toISOString() })
    }
    if (path.endsWith('/leases') && init?.method === 'POST') { issued ??= leaseAt(Date.now()); key ||= 'sk-test-virtual-key-never-in-renderer'; return Response.json({ ...issued, virtual_key: key }) }
    if (path.endsWith('/renew')) {
      if (failRenew) return Response.json({ detail: 'unavailable' }, { status: 503 })
      if (!issued) throw new Error('missing fake lease')
      if (!issued.auto_renewed) renewals++
      issued = { ...issued, auto_renewed: true, expires_at: new Date(Date.parse(issued.initial_expires_at) + LEASE_MS).toISOString(), server_time: new Date().toISOString() }
      return Response.json(issued)
    }
    if (path.includes('/leases/') && init?.method === 'DELETE') { if (issued) issued = { ...issued, status: 'revoked' }; return Response.json(issued) }
    return Response.json({}, { status: 404 })
  }
  const cancel = vi.fn(), manager = new ModelAccessManager(store, cancel, fetcher)
  return { manager, path, cipher, store, fetcher, calls, cancel, get key() { return key }, get renewals() { return renewals }, offline(value: boolean) { offline = value }, failRenew(value: boolean) { failRenew = value }, expireAccount() { rejectAccountOnce = true } }
}
async function signIn(env: Awaited<ReturnType<typeof setup>>) {
  await env.manager.configure({ baseUrl: 'https://agentos.test', allowInsecureTest: false })
  await env.manager.login({ username: 'test-employee', password: 'test-password' })
}

describe('finite team model policy', () => {
  it('requires TLS except an explicit private HTTP test origin', () => {
    expect(validateModelAccessConfiguration({ baseUrl: 'http://192.168.0.2:5001/', allowInsecureTest: true }).baseUrl).toBe('http://192.168.0.2:5001')
    for (const baseUrl of ['http://public.example', 'http://192.168.0.2:5001', 'https://user:pass@agentos.test', 'https://agentos.test/arbitrary-proxy', 'file:///tmp/private']) {
      expect(() => validateModelAccessConfiguration({ baseUrl, allowInsecureTest: false })).toThrow(ModelAccessError)
    }
    expect(() => validateModelAccessConfiguration({ baseUrl: 'http://public.example', allowInsecureTest: true })).toThrow()
  })
  it('renews only during the last ten minutes for recent use or an active request', () => {
    const lease = leaseAt(100_000)
    const expiry = Date.parse(lease.expires_at)
    expect(shouldAutoRenew(lease, expiry - RENEW_WINDOW_MS - 1, expiry - 1000, 1)).toBe(false)
    expect(shouldAutoRenew(lease, expiry - RENEW_WINDOW_MS, 0, 0)).toBe(false)
    expect(shouldAutoRenew(lease, expiry - 1, expiry - 1000, 0)).toBe(true)
    expect(shouldAutoRenew(lease, expiry, expiry - 1000, 1)).toBe(false)
    expect(shouldAutoRenew({ ...lease, auto_renewed: true }, expiry - 1, expiry - 1000, 1)).toBe(false)
  })
  it('rejects malformed server grants rather than trusting the displayed countdown', () => {
    const lease = leaseAt(100_000)
    expect(validateModelLease(lease)).toEqual(lease)
    for (const changes of [{ expires_at: new Date(100_000 + LEASE_MS * 3).toISOString() }, { auto_renewed: true }, { inference_path: 'https://other.test' }, { model: { ...lease.model, input_modalities: ['unknown'] } }]) {
      expect(() => validateModelLease({ ...lease, ...changes })).toThrow()
    }
  })
})

describe('desktop credential ownership and renewal', () => {
  it('stores encrypted credentials and returns only redacted status', async () => {
    const env = await setup()
    await signIn(env)
    await env.manager.claim()
    const bytes = await readFile(env.path)
    for (const secret of [env.key, 'test-account-refresh-token', 'test-password']) expect(bytes.toString('utf8')).not.toContain(secret)
    const state = await env.store.read()
    expect(state.lease?.virtualKey).toBe(env.key)
    expect(JSON.stringify(state)).not.toContain('test-password')
    const status = await env.manager.status()
    expect(status.usable).toBe(true)
    expect(JSON.stringify(status)).not.toContain(env.key)
    expect(JSON.stringify(status)).not.toContain('test-account-access-token')
  })
  it('does not persist plaintext when OS encryption is unavailable', async () => {
    const env = await setup()
    const store = new ModelAccessStore(env.path, { ...env.cipher, isEncryptionAvailable: () => false })
    await expect(store.write({ version: 1, installationId: 'test-installation-0001' })).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
    await expect(readFile(env.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('verifies restored grants online before making them available', async () => {
    const env = await setup()
    await signIn(env); await env.manager.claim()
    const restored = new ModelAccessManager(env.store, env.cancel, env.fetcher)
    await restored.initialize()
    expect((await restored.status()).usable).toBe(false)
    env.offline(true)
    await expect(restored.refresh()).rejects.toMatchObject({ code: 'NETWORK' })
    expect((await restored.status()).usable).toBe(false)
    env.offline(false)
    await restored.refresh()
    expect((await restored.status()).usable).toBe(true)
  })
  it('refreshes the account and extends the same lease only once while in use', async () => {
    const env = await setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await signIn(env); await env.manager.claim()
    const original = (await env.manager.status()).lease
    vi.setSystemTime(new Date('2026-01-01T02:51:00Z'))
    const access = await env.manager.beginRequest()
    env.manager.finishRequest()
    expect(access.virtualKey).toBe(env.key)
    expect(access.lease.id).toBe(original?.id)
    expect(access.lease.expires_at).toBe('2026-01-01T06:00:00.000Z')
    expect(env.calls.some(call => call.path === '/auth/refresh')).toBe(true)
    vi.setSystemTime(new Date('2026-01-01T05:55:00Z'))
    await env.manager.beginRequest(); env.manager.finishRequest()
    expect(env.renewals).toBe(1)
    vi.setSystemTime(new Date('2026-01-01T06:00:00Z'))
    await expect(env.manager.beginRequest()).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
  })
  it('keeps the original grant usable when the extension service fails', async () => {
    const env = await setup()
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await signIn(env); await env.manager.claim()
    vi.setSystemTime(new Date('2026-01-01T02:55:00Z')); env.failRenew(true)
    const access = await env.manager.beginRequest(); env.manager.finishRequest()
    expect(access.lease.expires_at).toBe('2026-01-01T03:00:00.000Z')
    expect((await env.manager.status()).error).toBe('SERVICE_ERROR')
  })
  it('refreshes a server-expired account token once even when local time says it is fresh', async () => {
    const env = await setup()
    await signIn(env); await env.manager.claim()
    env.expireAccount()
    await env.manager.beginRequest(); env.manager.finishRequest()
    expect(env.calls.filter(call => call.path === '/auth/refresh')).toHaveLength(1)
    expect((await env.manager.status()).usable).toBe(true)
  })
  it('stops local use and retains no account secrets after an offline logout', async () => {
    const env = await setup()
    await signIn(env); await env.manager.claim(); env.offline(true)
    await expect(env.manager.logout()).rejects.toMatchObject({ code: 'REVOCATION_PENDING' })
    expect(env.cancel).toHaveBeenCalled()
    const status = await env.manager.status()
    expect(status.signedIn).toBe(false); expect(status.usable).toBe(false); expect(status.pendingRevocation).toBe(true)
    const stored = await env.store.read()
    expect(stored.account).toBeUndefined(); expect(stored.lease).toBeUndefined()
    env.offline(false)
    await env.manager.login({ username: 'test-employee', password: 'test-password' })
    expect((await env.manager.status()).pendingRevocation).toBe(false)
    expect(env.calls.some(call => call.path.endsWith('/lease-test-0001'))).toBe(true)
  })
  it('preserves a damaged credential file and only resets it after an explicit logout', async () => {
    const env = await setup()
    await writeFile(env.path, 'damaged-encrypted-credentials')
    const damaged = new ModelAccessManager(env.store, env.cancel, env.fetcher)
    expect((await damaged.status()).error).toBe('STORE_INVALID')
    expect(await readFile(env.path, 'utf8')).toBe('damaged-encrypted-credentials')
    await damaged.logout()
    expect((await readdir(join(env.path, '..'))).some(name => name.includes('.recovery-'))).toBe(true)
    expect((await damaged.status()).error).toBeUndefined()
  })
})
