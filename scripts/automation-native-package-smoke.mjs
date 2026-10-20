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
      ...['dsh-system-prompt', 'dsh-tools', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop'].map(name => ({ id: name, name: moduleUrl('@deepseek-ai/' + name) })),
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
