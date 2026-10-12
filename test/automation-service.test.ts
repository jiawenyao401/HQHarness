import { afterEach, describe, expect, it, vi } from 'vitest'
const fakes = vi.hoisted(() => ({ dialog: vi.fn(async () => ({ response: 0 })), handlers: new Map<string, (event: unknown) => unknown>() }))
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

const services: DesktopAutomationService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); fakes.dialog.mockClear() })
async function endpoint() {
  const service = new DesktopAutomationService(() => undefined, () => 'en')
  services.push(service); await service.start()
  const env = service.environment()
  const url = env.HQHARNESS_AUTOMATION_URL
  if (!url) throw new Error('Missing endpoint')
  return { service, url, authorization: `Bearer ${env.HQHARNESS_AUTOMATION_TOKEN}` }
}
describe('native automation authenticated transport', () => {
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
