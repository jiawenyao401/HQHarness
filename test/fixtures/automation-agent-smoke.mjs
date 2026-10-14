import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'

const [root, url] = process.argv.slice(2)
const moduleUrl = name => pathToFileURL(join(root, 'node_modules', '@deepseek-ai', name, 'lib/index.js')).href
const { boot } = await import(moduleUrl('dsh-app-boot'))
const config = join(process.env.DSH_HOME, 'automation-agent.yml')
await writeFile(config, JSON.stringify([
  ...['dsh-system-prompt', 'dsh-tools', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop'].map(name => ({ id: name, name: moduleUrl(name) })),
  { id: 'automation', name: pathToFileURL(join(root, 'packages/hqharness-automation/index.js')).href }
]))
const ctx = await boot('automation-agent-smoke', config, [], ctx => {
  // Persist real PNGs in the temporary test Profile; preserve their dimensions.
  ctx.provide('attachments', { async saveImage({ data, mediaType, name }) {
    assert.equal(data.subarray(1, 4).toString(), 'PNG')
    const attachmentId = 'smoke-' + Date.now()
    await writeFile(join(process.env.DSH_HOME, attachmentId + '.png'), data)
    return { attachmentId, name, mediaType, width: data.readUInt32BE(16), height: data.readUInt32BE(20), bytes: data.length }
  } })
})
try {
  const agent = await ctx.agentLoop.create('session-native-smoke')
  const signal = new AbortController().signal
  async function execute(name, args) {
    const result = await ctx.tools.execute({ callId: name + '-' + Date.now(), name, arguments: args, agent, signal })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    return result.value
  }
  await execute('browser_use', { action: 'status' })
  await execute('computer_use', { action: 'status' })
  const page = await execute('browser_use', { action: 'open', url, screenshot: false })
  const input = page.nodes.find(node => node.role === 'textbox')
  assert(input)
  await execute('browser_use', { action: 'type', tab: page.tab, snapshot: page.snapshot, ref: input.ref, text: 'Agent browser 中文 🐎' })
  let frame = await execute('computer_use', { action: 'observe' })
  assert(frame.image.attachmentId && frame.coordinate_width > 0)
  await execute('computer_use', { action: 'key', display: frame.display, snapshot: frame.snapshot, key: 'RIGHT' })
  frame = await execute('computer_use', { action: 'observe' })
  await execute('computer_use', { action: 'type', display: frame.display, snapshot: frame.snapshot, text: ' + Agent native 中文 🐎' })
  console.log('OWNED_TOOL_EXECUTION_PASS: real Agent -> ToolRuntime -> authenticated Desktop bridge -> Chromium/Cua input')
} finally { await ctx.fiber.dispose() }
