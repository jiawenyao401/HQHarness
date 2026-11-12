import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ModelAccessError, objectValue, requiredText, validateModelAccessConfiguration, validateModelLease, type ModelAccessConfiguration, type ModelLease } from '../../shared/model-access'

export interface StoredModelAccess {
  version: 1
  installationId: string
  configuration?: ModelAccessConfiguration
  account?: { accessToken: string; refreshToken: string; expiresAt: number; name: string }
  lease?: { snapshot: ModelLease; virtualKey: string }
  claimRequestId?: string
  claimPredecessorId?: string
  retiringLeaseIds?: string[]
  pendingRevocation?: string
}
export interface CredentialEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export class ModelAccessStore {
  constructor(private readonly path: string, private readonly encryption: CredentialEncryption) {}
  async read(): Promise<StoredModelAccess> {
    let bytes: Buffer
    try {
      const stat = await lstat(this.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new ModelAccessError('STORE_INVALID', 'Team credential storage requires recovery')
      bytes = await readFile(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, installationId: randomUUID() }
      throw error
    }
    if (!this.encryption.isEncryptionAvailable()) throw new ModelAccessError('ENCRYPTION_UNAVAILABLE', 'System credential encryption is unavailable')
    try {
      const row = objectValue(JSON.parse(this.encryption.decryptString(bytes)))
      if (row.version !== 1) throw new Error('version')
      const result: StoredModelAccess = { version: 1, installationId: requiredText(row.installationId, 80) }
      if (!/^[a-zA-Z0-9_-]{16,80}$/.test(result.installationId)) throw new Error('installation')
      if (row.configuration) result.configuration = validateModelAccessConfiguration(row.configuration)
      if (row.account) {
        const account = objectValue(row.account)
        if (!Number.isFinite(account.expiresAt)) throw new Error('expiry')
        result.account = { accessToken: requiredText(account.accessToken, 16384), refreshToken: requiredText(account.refreshToken, 16384), expiresAt: Number(account.expiresAt), name: requiredText(account.name, 160) }
      }
      if (row.lease) {
        const lease = objectValue(row.lease)
        result.lease = { snapshot: validateModelLease(lease.snapshot), virtualKey: requiredText(lease.virtualKey, 256) }
      }
      if (row.claimRequestId) result.claimRequestId = requiredText(row.claimRequestId, 80)
      if (row.claimPredecessorId) {
        if (!result.claimRequestId) throw new Error('claim predecessor without request')
        result.claimPredecessorId = requiredText(row.claimPredecessorId, 80)
      }
      if (row.retiringLeaseIds) {
        if (!Array.isArray(row.retiringLeaseIds) || row.retiringLeaseIds.length > 20) throw new Error('retiring leases')
        result.retiringLeaseIds = [...new Set(row.retiringLeaseIds.map(id => requiredText(id, 80)))]
      }
      if (row.pendingRevocation) result.pendingRevocation = requiredText(row.pendingRevocation, 80)
      return result
    } catch { throw new ModelAccessError('STORE_INVALID', 'Team credentials could not be decrypted; the original file was preserved') }
  }
  async write(value: StoredModelAccess): Promise<void> {
    if (!this.encryption.isEncryptionAvailable()) throw new ModelAccessError('ENCRYPTION_UNAVAILABLE', 'System credential encryption is unavailable; plaintext storage is disabled')
    const encrypted = this.encryption.encryptString(JSON.stringify(value))
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    if ((await lstat(dirname(this.path))).isSymbolicLink()) throw new ModelAccessError('STORE_INVALID', 'Team credential directory cannot be a symbolic link')
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' })
    try { await rename(temporary, this.path) }
    catch (error) { await rm(temporary, { force: true }).catch(() => { /* Only an encrypted, task-owned temporary remains if cleanup fails. */ }); throw error }
  }
  async recover(): Promise<StoredModelAccess> {
    if (!this.encryption.isEncryptionAvailable()) throw new ModelAccessError('ENCRYPTION_UNAVAILABLE', 'Unlock system credentials before recovery')
    const file = await lstat(this.path)
    if (!file.isFile() || file.isSymbolicLink()) throw new ModelAccessError('STORE_INVALID', 'Team credential recovery requires a regular file')
    await rename(this.path, `${this.path}.recovery-${randomUUID()}`)
    const fresh: StoredModelAccess = { version: 1, installationId: randomUUID() }
    await this.write(fresh)
    return fresh
  }
}
