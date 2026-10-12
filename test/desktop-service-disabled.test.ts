import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  serviceUrl: null as string | null,
  getPath: vi.fn(),
  request: vi.fn(),
  consent: vi.fn()
}))

vi.mock('../src/shared/brand', () => ({
  get DESKTOP_SERVICE_URL() { return mocks.serviceUrl },
  UPDATE_BASE_URL: null,
  UPDATE_UNAVAILABLE_MESSAGE: 'HQHarness update service is not configured.'
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: mocks.getPath },
  net: { fetch: mocks.request },
  dialog: { showMessageBox: mocks.consent }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.serviceUrl = null
})

it.each([false, true])('does not initialize a remote diagnostic service without an HQ endpoint (development=%s)', async development => {
  const desktop = await import('../src/main/desktop-service')
  desktop.initializeDesktopService(development)
  await expect(desktop.checkDesktopUpdate()).rejects.toThrow('HQHarness update service is not configured.')
  expect(desktop.desktopDiagnostics).toBeUndefined()
  expect(mocks.getPath).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(mocks.consent).not.toHaveBeenCalled()
})

it('keeps packaged development builds local even when an HQ diagnostic endpoint is configured', async () => {
  mocks.serviceUrl = 'https://hqharness.test/crash'
  const desktop = await import('../src/main/desktop-service')
  desktop.initializeDesktopService(true)
  expect(desktop.desktopDiagnostics).toBeUndefined()
  expect(mocks.getPath).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(mocks.consent).not.toHaveBeenCalled()
})
