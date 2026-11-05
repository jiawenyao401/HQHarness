import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { WPS_INPUT_SCHEMA, WPS_RAW_TOOL_NAME, validateWpsCallMeta, validateWpsOperation } from '../../../packages/hqharness-wps/protocol.js'
import { PRODUCT_NAME } from '../../shared/brand'
import type { WpsStatus } from '../../shared/wps'
import { WpsConnection, WpsError } from './connection'
import { WpsDocuments, type WpsConsent } from './documents'
import { registerWpsAddins } from './addin-registration'

const exec = promisify(execFile)
interface Installation { port: number; secret: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The listener is private to the installed Desktop. WPS Add-ins need a stable
 * URL across WPS restarts; the separate Harness bearer rotates each launch. */
export class DesktopWpsService {
  private server?: HttpServer
  private connection?: WpsConnection
  private documents?: WpsDocuments
  private installation?: Installation
  private token = randomBytes(32).toString('hex')
  private registered = false
  private registering = false
  private registrationTask?: Promise<void>
  private addonStages = new Set<string>()
  private startupError?: string
  private active = new Set<AbortController>()
  private requests = new Map<string, AbortController>()
  constructor(private readonly directory: string, private readonly window: () => BrowserWindow | undefined, private readonly locale: () => 'zh' | 'en') {}
  private get origin(): string { return `http://127.0.0.1:${this.installation?.port ?? 0}` }
  private get baseUrl(): string { return `${this.origin}/${this.installation?.secret ?? ''}` }
  private registryDirectory(): string {
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Containers', 'com.kingsoft.wpsoffice.mac', 'Data', '.kingsoft', 'wps', 'jsaddons')
    if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'kingsoft', 'wps', 'jsaddons')
    throw new WpsError('WPS_UNSUPPORTED', 'Local WPS integration is available on Windows and macOS')
  }
  status(): WpsStatus {
    return { supported: process.platform === 'darwin' || process.platform === 'win32', registered: this.registered,
      connectedDocuments: this.connection?.documents().length ?? 0, connectedComponents: this.connection?.components() ?? [], frozenDocuments: this.documents?.frozenDocuments ?? 0, needsWpsRestart: this.registered && !this.connection?.components().length,
      ...(this.startupError ? { error: this.startupError } : {}) }
  }
  private connectionGuidance(status: WpsStatus): string | undefined {
    if (status.connectedDocuments) return
    if (!status.registered) return 'WPS Add-in is not enabled. Save and fully exit WPS. In Huaqing Desktop, open Settings → Built-in Plugins → WPS Office and choose Enable WPS connection. Reopen WPS and confirm loading the HuaqingDesktop Add-in if prompted.'
    if (!status.connectedComponents.length) return 'The WPS Add-in is registered but has not connected. Reopen WPS, confirm loading the HuaqingDesktop Add-in if prompted, and check the connection in Settings → Built-in Plugins → WPS Office.'
    return 'WPS is connected. Open a local document in WPS and then list connected documents again.'
  }
  environment(): NodeJS.ProcessEnv {
    this.stop(); this.token = randomBytes(32).toString('hex')
    return this.server ? { HQHARNESS_WPS_URL: `${this.origin}/mcp`, HQHARNESS_WPS_TOKEN: this.token } : {}
  }
  stop(): void {
    for (const active of this.active) active.abort(new WpsError('WPS_STOPPED', 'WPS automation was stopped'))
    this.documents?.stop()
  }
  registerIpc(assertTrusted: (event: IpcMainInvokeEvent) => void): void {
    for (const action of ['status', 'register', 'stop'] as const) {
      const channel = `hq:wps:${action}`
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async event => {
        assertTrusted(event)
        try {
          if (action === 'stop') this.stop()
          if (action === 'register') await this.enableAddin()
          return this.status()
        } catch (error) {
          if (error instanceof WpsError) throw new Error(`${error.code}: ${error.message}`)
          throw new Error('WPS_REGISTRATION_FAILED: WPS Add-in registration failed. Preserve its recovery files and retry after inspecting the connector status.')
        }
      })
    }
  }
  private async wpsRunning(): Promise<boolean> {
    // Read process metadata without a shell. Never terminate a user's WPS.
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/bin/ps', ['-axo', 'comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
      return stdout.split('\n').some(line => /\/WPS Office\.app\/|\/wpsoffice\.app\//iu.test(line))
    }
    if (process.platform === 'win32' && process.env.SystemRoot) {
      const { stdout } = await exec(join(process.env.SystemRoot, 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      return stdout.split('\n').some(line => /^"(?:wps|et|wpp|wpsoffice)\.exe"/iu.test(line))
    }
    throw new WpsError('WPS_UNSUPPORTED', 'Cannot verify whether WPS has exited on this platform')
  }
  async enableAddin(): Promise<void> {
    if (!this.server || !this.installation) throw new WpsError('WPS_UNAVAILABLE', 'The local WPS connector could not start')
    if (this.registering) throw new WpsError('WPS_BUSY', 'WPS registration is already running')
    this.registering = true
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    this.active.add(controller)
    const task = (async () => {
      signal.throwIfAborted()
      if (await this.wpsRunning()) throw new WpsError('WPS_RESTART_REQUIRED', this.locale() === 'zh' ? '请先保存文档并完全退出 WPS，再启用加载项。客户端不会关闭你的 WPS。' : 'Save your documents and completely quit WPS before enabling its Add-in. Desktop will not close WPS for you.')
      signal.throwIfAborted()
      const directory = this.registryDirectory()
      // Require the WPS-owned parent to exist. Do not manufacture a fake WPS
      // installation merely because this platform can run the connector.
      await stat(join(directory, '..'))
      signal.throwIfAborted()
      if (!await this.consent({ kind: 'register' }, signal)) throw new WpsError('WPS_DENIED', 'WPS Add-in registration was declined')
      if (await this.wpsRunning()) throw new WpsError('WPS_RESTART_REQUIRED', 'WPS opened during registration; close it and try again')
      signal.throwIfAborted()
      // An admitted registry transaction completes or retains recovery files.
      // Closing Desktop waits for it instead of reporting a false cancellation.
      await registerWpsAddins({ directory, baseUrl: this.baseUrl, platform: process.platform })
      await this.writeConfiguration('registered.json', { baseUrl: this.baseUrl, registeredAt: Date.now() })
      this.registered = true
    })().finally(() => { this.registering = false; this.active.delete(controller) })
    this.registrationTask = task
    try { await task }
    finally { if (this.registrationTask === task) this.registrationTask = undefined }
  }
  private async consent(request: WpsConsent | { kind: 'register' }, signal: AbortSignal): Promise<boolean> {
    const zh = this.locale() === 'zh'
    const parent = this.window()
    if (!parent || parent.isDestroyed()) throw new WpsError('WPS_CONSENT_UNAVAILABLE', 'Open Huaqing Desktop to authorize local WPS access')
    const target = 'document' in request && request.document ? request.document.path || request.document.name : ''
    const detail = request.kind === 'register'
      ? zh ? '将在当前用户的 WPS 加载项配置中添加 Huaqing Desktop 的本机连接器，保留其他加载项。不会更改 WPS 的宏或安全策略。启用后重新打开 WPS 文档。' : 'Add the local Huaqing Desktop connector to this user’s WPS Add-in configuration, preserving other Add-ins. WPS macro and security policies remain in effect. Reopen WPS documents after enabling.'
      : request.kind === 'documents'
        ? zh ? '允许当前会话查看本机已打开的 WPS 文档名称和路径。读取内容或修改文档会分别请求授权。' : 'Allow this session to list names and paths of local documents open in WPS. Reading content and changing documents require separate authorization.'
        : request.kind === 'save'
          ? zh ? `保存当前 WPS 文档，包含你手工所做的其他未保存编辑。客户端会先备份磁盘原件；保存后核对 WPS 状态和本地文件，不会关闭文档。\n${target}` : `Save the current WPS document, including your other unsaved edits. Desktop first backs up the existing local file, then checks WPS and the file. The document stays open.\n${target}`
          : request.kind === 'recover'
            ? zh ? `此前操作结果未确认。请先在 WPS 检查文档，再允许客户端重新读取并恢复后续操作。不会重放此前的修改。\n${target}` : `A previous operation has an unconfirmed result. Inspect the document in WPS before allowing a fresh read and further operations. The previous change will not be replayed.\n${target}`
            : zh ? `允许当前会话${request.kind === 'write' ? '修改' : '读取'}此本机 WPS 文档？内容会交给当前模型；修改先留在 WPS 中，保存需要单独确认。授权 30 分钟后失效，可通过紧急停止撤销。${'outsideWorkspace' in request && request.outsideWorkspace ? '\n此文档位于当前工作区之外。' : ''}\n${target}` : `Allow this session to ${request.kind === 'write' ? 'change' : 'read'} this local WPS document? Content is sent to the current model. Changes remain in WPS until a separately confirmed save. Access expires in 30 minutes and can be revoked with emergency stop.\n${target}`
    signal.throwIfAborted(); parent.show(); parent.focus()
    const pending = new AbortController()
    const abort = (): void => pending.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const result = await dialog.showMessageBox(parent, { type: 'question', title: `${PRODUCT_NAME} · WPS`, message: zh ? 'WPS 本机文档授权' : 'Local WPS document access', detail,
        buttons: zh ? ['取消', '允许'] : ['Cancel', 'Allow'], defaultId: 0, cancelId: 0, noLink: true, signal: pending.signal })
      signal.throwIfAborted()
      return result.response === 1
    } finally {
      // Electron can retain the dialog's AbortSignal callback after it has
      // resolved. Do not send a later operation timeout to a closed dialog.
      signal.removeEventListener('abort', abort)
    }
  }
  async start(): Promise<void> {
    if (this.server) return
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const path = join(this.directory, 'connection.json')
      let installation: Installation = { port: 0, secret: randomBytes(32).toString('hex') }
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new WpsError('WPS_INVALID_INSTALLATION', 'Invalid local WPS connector configuration')
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (!record(saved) || !Number.isInteger(saved.port) || Number(saved.port) < 1025 || Number(saved.port) > 65535 || typeof saved.secret !== 'string' || !/^[a-f0-9]{64}$/u.test(saved.secret)) throw new WpsError('WPS_INVALID_INSTALLATION', 'Invalid local WPS connector configuration')
        installation = { port: Number(saved.port), secret: saved.secret }
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      this.installation = installation
      const documents = new WpsDocuments(this.directory, { documents: () => this.connection?.documents() ?? [], resolve: target => {
        if (!this.connection) throw new WpsError('WPS_NOT_CONNECTED', 'WPS is not connected')
        return this.connection.resolve(target)
      }, execute: (target, operation, signal) => {
        if (!this.connection) throw new WpsError('WPS_NOT_CONNECTED', 'WPS is not connected')
        return this.connection.execute(target, operation, signal)
      }, stop: () => this.connection?.stop() }, (request, signal) => this.consent(request, signal))
      await documents.initialize(); this.documents = documents
      const server = createServer((request, response) => { void this.handle(request, response) })
      server.requestTimeout = 15_000; server.headersTimeout = 5000; server.maxConnections = 24
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(installation.port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new WpsError('WPS_UNAVAILABLE', 'WPS loopback listener did not start')
      installation.port = address.port
      this.server = server
      this.connection = new WpsConnection(server, installation.secret, () => this.origin)
      await this.writeConfiguration('connection.json', installation)
      try { const marker: unknown = JSON.parse(await readFile(join(this.directory, 'registered.json'), 'utf8')); this.registered = record(marker) && marker.baseUrl === this.baseUrl }
      catch (error) {
        // Registration is a repairable state marker, never an authority for
        // document access. Preserve a damaged marker and keep the connector
        // available so Settings can register the Add-in again.
        this.registered = false
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) console.warn('[wps] registration marker could not be read; setup remains available')
      }
    } catch (error) {
      await this.close()
      this.startupError = error instanceof WpsError ? error.code : 'WPS_STARTUP_FAILED'
      console.warn('[wps] connector startup failed:', this.startupError)
    }
  }
  private async writeConfiguration(name: string, value: object): Promise<void> {
    const temporary = join(this.directory, `${name}.${randomBytes(8).toString('hex')}.tmp`)
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(this.directory, name))
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController(); this.active.add(controller)
    response.once('close', () => { if (!response.writableEnded) controller.abort() })
    try {
      if (request.headers.host !== this.origin.slice(7) || request.headers.origin && request.headers.origin !== this.origin) {
        if (request.url?.startsWith(`/${this.installation?.secret}/addins/`)) console.warn('[wps] Add-in HTTP request rejected:', request.headers.host !== this.origin.slice(7) ? 'unexpected-host' : request.headers.origin === 'null' ? 'null-origin' : 'unexpected-origin')
        response.writeHead(403).end(); return
      }
      if (request.url?.startsWith(`/${this.installation?.secret}/addins/`) && request.method === 'GET') {
        const match = new RegExp(`^/${this.installation?.secret}/addins/(et|wps|wpp)(?:/(index.html|manifest.xml|ribbon.xml|adapter.js|main.js)?)?$`, 'u').exec(request.url)
        if (!match) { console.warn('[wps] Add-in requested an unsupported resource'); response.writeHead(404).end(); return }
        const file = match[2] || 'index.html'
        const assetDirectory = join(app.getAppPath(), 'node_modules', 'hqharness-wps', 'addin')
        let content = await readFile(join(assetDirectory, file))
        // WPS normalizes the stored Add-in URL by removing its trailing slash.
        // Serve it directly; native loaders need not follow redirects.
        if (file === 'index.html') content = Buffer.from(content.toString('utf8').replace('<head>', `<head><base href="${this.baseUrl}/addins/${match[1]}/">`))
        if (file === 'manifest.xml') content = Buffer.from(content.toString('utf8').replace('{{ADDIN_NAME}}', match[1] === 'et' ? 'HuaqingDesktopET' : match[1] === 'wpp' ? 'HuaqingDesktopWPP' : 'HuaqingDesktopWPS'))
        // Some WPS builds synthesize their own index and load main.js alone.
        // Keep one entry with the adapter first, from the same installed source.
        if (file === 'main.js') content = Buffer.concat([
          Buffer.from(`;(()=>{const HQ_WPS_ADDIN_URL=${JSON.stringify(`${this.baseUrl}/addins/${match[1]}/`)};\n`),
          await readFile(join(assetDirectory, 'adapter.js')), Buffer.from(';\n'), content, Buffer.from(';\n})();\n')
        ])
        // WPS resolves the ribbon onLoad callback before external scripts may
        // finish. Permit only the exact inline callback in this trusted asset.
        const inline = file === 'index.html' ? /<script>([^<]*)<\/script>/u.exec(content.toString('utf8'))?.[1] : undefined
        const inlinePolicy = inline ? ` 'sha256-${createHash('sha256').update(inline).digest('base64')}'` : ''
        const stage = `${match[1]}/${file}`
        if (!this.addonStages.has(stage)) { this.addonStages.add(stage); console.info('[wps] Add-in resource served:', stage) }
        // WPS embeds the Add-in in its native host. A frame-ancestors denial
        // prevents that host from running the entry at all. The unguessable
        // asset path, private WS credential and exact Origin check remain.
        response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; base-uri 'self'; script-src 'self'${inlinePolicy}; connect-src ws://127.0.0.1:${this.installation?.port}` }).end(content)
        return
      }
      const supplied = request.headers.authorization ?? ''
      const expected = `Bearer ${this.token}`
      if (request.url !== '/mcp' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { response.writeHead(403).end(); return }
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > 80 * 1024) { response.writeHead(413).end(); return }; chunks.push(data) }
      const body = Buffer.concat(chunks).toString('utf8')
      let message: unknown
      try { message = JSON.parse(body) }
      catch {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
        return
      }
      const client = request.headers['x-hq-wps-client']
      const clientId = typeof client === 'string' && /^[a-f0-9-]{36}$/u.test(client) ? client : 'legacy'
      if (record(message) && message.method === 'notifications/cancelled') {
        const params = message.params
        if (record(params) && (typeof params.requestId === 'number' || typeof params.requestId === 'string')) this.requests.get(`${clientId}:${JSON.stringify(params.requestId)}`)?.abort(new WpsError('WPS_STOPPED', 'The WPS MCP request was cancelled'))
        response.writeHead(202).end(); return
      }
      const requestKey = record(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? `${clientId}:${JSON.stringify(message.id)}` : undefined
      if (requestKey && this.requests.has(requestKey)) { response.writeHead(409).end(); return }
      if (requestKey) this.requests.set(requestKey, controller)
      const server = new Server({ name: 'huaqing-local-wps', version: '0.1.0' }, { capabilities: { tools: {} } })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 80 * 1024 })
      server.setRequestHandler('tools/list', () => ({ tools: [{ name: WPS_RAW_TOOL_NAME, description: 'Read and edit local WPS documents through the Huaqing Desktop Add-in. Finite structured operations only; no arbitrary scripts. Writes require a current snapshot and native user authorization.', inputSchema: { ...WPS_INPUT_SCHEMA, type: 'object' } }] }))
      server.setRequestHandler('tools/call', async (call, ctx) => {
        try {
          if (call.params.name !== WPS_RAW_TOOL_NAME) throw new WpsError('WPS_INVALID_INPUT', 'Unknown local WPS tool')
          const operation = validateWpsOperation(call.params.arguments)
          const meta = validateWpsCallMeta(ctx.mcpReq._meta?.huaqing)
          if (!this.documents) throw new WpsError('WPS_UNAVAILABLE', 'The local WPS connector is unavailable')
          const result = await this.documents.execute(operation, meta, AbortSignal.any([ctx.mcpReq.signal, controller.signal]))
          let value = result
          if (operation.action === 'status' || operation.action === 'documents' && Array.isArray(result.documents) && !result.documents.length) {
            const status = this.status()
            const guidance = this.connectionGuidance(status)
            value = { ...result, ...(operation.action === 'status' ? status : {}), ...(guidance ? { guidance } : {}) }
          }
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
        } catch (error) {
          const failure = error instanceof WpsError ? { code: error.code, message: error.message, outcome: error.outcome, ...(error.completed === undefined ? {} : { completed: error.completed }), ...(error.causeCode ? { causeCode: error.causeCode } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }
            : { code: error instanceof TypeError ? 'WPS_INVALID_INPUT' : 'WPS_OPERATION_FAILED', message: 'Local WPS operation failed. Inspect the document and connector status before continuing.', outcome: 'not_executed' }
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }] }
        }
      })
      try {
        await server.connect(transport)
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value)
        const result = await transport.handleRequest(new Request(`${this.origin}/mcp`, { method: 'POST', headers, body, signal: controller.signal }))
        response.writeHead(result.status, Object.fromEntries(result.headers))
        response.end(Buffer.from(await result.arrayBuffer()))
      } finally { if (requestKey) this.requests.delete(requestKey); await server.close() }
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Local WPS connector request failed' }))
      else response.destroy()
    } finally { this.active.delete(controller) }
  }
  async close(): Promise<void> {
    this.stop()
    await this.registrationTask?.catch(() => undefined) // The owning setup action already reports registration failure.
    await this.connection?.close(); this.connection = undefined
    const server = this.server; this.server = undefined
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    for (const action of ['status', 'register', 'stop']) ipcMain.removeHandler(`hq:wps:${action}`)
  }
}
