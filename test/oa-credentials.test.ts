import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OaCredentials, OaCredentialsError, type OaConfigurationInput, type OaCredentialEncryption } from '../src/main/oa/credentials'

const configuration: OaConfigurationInput = {
  environment: 'test', account: 'wwb', corpid: 'test-corporation', appKey: 'test-key',
  appSecret: 'test-secret', tenantKey: 'test-tenant', operatorName: '测试人员'
}
const verified = { operatorName: configuration.operatorName, operatorId: '1342738882223334444' }

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'hq-oa-credentials-test-'))
  directories.push(directory)
  const path = join(directory, 'credentials.bin')
  const key = randomBytes(32)
  const encryption: OaCredentialEncryption = {
    isEncryptionAvailable: async () => true,
    async encryptString(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    async decryptString(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(-16))
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8')
    }
  }
  return { directory, path, encryption, store: new OaCredentials(path, encryption) }
}

it('persists only encrypted, verified configuration and can clear it after a restart', async () => {
  const { path, store, encryption } = await setup()
  expect(await store.read()).toBeNull()
  const verify = vi.fn(async () => verified)
  const written = await store.write({ ...configuration, operatorName: '  测试人员  ' }, verify)
  expect(verify).toHaveBeenCalledWith(configuration)
  expect(written).toEqual({ ...configuration, operatorId: verified.operatorId })
  expect(await readFile(path, 'utf8')).not.toContain(configuration.appSecret)

  const reopened = new OaCredentials(path, encryption)
  expect(await reopened.read()).toEqual(written)
  await reopened.clear()
  expect(await reopened.read()).toBeNull()
})

it('blocks untrusted identities and retains the prior configuration after verification fails', async () => {
  const { store } = await setup()
  const verify = vi.fn(async () => verified)
  await expect(store.write({ ...configuration, operatorId: verified.operatorId }, verify))
    .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  expect(verify).not.toHaveBeenCalled()
  const prior = await store.write(configuration, verify)

  await expect(store.write(configuration, async () => ({ ...verified, operatorName: '其他人员' })))
    .rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' })
  await expect(store.write(configuration, async () => { throw new Error(configuration.appSecret) }))
    .rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED', message: 'The OA operator could not be verified in the test environment' })
  expect(await store.read()).toEqual(prior)
})

it('preserves corrupt bytes until explicit recovery and requires system encryption before verifying', async () => {
  const { directory, path, store, encryption } = await setup()
  const corrupt = 'unreadable record'
  await writeFile(path, corrupt)
  const verify = vi.fn(async () => verified)
  await expect(store.write(configuration, verify)).rejects.toMatchObject({ code: 'STORE_INVALID' })
  expect(await readFile(path, 'utf8')).toBe(corrupt)
  await store.clear()
  const backups = await readdir(directory)
  expect(backups).toHaveLength(1)
  expect(await readFile(join(directory, backups.join('')), 'utf8')).toBe(corrupt)
  expect(await store.read()).toBeNull()

  const noEncryption = new OaCredentials(path, { ...encryption, isEncryptionAvailable: async () => false })
  await expect(noEncryption.write(configuration, verify)).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
  expect(verify).not.toHaveBeenCalled()
})

it('keeps a credential record in place while the system key is temporarily unavailable', async () => {
  const { directory, path, store, encryption } = await setup()
  const written = await store.write(configuration, async () => verified)
  const ciphertext = await readFile(path)
  const locked = new OaCredentials(path, {
    ...encryption, decryptString: async () => { throw new OaCredentialsError('ENCRYPTION_UNAVAILABLE') }
  })
  await expect(locked.read()).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
  await expect(locked.clear()).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
  expect(await readdir(directory)).toEqual(['credentials.bin'])
  expect(await readFile(path)).toEqual(ciphertext)
  expect(await store.read()).toEqual(written)
})

it('serializes reads, verification, and clearing without replaying old writes', async () => {
  const { store } = await setup()
  const actions: string[] = []
  const write = store.write(configuration, async () => {
    actions.push('verify')
    await Promise.resolve()
    actions.push('verified')
    return verified
  })
  const read = store.read().then(value => { actions.push('read'); return value })
  const clear = store.clear().then(() => { actions.push('clear') })
  const [written, observed] = await Promise.all([write, read, clear])
  expect(observed).toEqual(written)
  expect(actions).toEqual(['verify', 'verified', 'read', 'clear'])
  expect(await store.read()).toBeNull()
})
