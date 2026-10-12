import { join } from 'node:path'

/** Generated brand pages and images share a directory in development and installs. */
export function resolveDesktopResourcePath(name: string, options: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}): string {
  if (options.isPackaged) return join(options.resourcesPath, name)
  if (name.endsWith('.html') || ['icon.png', 'app-icon.png', 'dsh-loader.gif', 'dsh-loader-dark.gif'].includes(name)) {
    return join(options.appPath, '.build', 'brand', name === 'icon.png' ? 'app-icon.png' : name)
  }
  return join(options.appPath, 'build', name)
}
