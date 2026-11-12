import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog, ipcMain, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { OaCredentials, OaCredentialsError, type OaCredentialEncryption } from './credentials'
import { findOaRuntime, OaJobError, OA_REQUEST_LIMIT, parseOaJob, privateDirectory, runOaWorker, stageMaterials, type OaJob, type OaWorkflow } from './job-runner'

const WORKFLOW_NAMES: Record<OaWorkflow, readonly [string, string]> = {
  'oa-travel-expense': ['差旅报销', 'Travel reimbursement'],
  'oa-home-travel-expense': ['往返居住地报销', 'Home travel reimbursement'],
  'oa-business-travel-application': ['出差申请', 'Business travel application'],
  'oa-reception-expense': ['业务接待报销', 'Business reception reimbursement']
}

interface OaStatus {
  available: boolean
  configured: boolean
  account?: string
  operatorName?: string
}

function failure(error: unknown): string {
  return error instanceof OaCredentialsError || error instanceof OaJobError ? error.code : 'OA_SERVICE_FAILED'
}

function json(response: ServerResponse, status: number, value: object): void {
  if (!response.destroyed) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value))
  }
}

async function readOperation(request: IncomingMessage): Promise<OaJob> {
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > OA_REQUEST_LIMIT) throw new OaJobError('OA_INPUT_TOO_LARGE')
    chunks.push(bytes)
  }
  try {
    return parseOaJob(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch {
    throw new OaJobError('OA_INVALID_INPUT')
  }
}

const credentialEncryption: OaCredentialEncryption = process.platform === 'linux' ? {
  // Linux's async key provider can fall back to a fixed key. The selected
  // backend check here corresponds to the synchronous encryption provider.
  isEncryptionAvailable: async () => safeStorage.isEncryptionAvailable()
    && safeStorage.getSelectedStorageBackend() !== 'basic_text',
  encryptString: async value => safeStorage.encryptString(value),
  decryptString: async value => safeStorage.decryptString(value)
} : {
  isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encryptString: value => safeStorage.encryptStringAsync(value),
  decryptString: async value => {
    try {
      // Electron's async providers can read the existing macOS and Windows records.
      return (await safeStorage.decryptStringAsync(value)).result
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('safeStorage.decryptStringAsync is temporarily unavailable.')) {
        throw new OaCredentialsError('ENCRYPTION_UNAVAILABLE')
      }
      throw error
    }
  }
}

/** Owns OA credentials and native write confirmation for one installation.
 * Harness can invoke fixed operations through a per-launch loopback capability.
 */
export class DesktopOaService {
  private readonly credentials: OaCredentials
  private runtime?: NonNullable<Awaited<ReturnType<typeof findOaRuntime>>>
  private server?: Server
  private port = 0
  private token = randomBytes(32).toString('hex')
  private launch = new AbortController()
  private pending?: Promise<unknown>
  private closing = false

  constructor(
    private readonly directory: string,
    private readonly attachmentRoot: string,
    private readonly window: () => BrowserWindow | undefined,
    private readonly locale: () => 'zh' | 'en'
  ) {
    this.credentials = new OaCredentials(join(directory, 'credentials.bin'), credentialEncryption)
  }

