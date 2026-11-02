import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { AppInfo } = require('app-builder-lib/out/appInfo')
const { getWindowsInstallationDirName } = require('app-builder-lib/out/targets/targetUtil')
const brand = JSON.parse(readFileSync(new URL('../brand.config.json', import.meta.url), 'utf8'))
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const development = require('../electron-builder.dev.cjs')

describe('display branding with stable installed identities', () => {
  it.each([
    ['Huaqing Desktop', metadata.build, 'HQHarness', 'app.hqharness.desktop'],
    ['Huaqing Desktop Dev', development, 'HQHarness Dev', 'app.hqharness.desktop.dev']
  ])('keeps executable, bundle and NSIS installation names stable for %s', (product, config, executable, appId) => {
    const actual = new AppInfo({ metadata, config })
    expect(actual.productName).toBe(product)
    expect(actual.productFilename).toBe(executable)
    expect(actual.id).toBe(appId)
    expect(getWindowsInstallationDirName(actual, true)).toBe(executable)
    // MacPackager uses productFilename for the bundle and main binary. Helpers
    // follow sanitizedProductName and are resolved from the installed layout.
    expect(`${actual.productFilename}.app`).toBe(`${executable}.app`)
  })
  it('keeps the package, profiles and update repository independently stable', () => {
    expect(metadata.name).toBe('hqharness')
    expect(brand).toMatchObject({ productName: 'Huaqing Desktop', developmentProductName: 'Huaqing Desktop Dev', packageName: 'hqharness', appId: 'app.hqharness.desktop', developmentAppId: 'app.hqharness.desktop.dev', userDataDirectory: 'hqharness', developmentUserDataDirectory: 'hqharness-dev', releaseRepository: 'jiawenyao401/HQHarness' })
  })
})
