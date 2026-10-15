import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { ModelAccessError, objectValue, requiredText, shouldAutoRenew, validateModelAccessConfiguration, validateModelLease, type ModelAccessStatus, type ModelLease } from '../../shared/model-access'
import { AgentOsClient } from './model-access-client'
import { ModelAccessStore, type StoredModelAccess } from './model-access-store'

export interface ModelRequestAccess { lease: ModelLease; baseUrl: string; virtualKey: string; remainingMs: number }
export class ModelAccessManager {
  private data: StoredModelAccess = { version: 1, installationId: randomUUID() }
  private initialized?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private busy = false
  private verified = false
  private disabled = false
  private error?: string
  private remoteLease?: ModelLease
  private anchor?: { server: number; wall: number; monotonic: number }
  private active = 0
  private lastUsed = 0
  private lastRenewalAttempt = 0
  constructor(private readonly store: ModelAccessStore, private readonly cancelRequests: () => void, private readonly fetcher: typeof fetch = fetch) {}
  initialize(): Promise<void> {
    return this.initialized ??= this.store.read().then(data => { this.data = data }).catch(error => {
      this.error = error instanceof ModelAccessError ? error.code : 'STORE_INVALID'
      throw new ModelAccessError(this.error, 'Team credential storage is unavailable; the original file was preserved')
    })
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize()
    const result = this.queue.then(async () => {
      this.busy = true
      this.error = undefined
      try { return await operation() }
      catch (error) {
        this.error = error instanceof ModelAccessError ? error.code : 'SERVICE_ERROR'
        throw error instanceof ModelAccessError ? error : new ModelAccessError('SERVICE_ERROR', 'The team model operation failed')
      } finally { this.busy = false }
    })
    // Failed operations must not poison the serialization queue. Their caller
    // still receives the original rejection and the public error code.
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  private client(): AgentOsClient {
    if (!this.data.configuration) throw new ModelAccessError('NOT_CONFIGURED', 'Configure the AgentOS service first')
    return new AgentOsClient(this.data.configuration, this.fetcher)
  }
  private now(): number {
    if (!this.anchor) return Date.now()
    return this.anchor.server + Math.max(0, Date.now() - this.anchor.wall, performance.now() - this.anchor.monotonic)
  }
  private acceptLease(value: unknown): ModelLease {
    const lease = validateModelLease(value)
    if (lease.test_environment === false && this.data.configuration?.allowInsecureTest) throw new ModelAccessError('TLS_REQUIRED', 'The server requires HTTPS')
    this.anchor = { server: Date.parse(lease.server_time), wall: Date.now(), monotonic: performance.now() }
    this.remoteLease = lease
    if (this.data.lease?.snapshot.id === lease.id) this.data.lease.snapshot = lease
    return lease
  }
  async status(): Promise<ModelAccessStatus> {
    try { await this.initialize() } catch { /* Status must expose a recoverable storage failure. */ }
    const lease = this.remoteLease ?? this.data.lease?.snapshot
    const remainingMs = lease ? Math.max(0, Date.parse(lease.expires_at) - this.now()) : 0
    return {
      configured: !!this.data.configuration, server: this.data.configuration?.baseUrl ?? '', insecureTest: this.data.configuration?.allowInsecureTest ?? false,
      signedIn: !!this.data.account, ...(this.data.account ? { accountName: this.data.account.name } : {}), busy: this.busy,
      ...(lease ? { lease: structuredClone(lease) } : {}), usable: !this.disabled && this.verified && !!this.data.lease && !!lease && ['active', 'renewing'].includes(lease.status) && remainingMs > 0,
      remainingMs, ...(this.error ? { error: this.error } : {}), pendingRevocation: !!this.data.pendingRevocation
    }
  }
  async configure(value: unknown): Promise<ModelAccessStatus> {
    await this.run(async () => {
      if (this.data.account || this.data.lease) throw new ModelAccessError('LOGOUT_REQUIRED', 'Sign out before changing the team service')
      this.data.configuration = validateModelAccessConfiguration(value)
      await this.store.write(this.data)
      await this.client().request('/auth/login-options', 'GET')
    })
    return this.status()
  }
  private async saveAccount(response: Record<string, unknown>): Promise<void> {
    const user = objectValue(response.user)
    if (typeof response.expires_in_seconds !== 'number' || response.expires_in_seconds <= 0 || response.expires_in_seconds > 3600) throw new ModelAccessError('INVALID_RESPONSE', 'Invalid account token expiry')
    this.data.account = {
      accessToken: requiredText(response.access_token, 16384), refreshToken: requiredText(response.refresh_token, 16384),
      expiresAt: Date.now() + response.expires_in_seconds * 1000, name: requiredText(user.display_name || user.email || user.id, 160)
    }
    await this.store.write(this.data)
  }
  private async accountToken(): Promise<string> {
    const account = this.data.account
    if (!account) throw new ModelAccessError('LOGIN_REQUIRED', 'Sign in to AgentOS first')
    if (account.expiresAt - Date.now() > 60_000) return account.accessToken
    const response = await this.client().request('/auth/refresh', 'POST', undefined, { refresh_token: account.refreshToken })
    await this.saveAccount(response)
    return requiredText(this.data.account?.accessToken, 16384)
  }
  private async authorized(path: string, method: 'GET' | 'POST' | 'DELETE', body?: object): Promise<Record<string, unknown>> {
    try { return await this.client().request(path, method, await this.accountToken(), body) }
    catch (error) {
      if (!(error instanceof ModelAccessError) || error.status !== 401 || !this.data.account) throw error
      // A changed local clock can make an expired access token look fresh.
      // Retry only idempotent control operations, never an inference request.
      this.data.account.expiresAt = 0
      return this.client().request(path, method, await this.accountToken(), body)
    }
  }
  async login(value: unknown): Promise<ModelAccessStatus> {
    await this.run(async () => {
      if (this.data.account) throw new ModelAccessError('LOGOUT_REQUIRED', 'Sign out before changing accounts')
      const input = objectValue(value)
      if (Object.keys(input).some(k => k !== 'username' && k !== 'password')) throw new ModelAccessError('INVALID_INPUT', 'Invalid login request')
      const username = requiredText(input.username, 256)
      const password = requiredText(input.password, 4096)
      const options = await this.client().request('/auth/login-options', 'GET')
      if (options.password_login_enabled !== true) throw new ModelAccessError('PASSWORD_LOGIN_DISABLED', 'Use the organization sign-in method enabled by this service')
      await this.saveAccount(await this.client().request('/auth/login', 'POST', undefined, { username, password }))
      this.disabled = false
      if (this.data.pendingRevocation) {
        await this.authorized(`/desktop/model-access/leases/${this.data.pendingRevocation}`, 'DELETE', { installation_id: this.data.installationId })
        this.data.pendingRevocation = undefined
        await this.store.write(this.data)
      }
      await this.syncCurrent()
    })
    return this.status()
  }
  private async syncCurrent(): Promise<void> {
    this.verified = false
    const response = await this.authorized(`/desktop/model-access/leases/current?installation_id=${this.data.installationId}`, 'GET')
    if (response.lease) {
      const lease = this.acceptLease(response.lease)
      this.verified = this.data.lease?.snapshot.id === lease.id && ['active', 'renewing'].includes(lease.status) && Date.parse(lease.expires_at) > this.now()
      if (['revoked', 'revoking', 'failed', 'expired'].includes(lease.status)) this.cancelRequests()
    } else { this.remoteLease = undefined; this.data.lease = undefined; this.verified = false }
    await this.store.write(this.data)
  }
  async refresh(): Promise<ModelAccessStatus> {
    await this.run(async () => { await this.syncCurrent(); await this.autoRenew() })
    return this.status()
  }
  async claim(): Promise<ModelAccessStatus> {
    await this.run(async () => {
      await this.syncCurrent()
      if (this.remoteLease && !this.data.claimRequestId && !['revoked', 'failed', 'expired'].includes(this.remoteLease.status)) {
        await this.authorized(`/desktop/model-access/leases/${this.remoteLease.id}`, 'DELETE', { installation_id: this.data.installationId })
      }
      this.data.claimRequestId ??= randomUUID()
      await this.store.write(this.data)
      const result = await this.authorized('/desktop/model-access/leases', 'POST', { installation_id: this.data.installationId, request_id: this.data.claimRequestId })
      const snapshot = this.acceptLease(result)
      const virtualKey = requiredText(result.virtual_key, 256)
      if (!virtualKey.startsWith('sk-') || snapshot.status !== 'active') throw new ModelAccessError('INVALID_RESPONSE', 'Invalid issued team credentials')
      this.data.lease = { snapshot, virtualKey }
      this.data.claimRequestId = undefined
      this.data.pendingRevocation = undefined
      this.disabled = false
      await this.store.write(this.data)
      this.verified = true
    })
    return this.status()
  }
  private async autoRenew(): Promise<void> {
    let lease = this.data.lease?.snapshot
    if (!lease || this.disabled || !shouldAutoRenew(lease, this.now(), this.lastUsed, this.active) || this.now() - this.lastRenewalAttempt < 30_000) return
    this.lastRenewalAttempt = this.now()
    if (lease.status === 'renewing') {
      await this.syncCurrent()
      lease = this.data.lease?.snapshot
      if (!lease || !shouldAutoRenew(lease, this.now(), this.lastUsed, this.active)) return
    }
    // Remember an ambiguous attempt across restarts; the server remains the
    // authority on whether it was accepted before the original deadline.
    if (this.data.lease) this.data.lease.snapshot = { ...lease, status: 'renewing' }
    await this.store.write(this.data)
    const result = await this.authorized(`/desktop/model-access/leases/${lease.id}/renew`, 'POST', { installation_id: this.data.installationId })
    const renewed = this.acceptLease(result)
    if (renewed.id !== lease.id || !renewed.auto_renewed) throw new ModelAccessError('INVALID_RESPONSE', 'The renewal was not confirmed')
    await this.store.write(this.data)
    this.verified = true
  }
  async tick(): Promise<void> {
    if (!this.data.lease || this.disabled) return
    await this.run(() => this.autoRenew())
  }
  async beginRequest(): Promise<ModelRequestAccess> {
    return this.run(async () => {
      if (this.disabled || !this.data.lease) throw new ModelAccessError('LEASE_REQUIRED', 'Claim team model access first')
      await this.syncCurrent()
      this.lastUsed = this.now()
      try { await this.autoRenew() } catch (error) {
        // A failed extension does not consume the original three-hour grant.
        this.error = error instanceof ModelAccessError ? error.code : 'SERVICE_ERROR'
      }
      const lease = this.data.lease
      if (!this.verified || !lease || !['active', 'renewing'].includes(lease.snapshot.status) || Date.parse(lease.snapshot.expires_at) <= this.now()) throw new ModelAccessError('LEASE_EXPIRED', 'Team model access expired or was revoked')
      this.active++
      return { lease: structuredClone(lease.snapshot), virtualKey: lease.virtualKey, baseUrl: `${this.data.configuration?.baseUrl}${lease.snapshot.inference_path}`, remainingMs: Date.parse(lease.snapshot.expires_at) - this.now() }
    })
  }
  finishRequest(): void { this.active = Math.max(0, this.active - 1); this.lastUsed = this.now() }
  invalidate(): void { this.verified = false; this.cancelRequests() }
  async logout(): Promise<ModelAccessStatus> {
    try { await this.initialize() } catch (error) {
      if (!(error instanceof ModelAccessError) || error.code !== 'STORE_INVALID') throw error
      this.data = await this.store.recover()
      this.initialized = Promise.resolve()
      this.error = undefined
      this.verified = false
      this.cancelRequests()
      return this.status()
    }
    await this.run(async () => {
      this.disabled = true
      this.verified = false
      this.cancelRequests()
      const id = this.data.lease?.snapshot.id ?? this.remoteLease?.id ?? this.data.pendingRevocation
      let failed = false
      try {
        if (this.data.account) {
          if (id) await this.authorized(`/desktop/model-access/leases/${id}`, 'DELETE', { installation_id: this.data.installationId })
          await this.authorized('/auth/logout', 'POST')
        }
      } catch { failed = true }
      this.data = { version: 1, installationId: this.data.installationId, ...(this.data.configuration ? { configuration: this.data.configuration } : {}), ...(failed && id ? { pendingRevocation: id } : {}) }
      this.remoteLease = undefined
      await this.store.write(this.data)
      if (failed) throw new ModelAccessError('REVOCATION_PENDING', 'Local access stopped; remote revocation awaits the next sign-in or expiry')
    })
    return this.status()
  }
  async managedModel(): Promise<ModelLease | undefined> {
    const status = await this.status()
    return status.usable ? status.lease : undefined
  }
}
