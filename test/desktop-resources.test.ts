import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDesktopResourcePath } from '../src/main/desktop-resources'

const options = { isPackaged: false, appPath: '/workspace/HQHarness', resourcesPath: '/installed/HQHarness/resources' }

describe('HQHarness desktop resources', () => {
  it('loads development pages, icons and loaders from the same generated directory', () => {
    for (const name of ['splash.html', 'plugin-recovery.html', 'safe-mode.html', 'web-import.html', 'app-icon.png', 'dsh-loader.gif', 'dsh-loader-dark.gif']) {
      expect(resolveDesktopResourcePath(name, options)).toBe(join(options.appPath, '.build', 'brand', name))
    }
    expect(resolveDesktopResourcePath('icon.png', options)).toBe(join(options.appPath, '.build', 'brand', 'app-icon.png'))
  })

  it('keeps runtime entry and patch inputs in their source directory during development', () => {
    for (const name of ['harness-node-entry.mjs', 'host-module-fallback.mjs', 'dsh-desktop.patch.yml']) {
      expect(resolveDesktopResourcePath(name, options)).toBe(join(options.appPath, 'build', name))
    }
  })

  it('loads installed resources from the actual package resources directory', () => {
    for (const name of ['splash.html', 'safe-mode.html', 'icon.png', 'dsh-loader.gif', 'harness-node-entry.mjs', 'dsh-desktop.patch.yml']) {
      expect(resolveDesktopResourcePath(name, { ...options, isPackaged: true })).toBe(join(options.resourcesPath, name))
    }
  })
})
