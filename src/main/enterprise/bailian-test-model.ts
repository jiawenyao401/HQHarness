import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { lstat, open } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'

const MODEL = 'qwen3.8-flash'
const UPSTREAM = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const LOOPBACK = '127.0.0.1'
const COMPLETIONS = '/v1/chat/completions'
const KEY_PATTERN = /^sk-[\x21-\x7e]{8,509}$/u
const MAX_KEY_BYTES = 4096
const MAX_INPUT_BYTES = 28 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_TOKENS = 16_384
const MAX_IN_FLIGHT = 8
const REQUEST_TIMEOUT_MS = 300_000
const PAYLOAD_FIELDS = [
  'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'temperature',
  'top_p', 'stream', 'stream_options'
] as const

class BailianTestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The caller supplies the one packaged development resource path. */
export async function readBailianTestKey(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_KEY_BYTES) return undefined
    const file = await open(path, 'r')
    try {
      const current = await file.stat()
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) return undefined
      const buffer = Buffer.alloc(MAX_KEY_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_KEY_BYTES) return undefined
      const value: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead))
      const key = record(value) && typeof value.apikey === 'string' ? value.apikey.trim() : ''
      return KEY_PATTERN.test(key) ? key : undefined
    } finally {
      await file.close()
    }
  } catch {
    // The caller can report the test resource as unavailable without logging its contents.
    return undefined
  }
}

function respondError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed) return
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ error: { type: 'bailian_test', message } }))
}

async function completionsInput(request: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (Number(request.headers['content-length']) > MAX_INPUT_BYTES) {
    throw new BailianTestError(413, 'Bailian test request is too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted()
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_INPUT_BYTES) throw new BailianTestError(413, 'Bailian test request is too large')
    chunks.push(buffer)
  }
  let input: unknown
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new BailianTestError(400, 'Invalid Bailian test request') }
  if (!record(input) || !Array.isArray(input.messages)) {
    throw new BailianTestError(400, 'Invalid Bailian test request')
  }
  if (input.model !== MODEL) throw new BailianTestError(403, 'The test deployment uses qwen3.8-flash')
  const { max_tokens: chatLimit = MAX_OUTPUT_TOKENS } = input
  const outputLimit = input.max_completion_tokens === undefined ? chatLimit : input.max_completion_tokens
  if (typeof outputLimit !== 'number' || !Number.isSafeInteger(outputLimit)
    || outputLimit < 1 || outputLimit > MAX_OUTPUT_TOKENS
    || (input.max_tokens !== undefined && input.max_completion_tokens !== undefined)) {
    throw new BailianTestError(400, 'Invalid Bailian test output limit')
  }
  return {
    ...Object.fromEntries(PAYLOAD_FIELDS.map(field => [field, input[field]])),
    model: MODEL,
    max_tokens: outputLimit,
    enable_thinking: false,
    preserve_thinking: false
  }
}

/** The development build's inference bridge owns the test key in Electron main. */
export class DesktopBailianTestModel {
  private server?: Server
  private address?: string
  private starting?: Promise<void>
  private closing?: Promise<void>
  private token = ''
  private launch = new AbortController()
  private inFlight = 0

  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) {
    if (!KEY_PATTERN.test(key)) throw new Error('Invalid Bailian test credential')
  }

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Bailian test bridge has closed'))
    return this.starting ??= this.listen().catch(error => {
      this.starting = undefined
      throw error
    })
  }

  private async listen(): Promise<void> {
    const server = createServer({
      requestTimeout: 30_000, headersTimeout: 5_000, connectionsCheckingInterval: 1000
    }, (request, response) => { void this.handle(request, response) })
    server.maxConnections = 16
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, LOOPBACK, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Bailian test bridge could not bind loopback')
    }
    this.server = server
    this.address = `${LOOPBACK}:${address.port}`
  }

  environment(): NodeJS.ProcessEnv {
    this.launch.abort()
    this.launch = new AbortController()
    this.token = randomBytes(32).toString('hex')
    return {
      HQHARNESS_MODEL_SOURCE: 'bailian',
      ...(this.address && !this.closing && {
        HQHARNESS_BAILIAN_URL: `http://${this.address}/v1`,
        HQHARNESS_BAILIAN_TOKEN: this.token
      })
    }
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown()
  }

  private async shutdown(): Promise<void> {
    this.launch.abort()
    this.token = ''
    await this.starting?.catch(() => { /* The start caller receives the bind failure. */ })
    const server = this.server
    this.address = this.server = undefined
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.token}`)
    if (!this.token || this.closing || request.headers.origin !== undefined || request.headers.host !== this.address
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      respondError(response, 403, 'Bailian test bridge access denied')
      request.resume()
      return
    }
    if (request.method !== 'POST' || request.url !== COMPLETIONS) {
      respondError(response, 404, 'Bailian test route not found')
      request.resume()
      return
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      respondError(response, 429, 'Bailian test bridge is busy')
      request.resume()
      return
    }
    this.inFlight++
    const connection = new AbortController()
    request.once('aborted', () => connection.abort())
    response.once('close', () => { if (!response.writableEnded) connection.abort() })
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = AbortSignal.any([this.launch.signal, connection.signal, deadline])
    try {
      const input = await completionsInput(request, signal)
      signal.throwIfAborted()
      const upstream = await this.fetcher(UPSTREAM, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify(input)
      })
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel().catch(() => { /* A cancelled upstream can already be closed. */ })
        throw new BailianTestError(upstream.ok ? 502 : upstream.status, `Bailian test request failed (HTTP ${upstream.status})`)
      }
      const type = input.stream === true ? 'text/event-stream' : 'application/json'
      if (upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== type) {
        await upstream.body.cancel().catch(() => { /* An interrupted upstream can already be closed. */ })
        throw new BailianTestError(502, 'Bailian returned an unexpected response type')
      }
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      const reader = upstream.body.getReader()
      const cancel = (): void => {
        void reader.cancel().catch(() => { /* Native fetch also cancels the stream on abort. */ })
      }
      signal.addEventListener('abort', cancel, { once: true })
      let streamed = 0
      try {
        signal.throwIfAborted()
        while (true) {
          const { value, done } = await reader.read()
          signal.throwIfAborted()
          if (done) break
          streamed += value.length
          if (streamed > MAX_RESPONSE_BYTES) throw new BailianTestError(502, 'Bailian test response is too large')
          if (!response.write(value)) await once(response, 'drain', { signal })
        }
        response.end()
      } finally {
        signal.removeEventListener('abort', cancel)
        await reader.cancel().catch(() => { /* The stream may already have completed or aborted. */ })
        reader.releaseLock()
      }
    } catch (error) {
      if (response.headersSent || connection.signal.aborted) response.destroy()
      else {
        if (!request.complete) response.setHeader('Connection', 'close')
        const failure = error instanceof BailianTestError ? error
          : deadline.aborted ? new BailianTestError(504, 'Bailian test request timed out')
            : new BailianTestError(502, 'Bailian test request was interrupted')
        respondError(response, failure.status, failure.message)
        request.resume()
      }
    } finally {
      this.inFlight--
    }
  }
}
