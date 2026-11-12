import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { ModelAccessError, objectValue, requiredText, shouldAcquireLease, shouldAutoRenew, validateModelAccessConfiguration, validateModelLease, type ModelAccessStatus, type ModelLease } from '../../shared/model-access'
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
  private recoveryFailures = 0
  private nextRecoveryAt = 0
  private recoveryError?: ModelAccessError
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
    const lease = this.data.lease?.snapshot ?? this.remoteLease
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
      await this.retireOldLeases(true)
      await this.syncCurrent()
      this.recoveryFailures = 0
      this.nextRecoveryAt = 0
      this.recoveryError = undefined
    })
    return this.status()
  }
  private async syncCurrent(): Promise<void> {
    let response: Record<string, unknown>
    try { response = await this.authorized(`/desktop/model-access/leases/current?installation_id=${this.data.installationId}`, 'GET') }
    catch (error) {
      // A transient outage does not revoke an already verified, finite grant.
      // Restored/resumed processes start unverified and cannot use this path.
      if (!(error instanceof ModelAccessError) || error.code !== 'NETWORK' && error.status !== 503) this.verified = false
      throw error
    }
    const wasVerified = this.verified
    this.verified = false
    if (response.lease) {
      const lease = this.acceptLease(response.lease)
      if (this.data.lease?.snapshot.id === lease.id) {
        this.verified = ['active', 'renewing'].includes(lease.status) && Date.parse(lease.expires_at) > this.now()
        if (['revoked', 'revoking', 'failed'].includes(lease.status)) this.cancelRequests()
      } else if (this.data.claimRequestId && ['active', 'renewing'].includes(lease.status)) this.verified = wasVerified
    } else { this.remoteLease = undefined; this.data.lease = undefined; this.verified = false }
    await this.store.write(this.data)
  }
  async refresh(): Promise<ModelAccessStatus> {
    await this.run(() => this.maintainAccess(true))
    return this.status()
  }
  async claim(): Promise<ModelAccessStatus> {
    await this.run(() => this.maintainAccess(true))
    return this.status()
  }
  private async issueLease(): Promise<void> {
    if (!this.data.claimRequestId) {
      const previous = this.data.lease?.snapshot
      this.data.claimPredecessorId = previous && Date.parse(previous.expires_at) > this.now() ? previous.id : undefined
    }
    this.data.claimRequestId ??= randomUUID()
    await this.store.write(this.data)
    let result: Record<string, unknown>
    try {
      result = await this.authorized('/desktop/model-access/leases', 'POST', {
        installation_id: this.data.installationId, request_id: this.data.claimRequestId,
        ...(this.data.claimPredecessorId ? { predecessor_id: this.data.claimPredecessorId } : {})
      })
    } catch (error) {
      if (!(error instanceof ModelAccessError) || error.code !== 'CLAIM_ENDED') throw error
      // The server explicitly confirmed that a lost-ack claim has expired (or
      // was fully compensated). Never rotate an ambiguous live reservation.
      this.data.claimRequestId = randomUUID()
      this.data.claimPredecessorId = undefined
      await this.store.write(this.data)
      throw error
    }
    const snapshot = this.acceptLease(result)
    const virtualKey = requiredText(result.virtual_key, 256)
    if (!virtualKey.startsWith('sk-') || snapshot.status !== 'active') throw new ModelAccessError('INVALID_RESPONSE', 'Invalid issued team credentials')
    const previousId = this.data.lease?.snapshot.id
    if (previousId && previousId !== snapshot.id) this.data.retiringLeaseIds = [...new Set([...(this.data.retiringLeaseIds ?? []), previousId])]
    this.data.lease = { snapshot, virtualKey }
    this.data.claimRequestId = undefined
    this.data.claimPredecessorId = undefined
    this.disabled = false
    await this.store.write(this.data)
    this.verified = true
  }
  private async retireOldLeases(includePending = false): Promise<void> {
    if (this.active > 0) return
    const ids = new Set(this.data.retiringLeaseIds ?? [])
    if (includePending && this.data.pendingRevocation) ids.add(this.data.pendingRevocation)
    for (const id of ids) {
      await this.authorized(`/desktop/model-access/leases/${id}`, 'DELETE', { installation_id: this.data.installationId })
      this.data.retiringLeaseIds = this.data.retiringLeaseIds?.filter(value => value !== id)
      if (this.data.pendingRevocation === id) this.data.pendingRevocation = undefined
      await this.store.write(this.data)
    }
  }
  private async maintainAccess(synchronize: boolean): Promise<void> {
    if (!this.data.account || this.disabled) return
    try {
      if (this.data.pendingRevocation) await this.retireOldLeases(true)
      if (synchronize || !this.verified) await this.syncCurrent()
      try { await this.autoRenew() } catch (error) {
        // Preserve the original deadline if a renewal cannot be confirmed.
        this.error = error instanceof ModelAccessError ? error.code : 'SERVICE_ERROR'
        if (!(error instanceof ModelAccessError) || !['NETWORK', 'SERVICE_ERROR', 'LEASE_CONFLICT'].includes(error.code)) {
          this.verified = false
          throw error
        }
      }
      const lease = this.data.lease?.snapshot ?? this.remoteLease
      if (lease && (['revoked', 'revoking'].includes(lease.status) || lease.status === 'failed' && !this.data.claimRequestId)) throw new ModelAccessError('ACCESS_DENIED', 'Model access was revoked or disabled')
      if (this.data.claimRequestId || shouldAcquireLease(lease, this.now(), this.lastUsed, this.active)) await this.issueLease()
      await this.retireOldLeases(true)
      this.recoveryFailures = 0
      this.nextRecoveryAt = 0
      this.recoveryError = undefined
    } catch (error) {
      this.recoveryFailures++
      // One serialized retry loop covers startup, expiry and wake events. The
      // server remains authoritative for admission, budgets and idempotency.
      const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.recoveryFailures - 1, 5))
      this.nextRecoveryAt = this.now() + backoff * (0.8 + Math.random() * 0.2)
      this.recoveryError = error instanceof ModelAccessError ? error : new ModelAccessError('SERVICE_ERROR', 'Model access recovery is pending')
      throw error
    }
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
    await this.initialize()
    if (!this.data.account || this.disabled || this.now() < this.nextRecoveryAt || this.busy) return
    await this.run(() => this.maintainAccess(false))
  }
  async beginRequest(): Promise<ModelRequestAccess> {
    return this.run(async () => {
      if (this.disabled || !this.data.account) throw new ModelAccessError('LEASE_REQUIRED', 'Model access is unavailable')
      this.lastUsed = this.now()
      if (this.now() < this.nextRecoveryAt && this.recoveryError) {
        const current = this.data.lease?.snapshot
        // Queued conversations share the same recovery attempt. Do not let an
        // outage turn sixteen queued requests into sixteen 30-second probes.
        if (!['NETWORK', 'SERVICE_ERROR', 'LEASE_CONFLICT'].includes(this.recoveryError.code) || !this.verified || !current || Date.parse(current.expires_at) <= this.now()) throw this.recoveryError
      } else {
        try { await this.maintainAccess(true) } catch (error) {
          this.error = error instanceof ModelAccessError ? error.code : 'SERVICE_ERROR'
          if (!(error instanceof ModelAccessError) || !['NETWORK', 'SERVICE_ERROR', 'LEASE_CONFLICT'].includes(error.code)) throw error
        }
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
      const ids = new Set([this.data.lease?.snapshot.id, this.remoteLease?.id, this.data.pendingRevocation, ...(this.data.retiringLeaseIds ?? [])].filter((id): id is string => !!id))
      const pending: string[] = []
      let failed = false
      try {
        if (this.data.account) {
          for (const id of ids) {
            try { await this.authorized(`/desktop/model-access/leases/${id}`, 'DELETE', { installation_id: this.data.installationId }) }
            catch { pending.push(id); failed = true }
          }
          await this.authorized('/auth/logout', 'POST')
        }
      } catch { failed = true }
      this.data = { version: 1, installationId: this.data.installationId, ...(this.data.configuration ? { configuration: this.data.configuration } : {}), ...(pending[0] ? { pendingRevocation: pending[0], retiringLeaseIds: pending } : {}) }
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
