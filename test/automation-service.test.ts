import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
const fakes = vi.hoisted(() => ({ dialog: vi.fn(async (_window: BrowserWindow, _options: { signal?: AbortSignal }) => ({ response: 0 })), handlers: new Map<string, (event: unknown) => unknown>() }))
vi.mock('electron', () => ({
  BrowserWindow: class {}, session: {},
  dialog: { showMessageBox: fakes.dialog },
  globalShortcut: { register: () => true, unregister: vi.fn() },
  ipcMain: { removeHandler: (name: string) => fakes.handlers.delete(name), handle: (name: string, callback: (event: unknown) => unknown) => fakes.handlers.set(name, callback) },
  shell: { openExternal: vi.fn() },
  desktopCapturer: {}, screen: {},
  systemPreferences: { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => 'denied' }
}))
import { DesktopAutomationService } from '../src/main/automation/service'
import { ComputerAutomation } from '../src/main/automation/computer'
import { AutomationError } from '../src/shared/automation'

const services: DesktopAutomationService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.restoreAllMocks(); fakes.dialog.mockReset().mockResolvedValue({ response: 0 }) })
async function endpoint(parent?: BrowserWindow, timeouts = { authorizationMs: 120_000, operationMs: 30_000 }) {
  const service = new DesktopAutomationService(() => parent, () => 'en', timeouts)
  services.push(service); await service.start()
  const env = service.environment()
  const url = env.HQHARNESS_AUTOMATION_URL
  if (!url) throw new Error('Missing endpoint')
  return { service, url, authorization: `Bearer ${env.HQHARNESS_AUTOMATION_TOKEN}` }
}
function hostWindow() {
  return Object.assign(new BrowserWindow({ show: false }), { isDestroyed: () => false, isMinimized: () => true, isVisible: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), flashFrame: vi.fn() })
}
const operationBody = (capability: 'browser' | 'computer') => JSON.stringify({ capability, owner: 's1', operation: { action: capability === 'browser' ? 'tabs' : 'observe' } })
describe('native automation authenticated transport', () => {
  it('reports authorization failure time without claiming any engine execution', async () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fakes.dialog.mockImplementationOnce(async () => { now = 130; return { response: 0 } })
    const { url, authorization } = await endpoint(hostWindow())
    const response = await fetch(url, { method: 'POST', headers: { authorization }, body: operationBody('computer') })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'DENIED', host_timing: { queue_and_consent_ms: 30, execute_ms: 0, total_ms: 30 } })
  })
  it.each([
    { started: 0, admitted: 0, finished: 45, queue: 0 },
    { started: 100, admitted: 130, finished: 175, queue: 30 }
  ])('preserves execution failure stages including a zero admission timestamp: %j', async timing => {
    let now = timing.started
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    fakes.dialog.mockImplementationOnce(async () => { now = timing.admitted; return { response: 1 } })
    vi.spyOn(ComputerAutomation.prototype, 'execute').mockImplementationOnce(async () => {
      now = timing.finished
      throw new AutomationError('NATIVE_INPUT_REFUSED', 'Native input was refused')
    })
    const { url, authorization } = await endpoint(hostWindow())
    const response = await fetch(url, { method: 'POST', headers: { authorization }, body: operationBody('computer') })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: 'NATIVE_INPUT_REFUSED', error: 'Native input was refused', host_timing: { queue_and_consent_ms: timing.queue, execute_ms: 45, total_ms: timing.queue + 45 } })
  })
  it('returns zero execution time when validation fails before engine admission', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const { url, authorization } = await endpoint()
    const response = await fetch(url, { method: 'POST', headers: { authorization }, body: '{}' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT', host_timing: { queue_and_consent_ms: 0, execute_ms: 0, total_ms: 0 } })
    expect(fakes.dialog).not.toHaveBeenCalled()
  })
  it('restores and foregrounds a hidden/minimized host before requesting native consent', async () => {
    // Only the BrowserWindow methods used by consent are required by this
    // Electron boundary fixture; no real application window is manipulated.
    const window = hostWindow()
    const { url, authorization } = await endpoint(window)
    const response = await fetch(url, { method: 'POST', headers: { authorization }, body: JSON.stringify({ capability: 'browser', owner: 's1', operation: { action: 'tabs' } }) })
    expect((await response.json()).code).toBe('DENIED')
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(fakes.dialog).toHaveBeenCalledOnce()
    expect(window.flashFrame.mock.calls).toEqual([[true], [false]])
  })
  it.each(['browser', 'computer'] as const)('returns a distinct %s consent timeout and accepts a new attempt without restarting', async capability => {
    const computerWork = vi.spyOn(ComputerAutomation.prototype, 'execute')
    // Electron returns Cancel when AbortSignal closes its native dialog.
    fakes.dialog.mockImplementationOnce(async (_window, options) => new Promise(resolve => {
      options.signal?.addEventListener('abort', () => resolve({ response: 0 }), { once: true })
    }))
    const { service, url, authorization } = await endpoint(hostWindow(), { authorizationMs: 50, operationMs: 1_000 })
    const response = await fetch(url, { method: 'POST', headers: { authorization }, body: operationBody(capability) })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'CONSENT_TIMEOUT', error: expect.stringContaining('no action was performed') })
    expect(service.status().activeSessions).toBe(0)
    expect(computerWork).not.toHaveBeenCalled()
    fakes.dialog.mockResolvedValueOnce({ response: 1 })
    const retry = await fetch(url, { method: 'POST', headers: { authorization }, body: operationBody('browser') })
    expect(retry.status).toBe(200)
    expect(service.status().activeSessions).toBe(1)
    expect(fakes.dialog).toHaveBeenCalledTimes(2)
  })
  it('allows approval to take longer than the independent operation budget', async () => {
    fakes.dialog.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return { response: 1 }
    })
    const { url, authorization } = await endpoint(hostWindow(), { authorizationMs: 2_000, operationMs: 50 })
    const response = await fetch(url, { method: 'POST', headers: { authorization }, body: operationBody('browser') })
    expect(response.status).toBe(200)
  })
  it('keeps explicit stop distinct from refusal and allows subsequent authorization', async () => {
    let opened: () => void = () => undefined
    const ready = new Promise<void>(resolve => { opened = resolve })
    fakes.dialog.mockImplementationOnce(async (_window, options) => new Promise(resolve => {
      options.signal?.addEventListener('abort', () => resolve({ response: 0 }), { once: true })
      opened()
    }))
    const { service, url, authorization } = await endpoint(hostWindow())
    const pending = fetch(url, { method: 'POST', headers: { authorization }, body: operationBody('computer') })
    await ready
    service.stop()
    expect(await (await pending).json()).toMatchObject({ code: 'STOPPED' })
    expect(service.status().activeSessions).toBe(0)
    fakes.dialog.mockResolvedValueOnce({ response: 1 })
    expect((await fetch(url, { method: 'POST', headers: { authorization }, body: operationBody('browser') })).status).toBe(200)
  })
  it('reports an unavailable parent window instead of claiming the user declined', async () => {
    const { url, authorization } = await endpoint()
    const response = await fetch(url, { method: 'POST', headers: { authorization }, body: JSON.stringify({ capability: 'computer', owner: 's1', operation: { action: 'observe' } }) })
    expect((await response.json()).code).toBe('CONSENT_UNAVAILABLE')
    expect(fakes.dialog).not.toHaveBeenCalled()
  })
  it('accepts a token-bound loopback request and refuses browser Origins or wrong tokens', async () => {
    const { url, authorization } = await endpoint()
    const body = JSON.stringify({ capability: 'browser', owner: 's1', operation: { action: 'status' } })
    const refused: Record<string, string>[] = [{ authorization: 'wrong' }, { authorization, Origin: 'https://evil.example' }, { authorization, Origin: '' }]
    for (const headers of refused) {
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(403)
    }
    const response = await fetch(url, { method: 'POST', headers: { authorization }, body })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ supported: true })
  })
  it('invalidates the old bearer when Harness restarts', async () => {
    const { service, url, authorization } = await endpoint()
    service.environment()
    expect((await fetch(url, { method: 'POST', headers: { authorization }, body: '{}' })).status).toBe(403)
  })
  it('refuses malformed and oversized operation bodies with no side effect', async () => {
    const { url, authorization } = await endpoint()
    for (const body of ['{invalid', JSON.stringify({ capability: 'computer', owner: 'a', operation: { action: 'shell', command: 'not allowed' } }), JSON.stringify({ text: 'a'.repeat(20_000) })]) {
      expect((await fetch(url, { method: 'POST', headers: { authorization }, body })).status).toBe(400)
    }
    expect(fakes.dialog).not.toHaveBeenCalled()
  })
  it('checks IPC sender trust before permission prompts and stopping', async () => {
    const { service } = await endpoint()
    service.registerIpc(() => { throw new Error('Untrusted frame') })
    expect(() => fakes.handlers.get('hq:automation:permissions')?.({})).toThrow('Untrusted frame')
    expect(() => fakes.handlers.get('hq:automation:stop')?.({})).toThrow('Untrusted frame')
  })
})
