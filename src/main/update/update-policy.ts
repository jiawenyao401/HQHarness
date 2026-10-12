import { DESKTOP_SERVICE_URL, UPDATE_BASE_URL } from '../../shared/brand'

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
export const UPDATE_STARTUP_DELAY_MS = 15_000
export const UPDATE_STARTUP_JITTER_MS = 15_000
export const AUTO_INSTALL_ON_APP_QUIT = false

export function supportsAutoUpdates(
  isPackaged: boolean,
  platform: NodeJS.Platform,
  developmentBuild = !isPackaged,
  configured = Boolean(UPDATE_BASE_URL && DESKTOP_SERVICE_URL)
): boolean {
  return configured && isPackaged && !developmentBuild && (platform === 'darwin' || platform === 'win32')
}

export function shouldCheckAfterResume(lastCheckedAt: number, now = Date.now()): boolean {
  return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS
}
