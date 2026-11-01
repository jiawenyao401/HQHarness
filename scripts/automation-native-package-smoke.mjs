import { spawnSync } from 'node:child_process'
import { electronExecutable } from './electron-node-loader.mjs'
import path from 'node:path'

const source = `
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { randomBytes } = require('node:crypto')
const { mkdtemp, realpath, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
async function qualifyOwnedTools(appRoot) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'hq-packaged-agent-')))
  const moduleUrl = name => pathToFileURL(join(appRoot, 'node_modules', name, 'lib/index.js')).href
  const token = randomBytes(32).toString('hex')
  const calls = []
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token)
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    calls.push(input)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(input.operation.action === 'observe' ? { snapshot: 'test-frame', coordinates: { width: 1000, height: 600 }, image: { png: 'AA==' } } : { available: true }))
  })
  let ctx
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    process.env.HQHARNESS_AUTOMATION_URL = 'http://127.0.0.1:' + server.address().port + '/operation'
    process.env.HQHARNESS_AUTOMATION_TOKEN = token
    process.env.DSH_HOME = home
    const config = join(home, 'cordis.yml')
    await writeFile(config, JSON.stringify([
      ...['dsh-system-prompt', 'dsh-tools', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-token-meter'].map(name => ({ id: name, name: moduleUrl('@deepseek-ai/' + name) })),
      { id: 'history-query', name: moduleUrl('@deepseek-ai/dsh-session-query-sqlite'), config: { path: ':memory:', openAt: 'never' } },
      { id: 'automation', name: pathToFileURL(join(appRoot, 'node_modules/hqharness-automation/index.js')).href }
    ]))
    const { boot } = await import(moduleUrl('@deepseek-ai/dsh-app-boot'))
    ctx = await boot('packaged-automation-qualification', config, [], ctx => {
      ctx.provide('attachments', { async saveImage() { return { attachmentId: 'test-frame', mediaType: 'image/png', width: 500, height: 300, bytes: 1 } } })
    })
    const agent = await ctx.agentLoop.create('session-packaged-automation')
    assert.equal(agent.session.header.id, 'session-packaged-automation')
    for (const name of ['browser_use', 'computer_use']) {
      const result = await ctx.tools.execute({ callId: name, name, arguments: { action: 'status' }, agent, signal: new AbortController().signal })
      assert.equal(result.isError, false, JSON.stringify(result.content))
      assert.deepEqual(result.value, { available: true })
      const observed = await ctx.tools.execute({ callId: name + '-frame', name, arguments: { action: 'observe' }, agent, signal: new AbortController().signal })
      assert.equal(observed.isError, false, JSON.stringify(observed.content))
      assert.equal(observed.value.coordinate_width, 500)
      assert(!Object.hasOwn(observed.value, 'coordinates'))
    }
    assert.deepEqual(calls.map(call => call.owner), Array(4).fill('session-packaged-automation'))
    console.log('PACKAGED_OWNED_TOOLS_PASS: actual packaged Agent, ToolRuntime, automation module, authenticated test bridge and lossless screenshot results')
    // Qualify the optional history hook from this exact installed dependency
    // closure too. Fixture events never dispatch browser/desktop input.
    const { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId } = await import(moduleUrl('@deepseek-ai/dsh-llm'))
    const historyAgent = await ctx.agentLoop.create('session-packaged-history')
    const session = historyAgent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Keep all fixture rows.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    for (let step = 1; step <= 4; step++) {
      const callId = ToolCallId('history-' + step)
      const args = JSON.stringify({ action: 'observe' })
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', { turn: 1, step, stream: [], message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: callId, name: 'computer_use', arguments: args }] }) }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step, callId, name: 'computer_use', arguments: args })
      const observation = { snapshot: 'history-' + step, elements: Array.from({ length: 220 }, (_, index) => ({ ref: 'history-' + step + ':' + index, role: 'cell', name: 'Fixture ' + index, value: 'Value ' + index, bounds: { x: 100, y: index * 20, width: 800, height: 20 } })) }
      session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId, content: [{ type: 'text', text: JSON.stringify(observation) }], isError: false }) }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
    const decision = { kind: 'enter', messages: [] }
    assert.equal(await ctx.waterfall('agent/pre-step', { agent: historyAgent, signal: new AbortController().signal }, () => Promise.resolve(decision)), decision)
    const cut = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
    try {
      const surface = [...session.surface.nodes].map(seq => cut.events[seq])
      const results = surface.filter(event => event.type === 'tool/result').map(event => JSON.parse(session.deriveEventMessage(event).content[0].text))
      assert.equal(results.length, 4)
      assert.equal(results.filter(result => result.archived_observation).length, 2)
      assert.equal(results.filter(result => result.snapshot).length, 2)
      assert.equal(results[0].elements.length, 220)
      assert.equal(results[0].elements[219].value, 'Value 219')
      assert.equal(Object.hasOwn(results[0].elements[0], 'ref'), false)
      const original = cut.events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append')
      assert.equal(original.length, 4)
      assert.equal(JSON.parse(original[0].data.message.content[0].text).elements[0].ref, 'history-1:0')
      assert.equal(cut.events.filter(event => event.type === 'compaction/prune').length, 2)
      assert.equal(calls.length, 4, 'History maintenance must not dispatch native input')
    } finally { cut[Symbol.dispose]() }
    console.log('PACKAGED_CONTEXT_PRUNING_PASS: exact packaged helper, services, Agent pre-step, retained semantic rows, latest observations and durable original history')
    // Exercise the guard from the shipped module and dependency closure. These
    // fixtures cannot touch a real file, website or desktop input.
    const { defineTool } = await import(moduleUrl('@deepseek-ai/dsh-tools'))
    const { agentEvents } = await import(moduleUrl('@deepseek-ai/dsh-agent'))
    let directCalls = 0
    for (const name of ['web_search', 'read']) ctx.tools.register(defineTool({
      name, description: 'Packaged routing qualification fixture', parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      execute() { directCalls++; return { fixture: true } }
    }))
    const routingAgent = await ctx.agentLoop.create('session-packaged-routing')
    const executeFixture = (agent, name) => ctx.tools.execute({ callId: 'routing-' + name, name, arguments: {}, agent, signal: new AbortController().signal })
    for (const name of ['web_search', 'read']) {
      const rejected = await executeFixture(routingAgent, name)
      assert.equal(rejected.isError, true)
      assert(rejected.content.some(block => /HQ_ROUTING_PREFERRED/.test(block.text ?? '')))
    }
    assert.equal(directCalls, 0)
    agentEvents(ctx, routingAgent).emit('agent/inbox/claimed', { message: createUserMessage({ content: [{ type: 'text', text: '工具模式：直接工具' }], source: { kind: 'user' } }), turn: 1 })
    for (const name of ['web_search', 'read']) assert.equal((await executeFixture(routingAgent, name)).isError, false)
    assert.equal(directCalls, 2)
    assert.equal((await executeFixture(agent, 'read')).isError, true, 'Another Agent must keep GUI preference')
    agentEvents(ctx, routingAgent).emit('agent/inbox/claimed', { message: createUserMessage({ content: [{ type: 'text', text: 'Inspect my local file.' }], source: { kind: 'user' } }), turn: 2 })
    assert.equal((await executeFixture(routingAgent, 'read')).isError, true, 'A new turn must reset direct mode')
    assert.equal(directCalls, 2)
    assert.equal(calls.length, 4, 'Routing qualification must not dispatch native input')
    console.log('PACKAGED_TOOL_ROUTING_PASS: exact packaged guard, real Agent events, web/file preference, explicit override, next-turn reset and Agent isolation')
  } finally {
    await ctx?.fiber.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
}
async function run() {
  const appRoot = process.argv[1]
  const folder = join(appRoot, 'node_modules', '@trycua', 'cua-driver')
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '0.28.0')
  const entry = manifest.exports?.['.']?.import
  assert.equal(typeof entry, 'string')
  const sdk = await import(pathToFileURL(resolve(folder, entry)).href)
  await sdk.uniffiInitAsync()
  const driver = sdk.CuaDriver.create(undefined)
  try {
    const catalog = JSON.parse(await driver.listToolsJson())
    const tools = Array.isArray(catalog) ? catalog : catalog.tools
    for (const name of ['get_desktop_state', 'click', 'type_text', 'press_key', 'scroll', 'drag']) assert(tools.some(tool => tool.name === name), name)
    const first = await driver.callTool('get_screen_size', '{}')
    assert.equal(first.isError, false, first.errorCode)
    await driver.endSession(sdk.EndSessionInput.new({}))
    const ended = await driver.callTool('get_screen_size', '{}')
    assert.equal(ended.errorCode, 'session_ended')
    const restarted = await driver.startSession(sdk.StartSessionInput.new({}))
    assert.equal(restarted.active, true)
    assert.equal(restarted.revived, true)
    const recovered = await driver.callTool('get_screen_size', '{}')
    assert.equal(recovered.isError, false, recovered.errorCode)
    console.log('NATIVE_SESSION_RECOVERY_PASS: actual native session end/start on the same runtime; no screen capture or input')
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, electron: process.versions.electron, driver: manifest.version, tools: tools.length, qualification: 'native import/catalog/session recovery only; GUI input requires manual acceptance' }))
  } finally {
    await driver.shutdown()
    if ('uniffiDestroy' in driver && typeof driver.uniffiDestroy === 'function') driver.uniffiDestroy()
  }
  await qualifyOwnedTools(appRoot)
}
run().catch(error => { console.error(error); process.exitCode = 1 })
`

const [packagedExecutable, appRoot] = process.argv.slice(2)
if ((packagedExecutable && !appRoot) || (!packagedExecutable && appRoot)) throw new Error('Provide both the packaged Electron executable and app.asar path, or neither')
const executable = packagedExecutable ? path.resolve(packagedExecutable) : electronExecutable(process.cwd())
const result = spawnSync(executable, ['-e', source, path.resolve(appRoot ?? process.cwd())], {
  cwd: appRoot ? path.dirname(path.resolve(appRoot)) : process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', timeout: 30_000, windowsHide: true
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Cua native package smoke failed: ${result.status ?? result.signal}`)
