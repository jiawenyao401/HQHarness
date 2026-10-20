import { beforeEach, describe, expect, it, vi } from 'vitest'
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
beforeEach(() => { native.call.mockReset().mockResolvedValue(result()); native.start.mockReset().mockResolvedValue({ active: true, revived: false }); native.windows.mockReset().mockResolvedValue({ windows: [] }); native.observeWindow.mockReset().mockResolvedValue({ pid: 9, windowId: 10n, snapshotId: 'sdk-snapshot', elements: [], images: [] }); native.shutdown.mockReset().mockResolvedValue(undefined); native.destroy.mockReset() })
describe('native desktop adapter lifecycle and refusal', () => {
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
    expect(JSON.parse(String(native.call.mock.calls[0]?.[1]))).toMatchObject({ delivery_mode: 'foreground' })
    native.start.mockResolvedValueOnce({ active: true, revived: true })
    await expect(driver.elementText(target, 'no replay', false, signal)).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(native.call).toHaveBeenCalledTimes(3)
    await driver.close()
  })
  it('never silently accepts unverified element text or replays it on another route', async () => {
    const driver = new NativeInput()
    const signal = new AbortController().signal
    native.call.mockResolvedValueOnce(result({ action: { effect: 2, route: 0 } }))
    await expect(driver.elementText({ pid: 9, window: '10', token: 'sdk:1' }, 'once only', false, signal)).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' })
    expect(native.call).toHaveBeenCalledOnce()
    expect(native.shutdown).not.toHaveBeenCalled()
    await driver.close()
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
