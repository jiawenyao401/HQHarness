import {
  PRODUCT_NAME,
  DEVELOPMENT_PRODUCT_NAME,
  USER_DATA_DIRECTORY,
  DEVELOPMENT_USER_DATA_DIRECTORY
} from '../shared/brand'
import { isAbsolute, join, resolve } from 'node:path'

/** Stable data roots let HQHarness coexist with upstream and development builds. */
export function applicationIdentity(developmentBuild: boolean): { name: string; directory: string } {
  return developmentBuild
    ? { name: DEVELOPMENT_PRODUCT_NAME, directory: DEVELOPMENT_USER_DATA_DIRECTORY }
    : { name: PRODUCT_NAME, directory: USER_DATA_DIRECTORY }
}

/** Honor Electron's explicit diagnostic profile flag; the stable default is
 * unchanged. QA can exercise a packaged app without editing real user data. */
export function applicationUserData(appData: string, developmentBuild: boolean, override = ''): string {
  if (override) {
    if (!isAbsolute(override)) throw new Error('--user-data-dir must be an absolute path')
    return resolve(override)
  }
  return join(appData, applicationIdentity(developmentBuild).directory)
}
