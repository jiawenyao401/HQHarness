import { PRODUCT_NAME } from '../../shared/brand'
import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dialog, globalShortcut, ipcMain, shell, systemPreferences, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { AutomationError, MAX_AUTOMATION_REQUEST_BYTES, validateAutomationRequest, type AutomationCapability, type AutomationStatus } from '../../shared/automation'
import { BrowserAutomation } from './browser'
import { ComputerAutomation } from './computer'
import { AutomationGate } from './gate'

const SHORTCUT = 'CommandOrControl+Shift+F12'
const INPUT_TIMEOUT_MS = 15_000
interface AutomationTimeouts { authorizationMs: number; operationMs: number }
export class DesktopAutomationService {
  private server?: Server
  private port = 0
  private token = randomBytes(32).toString('hex')
  private gate = new AutomationGate()
  private browser = new BrowserAutomation()
  private computer = new ComputerAutomation()
  private active = new Set<AbortController>()
  private shortcut = false
  constructor(
    private readonly window: () => BrowserWindow | undefined,
    private readonly locale: () => 'zh' | 'en',
    private readonly timeouts: AutomationTimeouts = { authorizationMs: 120_000, operationMs: 30_000 }
  ) {}
  registerIpc(assertTrusted: (event: IpcMainInvokeEvent) => void): void {
    for (const action of ['status', 'permissions', 'stop'] as const) {
      const channel = `hq:automation:${action}`
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, event => {
        assertTrusted(event)
        if (action === 'permissions') return this.preparePermissions()
        if (action === 'stop') this.stop()
        return this.status()
      })
    }
  }
  status(): AutomationStatus { return { ...this.computer.permissions(), activeSessions: this.gate.activeSessions, shortcut: this.shortcut } }
  stop(): void {
    this.gate.stop()
    for (const controller of this.active) controller.abort(new AutomationError('STOPPED', 'Automation was stopped'))
    this.browser.stop()
    this.computer.stop()
  }
  environment(): NodeJS.ProcessEnv {
    // Rotate the bearer and revoke grants whenever Harness starts/restarts.
    this.stop()
    this.token = randomBytes(32).toString('hex')
    return { HQHARNESS_AUTOMATION_URL: `http://127.0.0.1:${this.port}/operation`, HQHARNESS_AUTOMATION_TOKEN: this.token }
  }
  async preparePermissions(): Promise<AutomationStatus> {
    if (process.platform === 'darwin') {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true)
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    }
    return this.status()
  }
  private async consent(capability: AutomationCapability, signal: AbortSignal): Promise<boolean> {
    const zh = this.locale() === 'zh'
    const name = capability === 'browser' ? 'Browser Use' : 'Computer Use'
    const options = {
      type: 'question' as const, title: `${PRODUCT_NAME} · ${name}`,
      message: zh ? `允许当前会话使用 ${name}？` : `Allow this session to use ${name}?`,
      detail: (capability === 'browser'
        ? zh ? '模型可以访问、观察和操作独立浏览器中的网页。网页内容和截图会交给当前模型；不会读取系统浏览器的数据。' : 'The current model can visit, observe and operate an isolated browser. Page content and screenshots are sent to that model. System browser data is not imported.'
        : zh ? '模型可以查看屏幕并操作本机鼠标、键盘，截图会交给当前模型。请关闭含敏感内容的窗口。不能控制 UAC 或系统安全桌面。' : 'The current model can view your screen and control the mouse and keyboard. Screenshots are sent to that model. Close sensitive windows. UAC and secure desktops are not controllable.')
        + (zh ? '\n授权仅限当前会话，30 分钟后失效。可在设置 → 插件中立即停止。' : '\nAccess is scoped to this session and expires after 30 minutes. Stop immediately in Settings > Plugins.'),
      buttons: zh ? ['取消', '允许当前会话'] : ['Cancel', 'Allow this session'], defaultId: 0, cancelId: 0, noLink: true, signal
    }
    const parent = this.window()
    // Unparented macOS dialogs cannot be aborted and would block stop/timeout.
    if (!parent || parent.isDestroyed()) throw new AutomationError('CONSENT_UNAVAILABLE', `The ${PRODUCT_NAME} window is unavailable for authorization. Open ${PRODUCT_NAME} and retry the tool.`)
    signal.throwIfAborted()
    if (parent.isMinimized()) parent.restore()
    if (!parent.isVisible()) parent.show()
    parent.focus()
    parent.flashFrame(true)
    try {
      const result = await dialog.showMessageBox(parent, options)
      signal.throwIfAborted()
      if (parent.isDestroyed()) throw new AutomationError('CONSENT_UNAVAILABLE', `The authorization window closed. Open ${PRODUCT_NAME} and retry the tool.`)
      return result.response === 1
    } finally {
      if (!parent.isDestroyed()) parent.flashFrame(false)
    }
  }
  async start(): Promise<void> {
    if (this.server) return
    const server = createServer(async (request, response) => {
      const authorization = request.headers.authorization ?? ''
      const expected = `Bearer ${this.token}`
      if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${this.port}` || Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
        response.writeHead(403).end(); request.resume(); return
      }
      if (request.method !== 'POST' || request.url !== '/operation') { response.writeHead(404).end(); request.resume(); return }
      const controller = new AbortController()
      const started = performance.now()
      let admitted: number | undefined
      let executed: number | undefined
      const hostTiming = () => {
        const finished = performance.now()
        return {
          queue_and_consent_ms: Math.round((admitted ?? finished) - started),
          execute_ms: admitted === undefined ? 0 : Math.round((executed ?? finished) - admitted),
          total_ms: Math.round(finished - started)
        }
      }
      // A completed request must retain its response socket so approval timeout
      // can return its real reason instead of becoming a generic fetch failure.
      controller.signal.addEventListener('abort', () => { if (!request.complete) request.destroy() }, { once: true })
      let timer = setTimeout(() => controller.abort(new AutomationError('TIMEOUT', 'Automation input timed out')), INPUT_TIMEOUT_MS)
      const deadline = (ms: number, error: AutomationError): void => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(error), ms)
      }
      this.active.add(controller)
      request.on('aborted', () => controller.abort(new AutomationError('CANCELLED', 'The tool call was cancelled')))
      response.on('close', () => { if (!response.writableEnded) controller.abort(new AutomationError('CANCELLED', 'The client disconnected')) })
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > MAX_AUTOMATION_REQUEST_BYTES) throw new AutomationError('INVALID_INPUT', 'Operation exceeds the 64 KiB UTF-8 input size limit')
          chunks.push(buffer)
        }
        const input = validateAutomationRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const engine = input.capability === 'browser' ? this.browser : this.computer
        const execute = async () => {
          controller.signal.throwIfAborted()
          admitted = performance.now()
          deadline(this.timeouts.operationMs, new AutomationError('TIMEOUT', 'Automation operation timed out. Observe again before retrying input.'))
          try { return await engine.execute(input.owner, input.operation, controller.signal) }
          finally { executed = performance.now() }
        }
        deadline(this.timeouts.authorizationMs, new AutomationError('CONSENT_TIMEOUT', `Automation authorization timed out while waiting for the ${PRODUCT_NAME} dialog or another operation. Bring ${PRODUCT_NAME} to the foreground and retry the tool to authorize; no action was performed.`))
        const result = input.operation.action === 'status' ? await execute()
          : await this.gate.run(input.capability, input.owner, controller.signal, () => this.consent(input.capability, controller.signal), execute)
        controller.signal.throwIfAborted()
        const output = input.operation.action === 'status' ? result : {
          ...result,
          host_timing: hostTiming()
        }
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(output))
      } catch (error) {
        // Native/browser failures carry stage identity but never typed text, URL
        // credentials, cookies or the bridge bearer into diagnostic logs.
        const cause: unknown = controller.signal.aborted ? controller.signal.reason : error
        const code = cause instanceof AutomationError ? cause.code : controller.signal.aborted ? 'CANCELLED' : 'AUTOMATION_FAILED'
        const message = cause instanceof AutomationError ? cause.message : 'The automation operation failed. Observe again or reopen the target and retry.'
        if (!response.destroyed) response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ code, error: message, host_timing: hostTiming() }))
      } finally { clearTimeout(timer); this.active.delete(controller) }
    })
    server.requestTimeout = INPUT_TIMEOUT_MS
    server.headersTimeout = 5_000
    server.maxConnections = 16
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new Error('Automation loopback endpoint could not be created') }
    this.server = server
    this.port = address.port
    this.shortcut = globalShortcut.register(SHORTCUT, () => this.stop())
  }
  async close(): Promise<void> {
    this.stop()
    if (this.shortcut) globalShortcut.unregister(SHORTCUT)
    this.shortcut = false
    for (const action of ['status', 'permissions', 'stop']) ipcMain.removeHandler(`hq:automation:${action}`)
    const server = this.server
    this.server = undefined
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    await this.computer.close()
  }
}
