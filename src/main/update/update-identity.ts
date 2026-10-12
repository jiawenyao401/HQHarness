import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { matchesConfiguredPublisher } from '../../shared/brand-config'

export function validateInstalledUpdateConfig(config: unknown, options: {
  feedUrl: string
  publisherName: string | null
  platform: NodeJS.Platform
}): void {
  const update = config as { provider?: unknown; url?: unknown; publisherName?: unknown } | null
  if (!update || update.provider !== 'generic' || update.url !== options.feedUrl) {
    throw new Error('Installed app-update.yml does not match the configured update feed')
  }
  if (options.platform === 'win32' && (!options.publisherName || !matchesConfiguredPublisher(update.publisherName, options.publisherName))) {
    throw new Error('Installed app-update.yml does not match the configured Windows publisher')
  }
}

export function verifyInstalledUpdateIdentity(resourcesPath: string, options: Parameters<typeof validateInstalledUpdateConfig>[1]): void {
  validateInstalledUpdateConfig(parse(readFileSync(join(resourcesPath, 'app-update.yml'), 'utf8')), options)
}
