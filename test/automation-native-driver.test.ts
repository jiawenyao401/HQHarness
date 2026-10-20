import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '@trycua/cua-driver'
const native = vi.hoisted(() => ({ call: vi.fn(), start: vi.fn(), shutdown: vi.fn(), destroy: vi.fn() }))
vi.mock('@trycua/cua-driver', () => ({
  uniffiInitAsync: async () => undefined,
  CuaDriver: { create: () => ({ callTool: native.call, startSession: native.start, shutdown: native.shutdown, uniffiDestroy: native.destroy }) },
  StartSessionInput: { new: (input: object) => input },
  ActionEffect: { Confirmed: 0, Partial: 1, Unverifiable: 2, SuspectedNoop: 3, Refused: 4 }
}))
import { NativeInput } from '../src/main/automation/native-input'
const result = (extras: Partial<ToolResult> = {}): ToolResult => ({ text: 'sent', images: [], isError: false, degraded: false, rawJson: '{}', ...extras })
beforeEach(() => { native.call.mockReset().mockResolvedValue(result()); native.start.mockReset().mockResolvedValue({ active: true, revived: false }); native.shutdown.mockReset().mockResolvedValue(undefined); native.destroy.mockReset() })
describe('native desktop adapter lifecycle and refusal', () => {
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
