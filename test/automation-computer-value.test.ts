import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResult, WindowElement, WindowStateOutput } from '@trycua/cua-driver'
const native = vi.hoisted(() => ({ call: vi.fn(), observe: vi.fn(), start: vi.fn(), shutdown: vi.fn() }))
vi.mock('@trycua/cua-driver', () => ({
  uniffiInitAsync: async () => undefined,
  CuaDriver: { create: () => ({ callTool: native.call, getWindowState: native.observe, startSession: native.start, shutdown: native.shutdown }) },
  StartSessionInput: { new: (input: object) => input }, GetWindowStateInput: { new: (input: object) => input },
  ActionEffect: { Confirmed: 0, Partial: 1, Unverifiable: 2, SuspectedNoop: 3, Refused: 4 }
}))
vi.mock('electron', () => ({
  screen: { getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1, rotation: 0 }] },
  systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => 'granted' }
}))
import { ComputerAutomation } from '../src/main/automation/computer'
const valueElement = (value: string | undefined, index = 1n): WindowElement => ({ elementIndex: index, elementToken: `sdk:${index}`, role: 'Edit', depth: 1, label: 'Query', value, actions: ['set_value'], enabled: true })
const valueState = (value: string | undefined): WindowStateOutput => ({ pid: 9, windowId: 10n, snapshotId: 'sdk', elementsComplete: true, images: [], elements: [valueElement(value)] })
const acceptedWithoutReadback = (extras: Partial<ToolResult> = {}): ToolResult => ({ text: 'accepted', images: [], isError: false, degraded: false, rawJson: '{}', action: { effect: 2, route: 0 }, ...extras })
beforeEach(() => {
  native.call.mockReset().mockResolvedValue(acceptedWithoutReadback())
  native.observe.mockReset().mockResolvedValue(valueState('initial'))
  native.start.mockReset().mockResolvedValue({ active: true, revived: false })
  native.shutdown.mockReset().mockResolvedValue(undefined)
})
describe('Cua 0.28 unverified text outcomes and host readback', () => {
  it.each(['', 'initial'])('confirms one unverified append only against its known baseline %j and a fresh exact value', async baseline => {
    const computer = new ComputerAutomation()
    const signal = new AbortController().signal
    native.observe.mockResolvedValue(valueState(baseline))
    try {
      const observation = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal)
      native.call.mockImplementationOnce(async () => {
        native.observe.mockResolvedValue(valueState(baseline + '中文'))
        return acceptedWithoutReadback()
      })
      const result = await computer.execute('a', { action: 'type', snapshot: String(observation.snapshot), target: { name: 'Query' }, text: '中文' }, signal)
      expect(result).toMatchObject({ verified: true, inputSent: 'type', elements: [{ value: baseline + '中文' }] })
      expect(result.snapshot).not.toBe(observation.snapshot)
      expect(native.observe).toHaveBeenCalledTimes(2)
      expect(native.call).toHaveBeenCalledOnce()
      expect(native.call.mock.calls[0]?.[0]).toBe('type_text')
      expect(JSON.parse(String(native.call.mock.calls[0]?.[1]))).toMatchObject({ pid: 9, element_token: 'sdk:1', delivery_mode: 'foreground', text: '中文' })
    } finally { await computer.close() }
  })
  it('rejects an unverified append whose fresh value does not match, without replaying input', async () => {
    const computer = new ComputerAutomation()
    const signal = new AbortController().signal
    try {
      const observation = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal)
      await expect(computer.execute('a', { action: 'type', snapshot: String(observation.snapshot), target: { name: 'Query' }, text: 'missing' }, signal)).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' })
      expect(native.observe.mock.calls.length).toBeGreaterThan(2)
      expect(native.call).toHaveBeenCalledOnce()
      expect(native.call.mock.calls[0]?.[0]).toBe('type_text')
      await expect(computer.execute('a', { action: 'type', snapshot: String(observation.snapshot), target: { name: 'Query' }, text: 'missing' }, signal)).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
      expect(native.call).toHaveBeenCalledOnce()
    } finally { await computer.close() }
  })
  it('does not confirm an unverified append against multiple fresh controls with the same name and role', async () => {
    const computer = new ComputerAutomation()
    const signal = new AbortController().signal
    try {
      const observation = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal)
      native.call.mockImplementationOnce(async () => {
        native.observe.mockResolvedValue({ ...valueState('initial中文'), elements: [valueElement('initial中文'), valueElement('initial中文', 2n)] })
        return acceptedWithoutReadback()
      })
      await expect(computer.execute('a', { action: 'type', snapshot: String(observation.snapshot), target: { name: 'Query' }, text: '中文' }, signal)).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' })
      expect(native.observe).toHaveBeenCalledTimes(2)
      expect(native.call).toHaveBeenCalledOnce()
    } finally { await computer.close() }
  })
  it('does not assume an omitted baseline is empty or dispatch an append that cannot be verified', async () => {
    const computer = new ComputerAutomation()
    const signal = new AbortController().signal
    native.observe.mockResolvedValue(valueState(undefined))
    try {
      const observation = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal)
      await expect(computer.execute('a', { action: 'type', snapshot: String(observation.snapshot), target: { name: 'Query' }, text: '中文' }, signal)).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' })
      expect(native.call).not.toHaveBeenCalled()
      expect(native.observe).toHaveBeenCalledOnce()
    } finally { await computer.close() }
  })
  it('accepts an unverified replacement only after a fresh unique native value matches exactly', async () => {
    const computer = new ComputerAutomation()
    const signal = new AbortController().signal
    try {
      const observation = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal)
      native.call.mockImplementationOnce(async () => {
        native.observe.mockResolvedValue(valueState('中文'))
        return acceptedWithoutReadback()
      })
      const result = await computer.execute('a', { action: 'type', snapshot: String(observation.snapshot), target: { name: 'Query' }, text: '中文', replace: true }, signal)
      expect(result.verified).toBe(true)
      expect(result.snapshot).not.toBe(observation.snapshot)
      expect(native.observe).toHaveBeenCalledTimes(2)
      expect(native.call).toHaveBeenCalledOnce()
      expect(native.call.mock.calls[0]?.[0]).toBe('set_value')
    } finally { await computer.close() }
  })
  it('does not turn accepted replacement into success when its value never appears, and never replays it', async () => {
    const computer = new ComputerAutomation()
    const signal = new AbortController().signal
    try {
      const observation = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal)
      await expect(computer.execute('a', { action: 'type', snapshot: String(observation.snapshot), target: { name: 'Query' }, text: 'missing', replace: true }, signal)).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' })
      expect(native.observe.mock.calls.length).toBeGreaterThan(2)
      expect(native.call).toHaveBeenCalledOnce()
    } finally { await computer.close() }
  })
  it.each([false, true])('keeps partial, refused and escalation outcomes authoritative without another route (replace=%s)', async replace => {
    const computer = new ComputerAutomation()
    const signal = new AbortController().signal
    try {
      for (const [outcome, code] of [
        [acceptedWithoutReadback({ action: { effect: 1, route: 0 } }), 'INPUT_UNCONFIRMED'],
        [acceptedWithoutReadback({ isError: true, errorCode: 'PERMISSION_REQUIRED' }), 'PERMISSION_REQUIRED'],
        [acceptedWithoutReadback({ action: { effect: 4, route: 0 } }), 'INPUT_REFUSED'],
        [acceptedWithoutReadback({ action: { effect: 2, route: 0, escalation: { target: 0, reason: 2 } } }), 'INPUT_UNCONFIRMED']
      ] as const) {
        const observation = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal)
        native.call.mockResolvedValueOnce(outcome)
        const beforeObservations = native.observe.mock.calls.length
        await expect(computer.execute('a', { action: 'type', snapshot: String(observation.snapshot), target: { name: 'Query' }, text: 'once only', replace }, signal)).rejects.toMatchObject({ code })
        expect(native.observe).toHaveBeenCalledTimes(beforeObservations)
      }
      expect(native.call).toHaveBeenCalledTimes(4)
    } finally { await computer.close() }
  })
})
