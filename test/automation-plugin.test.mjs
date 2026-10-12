import { describe, expect, it, vi } from 'vitest'
import { createAutomationPlugin, apply } from '../packages/hqharness-automation/index.js'

function context() {
  const tools = []
  return { tools, ctx: { tools: { register: tool => tools.push(tool) }, attachments: { saveImage: async () => ({ attachmentId: 'image-test', mediaType: 'image/png', width: 500, height: 300, bytes: 10 }) }, systemPrompt: { section: vi.fn() }, on: vi.fn() } }
}
describe('built-in automation tool composition', () => {
  it('composes two actual Cordis plugins and two distinct tools', () => {
    const plugins = []; apply({ plugin: value => plugins.push(value) })
    expect(plugins.map(value => value.name)).toEqual(['browser-use', 'computer-use'])
    const { ctx, tools } = context()
    for (const plugin of plugins) plugin.apply(ctx)
    expect(tools.map(value => value.name)).toEqual(['browser_use', 'computer_use'])
  })
  it('returns durable images and maps normalized screenshot input to source coordinates', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async (_cap, _owner, args) => args.action === 'observe' ? { snapshot: 's1', display: 'd1', coordinates: { width: 2000, height: 1200 }, image: { png: 'AA==', width: 2000, height: 1200 } } : { performed: 'click' })
    createAutomationPlugin('computer', request).apply(ctx)
    const exec = { agent: { sessionId: 'owner' }, signal: new AbortController().signal }
    const image = await tools[0].execute({ action: 'observe' }, exec)
    expect(image.coordinate_width).toBe(500)
    const blocks = tools[0].output.render({}, image)
    expect(blocks[1]).toEqual({ type: 'image', attachment: image.image })
    expect(blocks[0].text).not.toContain('AA==')
    await tools[0].execute({ action: 'click', display: 'd1', snapshot: 's1', x: 250, y: 150 }, exec)
    expect(request.mock.calls[1][2]).toMatchObject({ x: 1000, y: 600 })
    expect(request.mock.calls[1][1]).toBe('owner')
    await expect(tools[0].execute({ action: 'click', display: 'd1', snapshot: 'old', x: 250, y: 150 }, exec)).rejects.toThrow('mapping is stale')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('requires actual Agent ownership and propagates errors/cancellation', async () => {
    const { ctx, tools } = context()
    const request = vi.fn(async () => { throw new Error('permission denied') })
    createAutomationPlugin('browser', request).apply(ctx)
    await expect(tools[0].execute({ action: 'tabs' }, { signal: new AbortController().signal })).rejects.toThrow('owning Agent')
    await expect(tools[0].execute({ action: 'open', url: 'https://example.com' }, { agent: { sessionId: 'a' } })).rejects.toThrow('permission denied')
  })
})
