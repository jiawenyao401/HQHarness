import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '@trycua/cua-driver'
const native = vi.hoisted(() => ({ call: vi.fn(), start: vi.fn(), windows: vi.fn(), observeWindow: vi.fn(), shutdown: vi.fn(), destroy: vi.fn() }))
vi.mock('@trycua/cua-driver', () => ({
  uniffiInitAsync: async () => undefined,
  CuaDriver: { create: () => ({ callTool: native.call, startSession: native.start, listWindows: native.windows, getWindowState: native.observeWindow, shutdown: native.shutdown, uniffiDestroy: native.destroy }) },
  StartSessionInput: { new: (input: object) => input },
  ListWindowsInput: { new: (input: object) => input },
  GetWindowStateInput: { new: (input: object) => input },
  ActionEffect: { Confirmed: 0, Partial: 1, Unverifiable: 2, SuspectedNoop: 3, Refused: 4 }
}))
import { NativeInput } from '../src/main/automation/native-input'
const result = (extras: Partial<ToolResult> = {}): ToolResult => ({ text: 'sent', images: [], isError: false, degraded: false, rawJson: '{}', ...extras })
const hostPlatform = process.platform
afterEach(() => { Object.defineProperty(process, 'platform', { value: hostPlatform }) })
beforeEach(() => { native.call.mockReset().mockResolvedValue(result()); native.start.mockReset().mockResolvedValue({ active: true, revived: false }); native.windows.mockReset().mockResolvedValue({ windows: [] }); native.observeWindow.mockReset().mockResolvedValue({ pid: 9, windowId: 10n, snapshotId: 'sdk-snapshot', elements: [], images: [] }); native.shutdown.mockReset().mockResolvedValue(undefined); native.destroy.mockReset() })
describe('native desktop adapter lifecycle and refusal', () => {
  it('does not require the target to be foreground for an exact Windows semantic click', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const driver = new NativeInput()
    native.call.mockImplementation(async (_name, args) => {
      const operation = JSON.parse(String(args))
      // Reproduce the provider's refusal while HQHarness still owns the
      // foreground HWND; the accessibility route needs no global input.
      return operation.delivery_mode === 'foreground'
        ? result({ text: 'Foreground HWND 0x20632 differs from target', action: { effect: 4, route: 2 } })
        : result({ action: { effect: 0, route: 0 } })
    })
    try {
      await expect(driver.elementClick({ pid: 9, window: '10', token: 'sdk:1' }, 'left', 1, new AbortController().signal)).resolves.toBeUndefined()
      expect(native.call).toHaveBeenCalledOnce()
      expect(JSON.parse(String(native.call.mock.calls[0]?.[1]))).toMatchObject({ pid: 9, element_token: 'sdk:1', delivery_mode: 'background' })
    } finally { await driver.close() }
  })
  it('preserves a Windows double-click as one count=2 request instead of replaying semantic clicks', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const driver = new NativeInput()
    try {
      await driver.elementClick({ pid: 9, window: '10', token: 'sdk:list-item' }, 'left', 2, new AbortController().signal)
      expect(native.call).toHaveBeenCalledOnce()
      expect(JSON.parse(String(native.call.mock.calls[0]?.[1]))).toEqual({ pid: 9, element_token: 'sdk:list-item', delivery_mode: 'background', button: 'left', count: 2 })
    } finally { await driver.close() }
  })
  it.each([
    [result({ isError: true, errorCode: 'background_unavailable', text: 'No supported background route' }), 'background_unavailable'],
    [result({ action: { effect: 4, route: 0 } }), 'INPUT_REFUSED'],
    [result({ action: { effect: 1, route: 1 } }), 'INPUT_UNCONFIRMED']
  ] as const)('does not switch or replay a refused/partial Windows click (%j)', async (outcome, code) => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const driver = new NativeInput()
    native.call.mockResolvedValueOnce(outcome)
    try {
      await expect(driver.elementClick({ pid: 9, window: '10', token: 'sdk:1' }, 'left', 2, new AbortController().signal)).rejects.toMatchObject({ code })
      expect(native.call).toHaveBeenCalledOnce()
      expect(JSON.parse(String(native.call.mock.calls[0]?.[1])).delivery_mode).toBe('background')
    } finally { await driver.close() }
  })
  it('does not dispatch a Windows semantic click after cancellation during session attachment', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const driver = new NativeInput()
    const controller = new AbortController()
    native.start.mockImplementationOnce(async () => { controller.abort(); return { active: true, revived: false } })
    try {
      await expect(driver.elementClick({ pid: 9, window: '10', token: 'sdk:1' }, 'left', 1, controller.signal)).rejects.toThrow()
      expect(native.call).not.toHaveBeenCalled()
    } finally { await driver.close() }
  })
  it('uses typed discovery and bounded tree-only observation without losing the native window identifier', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    native.start.mockResolvedValue({ active: true, revived: true })
    await driver.windows(9, signal)
    await driver.observeWindow({ pid: 9, window: '18446744073709551615' }, false, signal)
    expect(native.windows).toHaveBeenCalledWith({ pid: 9, onScreenOnly: true }, { signal })
    expect(native.observeWindow).toHaveBeenCalledWith({ pid: 9, windowId: 18446744073709551615n, includeAccessibilityTree: true, includeScreenshot: false, maxElements: 250, maxDepth: 12, maxDimension: 1280 }, { signal })
    expect(native.call).not.toHaveBeenCalled()
    await driver.close()
  })
  it('keeps window mutations bound to the observed element token and explicitly selected delivery', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    const target = { pid: 9, window: '18446744073709551615', token: 'sdk-snapshot:4' }
    await driver.elementClick(target, 'left', 1, signal)
    await driver.elementText(target, 'value', true, signal)
    await driver.elementKey(target, 'MOD+A', signal)
    expect(native.call.mock.calls.map(([name]) => name)).toEqual(['click', 'set_value', 'hotkey'])
    for (const [, args] of native.call.mock.calls) expect(JSON.parse(String(args))).toMatchObject({ pid: 9, element_token: 'sdk-snapshot:4' })
    expect(JSON.parse(String(native.call.mock.calls[0]?.[1]))).toMatchObject({ delivery_mode: process.platform === 'win32' ? 'background' : 'foreground' })
    native.start.mockResolvedValueOnce({ active: true, revived: true })
    await expect(driver.elementText(target, 'no replay', false, signal)).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(native.call).toHaveBeenCalledTimes(3)
    await driver.close()
  })
  it('leaves unverified element text for the host readback without replaying it on another route', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    native.call.mockResolvedValue(result({ action: { effect: 2, route: 0 } }))
    await expect(driver.elementText({ pid: 9, window: '10', token: 'sdk:1' }, 'once only', false, signal)).resolves.toBeUndefined()
    expect(native.call.mock.calls.map(([name]) => name)).toEqual(process.platform === 'win32' ? ['hotkey', 'type_text'] : ['type_text'])
    expect(native.shutdown).not.toHaveBeenCalled()
    await driver.close()
  })
  it('positions the Windows document caret on the exact element before delivering append text once', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const driver = new NativeInput()
    const target = { pid: 9, window: '10', token: 'sdk:1' }
    try {
      await driver.elementText(target, '中文', false, new AbortController().signal)
      expect(native.call.mock.calls.map(([name]) => name)).toEqual(['hotkey', 'type_text'])
      expect(JSON.parse(String(native.call.mock.calls[0]?.[1]))).toEqual({ pid: 9, element_token: 'sdk:1', delivery_mode: 'foreground', keys: ['CTRL', 'END'] })
      expect(JSON.parse(String(native.call.mock.calls[1]?.[1]))).toEqual({ pid: 9, element_token: 'sdk:1', delivery_mode: 'foreground', text: '中文' })
    } finally { await driver.close() }
  })
  it.each([
    [result({ action: { effect: 1, route: 2 } }), 'INPUT_UNCONFIRMED'],
    [result({ action: { effect: 4, route: 2 } }), 'INPUT_REFUSED'],
    [result({ isError: true, errorCode: 'foreground_unavailable' }), 'foreground_unavailable'],
    [result({ action: { effect: 2, route: 2, escalation: { target: 0, reason: 2 } } }), 'INPUT_UNCONFIRMED']
  ] as const)('does not send append text after caret positioning is refused or uncertain (%j)', async (outcome, code) => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const driver = new NativeInput()
    native.call.mockResolvedValueOnce(outcome)
    try {
      await expect(driver.elementText({ pid: 9, window: '10', token: 'sdk:1' }, 'must not be sent', false, new AbortController().signal)).rejects.toMatchObject({ code })
      expect(native.call.mock.calls.map(([name]) => name)).toEqual(['hotkey'])
    } finally { await driver.close() }
  })
  it('does not send append text if cancellation or session revival occurs after positioning the caret', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const driver = new NativeInput()
    const controller = new AbortController()
    const reason = new Error('stop after caret positioning')
    native.call.mockImplementationOnce(async () => { controller.abort(reason); return result() })
    try {
      await expect(driver.elementText({ pid: 9, window: '10', token: 'sdk:1' }, 'cancelled', false, controller.signal)).rejects.toBe(reason)
      expect(native.call.mock.calls.map(([name]) => name)).toEqual(['hotkey'])
      native.call.mockClear().mockResolvedValue(result())
      native.start.mockResolvedValueOnce({ active: true, revived: false }).mockResolvedValueOnce({ active: true, revived: true })
      await expect(driver.elementText({ pid: 9, window: '10', token: 'sdk:1' }, 'not replayed', false, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
      expect(native.call.mock.calls.map(([name]) => name)).toEqual(['hotkey'])
    } finally { await driver.close() }
  })
  it('reopens an ended implicit session before observing again without restarting the adapter', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    let ended = false
    native.start.mockImplementation(async () => {
      const revived = ended
      ended = false
      return { active: true, revived }
    })
    native.call.mockImplementation(async () => ended
      ? result({ isError: true, errorCode: 'session_ended', text: 'this session has ended; call start_session explicitly to reuse its label' })
      : result())
    try {
      await driver.observe(signal)
      ended = true
      await expect(driver.observe(signal)).resolves.toMatchObject({ isError: false })
      expect(native.start).toHaveBeenCalledTimes(2)
      expect(native.start).toHaveBeenLastCalledWith({}, { signal })
      expect(native.shutdown).not.toHaveBeenCalled()
    } finally { await driver.close() }
  })
  it('requires a fresh observation after revival before dispatching any input', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    await driver.observe(signal)
    native.start.mockResolvedValueOnce({ active: true, revived: true })
    await expect(driver.text('must not be replayed', signal)).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(native.call).toHaveBeenCalledTimes(1)
    await driver.observe(signal)
    await driver.text('after observing', signal)
    expect(native.call).toHaveBeenCalledTimes(3)
    await driver.close()
  })
  it('does not dispatch input if session start fails or access was revoked during start', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    native.start.mockResolvedValueOnce({ active: false, revived: false })
    await expect(driver.observe(signal)).rejects.toMatchObject({ code: 'NATIVE_SESSION_UNAVAILABLE' })
    expect(native.call).not.toHaveBeenCalled()
    const controller = new AbortController()
    native.start.mockImplementationOnce(async () => {
      controller.abort()
      return { active: true, revived: true }
    })
    await expect(driver.text('never sent', controller.signal)).rejects.toThrow()
    expect(native.call).not.toHaveBeenCalled()
    await driver.close()
  })
  it('passes native pixel coordinates to the explicit primary desktop target', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    await driver.click({ x: 1920, y: 1080 }, 'left', 1, signal)
    const [name, args, options] = native.call.mock.calls[0] ?? []
    expect(name).toBe('click')
    expect(JSON.parse(String(args))).toMatchObject({ target: { kind: 'desktop', display_id: 'primary' }, delivery_mode: 'foreground', x: 1920, y: 1080 })
    expect(options).toEqual({ signal })
    await driver.close()
    expect(native.shutdown).toHaveBeenCalledOnce()
    expect(native.destroy).toHaveBeenCalledOnce()
  })
  it('preserves refusal and never reports partial input as successful', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    native.call.mockResolvedValueOnce(result({ isError: true, errorCode: 'PERMISSION_REQUIRED', text: 'access denied' }))
    await expect(driver.text('value', signal)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED', message: 'access denied' })
    native.call.mockResolvedValueOnce(result({ action: { effect: 1, route: 2 } }))
    await expect(driver.key('ENTER', signal)).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' })
    await driver.close()
  })
  it('does not admit cancelled input and waits for shutdown before reopening', async () => {
    const driver = new NativeInput()
    const cancelled = new AbortController(); cancelled.abort()
    await expect(driver.text('never sent', cancelled.signal)).rejects.toThrow()
    expect(native.call).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    await driver.observe(signal)
    let release: () => void = () => undefined
    native.shutdown.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const closing = driver.close()
    const next = driver.text('after teardown', signal)
    await Promise.resolve(); await Promise.resolve()
    expect(native.call).toHaveBeenCalledTimes(1)
    release(); await closing; await next
    expect(native.call).toHaveBeenCalledTimes(2)
    await driver.close()
  })
})
