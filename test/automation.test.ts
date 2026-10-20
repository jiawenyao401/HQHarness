import { describe, expect, it } from 'vitest'
import { AutomationGate } from '../src/main/automation/gate'
import { automationUrl, validateAutomationRequest } from '../src/shared/automation'
import { framePoint, type DesktopFrame } from '../src/main/automation/computer'
import { parseAutomationKey } from '../src/main/automation/native-input'
import { vi } from 'vitest'
vi.mock('electron', () => ({ desktopCapturer: {}, screen: {}, systemPreferences: {} }))

const request = (operation: Record<string, unknown>, capability = 'browser') => ({ owner: 'session-1', capability, operation })
describe('automation input boundary', () => {
  it('allows only web URLs without credentials', () => {
    expect(automationUrl('https://example.com/')).toBe('https://example.com/')
    for (const url of ['file:///tmp/test', 'javascript:alert(1)', 'https://secret@example.com/', 'x-apple.systempreferences:test']) expect(() => automationUrl(url)).toThrow()
  })
  it('rejects commands, invalid fields, non-finite coordinates and incomplete actions', () => {
    for (const input of [request({ action: 'execute', command: 'rm' }), request({ action: 'open', url: 'file:///a' }), request({ action: 'click', x: NaN, y: 0 }), request({ action: 'drag', x: 2, y: 3 }, 'computer'), { ...request({ action: 'status' }), token: 'untrusted' }]) expect(() => validateAutomationRequest(input)).toThrow()
    expect(validateAutomationRequest(request({ action: 'click', ref: 'e1', snapshot: 's1' })).operation.ref).toBe('e1')
  })
  it('maps screenshot pixels to the observed display including negative origins', () => {
    const frame: DesktopFrame = { id: 's', display: '1', width: 1000, height: 500, bounds: { x: -2000, y: -100, width: 2000, height: 1000 }, topology: 'one', capturedAt: Date.now() }
    expect(framePoint(frame, 500, 250)).toEqual({ x: -1000, y: 400 })
    expect(() => framePoint(frame, 1000, 20)).toThrow()
  })
  it('parses platform modifiers and refuses arbitrary key names', () => {
    expect(parseAutomationKey('MOD+A', 'darwin').modifiers).toEqual(['CMD'])
    expect(parseAutomationKey('MOD+A', 'win32')).toMatchObject({ modifiers: ['CTRL'], code: 65 })
    expect(parseAutomationKey('ENTER', 'win32').code).toBe(13)
    expect(() => parseAutomationKey('CMD+A', 'win32')).toThrow()
    expect(() => parseAutomationKey('SHIFT+SHIFT+A', 'darwin')).toThrow()
    expect(() => parseAutomationKey('RUN_SHELL', 'win32')).toThrow()
  })
})
describe('automation grants and queue', () => {
  it('does not misreport an aborted consent dialog as an explicit user denial', async () => {
    const gate = new AutomationGate()
    const controller = new AbortController()
    const reason = new Error('authorization timed out')
    const work = vi.fn(async () => 'must not run')
    await expect(gate.run('computer', 'a', controller.signal, async () => {
      controller.abort(reason)
      return false
    }, work)).rejects.toBe(reason)
    expect(work).not.toHaveBeenCalled()
    expect(gate.activeSessions).toBe(0)
  })
  it('keeps later operations runnable after a native session error and reauthorizes after stop', async () => {
    const gate = new AutomationGate()
    const signal = new AbortController().signal
    const consent = vi.fn(async () => true)
    await expect(gate.run('computer', 'a', signal, consent, async () => { throw new Error('session_ended') })).rejects.toThrow('session_ended')
    await expect(gate.run('computer', 'a', signal, consent, async () => 'observed')).resolves.toBe('observed')
    expect(consent).toHaveBeenCalledTimes(1)
    gate.stop()
    await expect(gate.run('computer', 'a', signal, consent, async () => 'observed after consent')).resolves.toBe('observed after consent')
    expect(consent).toHaveBeenCalledTimes(2)
  })
  it('serializes mutations, keeps consent session/capability scoped and expires it', async () => {
    let now = 0
    const gate = new AutomationGate(() => now)
    const consent = vi.fn(async () => true)
    const work = vi.fn(async () => 1)
    const signal = new AbortController().signal
    await gate.run('browser', 'a', signal, consent, work)
    await gate.run('browser', 'a', signal, consent, work)
    await gate.run('computer', 'a', signal, consent, work)
    await gate.run('browser', 'b', signal, consent, work)
    expect(consent).toHaveBeenCalledTimes(3)
    now = 31 * 60_000
    await gate.run('browser', 'a', signal, consent, work)
    expect(consent).toHaveBeenCalledTimes(4)
  })
  it('stop revokes a consent in flight and queued operations before side effects', async () => {
    const gate = new AutomationGate()
    let approve: (value: boolean) => void = () => undefined
    const consent = () => new Promise<boolean>(resolve => { approve = resolve })
    const work = vi.fn(async () => 1)
    const first = gate.run('browser', 'a', new AbortController().signal, consent, work)
    const second = gate.run('computer', 'b', new AbortController().signal, async () => true, work)
    const errors = Promise.allSettled([first, second])
    await Promise.resolve(); await Promise.resolve()
    gate.stop(); approve(true)
    expect((await errors).map(value => value.status)).toEqual(['rejected', 'rejected'])
    expect(work).not.toHaveBeenCalled()
    expect(gate.activeSessions).toBe(0)
  })
  it('declined/cancelled calls do not acquire a grant or perform input', async () => {
    const gate = new AutomationGate()
    const work = vi.fn(async () => 1)
    await expect(gate.run('computer', 'a', new AbortController().signal, async () => false, work)).rejects.toThrow('declined')
    const controller = new AbortController(); controller.abort()
    await expect(gate.run('browser', 'a', controller.signal, async () => true, work)).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
  })
})
