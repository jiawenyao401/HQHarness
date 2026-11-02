import { spawnSync } from 'node:child_process'
import { electronExecutable } from './electron-node-loader.mjs'
import path from 'node:path'

const source = `
const { readFileSync, existsSync, realpathSync } = require('node:fs')
const { join, resolve, relative, isAbsolute, sep } = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { randomBytes } = require('node:crypto')
const { mkdtemp, realpath, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
async function packagedWpsFixture(appRoot) {
  const appRequire = createRequire(join(appRoot, 'package.json'))
  const ownedEntry = (name, directory) => {
    // Require the package in this installation before resolving its exports.
    // An ancestor/development copy must not hide a missing ASAR dependency.
    const folder = realpathSync(join(appRoot, 'node_modules', directory))
    const entry = appRequire.resolve(name)
    const child = relative(folder, realpathSync(entry))
    assert(child && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep), 'Package escaped the explicit appRoot: ' + name)
    return entry
  }
  const serverEntry = ownedEntry('@modelcontextprotocol/server', '@modelcontextprotocol/server')
  assert.equal(JSON.parse(readFileSync(join(appRoot, 'node_modules/@modelcontextprotocol/server/package.json'), 'utf8')).version, '2.2.0')
  const { Server, WebStandardStreamableHTTPServerTransport } = appRequire(serverEntry)
  const pluginEntry = ownedEntry('hqharness-wps', 'hqharness-wps')
  const { WPS_TOOL_NAME, WPS_RAW_TOOL_NAME, WPS_INPUT_SCHEMA, validateWpsOperation, validateWpsCallMeta } = await import(pathToFileURL(ownedEntry('hqharness-wps/protocol', 'hqharness-wps')).href)
  const token = randomBytes(32).toString('hex')
  const calls = []
  const value = { fixture: 'packaged-wps-mcp', supported: true, connectedDocuments: 0 }
  let failure
  let origin
  const listener = createServer((request, response) => {
    void (async () => {
      assert(request.url === '/mcp' && request.headers.host === origin.slice(7), 'Unexpected WPS fixture request')
      assert(request.headers.authorization === 'Bearer ' + token, 'WPS fixture bearer was not supplied')
      assert(!request.headers.origin || request.headers.origin === origin, 'Unexpected WPS fixture origin')
      assert.match(request.headers['x-hq-wps-client'] ?? '', /^[a-f0-9-]{36}$/u)
      // The standard client may probe for an SSE stream. This stateless
      // fixture mirrors Main's POST-only transport rather than opening one.
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      let body = ''
      for await (const chunk of request) { body += chunk; assert(Buffer.byteLength(body) <= 80 * 1024, 'Oversized WPS fixture request') }
      const sdk = new Server({ name: 'packaged-wps-mcp-fixture', version: '0.1.0' }, { capabilities: { tools: {} } })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 80 * 1024 })
      sdk.setRequestHandler('tools/list', () => ({ tools: [{ name: WPS_RAW_TOOL_NAME, description: 'Owned package qualification fixture; no WPS application is accessed.', inputSchema: WPS_INPUT_SCHEMA }] }))
      sdk.setRequestHandler('tools/call', (call, context) => {
        assert.equal(call.params.name, WPS_RAW_TOOL_NAME)
        const operation = validateWpsOperation(call.params.arguments)
        assert.deepEqual(operation, { action: 'status' }, 'The packaged MCP fixture supports status only')
        const meta = validateWpsCallMeta(context.mcpReq._meta?.huaqing)
        calls.push({ operation, meta, client: request.headers['x-hq-wps-client'] })
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
      })
      try {
        await sdk.connect(transport)
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value)
        const result = await transport.handleRequest(new Request(origin + '/mcp', { method: 'POST', headers, body }))
        response.writeHead(result.status, Object.fromEntries(result.headers))
        response.end(Buffer.from(await result.arrayBuffer()))
      } finally { await sdk.close() }
    })().catch(error => {
      failure ??= error
      if (!response.headersSent) response.writeHead(500).end('Packaged MCP fixture failed')
      else response.destroy()
    })
  })
  listener.requestTimeout = 5000
  listener.headersTimeout = 5000
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve() }) })
  origin = 'http://127.0.0.1:' + listener.address().port
  return { calls, value, pluginEntry, toolName: WPS_TOOL_NAME, url: origin + '/mcp', token,
    assertHealthy() { if (failure) throw failure },
    async close() { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)) }
  }
}
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
    if (input.owner === 'session-packaged-real-ptc') {
      if (input.operation.action === 'click') {
        res.writeHead(400)
        res.end(JSON.stringify({ code: 'INPUT_REFUSED', error: 'Owned fixture foreground mismatch; no desktop input was dispatched' }))
      } else res.end(JSON.stringify({ snapshot: 'routing-frame', pid: 1, window: '2', elements: [{ ref: 'routing-ref', role: 'Button', name: 'Fixture' }] }))
      return
    }
    res.end(JSON.stringify(input.operation.action === 'observe' ? { snapshot: 'test-frame', coordinates: { width: 1000, height: 600 }, image: { png: 'AA==' } } : { available: true }))
  })
  let ctx
  let wps
  const wpsDispatches = []
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    wps = await packagedWpsFixture(appRoot)
    process.env.HQHARNESS_AUTOMATION_URL = 'http://127.0.0.1:' + server.address().port + '/operation'
    process.env.HQHARNESS_AUTOMATION_TOKEN = token
    process.env.HQHARNESS_WPS_URL = wps.url
    process.env.HQHARNESS_WPS_TOKEN = wps.token
    process.env.DSH_HOME = home
    const config = join(home, 'cordis.yml')
    await writeFile(config, JSON.stringify([
      { id: 'prompt', name: moduleUrl('@deepseek-ai/dsh-system-prompt') },
      { id: 'tools', name: moduleUrl('@deepseek-ai/dsh-tools'), config: { mode: 'both' } },
      ...['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-token-meter', 'dsh-fs-local', 'dsh-subprocess-local', 'dsh-sandbox-local'].map(name => ({ id: name, name: moduleUrl('@deepseek-ai/' + name) })),
      { id: 'sandbox-policy', name: moduleUrl('@deepseek-ai/dsh-sandbox-policy'), config: { mode: 'workspace-write', workspaceRoot: home } },
      { id: 'ptc-runtime', name: moduleUrl('@deepseek-ai/dsh-ptc-runtime-node') },
      { id: 'history-query', name: moduleUrl('@deepseek-ai/dsh-session-query-sqlite'), config: { path: ':memory:', openAt: 'never' } },
      { id: 'automation', name: pathToFileURL(join(appRoot, 'node_modules/hqharness-automation/index.js')).href },
      { id: 'wps', name: pathToFileURL(wps.pluginEntry).href }
    ]))
    const { boot } = await import(moduleUrl('@deepseek-ai/dsh-app-boot'))
    ctx = await boot('packaged-automation-qualification', config, [], ctx => {
      ctx.provide('attachments', { async saveImage() { return { attachmentId: 'test-frame', mediaType: 'image/png', width: 500, height: 300, bytes: 1 } } })
      ctx.on('tools/result', (exec, result) => { if (exec.name === wps.toolName) wpsDispatches.push({ exec, result }) })
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
    const wpsPolicy = agent => {
      const resolved = ctx.sandboxPolicy.resolve({ session: agent.session })
      return { mode: resolved.mode, workspaceRoot: resolved.workspaceRoot }
    }
    const nativeWpsPolicy = wpsPolicy(agent)
    const nativeWps = await ctx.tools.execute({ callId: 'packaged-wps-native', name: wps.toolName, arguments: { action: 'status' }, agent, signal: new AbortController().signal })
    assert.equal(nativeWps.isError, false, JSON.stringify(nativeWps.content))
    assert.deepEqual(nativeWps.value.structuredContent, wps.value)
    assert.deepEqual(wps.calls.map(call => ({ operation: call.operation, meta: call.meta })), [{ operation: { action: 'status' }, meta: { owner: agent.session.header.id, policy: nativeWpsPolicy } }])
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
    // Load the real Node process provider from this exact appRoot too. A fixture
    // interpreter that only forwards tools cannot expose raw Node I/O bypasses.
    assert.equal(ctx.ptcRuntime.language, 'typescript')
    assert.equal(ctx.ptcRuntime.isolation, 'process')
    const { agent: ptcAgent } = await ctx.agents.create({ sessionId: 'session-packaged-real-ptc', meta: { cwd: home }, agentOptions: { provider: 'test', model: 'test' } })
    const claimPtc = (turn, text) => agentEvents(ctx, ptcAgent).emit('agent/inbox/claimed', { message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), turn })
    let ptcCallId = 0
    const ptcCall = (name, args) => ctx.tools.execute({ callId: 'packaged-ptc-' + ++ptcCallId, name, arguments: args, agent: ptcAgent, signal: new AbortController().signal })
    const program = code => ptcCall('run_code', { code, description: 'Exact packaged Node PTC routing qualification; owned fixture only' })
    const marker = join(home, 'ptc-owned-marker.txt')
    const rawWrite = value => 'const fs = await import("node:fs/promises"); await fs.writeFile(' + JSON.stringify(marker) + ', ' + JSON.stringify(value) + '); return "fixture written"'
    claimPtc(1, 'Inspect the owned local fixture through the application.')
    const initialRaw = await program(rawWrite('unexpected'))
    assert.equal(initialRaw.isError, true)
    assert(initialRaw.content.some(block => /HQ_ROUTING_/.test(block.text ?? '')))
    assert.equal(existsSync(marker), false)
    const guiCode = 'return await tools.computer_use({"action":"observe","pid":1,"window":"2"});'
    const gui = await program(guiCode)
    assert.equal(gui.isError, false, JSON.stringify(gui.content))
    assert.equal(gui.value.result.snapshot, 'routing-frame')
    assert.equal(gui.value.sandbox.mode, 'workspace-write')
    assert.equal(gui.value.sandbox.denied, false)
    const refused = await ptcCall('computer_use', { action: 'click', pid: 1, window: '2', snapshot: 'routing-frame', target: { name: 'Fixture', role: 'Button' } })
    assert.equal(refused.isError, true)
    assert.equal(refused.error.info.code, 'INPUT_REFUSED')
    const afterRefusal = await program(rawWrite('unexpected'))
    assert.equal(afterRefusal.isError, true)
    assert(afterRefusal.content.some(block => /HQ_ROUTING_/.test(block.text ?? '')))
    assert.equal(existsSync(marker), false, 'Refused GUI input must not become a raw Node filesystem write')
    const verified = await program(guiCode)
    assert.equal(verified.isError, false, JSON.stringify(verified.content))
    claimPtc(1, '工具模式：直接工具')
    assert.equal((await program(rawWrite('unexpected'))).isError, true, 'Same-turn steering must not bypass an unconfirmed input')
    assert.equal(existsSync(marker), false)
    claimPtc(2, '工具模式：直接工具')
    const direct = await program(rawWrite('approved fixture'))
    assert.equal(direct.isError, false, JSON.stringify(direct.content))
    assert.equal(readFileSync(marker, 'utf8'), 'approved fixture')
    claimPtc(3, 'Inspect another local fixture through the application.')
    assert.equal((await program(rawWrite('unexpected'))).isError, true)
    assert.equal(readFileSync(marker, 'utf8'), 'approved fixture')
    assert.equal(calls.length, 7, 'Only three owned bridge fixtures may be called; no real desktop input')
    console.log('PACKAGED_REAL_PTC_ROUTING_PASS: real packaged Node process and sandbox, canonical GUI binding, refused-input opaque-I/O denial, explicit new-turn authorization and default reset')
    const ptcWpsPolicy = wpsPolicy(ptcAgent)
    const ptcWps = await program('return await tools.' + wps.toolName + '({"action":"status"});')
    assert.equal(ptcWps.isError, false, JSON.stringify(ptcWps.content))
    assert.deepEqual(ptcWps.value.result.structuredContent, wps.value)
    assert.equal(ptcWps.value.sandbox.mode, ptcWpsPolicy.mode)
    wps.assertHealthy()
    assert.equal(wps.calls.length, 2)
    assert.deepEqual(wps.calls[1].operation, { action: 'status' })
    assert.deepEqual(wps.calls[1].meta, { owner: ptcAgent.session.header.id, policy: ptcWpsPolicy })
    assert.equal(wps.calls[1].client, wps.calls[0].client, 'The same SDK transport must retain its client identity')
    const nestedWps = wpsDispatches.find(({ exec }) => exec.rootCallId !== exec.callId)
    assert(nestedWps?.exec.parent, 'WPS PTC did not execute through the real child ToolRuntime pipeline')
    assert.equal(nestedWps.exec.agent, ptcAgent)
    assert.equal(calls.length, 7, 'WPS qualification must not dispatch GUI input')
    console.log('PACKAGED_WPS_MCP_PASS: actual appRoot WPS plugin and MCP SDK 2.2.0 server/client, real Agent policy/owner and strict Node PTC round trip; owned status fixture only, no real WPS connection')
  } finally {
    try { await ctx?.fiber.dispose() }
    finally {
      await wps?.close()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await rm(home, { recursive: true, force: true })
    }
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
