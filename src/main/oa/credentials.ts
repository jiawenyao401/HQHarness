import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface OaConfigurationInput {
  environment: 'test'
  account: 'lgw' | 'wwb'
  corpid: string
  appKey: string
  appSecret: string
  tenantKey: string
  operatorName: string
}

export interface OaConfiguration extends OaConfigurationInput {
  operatorId: string
}

export interface OaCredentialEncryption {
  isEncryptionAvailable(): Promise<boolean>
  encryptString(value: string): Promise<Buffer>
  decryptString(value: Buffer): Promise<string>
}

const ERROR_MESSAGES = {
  INVALID_CONFIGURATION: 'The OA test configuration is invalid',
  IDENTITY_UNVERIFIED: 'The OA operator could not be verified in the test environment',
  ENCRYPTION_UNAVAILABLE: 'System credential encryption is unavailable',
  STORE_INVALID: 'The OA credential file requires recovery',
  STORE_UNAVAILABLE: 'The OA credential file could not be accessed'
} as const

export class OaCredentialsError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code])
    this.name = 'OaCredentialsError'
  }
}

const MAX_RECORD_BYTES = 65_536
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const PERSONNEL_ID = /^[1-9][0-9]{0,39}$/u

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OaCredentialsError('INVALID_CONFIGURATION')
  }
  return value as Record<string, unknown>
}

function requiredText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || CONTROL_CHARACTER.test(value)) {
    throw new OaCredentialsError('INVALID_CONFIGURATION')
  }
  return value
}

function operatorName(value: unknown): string {
  return requiredText(value, 160).normalize('NFC').trim().replace(/\s+/gu, ' ')
}

function parseInput(value: unknown): OaConfigurationInput {
  const { environment, account, corpid, appKey, appSecret, tenantKey, operatorName: name, ...extra } = object(value)
  if (environment !== 'test' || (account !== 'lgw' && account !== 'wwb') || Object.keys(extra).length) {
    throw new OaCredentialsError('INVALID_CONFIGURATION')
  }
  return {
    environment,
    account,
    corpid: requiredText(corpid, 512),
    appKey: requiredText(appKey, 512),
    appSecret: requiredText(appSecret, 4096),
    tenantKey: requiredText(tenantKey, 512),
    operatorName: operatorName(name)
  }
}

function verifiedIdentity(value: unknown, expectedName: string): string {
  const { operatorId, operatorName: name } = object(value)
  if (typeof operatorId !== 'string' || !PERSONNEL_ID.test(operatorId) || operatorName(name) !== expectedName) {
    throw new OaCredentialsError('IDENTITY_UNVERIFIED')
  }
  return operatorId
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** A native Keychain prompt can outlive the Harness launch or app window. */
async function waitForEncryption<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return run()
  let listener: Disposable | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = addAbortListener(signal, () => reject(signal.reason))
  })
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      signal.throwIfAborted()
      return run()
    })])
  } finally {
    listener?.[Symbol.dispose]()
  }
}

export class OaCredentials {
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly filename: string, private readonly encryption: OaCredentialEncryption) {}

  read(signal?: AbortSignal): Promise<OaConfiguration | null> {
    return this.serialize(() => this.readRecord(signal))
  }

  async write(
    value: unknown,
    verifyIdentity: (candidate: Readonly<OaConfigurationInput>) => Promise<{ operatorName: string; operatorId: string }>,
    signal?: AbortSignal
  ): Promise<OaConfiguration> {
    const candidate = Object.freeze(parseInput(value))
    return this.serialize(async () => {
      await this.requireEncryption(signal)
      // Preserve a damaged record until the user explicitly clears it.
      await this.readRecord(signal)
      let operatorId: string
      try {
        operatorId = verifiedIdentity(await verifyIdentity(candidate), candidate.operatorName)
      } catch {
        // The verifier may include raw request details in an error.
        throw new OaCredentialsError('IDENTITY_UNVERIFIED')
      }
      const configuration = { ...candidate, operatorId }
      const record = JSON.stringify({ version: 1, ...configuration })
      let encrypted: Buffer
      try {
        encrypted = await waitForEncryption(() => this.encryption.encryptString(record), signal)
      } catch {
        signal?.throwIfAborted()
        throw new OaCredentialsError('ENCRYPTION_UNAVAILABLE')
      }
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      await this.checkDirectory()
      const temporary = `${this.filename}.${randomUUID()}.tmp`
      try {
        signal?.throwIfAborted()
        await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 })
        signal?.throwIfAborted()
        await rename(temporary, this.filename)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => { /* A failed cleanup leaves only encrypted bytes. */ })
        throw error
      }
      return configuration
    })
  }

  clear(signal?: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      try {
        if (await this.readRecord(signal)) {
          signal?.throwIfAborted()
          await rm(this.filename)
        }
      } catch (error) {
        if (!(error instanceof OaCredentialsError) || error.code !== 'STORE_INVALID') throw error
        await this.checkDirectory()
        signal?.throwIfAborted()
        await rename(this.filename, `${this.filename}.recovery-${randomUUID()}`)
      }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation).catch(error => {
      if (error instanceof OaCredentialsError) throw error
      throw new OaCredentialsError('STORE_UNAVAILABLE')
    })
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  private async requireEncryption(signal?: AbortSignal): Promise<void> {
    try {
      if (await waitForEncryption(() => this.encryption.isEncryptionAvailable(), signal)) return
    } catch {
      signal?.throwIfAborted()
    }
    throw new OaCredentialsError('ENCRYPTION_UNAVAILABLE')
  }

  private async checkDirectory(): Promise<void> {
    if (!(await lstat(dirname(this.filename))).isDirectory()) throw new OaCredentialsError('STORE_INVALID')
  }

  private async readRecord(signal?: AbortSignal): Promise<OaConfiguration | null> {
    signal?.throwIfAborted()
    let encrypted: Buffer
    try {
      await this.checkDirectory()
      const stat = await lstat(this.filename)
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new OaCredentialsError('STORE_INVALID')
      encrypted = await readFile(this.filename)
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
    await this.requireEncryption(signal)
    try {
      const plaintext = await waitForEncryption(() => this.encryption.decryptString(encrypted), signal)
      const { version, operatorId, ...input } = object(JSON.parse(plaintext))
      if (version !== 1 || encrypted.length > MAX_RECORD_BYTES) throw new Error('Invalid record')
      const configuration = parseInput(input)
      return {
        ...configuration,
        operatorId: verifiedIdentity({ operatorId, operatorName: input.operatorName }, configuration.operatorName)
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof OaCredentialsError && error.code === 'ENCRYPTION_UNAVAILABLE') throw error
      throw new OaCredentialsError('STORE_INVALID')
    }
  }
}
