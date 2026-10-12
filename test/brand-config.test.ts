import { describe, expect, it } from 'vitest'
import { validateBrandConfig } from '../src/shared/brand-config'

const disabled = { updateBaseUrl: null, desktopServiceUrl: null, supportUrl: null, publisherName: null }
const enabled = { ...disabled, updateBaseUrl: 'https://updates.hqharness.test/desktop', desktopServiceUrl: 'https://policy.hqharness.test/service', publisherName: 'HQHarness Test Publisher' }
const packageJson = () => ({ build: {
  publish: { provider: 'generic', url: 'https://updates.hqharness.test/desktop/latest/' },
  win: { verifyUpdateCodeSignature: true, signtoolOptions: { publisherName: enabled.publisherName } }
} })

describe('production brand service configuration', () => {
  it('allows the default disabled services and separate HTTPS policy/update origins', () => {
    expect(() => validateBrandConfig(disabled, { build: { publish: null } })).not.toThrow()
    expect(() => validateBrandConfig(enabled, packageJson())).not.toThrow()
    expect(() => validateBrandConfig({ ...disabled, desktopServiceUrl: enabled.desktopServiceUrl })).not.toThrow()
  })

  it.each(['updateBaseUrl', 'desktopServiceUrl', 'supportUrl'])('rejects unsafe or upstream %s endpoints', field => {
    for (const value of ['', 'http://hq.test', 'https://user:pass@hq.test', 'https://hq.test?q=1', 'https://hq.test/#fragment', 'https://dshdesktop.com/updates', 'https://www.dshdesktop.com/updates', 'https://DSHDESKTOP.COM./updates', 'javascript:alert(1)']) {
      expect(() => validateBrandConfig({ ...disabled, [field]: value })).toThrow()
    }
  })

  it('requires the policy service and publisher before enabling updates', () => {
    expect(() => validateBrandConfig({ ...enabled, desktopServiceUrl: null })).toThrow('desktopServiceUrl')
    expect(() => validateBrandConfig({ ...enabled, publisherName: null })).toThrow('publisherName')
    expect(() => validateBrandConfig({ ...enabled, publisherName: ' ' })).toThrow('publisherName')
  })

  it('requires the actual package feed and Windows signature identity to match', () => {
    const pkg = packageJson()
    pkg.build.publish.url = 'https://updates.hqharness.test/latest/'
    expect(() => validateBrandConfig(enabled, pkg)).toThrow('build.publish')
    expect(() => validateBrandConfig(enabled, { build: { publish: null } })).toThrow('build.publish')
    const wrongPublisher = packageJson()
    wrongPublisher.build.win.signtoolOptions.publisherName = 'Another Publisher'
    expect(() => validateBrandConfig(enabled, wrongPublisher)).toThrow('publisherName')
    const unsigned = packageJson()
    unsigned.build.win.verifyUpdateCodeSignature = false
    expect(() => validateBrandConfig(enabled, unsigned)).toThrow('signature verification')
  })
})
