import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  policy: vi.fn(), handlers: new Map<string, (...args: any[]) => void>(),
  updater: { setFeedURL: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), on: vi.fn(), autoDownload: false, allowDowngrade: false, allowPrerelease: false }
}))
vi.mock('../src/shared/brand', () => ({ PRODUCT_NAME: 'HQHarness', UPDATE_BASE_URL: 'https://hqharness.test/updates/', DESKTOP_SERVICE_URL: 'https://hqharness.test/crash', WINDOWS_PUBLISHER_NAME: 'HQHarness Test Publisher', UPDATE_UNAVAILABLE_MESSAGE: 'HQHarness update service is not configured.', UPDATE_IDENTITY_UNAVAILABLE_MESSAGE: 'HQHarness update signing identity is missing or does not match the configured channel.' }))
vi.mock('../src/main/update/update-identity', () => ({ verifyInstalledUpdateIdentity: vi.fn() }))
vi.mock('../src/main/desktop-service', () => ({ checkDesktopUpdate: mocks.policy }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks.updater } }))
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '0.8.0', getPath: () => '/nonexistent-desktop-test', isReady: () => true }, BrowserWindow: { getAllWindows: () => [] }, powerMonitor: { on: vi.fn(), removeListener: vi.fn() }, ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/update/update-policy', async importOriginal => ({ ...await importOriginal<object>(), supportsAutoUpdates: () => true }))
let manager: typeof import('../src/main/update/update-manager')
const metadata = (version: string, url = 'hqharness-windows-x64-setup.exe') => ({ version, files: [{ url, sha512: 'test-checksum', size: 123 }] })
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); mocks.handlers.clear()
  mocks.updater.on.mockImplementation((event, callback) => { mocks.handlers.set(event, callback) })
  mocks.updater.downloadUpdate.mockResolvedValue([])
  manager = await import('../src/main/update/update-manager')
  manager.startUpdateManager({ prepareToInstall: async () => {}, developmentBuild: false })
})
afterEach(() => manager.stopUpdateManager())
it('does not contact latest or download when no rule is selected, even for a manual check', async () => {
  mocks.policy.mockResolvedValue({ updateAvailable: false })
  await manager.checkForUpdates(true)
  expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
  expect(mocks.updater.setFeedURL).not.toHaveBeenCalled()
  expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
  expect(manager.getUpdateStatus().phase).toBe('up-to-date')
})
it('fails closed when the policy service fails', async () => {
  mocks.policy.mockRejectedValue(new Error('policy offline'))
  await manager.checkForUpdates()
  expect(manager.getUpdateStatus().phase).toBe('error')
  expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
})
it('pins the archive, holds the existing lock, and waits for user acceptance to download', async () => {
  let resolve!: (value: unknown) => void
  mocks.policy.mockReturnValue(new Promise(r => { resolve = r }))
  mocks.updater.checkForUpdates.mockImplementation(async () => { const info = metadata('0.9.0'); mocks.handlers.get('update-available')!(info); return { updateInfo: info } })
  const checking = manager.checkForUpdates()
  await manager.checkForUpdates(true)
  expect(mocks.policy).toHaveBeenCalledTimes(1)
  resolve({ updateAvailable: true, version: '0.9.0', feedUrl: 'https://hqharness.test/updates/archive/0.9.0/' })
  await checking
  expect(mocks.updater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'https://hqharness.test/updates/archive/0.9.0/' })
  expect(manager.getUpdateStatus().phase).toBe('available')
  expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
  await manager.downloadAvailableUpdate(); expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(1)
})
it('blocks mismatched metadata before it can enter the download UI', async () => {
  mocks.policy.mockResolvedValue({ updateAvailable: true, version: '0.9.0', feedUrl: 'https://hqharness.test/updates/archive/0.9.0/' })
  mocks.updater.checkForUpdates.mockImplementation(async () => { const info = metadata('0.10.0'); mocks.handlers.get('update-available')!(info); expect(manager.getUpdateStatus().phase).toBe('error'); return { updateInfo: info } })
  await manager.checkForUpdates()
  await manager.downloadAvailableUpdate()
  expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
})
it('preserves explicitly selected history installs and validates version input', async () => {
  mocks.updater.checkForUpdates.mockImplementation(async () => { const info = metadata('0.7.0'); mocks.handlers.get('update-available')!(info); return { updateInfo: info } })
  await manager.installSpecificVersion('../../unsafe')
  expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
  await manager.installSpecificVersion('0.7.0')
  expect(mocks.policy).not.toHaveBeenCalled()
  expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  expect(mocks.updater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'https://hqharness.test/updates/archive/0.7.0/' })
  expect(mocks.updater.allowDowngrade).toBe(false)
})

it.each([false, true])('rejects cross-origin metadata before offering or downloading a %s history update', async history => {
  const version = history ? '0.7.0' : '0.9.0'
  mocks.policy.mockResolvedValue({ updateAvailable: true, version, feedUrl: `https://hqharness.test/updates/archive/${version}/` })
  mocks.updater.checkForUpdates.mockImplementation(async () => {
    const info = metadata(version, 'https://another.test/unsigned.exe')
    mocks.handlers.get('update-available')!(info)
    expect(manager.getUpdateStatus().phase).toBe('error')
    return { updateInfo: info }
  })
  if (history) await manager.installSpecificVersion(version)
  else await manager.checkForUpdates(true)
  await manager.downloadAvailableUpdate()
  expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
  expect(manager.getUpdateStatus()).toMatchObject({ phase: 'error', message: 'Update download URL is outside the configured origin' })
})

it('revalidates metadata when the user accepts a download', async () => {
  const info = metadata('0.9.0')
  mocks.policy.mockResolvedValue({ updateAvailable: true, version: info.version, feedUrl: 'https://hqharness.test/updates/archive/0.9.0/' })
  mocks.updater.checkForUpdates.mockImplementation(async () => { mocks.handlers.get('update-available')!(info); return { updateInfo: info } })
  await manager.checkForUpdates(true)
  expect(manager.getUpdateStatus().phase).toBe('available')
  info.files[0]!.url = 'https://another.test/unsigned.exe'
  await manager.downloadAvailableUpdate()
  expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
  expect(manager.getUpdateStatus().phase).toBe('error')
})