  async start(resources: string, officeResources: string): Promise<void> {
    const runtime = await findOaRuntime(resources, officeResources)
    if (!runtime) return
    const server = createServer((request, response) => { void this.handle(request, response) })
    server.requestTimeout = 15_000
    server.headersTimeout = 5_000
    server.maxConnections = 8
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new OaJobError('OA_SERVICE_FAILED')
    }
    this.server = server
    this.port = address.port
    this.runtime = runtime
  }

  environment(): NodeJS.ProcessEnv {
    this.launch.abort()
    this.launch = new AbortController()
    this.token = randomBytes(32).toString('hex')
    return this.server ? {
      HQHARNESS_OA_URL: `http://127.0.0.1:${this.port}/operation`,
      HQHARNESS_OA_TOKEN: this.token
    } : {}
  }

  async close(): Promise<void> {
    this.closing = true
    this.launch.abort()
    this.server?.closeAllConnections()
    this.server?.close()
    await this.pending?.catch(() => undefined) // The original caller already receives the error.
  }

  private async status(signal: AbortSignal): Promise<OaStatus> {
    if (!this.runtime) return { available: false, configured: false }
    const configuration = await this.credentials.read(signal)
    return configuration ? {
      available: true, configured: true, account: configuration.account, operatorName: configuration.operatorName
    } : { available: true, configured: false }
  }

  registerIpc(assertTrusted: (event: IpcMainInvokeEvent) => void): void {
    for (const action of ['status', 'configure', 'clear'] as const) {
      ipcMain.handle(`hq:oa:${action}`, async (event, input: unknown) => {
        assertTrusted(event)
        const signal = this.launch.signal
        try {
          if (action !== 'status') {
            const runtime = this.runtime
            if (!runtime) throw new OaJobError('OA_RUNTIME_UNAVAILABLE')
            await this.exclusive(async () => {
              if (action === 'clear') return this.credentials.clear(signal)
              await privateDirectory(this.directory)
              const jobDir = await mkdtemp(join(this.directory, 'verify-'))
              try {
                await this.credentials.write(input, async configuration => {
                  const payload = { operation: 'identity', jobDir, configuration }
                  const identitySignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
                  const result = await runOaWorker(runtime, payload, identitySignal)
                  if (!result.ok || typeof result.operatorName !== 'string' || typeof result.operatorId !== 'string') {
                    throw new OaJobError('OA_IDENTITY_UNVERIFIED')
                  }
                  return { operatorName: result.operatorName, operatorId: result.operatorId }
                }, signal)
              } finally {
                await this.removeTemporary(jobDir)
              }
            })
          }
          return { ok: true, status: await this.status(signal) }
        } catch (error) {
          const status = await this.status(signal).catch(() => ({ available: !!this.runtime, configured: false }))
          return { ok: false, error: failure(error), status }
        }
      })
    }
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing || this.pending) throw new OaJobError('OA_BUSY')
    const pending = run()
    this.pending = pending
    try { return await pending } finally { this.pending = undefined }
  }

  private async removeTemporary(path: string): Promise<void> {
    try { await rm(path, { force: true, recursive: true }) }
    catch { console.warn('[desktop-oa] could not remove a private temporary job directory') }
  }

  private async confirm(job: OaJob, operator: string, signal: AbortSignal): Promise<void> {
    const window = this.window()
    if (!window || window.isDestroyed() || !window.isVisible() || !window.isFocused()) {
      throw new OaJobError('OA_WINDOW_REQUIRED')
    }
    const zh = this.locale() === 'zh'
    const title = WORKFLOW_NAMES[job.workflow][zh ? 0 : 1]
    const revising = job.operation === 'revise'
    const facts = revising
      ? [
          job.intake.payment && (zh
            ? `收款人：${job.intake.payment.payee}\n开户银行：${job.intake.payment.bank}\n银行账号：${job.intake.payment.account}`
            : `Payee: ${job.intake.payment.payee}\nBank: ${job.intake.payment.bank}\nBank account: ${job.intake.payment.account}`),
          job.intake.home && (zh ? `居住地：${job.intake.home}` : `Home city: ${job.intake.home}`),
          job.intake.city && (zh ? `第 ${job.intake.city.index} 段目的地：${job.intake.city.name}`
            : `Destination for leg ${job.intake.city.index}: ${job.intake.city.name}`)
        ].filter(Boolean).join('\n')
      : zh ? `附件：${job.materials.length} 份` : `Attachments: ${job.materials.length}`
    const detail = zh
      ? `环境：OA TEST\n操作人：${operator}\n${facts}\n${revising ? '将补写当前会话的原未提交草稿。' : '将使用当前会话的材料办理未提交草稿，保存后回查草稿状态。'}`
      : `Environment: OA TEST\nOperator: ${operator}\n${facts}\n${revising
        ? 'Apply these changes to the existing unsubmitted draft in this conversation.'
        : "Use the current conversation's materials for an unsubmitted draft. The desktop will check its status after saving."}`
    signal.throwIfAborted()
    const answer = await dialog.showMessageBox(window, {
      type: 'question', title: 'OA TEST',
      message: zh ? `${revising ? '补写' : '办理'}${title}草稿` : `${revising ? 'Update' : 'Prepare'} ${title.toLowerCase()} draft`,
      detail, buttons: zh ? ['取消', revising ? '确认补写' : '允许保存草稿'] : ['Cancel', revising ? 'Confirm changes' : 'Allow draft save'],
      defaultId: 0, cancelId: 0, noLink: true, signal
    })
    signal.throwIfAborted()
    if (answer.response !== 1) throw new OaJobError('OA_WRITE_DECLINED')
  }

  private async operation(job: OaJob, signal: AbortSignal): Promise<Record<string, unknown>> {
    const runtime = this.runtime
    if (!runtime) throw new OaJobError('OA_RUNTIME_UNAVAILABLE')
    signal.throwIfAborted()
    const configuration = await this.credentials.read(signal)
    signal.throwIfAborted()
    if (job.operation !== 'check' && !configuration) throw new OaJobError('OA_NOT_CONFIGURED')
    if ((job.operation === 'draft' || job.operation === 'revise') && configuration) {
      await this.confirm(job, configuration.operatorName, signal)
    }
    await privateDirectory(this.directory)
    const temporary = job.operation === 'check'
    const key = createHash('sha256').update(JSON.stringify([job.sessionId, job.workflow])).digest('hex')
    const jobDir = temporary ? await mkdtemp(join(this.directory, 'check-')) : join(this.directory, 'jobs', key)
    try {
      await privateDirectory(jobDir)
      const materials = await stageMaterials(this.attachmentRoot, join(jobDir, 'materials'), job.materials, signal)
      const { account: bindingAccount, ...testBindings } = runtime.bindings
      const payload = {
        operation: job.operation, workflow: job.workflow, jobDir, materials, intake: job.intake,
        ...(configuration && {
          configuration: temporary ? { operatorId: configuration.operatorId } : {
            ...configuration, ...(bindingAccount === configuration.account && testBindings)
          }
        })
      }
      return await runOaWorker(runtime, payload, signal)
    } finally {
      if (temporary) await this.removeTemporary(jobDir)
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.token}`)
    if (this.closing || request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${this.port}`
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      json(response, 403, { ok: false, code: 'OA_ACCESS_DENIED' })
      request.resume()
      return
    }
    if (request.method !== 'POST' || request.url !== '/operation') {
      json(response, 404, { ok: false, code: 'OA_INVALID_OPERATION' })
      request.resume()
      return
    }
    const connection = new AbortController()
    const signal = AbortSignal.any([this.launch.signal, connection.signal, AbortSignal.timeout(240_000)])
    response.once('close', () => { if (!response.writableEnded) connection.abort() })
    try {
      const job = await readOperation(request)
      json(response, 200, await this.exclusive(() => this.operation(job, signal)))
    } catch (error) {
      json(response, 200, { ok: false, code: failure(error) })
    }
  }
}
