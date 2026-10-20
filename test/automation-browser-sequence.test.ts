import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface TestNode { ignored?: boolean; backendDOMNodeId?: number; role?: { value: string }; name?: { value: string }; value?: { value: string | number | boolean }; properties?: { name: string; value: { value: boolean } }[] }
const fixture = vi.hoisted(() => ({
  nodes: [] as TestNode[], calls: [] as { method: string; params?: Record<string, unknown> }[],
  captured: vi.fn(), windows: [] as { destroyed: boolean }[],
  onCommand: (_method: string, _params?: Record<string, unknown>) => undefined as void,
  onRead: () => undefined as void
}))

vi.mock('electron', () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() }) },
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(), getURL: () => 'https://example.test/', getTitle: () => 'Fixture',
      capturePage: async () => {
        fixture.captured()
        const image = { resize: () => image, getSize: () => ({ width: 1100, height: 760 }), toPNG: () => Buffer.from('png') }
        return image
      },
      debugger: {
        attach: vi.fn(), isAttached: () => true,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          fixture.calls.push({ method, params })
          fixture.onCommand(method, params)
          if (method === 'Accessibility.getFullAXTree') { fixture.onRead(); return { nodes: structuredClone(fixture.nodes) } }
          if (method === 'DOM.getContentQuads') { const x = Number(params?.backendNodeId); return { quads: [[x, 10, x + 10, 10, x + 10, 20, x, 20]] } }
          return {}
        }
      }
    })
    constructor() { super(); fixture.windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    getContentSize() { return [1100, 760] }
    async loadURL() { this.webContents.emit('did-navigate') }
  }
}))

import { BrowserAutomation } from '../src/main/automation/browser'

const node = (id: number, name: string, role = 'button', value?: string): TestNode => ({ backendDOMNodeId: id, name: { value: name }, role: { value: role }, ...(value === undefined ? {} : { value: { value } }) })
const inputs = () => fixture.calls.filter(call => call.method.startsWith('Input.'))
let browser: BrowserAutomation
beforeEach(() => {
  fixture.nodes = [node(10, 'Search', 'textbox'), node(20, 'Submit')]
  fixture.calls = []; fixture.windows = []; fixture.captured.mockClear()
  fixture.onCommand = () => undefined; fixture.onRead = () => undefined
  browser = new BrowserAutomation()
})
afterEach(() => browser.stop())
async function open(screenshot?: boolean) {
  return browser.execute('owner', { action: 'open', url: 'https://example.test/', ...(screenshot === undefined ? {} : { screenshot }) }, new AbortController().signal)
}
function owned(result: Record<string, unknown>) {
  if (typeof result.tab !== 'string' || typeof result.snapshot !== 'string') throw new Error('Missing tab snapshot')
  return { tab: result.tab, snapshot: result.snapshot }
}

