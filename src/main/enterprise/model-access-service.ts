import { createServer, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { join } from 'node:path'
import { ipcMain, powerMonitor, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { ModelAccessError, objectValue, type ModelAccessResult } from '../../shared/model-access'
import { ModelAccessManager } from './model-access-manager'
import { ModelAccessStore } from './model-access-store'

const ACTIONS = ['status', 'configure', 'login', 'claim', 'refresh', 'logout'] as const
type ModelAccessController = Pick<ModelAccessManager, 'initialize' | 'refresh' | 'status' | 'configure' | 'login' | 'claim' | 'logout' | 'managedModel' | 'beginRequest' | 'finishRequest' | 'invalidate' | 'tick'>
export class DesktopModelAccessService {
  private server?: Server
  private port = 0
  private token = randomBytes(32).toString('hex')
  private readonly requests = new Set<AbortController>()
  private readonly manager: ModelAccessController
  private readonly fetcher: typeof fetch
  private timer?: ReturnType<typeof setInterval>
  private readonly resume = (): void => {
    this.manager.invalidate()
    void this.manager.refresh().catch(() => { /* The manager retains a visible recovery status. */ })
  }
  constructor(userData: string, options: { manager?: ModelAccessController; fetcher?: typeof fetch } = {}) {
    this.manager = options.manager ?? new ModelAccessManager(new ModelAccessStore(join(userData, 'model-access', 'credentials.bin'), safeStorage), () => this.cancelRequests())
    this.fetcher = options.fetcher ?? fetch
  }
  registerIpc(assertTrusted: (event: IpcMainInvokeEvent) => void): void {
    for (const action of ACTIONS) {
      const channel = `hq:model-access:${action}`
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, input: unknown): Promise<ModelAccessResult> => {
        assertTrusted(event)
        try {
          let status
          if (action === 'configure') status = await this.manager.configure(input)
          else if (action === 'login') status = await this.manager.login(input)
          else if (action === 'claim') status = await this.manager.claim()
          else if (action === 'refresh') status = await this.manager.refresh()
          else if (action === 'logout') status = await this.manager.logout()
          else status = await this.manager.status()
          return { ok: true, status }
        } catch (error) {
          return { ok: false, error: error instanceof ModelAccessError ? error.code : 'SERVICE_ERROR', status: await this.manager.status() }
        }
      })
    }
  }
  private cancelRequests(): void {
    for (const request of this.requests) request.abort(new ModelAccessError('CANCELLED', 'Team model request cancelled'))
  }
  environment(): NodeJS.ProcessEnv {
    this.cancelRequests()
    this.token = randomBytes(32).toString('hex')
    return { HQHARNESS_MODEL_BRIDGE_URL: `http://127.0.0.1:${this.port}`, HQHARNESS_MODEL_BRIDGE_TOKEN: this.token }
  }
  private json(response: ServerResponse, status: number, value: object): void {
    if (!response.destroyed) response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value))
  }
  async start(): Promise<void> {
    if (this.server) return
    await this.manager.initialize().catch(() => { /* Preserve damaged storage and expose its recovery error via IPC. */ })
    const initial = await this.manager.status()
    if (initial.signedIn) void this.manager.refresh().catch(() => { /* Account/network failures stay visible in settings. */ })
    const server = createServer(async (request, response) => {
      const authorization = request.headers.authorization ?? ''
      const expected = `Bearer ${this.token}`
      if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${this.port}` || Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
        response.writeHead(403).end(); request.resume(); return
      }
      if (request.method === 'GET' && request.url === '/managed-model') {
        this.json(response, 200, { lease: await this.manager.managedModel(), baseURL: `http://127.0.0.1:${this.port}/v1`, apiKey: this.token })
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); request.resume(); return }
      const controller = new AbortController()
      this.requests.add(controller)
      request.on('aborted', () => controller.abort())
      response.on('close', () => { if (!response.writableEnded) controller.abort() })
      const inputTimeout = setTimeout(() => controller.abort(), 30_000)
      const stop = (): void => { if (!response.destroyed) response.destroy() }
      controller.signal.addEventListener('abort', stop, { once: true })
      let began = false
      try {
        let size = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > 25 * 1024 * 1024) throw new ModelAccessError('REQUEST_TOO_LARGE', 'Model request is too large', 413)
          chunks.push(buffer)
        }
        clearTimeout(inputTimeout)
        const body = Buffer.concat(chunks)
        let payload: Record<string, unknown>
        try { payload = objectValue(JSON.parse(body.toString('utf8'))) }
        catch { throw new ModelAccessError('INVALID_INPUT', 'Invalid model request', 400) }
        const access = await this.manager.beginRequest()
        began = true
        if (payload.model !== access.lease.model.id) throw new ModelAccessError('MODEL_DENIED', 'Only the leased team model is allowed', 403)
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(300_000, access.remainingMs)))])
        const upstream = await this.fetcher(`${access.baseUrl}/chat/completions`, {
          method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access.virtualKey}` }, body
        })
        if (!upstream.ok) {
          await upstream.body?.cancel()
          const retry = upstream.headers.get('retry-after')
          if (retry && /^\d{1,4}$/.test(retry)) response.setHeader('Retry-After', retry)
          this.json(response, upstream.status, { error: { type: 'team_model', message: `Team model request failed (${upstream.status}); check access status` } })
          return
        }
        if (!upstream.body) throw new ModelAccessError('INVALID_RESPONSE', 'The team model returned no response')
        response.writeHead(200, { 'Content-Type': payload.stream === true ? 'text/event-stream' : 'application/json', 'Cache-Control': 'no-store' })
        const reader = upstream.body.getReader()
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            if (!response.write(next.value)) await once(response, 'drain', { signal })
          }
          response.end()
        } finally {
          await reader.cancel().catch(() => { /* Cancellation can race a disconnected transport. */ })
          reader.releaseLock()
        }
      } catch (error) {
        if (!response.headersSent) this.json(response, error instanceof ModelAccessError ? error.status ?? 503 : 502, { error: { type: 'team_model', message: error instanceof ModelAccessError ? error.message : 'The team model request was interrupted' } })
        else response.destroy()
      } finally {
        clearTimeout(inputTimeout)
        controller.signal.removeEventListener('abort', stop)
        this.requests.delete(controller)
        if (began) this.manager.finishRequest()
      }
    })
    server.requestTimeout = 30_000
    server.headersTimeout = 5_000
    server.maxConnections = 16
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new Error('Team model loopback bridge could not start') }
    this.server = server
    this.port = address.port
    this.timer = setInterval(() => { void this.manager.tick().catch(() => { /* The manager owns bounded retries; acquisition failures remain visible. */ }) }, 5000)
    this.timer.unref()
    powerMonitor.on('resume', this.resume)
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    powerMonitor.off('resume', this.resume)
    this.manager.invalidate()
    this.cancelRequests()
    for (const action of ACTIONS) ipcMain.removeHandler(`hq:model-access:${action}`)
    const server = this.server
    this.server = undefined
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }
}
