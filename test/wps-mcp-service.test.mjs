import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { WebSocket } from 'ws'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { JSDOM } from 'jsdom'

const fakes = vi.hoisted(() => ({ dialog: vi.fn(async () => ({ response: 1 })) }))
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() }, dialog: { showMessageBox: fakes.dialog },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }
}))
import { DesktopWpsService } from '../src/main/wps/service.ts'
import { WpsDocuments } from '../src/main/wps/documents.ts'
import { createWpsPlugin } from '../packages/hqharness-wps/index.js'
import { WPS_RAW_TOOL_NAME, WPS_WRITE_ACTIONS } from '../packages/hqharness-wps/protocol.js'

const cleanups = []
const digest = value => createHash('sha256').update(value).digest('hex')
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs(); vi.restoreAllMocks(); fakes.dialog.mockReset().mockResolvedValue({ response: 1 })
})

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'huaqing-wps-wire-')))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const window = { isDestroyed: () => false, show() {}, focus() {} }
  const service = new DesktopWpsService(directory, () => window, () => 'en')
  cleanups.push(() => service.close())
  await service.start()
  const env = service.environment()
  if (!env.HQHARNESS_WPS_URL || !env.HQHARNESS_WPS_TOKEN) throw new Error('WPS service failed to start')
  vi.stubEnv('HQHARNESS_WPS_URL', env.HQHARNESS_WPS_URL)
  vi.stubEnv('HQHARNESS_WPS_TOKEN', env.HQHARNESS_WPS_TOKEN)
  const disposers = []
  let definition
  const ctx = {
    tools: { register: value => { definition = value } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: directory }) },
    systemPrompt: { section() {} }, logger: { warn() {} },
    effect: callback => { const cleanup = callback(); if (typeof cleanup === 'function') disposers.push(cleanup) }
  }
  createWpsPlugin().apply(ctx)
  cleanups.push(async () => { for (const cleanup of disposers.reverse()) await cleanup() })
  const execution = (owner = 'owner-one', signal = new AbortController().signal) => ({ signal, agent: { session: { header: { id: owner } } } })
  const call = async (operation, owner, signal) => (await definition.execute(operation, execution(owner, signal))).structuredContent
  const raw = new Client({ name: 'wire-qualification', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  cleanups.push(() => raw.close())
  const clientId = randomUUID()
  const connectRaw = () => raw.connect(new StreamableHTTPClientTransport(new URL(env.HQHARNESS_WPS_URL), { requestInit: { headers: { Authorization: `Bearer ${env.HQHARNESS_WPS_TOKEN}`, 'x-hq-wps-client': clientId } } }))
  return { directory, service, env, call, raw, connectRaw, clientId }
}

async function addin(f, handler, host = 'et') {
  const installation = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'))
  const origin = new URL(f.env.HQHARNESS_WPS_URL).origin
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/${installation.secret}/bridge/${host}`, { origin })
  cleanups.push(async () => { socket.terminate() })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const filename = host === 'wps' ? 'wire-document.docx' : 'wire-document.xlsx'
  const path = join(f.directory, filename)
  await writeFile(path, 'local WPS fixture; no WPS process is used')
  socket.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.type !== 'execute') return
    if (handler?.(message) === false) return
    const mutating = WPS_WRITE_ACTIONS.includes(message.operation.action)
    socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, value: { snapshot: mutating ? message.operation.nextSnapshot : message.operation.snapshot, inspected: true } } }))
  })
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, host, documents: [{ key: 'native-document-key', name: filename, path, type: host === 'wps' ? 'writer' : 'spreadsheet', saved: true, readOnly: false }] }))
  await vi.waitFor(() => expect(f.service.status().connectedDocuments).toBe(1))
  return socket
}

/** Execute the actual served entry with no browser-derived HTTP URL. Keep VM
 * failures bounded: the bundle contains a private endpoint and must not appear
 * in assertion diffs or exception stacks. */
function executeAddinBundle(source) {
  const sockets = []
  const intervals = []
  const unload = []
  class Socket {
    static OPEN = 1
    readyState = 1
    sent = []
    constructor(url) { this.url = url; sockets.push(this) }
    send(value) { this.sent.push(JSON.parse(value)) }
    close() { this.readyState = 3 }
  }
  const evalCall = vi.fn(() => { throw new Error('Dynamic code is forbidden') })
  const functionCall = vi.fn(() => { throw new Error('Dynamic code is forbidden') })
  const environment = {
    URL, crypto: webcrypto, location: { href: 'about:blank' }, document: { currentScript: null }, WebSocket: Socket,
    setInterval: callback => { intervals.push(callback); return intervals.length }, clearInterval() {},
    setTimeout() { return 1 }, clearTimeout() {},
    addEventListener: (name, callback) => { if (name === 'unload') unload.push(callback) },
    eval: evalCall, Function: functionCall, __unexpectedExecution: false
  }
  environment.window = environment
  const context = createContext(environment, { codeGeneration: { strings: false, wasm: false } })
  let failure
  try { runInContext(source, context, { timeout: 1000 }) }
  catch (error) { failure = error?.name ?? 'UnknownError' }
  expect(failure).toBeUndefined()
  return { context, sockets, intervals, evalCall, functionCall, unload }
}

describe('real local MCP SDK wire and Desktop WPS service', () => {
  it('keeps the listener available to repair an incomplete registration marker', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'huaqing-wps-marker-')))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, 'registered.json'), '{')
    const service = new DesktopWpsService(directory, () => undefined, () => 'en')
    cleanups.push(() => service.close())
    await service.start()
    expect(service.environment().HQHARNESS_WPS_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(service.status().registered).toBe(false)
    expect(await readFile(join(directory, 'registered.json'), 'utf8')).toBe('{')
  })
  it('initializes the real client and forwards the exact current session policy to Main', async () => {
    const spy = vi.spyOn(WpsDocuments.prototype, 'execute')
    const f = await fixture()
    expect(await f.call({ action: 'status' })).toMatchObject({ component: 'local-wps', connected: false, guidance: expect.stringContaining('Enable WPS connection') })
    expect(spy).toHaveBeenCalledWith({ action: 'status' }, { owner: 'owner-one', policy: { mode: 'workspace-write', workspaceRoot: f.directory } }, expect.any(AbortSignal))
    expect(fakes.dialog).not.toHaveBeenCalled()
    expect(await f.call({ action: 'documents' })).toMatchObject({ documents: [], guidance: expect.stringContaining('Enable WPS connection') })
    expect(fakes.dialog).toHaveBeenCalledOnce()
  })
  it('dispatches Writer append once, after inspecting and authorizing the bound document', async () => {
    const f = await fixture()
    const forwarded = []
    await addin(f, message => { forwarded.push(message.operation) }, 'wps')
    const { documents: [document] } = await f.call({ action: 'documents' })
    const { snapshot } = await f.call({ action: 'inspect', key: document.key })
    const operation = { action: 'writer_append', key: document.key, snapshot, text: '会议纪要\n行动项' }
    const result = await f.call(operation)
    expect(typeof result.snapshot).toBe('string')
    expect(result.snapshot).not.toBe(snapshot)
    await expect(f.call(operation)).rejects.toThrow('Read this WPS document or range again')
    expect(forwarded.map(call => call.action)).toEqual(['inspect', 'writer_append'])
    expect(forwarded[1]).toMatchObject({ key: 'native-document-key', text: operation.text })
    expect(fakes.dialog).toHaveBeenCalledTimes(3)
  })
  it('rejects missing bearer and foreign origins before MCP dispatch', async () => {
    const f = await fixture()
    const spy = vi.spyOn(WpsDocuments.prototype, 'execute')
    for (const headers of [{}, { Authorization: `Bearer ${f.env.HQHARNESS_WPS_TOKEN}`, Origin: 'https://untrusted.example' }]) {
      const response = await fetch(f.env.HQHARNESS_WPS_URL, { method: 'POST', headers, body: '{}' })
      expect(response.status).toBe(403)
    }
    expect(spy).not.toHaveBeenCalled()
  })
  it('serves only the current installation Add-in assets with explicit response types', async () => {
    const f = await fixture()
    const { secret } = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'))
    const origin = new URL(f.env.HQHARNESS_WPS_URL).origin
    for (const [file, expected] of [['index.html', 'text/html'], ['manifest.xml', 'application/xml'], ['ribbon.xml', 'application/xml'], ['adapter.js', 'text/javascript'], ['main.js', 'text/javascript']]) {
      const response = await fetch(`${origin}/${secret}/addins/et/${file}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain(expected)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = await response.text()
      if (['adapter.js', 'ribbon.xml'].includes(file)) {
        const source = await readFile(join(process.cwd(), 'node_modules', 'hqharness-wps', 'addin', file), 'utf8')
        expect(digest(body)).toBe(digest(source))
      } else expect(body.length > 0).toBe(true)
    }
    const missing = await fetch(`${origin}/${secret}/addins/et/unlisted.js`)
    expect(missing.status).toBe(404)
    const foreign = await fetch(`${origin}/${secret}/addins/et/main.js`, { headers: { Origin: 'https://untrusted.example' } })
    expect(foreign.status).toBe(403)
    const unsupported = await fetch(f.env.HQHARNESS_WPS_URL, { headers: { Authorization: `Bearer ${f.env.HQHARNESS_WPS_TOKEN}` } })
    expect(unsupported.status).toBe(405)
  })
  it.each([['et', 'HuaqingDesktopET'], ['wps', 'HuaqingDesktopWPS'], ['wpp', 'HuaqingDesktopWPP']])('serves the bare %s entry with its canonical base and host-specific manifest', async (host, name) => {
    const f = await fixture()
    const { secret } = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'))
    const origin = new URL(f.env.HQHARNESS_WPS_URL).origin
    const base = `${origin}/${secret}/addins/${host}/`
    const response = await fetch(base.slice(0, -1), { redirect: 'manual' })
    expect(response.status).toBe(200)
    const html = await response.text()
    const dom = new JSDOM(html, { url: base.slice(0, -1) })
    try {
      expect(digest(dom.window.document.baseURI)).toBe(digest(base))
      expect(digest(new URL('main.js', dom.window.document.baseURI).href)).toBe(digest(`${base}main.js`))
      const inline = [...dom.window.document.querySelectorAll('script')].filter(script => !script.src).map(script => script.textContent)
      expect(inline).toHaveLength(1)
      const hash = createHash('sha256').update(inline[0]).digest('base64')
      const policy = response.headers.get('content-security-policy') ?? ''
      expect(policy.includes(`'sha256-${hash}'`)).toBe(true)
      expect(policy.includes("default-src 'none'")).toBe(true)
      expect(policy.includes("base-uri 'self'")).toBe(true)
      expect(policy.includes("script-src 'self'")).toBe(true)
      expect(policy.includes(`connect-src ${origin.replace('http:', 'ws:')}`)).toBe(true)
      expect(policy.includes('frame-ancestors')).toBe(false)
      expect(policy.includes("'unsafe-inline'") || policy.includes("'unsafe-eval'")).toBe(false)
      const context = createContext({ window: {} }, { codeGeneration: { strings: false, wasm: false } })
      runInContext(inline[0], context)
      expect(context.window.HuaqingDesktopOnLoad()).toBe(true)
    } finally { dom.window.close() }
    const manifest = await fetch(`${base}manifest.xml`)
    expect(manifest.status).toBe(200)
    const xml = await manifest.text()
    expect(xml.includes('<JsPlugin>') && xml.includes(`<Name>${name}</Name>`)).toBe(true)
    expect(xml.includes('{{ADDIN_NAME}}')).toBe(false)
  })
  it.each(['et', 'wps', 'wpp'])('executes served %s main in a synthesized WPS page and opens only the exact private bridge', async host => {
    const f = await fixture()
    const { secret } = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'))
    const origin = new URL(f.env.HQHARNESS_WPS_URL).origin
    const response = await fetch(`${origin}/${secret}/addins/${host}/main.js`)
    expect(response.status).toBe(200)
    const vm = executeAddinBundle(await response.text())
    expect(vm.sockets).toHaveLength(1)
    expect(digest(vm.sockets[0].url)).toBe(digest(`${origin.replace('http:', 'ws:')}/${secret}/bridge/${host}`))
    expect(Object.hasOwn(vm.context, 'HQ_WPS_ADDIN_URL')).toBe(false)
    expect(vm.context.location.href).toBe('about:blank')
    expect(vm.context.document.currentScript).toBe(null)
    expect(vm.context.HuaqingDesktopOnLoad()).toBe(true)
    vm.sockets[0].onopen()
    expect(vm.sockets[0].sent[0]).toEqual({ type: 'hello', protocol: 1, host, documents: [] })
    expect(vm.evalCall).not.toHaveBeenCalled()
    expect(vm.functionCall).not.toHaveBeenCalled()
    vm.unload.forEach(callback => callback())
    expect(vm.sockets[0].readyState).toBe(3)
  })
  it('initializes the API lazily, executes finite Writer operations and never evaluates supplied code', async () => {
    const f = await fixture()
    const { secret } = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'))
    const origin = new URL(f.env.HQHARNESS_WPS_URL).origin
    const response = await fetch(`${origin}/${secret}/addins/wps/main.js`)
    const vm = executeAddinBundle(await response.text())
    const socket = vm.sockets[0]
    socket.onopen()
    expect(socket.sent[0].documents).toEqual([])
    let body = 'alpha target omega\r'
    let writes = 0
    const document = { Name: 'fixture.docx', FullName: '/test/fixture.docx', Saved: true, ReadOnly: false,
      Content: { Start: 0, get Text() { return body } },
      Range: (start, end) => ({ get Text() { return body.slice(start, end) }, set Text(value) { body = body.slice(0, start) + value + body.slice(end); writes++; document.Saved = false } })
    }
    const app = { Documents: { Count: 1, Item: () => document } }
    vm.context.wps = { WpsApplication: () => app }
    vm.intervals.forEach(callback => callback())
    const listed = socket.sent.find(message => message.type === 'documents' && message.documents.length === 1)
    expect(Boolean(listed)).toBe(true)
    const key = listed.documents[0].key
    const send = (id, operation) => {
      socket.onmessage({ data: JSON.stringify({ type: 'execute', id, operation: { key, ...operation } }) })
      return socket.sent.find(message => message.type === 'result' && message.id === id).result
    }
    expect(send('inspect', { action: 'inspect', snapshot: 'snapshot-one' }).ok).toBe(true)
    for (const action of ['run_code', 'eval', 'executeCode', 'macro']) {
      expect(send(action, { action, code: 'globalThis.__unexpectedExecution = true' }).ok).toBe(false)
    }
    expect(writes).toBe(0)
    expect(vm.context.__unexpectedExecution).toBe(false)
    const changed = send('write', { action: 'writer_replace', snapshot: 'snapshot-one', nextSnapshot: 'snapshot-two', oldText: 'target', replaceText: 'replaced' })
    expect(changed.ok).toBe(true)
    expect(changed.value.snapshot).toBe('snapshot-two')
    expect(body).toBe('alpha replaced omega\r')
    expect(writes).toBe(1)
    expect(vm.evalCall).not.toHaveBeenCalled()
    expect(vm.functionCall).not.toHaveBeenCalled()
    vm.unload.forEach(callback => callback())
  })
  it('normalizes known native verification failures and sends only bounded diagnostic metadata from the actual bootstrap', async () => {
    const f = await fixture()
    const { secret } = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'))
    const origin = new URL(f.env.HQHARNESS_WPS_URL).origin
    const source = await (await fetch(`${origin}/${secret}/addins/et/main.js`)).text()
    const vm = executeAddinBundle(source)
    const diagnostic = { phase: 'final', ordinal: 3, mismatchFields: ['formula'],
      expectedTypes: { value: 'number', formula: 'number', numberFormat: 'string', hasFormula: 'boolean' },
      observedTypes: { value: 'number', formula: 'string', numberFormat: 'string', hasFormula: 'boolean' } }
    let failure = { code: 'READBACK_MISMATCH', outcome: 'unknown', completed: 4, diagnostic, message: 'private body', values: [['private value']] }
    vm.context.HuaqingWpsAdapter = { create: () => ({ documents: () => [], execute() { throw failure } }) }
    const socket = vm.sockets[0]
    socket.onopen()
    const call = id => {
      socket.onmessage({ data: JSON.stringify({ type: 'execute', id, operation: { action: 'sheet_write' } }) })
      return socket.sent.find(message => message.id === id).result
    }
    expect(call('bounded')).toEqual({ ok: false, code: 'WPS_READBACK_MISMATCH', outcome: 'unknown', completed: 4, diagnostic })
    failure = { ...failure, completed: -1, diagnostic: { ...diagnostic, cellValue: 'private body' } }
    expect(call('invalid')).toEqual({ ok: false, code: 'WPS_READBACK_MISMATCH', outcome: 'unknown' })
    failure = { ...failure, code: 'SAVE_UNVERIFIED' }
    expect(call('save')).toEqual({ ok: false, code: 'WPS_SAVE_UNVERIFIED', outcome: 'unknown' })
    expect(JSON.stringify(socket.sent)).not.toContain('private')
    vm.unload.forEach(callback => callback())
  })
  it('rejects unexpected tool arguments on the real MCP boundary', async () => {
    const f = await fixture()
    await f.connectRaw()
    const value = await f.raw.callTool({ name: WPS_RAW_TOOL_NAME, arguments: { action: 'status', code: 'forbidden' }, _meta: { huaqing: { owner: 'owner-one', policy: { mode: 'workspace-write', workspaceRoot: f.directory } } } })
    expect(value.isError).toBe(true)
    expect(JSON.parse(value.content[0].text)).toMatchObject({ code: 'WPS_INVALID_INPUT', outcome: 'not_executed' })
  })
  it('rejects externally capable formulas before granting access or dispatching to WPS', async () => {
    const f = await fixture()
    const spy = vi.spyOn(WpsDocuments.prototype, 'execute')
    await f.connectRaw()
    const value = await f.raw.callTool({ name: WPS_RAW_TOOL_NAME,
      arguments: { action: 'sheet_write', key: 'opaque', snapshot: 's', sheet: '数据', range: 'A1', formulas: [['=WEBSERVICE("https://example.test")']] },
      _meta: { huaqing: { owner: 'owner-one', policy: { mode: 'workspace-write', workspaceRoot: f.directory } } }
    })
    expect(value.isError).toBe(true)
    expect(JSON.parse(value.content[0].text)).toMatchObject({ code: 'WPS_INVALID_INPUT', outcome: 'not_executed' })
    expect(spy).not.toHaveBeenCalled()
    expect(fakes.dialog).not.toHaveBeenCalled()
  })
  it('returns client errors for malformed and oversized HTTP bodies before document dispatch', async () => {
    const f = await fixture()
    const spy = vi.spyOn(WpsDocuments.prototype, 'execute')
    const headers = { Authorization: `Bearer ${f.env.HQHARNESS_WPS_TOKEN}`, 'Content-Type': 'application/json', 'x-hq-wps-client': randomUUID() }
    const malformed = await fetch(f.env.HQHARNESS_WPS_URL, { method: 'POST', headers, body: '{' })
    expect(malformed.status).toBe(400)
    const oversized = await fetch(f.env.HQHARNESS_WPS_URL, { method: 'POST', headers, body: 'x'.repeat(81 * 1024) })
    expect(oversized.status).toBe(413)
    expect(spy).not.toHaveBeenCalled()
  })
  it('keeps opaque document handles session-owned and binds native document keys only in Main', async () => {
    const f = await fixture()
    const operations = []
    await addin(f, message => { operations.push(message.operation) })
    const listed = await f.call({ action: 'documents' })
    const key = listed.documents[0].key
    expect(key).not.toBe('native-document-key')
    await expect(f.call({ action: 'inspect', key }, 'owner-two')).rejects.toMatchObject({ code: 'WPS_STALE_DOCUMENT' })
    expect(operations).toHaveLength(0)
    const inspected = await f.call({ action: 'inspect', key })
    expect(typeof inspected.snapshot).toBe('string')
    expect(operations[0].key).toBe('native-document-key')
    expect(operations[0].snapshot).toBe(inspected.snapshot)
  })
  it('reports cancellation after write dispatch as unknown and freezes later writes', async () => {
    const f = await fixture()
    let started
    const dispatched = new Promise(resolve => { started = resolve })
    await addin(f, message => {
      if (message.operation.action === 'sheet_write') { started(); return false }
    })
    const listed = await f.call({ action: 'documents' })
    const key = listed.documents[0].key
    const inspected = await f.call({ action: 'inspect', key })
    const controller = new AbortController()
    const write = f.call({ action: 'sheet_write', key, snapshot: inspected.snapshot, sheet: 'Sheet1', range: 'A1:A1', values: [[1]] }, 'owner-one', controller.signal)
    const assertion = expect(write).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    await dispatched
    controller.abort()
    await assertion
    await vi.waitFor(async () => expect((await f.call({ action: 'status' })).frozenDocuments).toBeGreaterThan(0))
    await expect(f.call({ action: 'save', key, snapshot: inspected.snapshot })).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
  })
  it('preserves validated readback diagnostics through the native bridge, unknown journal and real MCP response', async () => {
    const f = await fixture()
    const diagnostic = { phase: 'cell', ordinal: 0, mismatchFields: ['formula'],
      expectedTypes: { value: 'number', formula: 'number', numberFormat: 'string', hasFormula: 'boolean' },
      observedTypes: { value: 'number', formula: 'string', numberFormat: 'string', hasFormula: 'boolean' } }
    let writes = 0
    const socket = await addin(f, message => {
      if (message.operation.action !== 'sheet_write') return
      writes++
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: false, code: 'WPS_READBACK_MISMATCH', outcome: 'unknown', completed: 0, diagnostic, message: 'private body', values: [['private value']] } }))
      return false
    })
    const { documents } = await f.call({ action: 'documents' })
    const key = documents[0].key
    const inspected = await f.call({ action: 'inspect', key })
    await f.connectRaw()
    const result = await f.raw.callTool({ name: WPS_RAW_TOOL_NAME,
      arguments: { action: 'sheet_write', key, snapshot: inspected.snapshot, sheet: 'Sheet1', range: 'A1', values: [[1]] },
      _meta: { huaqing: { owner: 'owner-one', policy: { mode: 'workspace-write', workspaceRoot: f.directory } } }
    })
    expect(result.isError).toBe(true)
    const failure = JSON.parse(result.content[0].text)
    expect(failure).toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME', causeCode: 'WPS_READBACK_MISMATCH', outcome: 'unknown', completed: 0, diagnostic })
    expect(failure.message).toContain('[cause=WPS_READBACK_MISMATCH]')
    expect(JSON.stringify(failure)).not.toContain('private')
    const journals = await readdir(join(f.directory, 'operations'))
    expect(journals.filter(name => name.endsWith('.json'))).toHaveLength(1)
    const journal = JSON.parse(await readFile(join(f.directory, 'operations', journals.find(name => name.endsWith('.json'))), 'utf8'))
    expect(journal).toMatchObject({ state: 'unknown', causeCode: failure.causeCode, completed: 0, diagnostic })
    expect(JSON.stringify(journal)).not.toContain('private')
    await expect(f.call({ action: 'sheet_write', key, snapshot: inspected.snapshot, sheet: 'Sheet1', range: 'A1', values: [[1]] })).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    expect(writes).toBe(1)
  })
  it('associates MCP cancellation with both the originating transport and request ID', async () => {
    const f = await fixture()
    const spy = vi.spyOn(WpsDocuments.prototype, 'execute')
    let started
    const dispatched = new Promise(resolve => { started = resolve })
    await addin(f, message => {
      if (message.operation.action === 'sheet_write') { started(); return false }
    })
    const { documents } = await f.call({ action: 'documents' })
    const key = documents[0].key
    const inspected = await f.call({ action: 'inspect', key })
    await f.connectRaw()
    const originalFetch = globalThis.fetch
    let requestId
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (typeof init?.body === 'string') {
        const message = JSON.parse(init.body)
        if (message.method === 'tools/call' && message.params?.arguments?.action === 'sheet_write') requestId = message.id
      }
      return originalFetch(input, init)
    })
    const write = f.raw.callTool({ name: WPS_RAW_TOOL_NAME,
      arguments: { action: 'sheet_write', key, snapshot: inspected.snapshot, sheet: 'Sheet1', range: 'A1:A1', values: [[1]] },
      _meta: { huaqing: { owner: 'owner-one', policy: { mode: 'workspace-write', workspaceRoot: f.directory } } }
    })
    await dispatched
    expect(typeof requestId === 'number' || typeof requestId === 'string').toBe(true)
    const cancel = async clientId => originalFetch(f.env.HQHARNESS_WPS_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${f.env.HQHARNESS_WPS_TOKEN}`, 'Content-Type': 'application/json', 'x-hq-wps-client': clientId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } })
    })
    expect((await cancel(randomUUID())).status).toBe(202)
    const invocation = spy.mock.calls.find(([operation]) => operation.action === 'sheet_write')
    expect(invocation[2].aborted).toBe(false)
    expect((await cancel(f.clientId)).status).toBe(202)
    const result = await write
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME', outcome: 'unknown' })
    expect((await f.call({ action: 'status' })).frozenDocuments).toBeGreaterThan(0)
  })
})