describe('Browser Use local semantic execution', () => {
  it('returns structured controls without capturing an image by default, and captures only when requested', async () => {
    const first = await open()
    expect(first.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Search', role: 'textbox' })]))
    expect(first.image).toBeUndefined()
    expect(first.coordinates).toBeUndefined()
    expect(fixture.captured).not.toHaveBeenCalled()
    const pictured = await browser.execute('owner', { action: 'observe', tab: owned(first).tab, screenshot: true }, new AbortController().signal)
    expect(pictured.image?.png).toBe(Buffer.from('png').toString('base64'))
    expect(fixture.captured).toHaveBeenCalledOnce()
  })

  it('runs search steps with fresh semantic controls and only captures the final result when requested', async () => {
    const initial = await open(false)
    fixture.onCommand = (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp' && params.key === 'Enter') fixture.nodes = [node(28, 'Matching result')]
    }
    const result = await browser.execute('owner', { action: 'run', ...owned(initial), screenshot: true, steps: [
      { action: 'type', target: { name: 'Search', role: 'textbox' }, text: 'HQHarness', replace: true },
      { action: 'key', key: 'ENTER' },
      { action: 'click', target: { name: 'Matching result', role: 'button' } }
    ] }, new AbortController().signal)
    expect(fixture.calls).toContainEqual({ method: 'DOM.focus', params: { backendNodeId: 10 } })
    expect(fixture.calls).toContainEqual({ method: 'Input.insertText', params: { text: 'HQHarness' } })
    expect(fixture.calls.some(call => call.method === 'Input.dispatchKeyEvent' && Array.isArray(call.params?.commands) && call.params.commands.includes('selectAll'))).toBe(true)
    expect(fixture.calls).toContainEqual({ method: 'DOM.getContentQuads', params: { backendNodeId: 28 } })
    expect(result.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Matching result' })]))
    expect(fixture.captured).toHaveBeenCalledOnce()
  })

  it('refuses ambiguous targets before input and does not run subsequent steps', async () => {
    const initial = await open(false)
    fixture.nodes = [node(11, 'Delete'), node(12, 'Delete')]
    const result = await browser.execute('owner', { action: 'run', ...owned(initial), steps: [
      { action: 'click', target: { name: 'Delete' } }, { action: 'key', key: 'ENTER' }
    ] }, new AbortController().signal)
    expect(result).toMatchObject({ observation_required: true, sequence: { status: 'failed', completed: 0, failed_step: 1, error: { code: 'AMBIGUOUS_TARGET' } } })
    expect(inputs()).toEqual([])
    await expect(browser.execute('owner', { action: 'click', ...owned(initial), target: { name: 'Delete' } }, new AbortController().signal)).rejects.toMatchObject({ code: expect.stringMatching(/AMBIGUOUS|STALE/) })
  })

  it('refreshes a semantic target instead of reusing an old element reference', async () => {
    const initial = await open(false)
    fixture.nodes = [node(55, 'Submit')]
    await browser.execute('owner', { action: 'click', ...owned(initial), target: { name: 'Submit', role: 'button' } }, new AbortController().signal)
    expect(fixture.calls).toContainEqual({ method: 'DOM.getContentQuads', params: { backendNodeId: 55 } })
    expect(fixture.calls).not.toContainEqual({ method: 'DOM.getContentQuads', params: { backendNodeId: 20 } })
  })

  it('waits briefly for a new semantic target after navigation instead of asking the model to click again', async () => {
    const initial = await open(false)
    fixture.nodes = []
    let reads = 0
    fixture.onRead = () => { if (++reads >= 2) fixture.nodes = [node(70, 'Loaded result')] }
    const result = await browser.execute('owner', { action: 'run', ...owned(initial), steps: [{ action: 'click', target: { name: 'Loaded result' } }] }, new AbortController().signal)
    expect(result.sequence).toMatchObject({ status: 'completed', completed: 1 })
    expect(inputs().filter(call => call.params?.type === 'mousePressed')).toHaveLength(1)
  })

  it('keeps explicit screenshot coordinate and element reference input available', async () => {
    const initial = await open(true)
    const clicked = await browser.execute('owner', { action: 'click', ...owned(initial), x: 30, y: 40, screenshot: true }, new AbortController().signal)
    expect(inputs()).toContainEqual({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 30, y: 40, button: 'left', clickCount: 1 } })
    await browser.execute('owner', { action: 'type', ...owned(clicked), ref: 'e1', text: 'append' }, new AbortController().signal)
    expect(fixture.calls).toContainEqual({ method: 'DOM.focus', params: { backendNodeId: 10 } })
    expect(inputs()).toContainEqual({ method: 'Input.insertText', params: { text: 'append' } })
    expect(fixture.captured).toHaveBeenCalledTimes(2)
  })

  it('refuses coordinate input from a DOM-only snapshot before dispatching a mouse event', async () => {
    const initial = await open()
    await expect(browser.execute('owner', { action: 'click', ...owned(initial), x: 20, y: 30 }, new AbortController().signal)).rejects.toMatchObject({ code: 'SCREENSHOT_REQUIRED' })
    expect(inputs()).toEqual([])
    const pictured = await browser.execute('owner', { action: 'observe', tab: owned(initial).tab, screenshot: true }, new AbortController().signal)
    await browser.execute('owner', { action: 'click', ...owned(pictured), x: 20, y: 30 }, new AbortController().signal)
    expect(inputs().filter(call => call.params?.type === 'mousePressed')).toHaveLength(1)
  })

  it('refuses non-editable semantic fields without typing or selecting text', async () => {
    const initial = await open(false)
    await expect(browser.execute('owner', { action: 'type', ...owned(initial), target: { name: 'Submit' }, text: 'invalid', replace: true }, new AbortController().signal)).rejects.toMatchObject({ code: 'TARGET_NOT_EDITABLE' })
    expect(inputs()).toEqual([])
  })

  it.each([
    ['ref', 'readonly', 'TARGET_NOT_EDITABLE'], ['target', 'readonly', 'TARGET_NOT_EDITABLE'],
    ['ref', 'disabled', 'TARGET_DISABLED'], ['target', 'disabled', 'TARGET_DISABLED']
  ] as const)('checks fresh %s metadata for %s before focus, select-all, or text dispatch', async (route, property, code) => {
    const initial = await open(false)
    fixture.nodes = [{ ...node(10, 'Search', 'textbox'), properties: [{ name: property, value: { value: true } }] }]
    await expect(browser.execute('owner', {
      action: 'type', ...owned(initial), ...(route === 'ref' ? { ref: 'e1' } : { target: { name: 'Search' } }), text: 'must not enter', replace: true
    }, new AbortController().signal)).rejects.toMatchObject({ code })
    expect(inputs()).toEqual([])
    expect(fixture.calls.some(call => call.method === 'DOM.focus')).toBe(false)
  })

  it('does not bind an old ref to a different element that takes its position in a new tree', async () => {
    const initial = await open(false)
    fixture.nodes = [node(55, 'Search', 'textbox')]
    await expect(browser.execute('owner', { action: 'type', ...owned(initial), ref: 'e1', text: 'not this replacement' }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_ELEMENT' })
    expect(inputs()).toEqual([])
  })

  it('does not run a sequence under another owner or without a current snapshot', async () => {
    const initial = await open(false)
    const op = { action: 'run', ...owned(initial), steps: [{ action: 'key' as const, key: 'ENTER' }] }
    await expect(browser.execute('other-owner', op, new AbortController().signal)).rejects.toMatchObject({ code: 'TAB_GONE' })
    await expect(browser.execute('owner', { ...op, snapshot: 'expired' }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(inputs()).toEqual([])
  })

  it('stops a sequence after a native command failure without retrying text or a later key', async () => {
    const initial = await open(false)
    fixture.onCommand = method => { if (method === 'Input.insertText') throw new Error('Input lost') }
    const result = await browser.execute('owner', { action: 'run', ...owned(initial), steps: [
      { action: 'type', target: { name: 'Search' }, text: 'once' }, { action: 'key', key: 'ENTER' }
    ] }, new AbortController().signal)
    expect(result).toMatchObject({ observation_required: true, sequence: { status: 'failed', completed: 0, failed_step: 1, error: { code: 'BROWSER_COMMAND_FAILED' } } })
    expect(inputs().filter(call => call.method === 'Input.insertText')).toHaveLength(1)
    expect(inputs().filter(call => call.method === 'Input.dispatchKeyEvent')).toHaveLength(0)
  })

  it('checks cancellation between focus and text so no later input is emitted', async () => {
    const initial = await open(false)
    const controller = new AbortController()
    fixture.onCommand = method => { if (method === 'DOM.focus') controller.abort(new Error('Stopped')) }
    await expect(browser.execute('owner', { action: 'run', ...owned(initial), steps: [
      { action: 'type', target: { name: 'Search' }, text: 'never' }, { action: 'key', key: 'ENTER' }
    ] }, controller.signal)).rejects.toThrow('Stopped')
    expect(fixture.calls.some(call => call.method === 'DOM.focus')).toBe(true)
    expect(inputs()).toEqual([])
  })

  it('waits for the named control value locally and returns its fresh observation', async () => {
    const initial = await open(false)
    fixture.nodes = [node(40, 'Status', 'status', 'Loading')]
    let reads = 0
    fixture.onRead = () => { if (++reads >= 2) fixture.nodes = [node(40, 'Status', 'status', 'Ready')] }
    const result = await browser.execute('owner', { action: 'run', ...owned(initial), steps: [
      { action: 'wait', target: { name: 'Status' }, value: 'Ready' }
    ] }, new AbortController().signal)
    expect(result.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Status', value: 'Ready' })]))
    expect(inputs()).toEqual([])
  })

  it.each([
    ['missing', undefined, ''], ['number', 0, '0'], ['boolean', false, 'false']
  ] as const)('requires an actual string value when the initial control value is %s', async (_label, initialValue, expected) => {
    const initial = await open(false)
    fixture.nodes = [{ ...node(40, 'Value', 'status'), ...(initialValue === undefined ? {} : { value: { value: initialValue } }) }]
    let reads = 0
    fixture.onRead = () => { if (++reads >= 2) fixture.nodes = [node(40, 'Value', 'status', expected)] }
    const result = await browser.execute('owner', { action: 'run', ...owned(initial), steps: [
      { action: 'wait', target: { name: 'Value' }, value: expected }
    ] }, new AbortController().signal)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(result.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Value', value: expected })]))
    expect(inputs()).toEqual([])
  })
})
