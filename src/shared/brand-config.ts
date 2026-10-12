export type BrandServiceConfig = {
  updateBaseUrl: string | null
  desktopServiceUrl: string | null
  supportUrl: string | null
  publisherName: string | null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Service endpoints belong to this distribution, never the upstream desktop. */
export function validateBrandServiceUrl(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be null or an HTTPS URL`)
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must use HTTPS without credentials, query or fragment`)
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'dshdesktop.com' || hostname.endsWith('.dshdesktop.com')) {
    throw new Error(`${field} must not use the upstream DSH Desktop service`)
  }
  return value
}

export function configuredUpdateFeedUrl(updateBaseUrl: string): string {
  return new URL('latest/', updateBaseUrl.endsWith('/') ? updateBaseUrl : `${updateBaseUrl}/`).href
}

export function matchesConfiguredPublisher(value: unknown, publisherName: string): boolean {
  return value === publisherName || (Array.isArray(value) && value.length === 1 && value[0] === publisherName)
}

/** Pure validation shared by builds, releases, and the installed application. */
export function validateBrandConfig(brand: unknown, packageJson?: unknown): asserts brand is BrandServiceConfig {
  const config = record(brand)
  if (!config) throw new Error('Brand configuration must be an object')
  const updateBaseUrl = validateBrandServiceUrl(config.updateBaseUrl, 'updateBaseUrl')
  const desktopServiceUrl = validateBrandServiceUrl(config.desktopServiceUrl, 'desktopServiceUrl')
  validateBrandServiceUrl(config.supportUrl, 'supportUrl')
  if (config.publisherName !== null && (typeof config.publisherName !== 'string' || !config.publisherName.trim() || config.publisherName !== config.publisherName.trim())) {
    throw new Error('publisherName must be null or the exact certificate publisher name')
  }
  if (!updateBaseUrl) return
  if (!desktopServiceUrl) throw new Error('Updates require a configured desktopServiceUrl')
  if (typeof config.publisherName !== 'string') throw new Error('Updates require an own Windows publisherName')
  if (packageJson === undefined) return
  const build = record(record(packageJson)?.build)
  const publish = record(build?.publish)
  if (publish?.provider !== 'generic' || publish.url !== configuredUpdateFeedUrl(updateBaseUrl)) {
    throw new Error('build.publish must use the configured generic latest/ update feed')
  }
  const windows = record(build?.win)
  const signing = record(windows?.signtoolOptions)
  if (!matchesConfiguredPublisher(signing?.publisherName, config.publisherName) || windows?.verifyUpdateCodeSignature !== true) {
    throw new Error('Windows update signature verification and publisherName must match the brand configuration')
  }
}
