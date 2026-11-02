import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { markTrustedWpsDefinition } from 'hqharness-automation/wps-routing'
import { WPS_TOOL_NAME, WPS_RAW_TOOL_NAME, WPS_INPUT_SCHEMA, WPS_WRITE_ACTIONS, validateWpsOperation, validateWpsCallMeta } from './protocol.js'

export const name = 'huaqing-wps'
export const inject = ['tools', 'sandboxPolicy', 'systemPrompt']
const TIMEOUT_MS = 175_000
const STARTUP_TIMEOUT_MS = 15_000
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Installation-only endpoint. No model input can configure transport or auth. */
function createConnection() {
  const endpoint = process.env.HQHARNESS_WPS_URL
  const token = process.env.HQHARNESS_WPS_TOKEN
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/mcp$/u.test(endpoint ?? '') || !/^[a-f0-9]{64}$/u.test(token ?? '')) {
    throw new HarnessError('Local WPS is unavailable. Launch this session in Huaqing Desktop.', 'WPS_NOT_CONNECTED')
  }
  const url = new URL(endpoint)
  if (Number(url.port) > 65535) throw new HarnessError('The local WPS endpoint is invalid.', 'WPS_NOT_CONNECTED')
  const client = new Client({ name: 'huaqing-desktop-wps', version: '0.1.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'x-hq-wps-client': randomUUID() } },
    reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
    // A local capability must never follow a redirect with its bearer token.
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' })
  })
  return { client, transport }
}

function providerError(result, mutation) {
  if (result?.isError !== true) return
  let detail
  const text = Array.isArray(result.content) ? result.content.find(block => block?.type === 'text')?.text : undefined
  if (typeof text === 'string' && text.length <= 65_536) {
    try { detail = JSON.parse(text) } catch { /* An invalid provider error cannot prove that a write did not run. */ }
  }
  if (record(detail) && typeof detail.code === 'string' && /^WPS_[A-Z_]{1,64}$/u.test(detail.code) && typeof detail.message === 'string') {
    const outcome = ['not_executed', 'unknown', 'modified_unsaved', 'completed'].includes(detail.outcome) ? ` [outcome=${detail.outcome}]` : ''
    throw new HarnessError(detail.message.slice(0, 4096) + outcome, detail.code)
  }
  throw new HarnessError('The local WPS service returned an invalid failure. Verify the document before continuing.', mutation ? 'WPS_UNKNOWN_OUTCOME' : 'WPS_FAILED')
}

/** Factory injection is for transport qualification; production always uses the
 * installation endpoint and the standard MCP SDK, without startup networking. */
