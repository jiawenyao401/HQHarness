import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NsisUpdater } from 'electron-updater'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { validateInstalledUpdateConfig, verifyInstalledUpdateIdentity } from '../src/main/update/update-identity'

const options = { feedUrl: 'https://updates.hqharness.test/latest/', publisherName: 'HQHarness Test Publisher', platform: 'win32' as const }
const config = { provider: 'generic', url: options.feedUrl, publisherName: [options.publisherName] }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('installed update identity', () => {
  it('rejects missing config, a mismatched feed, and missing or additional Windows publishers', () => {
    for (const invalid of [null, {}, { ...config, url: 'https://upstream.test/latest/' }, { ...config, publisherName: null }, { ...config, publisherName: ['Another Publisher'] }, { ...config, publisherName: [options.publisherName, 'Another Publisher'] }]) {
      expect(() => validateInstalledUpdateConfig(invalid, options)).toThrow()
    }
    expect(() => validateInstalledUpdateConfig(config, options)).not.toThrow()
    expect(() => validateInstalledUpdateConfig({ ...config, publisherName: options.publisherName }, options)).not.toThrow()
  })

  it('fails closed when the actual app-update.yml file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hqharness-update-identity-'))
    roots.push(root)
    expect(() => verifyInstalledUpdateIdentity(root, options)).toThrow()
  })

  it('feeds the real NsisUpdater the validated app-update.yml publisher and propagates signature rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hqharness-update-identity-'))
    roots.push(root)
    const path = join(root, 'app-update.yml')
    await writeFile(path, stringify(config))
    verifyInstalledUpdateIdentity(root, options)
    const updater = new NsisUpdater(null, {
      version: '0.8.0', name: 'HQHarness', isPackaged: true,
      appUpdateConfigPath: path, userDataPath: root, baseCachePath: root,
      whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {}
    })
    const signatureVerifier = vi.fn(async () => 'Signature does not match the configured publisher')
    updater.verifyUpdateCodeSignature = signatureVerifier
    const result = await (updater as unknown as { verifySignature(file: string): Promise<string | null> }).verifySignature(join(root, 'unsigned.exe'))
    expect(signatureVerifier).toHaveBeenCalledExactlyOnceWith([options.publisherName], join(root, 'unsigned.exe'))
    expect(result).toBe('Signature does not match the configured publisher')
  })
})
