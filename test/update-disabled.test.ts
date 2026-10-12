import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  brand: { UPDATE_BASE_URL: null as string | null, DESKTOP_SERVICE_URL: null as string | null },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  policy: vi.fn(),
  identity: vi.fn(),
  prepareToInstall: vi.fn(),
  resume: vi.fn(),
  updater: {
    setFeedURL: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(), on: vi.fn()
  }
}))

vi.mock('../src/shared/brand', () => ({
  get UPDATE_BASE_URL() { return mocks.brand.UPDATE_BASE_URL },
  get DESKTOP_SERVICE_URL() { return mocks.brand.DESKTOP_SERVICE_URL },
  PRODUCT_NAME: 'HQHarness',
  WINDOWS_PUBLISHER_NAME: 'HQHarness Test Publisher',
  UPDATE_UNAVAILABLE_MESSAGE: 'HQHarness update service is not configured.',
  UPDATE_IDENTITY_UNAVAILABLE_MESSAGE: 'HQHarness update signing identity is missing or does not match the configured channel.'
}))
vi.mock('../src/main/update/update-identity', () => ({ verifyInstalledUpdateIdentity: mocks.identity }))
vi.mock('../src/main/desktop-service', () => ({ checkDesktopUpdate: mocks.policy }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks.updater } }))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.8.0', getPath: () => '/nonexistent-hqharness-test', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: mocks.resume, removeListener: vi.fn() },
  ipcMain: { handle: (channel: string, callback: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, callback) }
}))

let manager: typeof import('../src/main/update/update-manager') | undefined

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.handlers.clear()
  mocks.brand.UPDATE_BASE_URL = null
  mocks.brand.DESKTOP_SERVICE_URL = null
  mocks.identity.mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  manager?.stopUpdateManager()
  manager = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['unconfigured', 'missing-policy-service', 'development', 'missing-installed-identity', 'mismatched-installed-identity'])('blocks every update entry point for %s builds', async scenario => {
  if (scenario !== 'unconfigured') mocks.brand.UPDATE_BASE_URL = 'https://hqharness.test/updates/'
  if (scenario !== 'unconfigured' && scenario !== 'missing-policy-service') mocks.brand.DESKTOP_SERVICE_URL = 'https://hqharness.test/crash'
  if (scenario.endsWith('installed-identity')) mocks.identity.mockImplementation(() => { throw new Error(scenario) })
  manager = await import('../src/main/update/update-manager')
  manager.startUpdateManager({ prepareToInstall: mocks.prepareToInstall, developmentBuild: scenario === 'development' })
  manager.registerUpdateHandlers()

  await manager.checkForUpdates(true)
  await manager.listAvailableVersions()
  await manager.installSpecificVersion('0.9.0')
  await manager.downloadAvailableUpdate()
  await manager.installDownloadedUpdate()
  manager.skipUpdate('0.9.0')
  for (const channel of ['updates:check', 'updates:list-versions', 'updates:install-version', 'updates:download', 'updates:install', 'updates:skip']) {
    await mocks.handlers.get(channel)?.({}, '0.9.0')
  }
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)

  expect(manager.getUpdateStatus()).toMatchObject({
    phase: 'unsupported',
    message: scenario === 'development'
      ? 'HQHarness development builds do not check for updates.'
      : scenario.endsWith('installed-identity')
        ? 'HQHarness update signing identity is missing or does not match the configured channel.'
        : 'HQHarness update service is not configured.'
  })
  expect(mocks.policy).not.toHaveBeenCalled()
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(mocks.prepareToInstall).not.toHaveBeenCalled()
  for (const operation of Object.values(mocks.updater)) expect(operation).not.toHaveBeenCalled()
})