export function createWpsPlugin(connectionFactory = createConnection) {
  return { name, inject, apply(ctx) {
    const lifetime = new AbortController()
    let disposed = false
    let connection
    let connecting
    const active = new Set()
    const closing = new WeakMap()
    const close = value => {
      if (!value) return
      let pending = closing.get(value.client)
      if (!pending) {
        pending = Promise.resolve().then(() => value.client.close()).catch(() => {
          ctx.logger?.warn('Local WPS connection cleanup failed; the host retains document recovery state.')
        })
        closing.set(value.client, pending)
      }
      return pending
    }
    async function ready(signal) {
      if (disposed) throw new HarnessError('WPS plugin was stopped.', 'WPS_STOPPED')
      if (connection?.ready) return connection
      if (!connecting) {
        connecting = (async () => {
          const value = connectionFactory()
          connection = value
          value.client.onclose = () => { if (connection === value) connection = undefined }
          try {
            await value.client.connect(value.transport, { signal, timeout: STARTUP_TIMEOUT_MS })
            const listed = await value.client.listTools(undefined, { signal, timeout: STARTUP_TIMEOUT_MS, cacheMode: 'refresh' })
            const tool = listed.tools?.[0]
            if (listed.tools?.length !== 1 || tool?.name !== WPS_RAW_TOOL_NAME || !isDeepStrictEqual(tool.inputSchema, WPS_INPUT_SCHEMA)) {
              throw new HarnessError('The installed WPS service has an incompatible tool contract.', 'WPS_PROTOCOL_MISMATCH')
            }
            signal.throwIfAborted()
            if (disposed || connection !== value) throw new HarnessError('WPS connection closed during initialization.', 'WPS_NOT_CONNECTED')
            value.tool = tool
            value.ready = true
            return value
          } catch (error) {
            if (connection === value) connection = undefined
            await close(value)
            throw error
          }
        })().finally(() => { connecting = undefined })
      }
      // A second call cannot use the partially connected client above.
      return connecting
    }
    const definition = createMcpToolDefinition(ctx, {
      name: WPS_TOOL_NAME, rawName: WPS_RAW_TOOL_NAME,
      description: 'Operate local WPS documents through bounded structured actions. Start with status/documents, use returned opaque keys and current snapshots. Writes require a snapshot; save uses the bound document path. Formula writes support only the documented built-in local calculation grammar, never external references, URLs, DDE, UDFs or dynamic evaluation. Use values with null to clear cells. No code, macros, shell, cloud documents or arbitrary file paths.',
      inputSchema: WPS_INPUT_SCHEMA,
      async call(args, exec) {
        let operation
        try { operation = validateWpsOperation(args) } catch (cause) { throw new HarnessError(cause.message, 'WPS_INVALID_INPUT', { cause }) }
        const session = exec.agent?.session
        let meta
        try {
          if (!session?.header?.id || !ctx.sandboxPolicy?.resolve) throw new Error('Missing owning session or sandbox policy')
          const resolved = ctx.sandboxPolicy.resolve({ session })
          meta = validateWpsCallMeta({ owner: session.header.id, policy: { mode: resolved.mode, workspaceRoot: resolved.workspaceRoot } })
        } catch (cause) { throw new HarnessError('WPS requires an owning session and a current sandbox policy.', 'WPS_POLICY_REQUIRED', { cause }) }
        const controller = new AbortController()
        const signal = AbortSignal.any([exec.signal ?? new AbortController().signal, lifetime.signal, controller.signal])
        const mutation = WPS_WRITE_ACTIONS.includes(operation.action)
        active.add(controller)
        let dispatched = false
        let activeConnection
        try {
          signal.throwIfAborted()
          const value = await ready(signal)
          activeConnection = value
          signal.throwIfAborted()
          if (disposed || !value.ready || connection !== value) throw new HarnessError('WPS is disconnected.', 'WPS_NOT_CONNECTED')
          dispatched = true
          // Metadata is transport-owned and cannot be supplied in arguments.
          const result = await value.client.callTool({ name: WPS_RAW_TOOL_NAME, arguments: operation, _meta: { huaqing: meta } }, {
            signal, timeout: TIMEOUT_MS, toolDefinition: value.tool
          })
          providerError(result, mutation)
          return result
        } catch (cause) {
          if (cause instanceof HarnessError) throw cause
          // A cancelled SDK request can settle before its HTTP exchange closes.
          // Close the transport as well so Main observes disconnection and can
          // freeze an unconfirmed write; never reconnect/replay this invocation.
          if (activeConnection) {
            if (connection === activeConnection) connection = undefined
            await close(activeConnection)
          }
          if (mutation && dispatched) throw new HarnessError('WPS write completion is unknown. Use recover with user confirmation before any retry.', 'WPS_UNKNOWN_OUTCOME', { cause })
          if (signal.aborted) throw new HarnessError('WPS call was cancelled before a confirmed modification.', 'WPS_STOPPED', { cause })
          throw new HarnessError('The local WPS service is unavailable. Check its connection and retry only after verifying the document.', 'WPS_NOT_CONNECTED', { cause })
        } finally { active.delete(controller) }
      }
    })
    definition.timeoutMs = 210_000
    ctx.tools.register(definition)
    ctx.effect(() => markTrustedWpsDefinition(definition), 'huaqing-wps.trusted-definition')
    ctx.systemPrompt.section({ name: 'huaqing:wps', order: 115, text:
      'For supported local WPS Writer, spreadsheets and presentation document operations, prefer the built-in mcp__huaqing_wps__wps_use structured tool before Computer Use. This controls WPS on this computer and local documents only, never cloud documents. Start with status/documents, inspect the exact document and use its returned key/snapshot; save never accepts another path. Formula writes must stay in the documented built-in calculation grammar. An unsupported formula must be corrected, never entered through GUI, code or another tool; use values with null to clear cells. Follow explicit GUI-only instructions. A refusal, stop, partial modification or unknown write result forbids automatic retries or switching tools to replay it. A confirmed unsupported non-formula operation that made no change may use the normal GUI route. In PTC mode use only return await tools.mcp__huaqing_wps__wps_use({"action":"status"}); with one strict JSON object; substitute a supported action and its fields, never add program expressions. This preference grants no file permissions.' })
    ctx.effect(() => async () => {
      disposed = true
      lifetime.abort()
      for (const controller of active) controller.abort()
      await close(connection)
      await connecting?.catch(() => undefined) // Initialization already reports its failure to its owning call.
      connection = undefined
    }, 'huaqing-wps.connection')
  } }
}

export function apply(ctx) { return createWpsPlugin().apply(ctx) }
