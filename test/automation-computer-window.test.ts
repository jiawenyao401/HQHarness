import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowElement, WindowStateOutput } from '@trycua/cua-driver'
const native = vi.hoisted(() => ({ windows: vi.fn(), observeWindow: vi.fn(), observe: vi.fn(), elementClick: vi.fn(), elementText: vi.fn(), elementKey: vi.fn(), elementScroll: vi.fn(), click: vi.fn(), close: vi.fn() }))
vi.mock('../src/main/automation/native-input', () => ({ NativeInput: class { windows = native.windows; observeWindow = native.observeWindow; observe = native.observe; elementClick = native.elementClick; elementText = native.elementText; elementKey = native.elementKey; elementScroll = native.elementScroll; click = native.click; close = native.close } }))
vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }), getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1, rotation: 0 }] },
  systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => 'granted' },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 720 }), resize() { return this }, toPNG: () => Buffer.from('png') }) }
}))
import { ComputerAutomation } from '../src/main/automation/computer'
const signal = () => new AbortController().signal
const element = (label: string, extras: Partial<WindowElement> = {}): WindowElement => ({ elementIndex: 1n, elementToken: 'sdk:1', role: 'Button', depth: 1, label, enabled: true, actions: ['invoke'], ...extras })
const state = (elements: WindowElement[]): WindowStateOutput => ({ pid: 9, windowId: 10n, snapshotId: 'sdk', elements, elementsComplete: true, images: [] })
beforeEach(() => {
  for (const fn of Object.values(native)) fn.mockReset()
  native.observeWindow.mockResolvedValue(state([element('保存')]))
  native.windows.mockResolvedValue({ windows: [{ pid: 9, windowId: 10n, appName: 'Editor', title: 'Document', bounds: { x: 0, y: 0, width: 600, height: 400 }, isOnScreen: true }] })
  native.observe.mockResolvedValue({ images: [{ mimeType: 'image/png', dataBase64: 'cG5n' }] })
  native.close.mockResolvedValue(undefined)
})
describe('exact native window automation', () => {
  it('discovers exact windows and observes a bounded tree without a screenshot by default', async () => {
    const computer = new ComputerAutomation()
    const windows = await computer.execute('owner', { action: 'windows' }, signal())
    expect(windows).toMatchObject({ windows: [{ pid: 9, window: '10', title: 'Document' }] })
    const observation = await computer.execute('owner', { action: 'observe', pid: 9, window: '10' }, signal())
    expect(native.observeWindow).toHaveBeenCalledWith({ pid: 9, window: '10' }, false, expect.any(AbortSignal))
    expect(observation).toMatchObject({ pid: 9, window: '10', elements: [{ name: '保存', role: 'Button', actions: ['invoke'] }] })
    expect(observation.image).toBeUndefined()
    expect(observation.snapshot).toEqual(expect.any(String))
  })
  it('performs one semantic click and returns a new observation in the same call', async () => {
    const computer = new ComputerAutomation()
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    const next = await computer.execute('a', { action: 'click', pid: 9, window: '10', snapshot: String(first.snapshot), target: { name: '保存', role: 'Button' } }, signal())
    expect(native.elementClick).toHaveBeenCalledWith({ pid: 9, window: '10', token: 'sdk:1' }, undefined, undefined, expect.any(AbortSignal))
    expect(next.snapshot).not.toBe(first.snapshot)
    expect(next.inputSent).toBe('click')
    expect(native.observeWindow).toHaveBeenCalledTimes(2)
    await expect(computer.execute('a', { action: 'click', snapshot: String(first.snapshot), target: { name: '保存' } }, signal())).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
  })
  it('returns complete attachment coordinates for an explicit window image while refusing window pixel input', async () => {
    const computer = new ComputerAutomation()
    native.observeWindow.mockResolvedValue({ ...state([element('保存')]), screenshotWidth: 800, screenshotHeight: 600, images: [{ mimeType: 'image/png', dataBase64: 'cG5n' }] })
    const observation = await computer.execute('a', { action: 'observe', pid: 9, window: '10', screenshot: true }, signal())
    expect(observation).toMatchObject({ coordinates: { width: 800, height: 600 }, image: { width: 800, height: 600 } })
    await expect(computer.execute('a', { action: 'click', pid: 9, window: '10', snapshot: String(observation.snapshot), x: 20, y: 30 }, signal())).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    expect(native.click).not.toHaveBeenCalled()
    expect(native.elementClick).not.toHaveBeenCalled()
  })
  it('refuses cross-owner, wrong-window, ambiguous and disabled targets before sending input', async () => {
    const computer = new ComputerAutomation()
    native.observeWindow.mockResolvedValue(state([element('保存'), element('保存', { elementIndex: 2n, elementToken: 'sdk:2' })]))
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    await expect(computer.execute('b', { action: 'click', snapshot: String(first.snapshot), target: { name: '保存' } }, signal())).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
    await expect(computer.execute('a', { action: 'click', pid: 9, window: '11', snapshot: String(first.snapshot), target: { name: '保存' } }, signal())).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
    await expect(computer.execute('a', { action: 'click', snapshot: String(first.snapshot), target: { name: '保存' } }, signal())).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' })
    native.observeWindow.mockResolvedValue(state([element('保存', { enabled: false })]))
    const second = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    await expect(computer.execute('a', { action: 'click', snapshot: String(second.snapshot), target: { name: '保存' } }, signal())).rejects.toMatchObject({ code: 'TARGET_DISABLED' })
    expect(native.elementClick).not.toHaveBeenCalled()
  })
  it('requires a writable semantic control and reads the exact expected value after text delivery', async () => {
    const computer = new ComputerAutomation()
    native.observeWindow.mockResolvedValue(state([element('标题', { role: 'Edit', actions: ['set_value'], value: 'old' })]))
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    native.elementText.mockImplementationOnce(async () => { native.observeWindow.mockResolvedValue(state([element('标题', { role: 'Edit', actions: ['set_value'], value: 'new' })])) })
    const next = await computer.execute('a', { action: 'type', snapshot: String(first.snapshot), target: { name: '标题' }, text: 'new', replace: true }, signal())
    expect(next).toMatchObject({ verified: true, elements: [{ value: 'new' }] })
    const invalid = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    await expect(computer.execute('a', { action: 'type', snapshot: String(invalid.snapshot), target: { name: '标题' }, text: 'ignored', replace: true }, signal())).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' })
    expect(native.elementText).toHaveBeenCalledTimes(2)
  })
  it('keeps legacy desktop coordinates and returns the refreshed screenshot after input', async () => {
    const computer = new ComputerAutomation()
    const first = await computer.execute('a', { action: 'observe' }, signal())
    const next = await computer.execute('a', { action: 'click', snapshot: String(first.snapshot), display: String(first.display), x: 20, y: 30 }, signal())
    expect(native.click).toHaveBeenCalledWith({ x: 20, y: 30 }, undefined, undefined, expect.any(AbortSignal))
    expect(next.image).toBeDefined()
    expect(next.snapshot).not.toBe(first.snapshot)
    expect(native.observe).toHaveBeenCalledTimes(2)
  })
  it('resolves fresh controls inside a local plan and includes a screenshot only at the end when requested', async () => {
    const computer = new ComputerAutomation()
    const controls = (value: string) => state([element('标题', { role: 'Edit', actions: ['set_value'], value }), element('保存', { elementIndex: 2n, elementToken: 'sdk:2' })])
    native.observeWindow.mockResolvedValue(controls('old'))
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    native.elementText.mockImplementationOnce(async () => { native.observeWindow.mockResolvedValue(controls('new')) })
    const result = await computer.execute('a', { action: 'run', snapshot: String(first.snapshot), pid: 9, window: '10', screenshot: true, steps: [
      { action: 'type', target: { name: '标题', role: 'Edit' }, text: 'new', replace: true },
      { action: 'wait', target: { name: '标题', role: 'Edit' }, value: 'new' },
      { action: 'click', target: { name: '保存', role: 'Button' } }
    ] }, signal())
    expect(result.sequence).toMatchObject({ status: 'completed', completed: 3, total: 3 })
    expect(native.elementText).toHaveBeenCalledOnce()
    expect(native.elementClick).toHaveBeenCalledOnce()
    const calls = native.observeWindow.mock.calls
    expect(calls.at(-1)?.[1]).toBe(true)
    expect(calls.slice(0, -1).every(call => call[1] === false)).toBe(true)
  })
  it('stops a partially completed plan at a new ambiguous target without replaying its prior input', async () => {
    const computer = new ComputerAutomation()
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    native.elementClick.mockImplementationOnce(async () => { native.observeWindow.mockResolvedValue(state([element('保存'), element('保存', { elementIndex: 2n, elementToken: 'sdk:2' })])) })
    const result = await computer.execute('a', { action: 'run', snapshot: String(first.snapshot), steps: [
      { action: 'click', target: { name: '保存' } }, { action: 'click', target: { name: '保存' } }
    ] }, signal())
    expect(result).toMatchObject({ observation_required: true, sequence: { status: 'failed', completed: 1, failed_step: 2, error: { code: 'AMBIGUOUS_TARGET' } } })
    expect(result.snapshot).toBeUndefined()
    expect(native.elementClick).toHaveBeenCalledOnce()
  })
  it('treats an empty expected value as an exact wait condition and preserves cancellation', async () => {
    const computer = new ComputerAutomation()
    native.observeWindow.mockResolvedValue(state([element('标题', { role: 'Edit', value: 'not empty', actions: ['set_value'] })]))
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    const controller = new AbortController()
    const reason = new Error('user stopped')
    native.observeWindow.mockImplementationOnce(async () => { controller.abort(reason); return state([element('标题', { role: 'Edit', value: 'not empty' })]) })
    await expect(computer.execute('a', { action: 'run', snapshot: String(first.snapshot), steps: [{ action: 'wait', target: { name: '标题' }, value: '' }] }, controller.signal)).rejects.toBe(reason)
    expect(native.elementClick).not.toHaveBeenCalled()
    expect(native.elementText).not.toHaveBeenCalled()
  })
  it('never carries a ref across host snapshots or accepts an SDK token as a host ref', async () => {
    const computer = new ComputerAutomation()
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    const oldElements = first.elements as Array<{ ref: string }>
    const second = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    await expect(computer.execute('a', { action: 'click', snapshot: String(second.snapshot), ref: oldElements[0]?.ref }, signal())).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(computer.execute('a', { action: 'click', snapshot: String(second.snapshot), ref: 'sdk:1' }, signal())).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    expect(native.elementClick).not.toHaveBeenCalled()
  })
  it('does not claim a web accessibility echo or unsupported text control is writable', async () => {
    const computer = new ComputerAutomation()
    native.observeWindow.mockResolvedValue(state([element('搜索', { role: 'Edit', actions: ['set_value'], value: '', inWebContent: true })]))
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    await expect(computer.execute('a', { action: 'type', snapshot: String(first.snapshot), target: { name: '搜索' }, text: 'test' }, signal())).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    expect(native.elementText).not.toHaveBeenCalled()
  })
  it('does not dispatch append when a provider omits the baseline value', async () => {
    const computer = new ComputerAutomation()
    native.observeWindow.mockResolvedValue(state([element('Query', { role: 'Edit', actions: ['set_value'] })]))
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    await expect(computer.execute('a', { action: 'type', snapshot: String(first.snapshot), target: { name: 'Query' }, text: '中文' }, signal())).rejects.toMatchObject({ code: 'INPUT_UNCONFIRMED' })
    expect(native.elementText).not.toHaveBeenCalled()
  })
  it('waits for an exact empty value instead of treating it as an existence-only predicate', async () => {
    const computer = new ComputerAutomation()
    native.observeWindow.mockResolvedValue(state([element('Query', { role: 'Edit', value: 'initial' })]))
    const first = await computer.execute('a', { action: 'observe', pid: 9, window: '10' }, signal())
    native.observeWindow.mockResolvedValueOnce(state([element('Query', { role: 'Edit', value: 'initial' })])).mockResolvedValueOnce(state([element('Query', { role: 'Edit', value: '' })]))
    const result = await computer.execute('a', { action: 'run', snapshot: String(first.snapshot), steps: [{ action: 'wait', target: { name: 'Query' }, value: '' }] }, signal())
    expect(result.sequence).toMatchObject({ status: 'completed', completed: 1 })
    expect(native.observeWindow).toHaveBeenCalledTimes(3)
  })
})
