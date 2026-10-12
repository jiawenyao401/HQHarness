import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '@trycua/cua-driver'
const native = vi.hoisted(() => ({ call: vi.fn(), shutdown: vi.fn(), destroy: vi.fn() }))
vi.mock('@trycua/cua-driver', () => ({
  uniffiInitAsync: async () => undefined,
  CuaDriver: { create: () => ({ callTool: native.call, shutdown: native.shutdown, uniffiDestroy: native.destroy }) },
  ActionEffect: { Confirmed: 0, Partial: 1, Unverifiable: 2, SuspectedNoop: 3, Refused: 4 }
}))
import { NativeInput } from '../src/main/automation/native-input'
const result = (extras: Partial<ToolResult> = {}): ToolResult => ({ text: 'sent', images: [], isError: false, degraded: false, rawJson: '{}', ...extras })
beforeEach(() => { native.call.mockReset().mockResolvedValue(result()); native.shutdown.mockReset().mockResolvedValue(undefined); native.destroy.mockReset() })
describe('native desktop adapter lifecycle and refusal', () => {
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
