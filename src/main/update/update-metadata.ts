/** Validate every URL electron-updater may resolve before offering a download. */
export function validateUpdateMetadataOrigin(info: unknown, feedUrl: string, updateBaseUrl: string): void {
  if (typeof info !== 'object' || info === null) throw new Error('Invalid update metadata')
  const metadata = info as { files?: unknown; path?: unknown; packages?: unknown }
  const origin = new URL(updateBaseUrl).origin
  if (new URL(feedUrl).origin !== origin) throw new Error('Update feed is outside the configured origin')
  const validatePath = (path: unknown): void => {
    if (typeof path !== 'string' || !path) throw new Error('Invalid update download URL')
    const url = new URL(path, feedUrl)
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('Update download URL is outside the configured origin')
    }
  }
  if (Array.isArray(metadata.files) && metadata.files.length > 0) {
    for (const file of metadata.files) validatePath(file?.url)
  } else if (metadata.path === undefined) {
    throw new Error('Update metadata has no downloadable files')
  }
  if (metadata.path !== undefined) validatePath(metadata.path)
  if (metadata.packages !== undefined) {
    if (typeof metadata.packages !== 'object' || metadata.packages === null) throw new Error('Invalid update packages')
    for (const entry of Object.values(metadata.packages)) validatePath(entry?.path)
  }
}
