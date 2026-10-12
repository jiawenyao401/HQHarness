import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBrandConfig } from '../../src/shared/brand-config.ts'

/** A fork must explicitly claim its own destination before any publication. */
export function validateReleaseConfig(brand, { mode, target, repository, publisherName }, packageJson) {
  validateBrandConfig(brand, packageJson)
  if (!brand || typeof brand !== 'object' || Array.isArray(brand)) {
    throw new Error('brand.config.json must contain a brand configuration object')
  }
  const publishing = mode === 'release' || (mode === 'prerelease' && target === 'all') || mode === 'backfill'
  if (publishing) {
    const destination = brand.releaseRepository
    if (typeof destination !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(destination)) {
      throw new Error('Configure your own owner/repo in brand.config.json releaseRepository before publishing')
    }
    if (destination.toLowerCase() === 'dataelement/dsh-desktop') {
      throw new Error('HQHarness must not publish into the upstream DSH Desktop repository')
    }
    if (typeof repository !== 'string' || destination.toLowerCase() !== repository.toLowerCase()) {
      throw new Error('releaseRepository must match the current GITHUB_REPOSITORY')
    }
  }
  const signedWindows = ['release', 'signed', 'prerelease', 'resign', 'smoke'].includes(mode) && target !== 'macos'
  if (signedWindows) {
    if (typeof brand.publisherName !== 'string' || !brand.publisherName.trim()) {
      throw new Error('Configure your own Windows certificate publisherName in brand.config.json before signing')
    }
    if (typeof publisherName !== 'string' || !publisherName.trim() || brand.publisherName !== publisherName) {
      throw new Error('HQHARN_WINDOWS_PUBLISHER_NAME must exactly match brand.config.json publisherName')
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const brand = JSON.parse(await readFile('brand.config.json', 'utf8'))
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
  validateReleaseConfig(brand, {
    mode: process.env.RELEASE_MODE ?? 'development',
    target: process.env.RELEASE_TARGET ?? 'all',
    repository: process.env.GITHUB_REPOSITORY,
    publisherName: process.env.HQHARN_WINDOWS_PUBLISHER_NAME
  }, packageJson)
  console.log('HQHarness release identity validated')
}
