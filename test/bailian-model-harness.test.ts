import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { resolveTestNodeExecutable } from './node-executable'
import { projectRoot } from './patch-path'

it('defaults a new Desktop conversation to Bailian and preserves an OA tool call over the local model bridge', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'hq-bailian-runtime-')))
  const token = 'b'.repeat(64)
  const provider = 'hqharness-bailian'
  const model = 'qwen3.8-flash'
  const calls: { model?: string; messages?: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] }[] = []
  const errors: string[] = []
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${token}`) {
        errors.push('Unexpected request to the fixture model bridge')
        response.writeHead(403).end()
        return
      }
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const call: (typeof calls)[number] = JSON.parse(body)
      const usesOa = call.tools?.some(tool => tool.function?.name === 'huaqing_oa') === true
      if (usesOa || call.messages?.some(message => message.role === 'tool')) calls.push(call)
      const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model }
      const toolCalls = [{
        index: 0, id: 'call_hq_fixture', type: 'function', function: {
          name: 'huaqing_oa', arguments: '{"operation":"system.info","input":{}}'
        }
      }]
      const first = usesOa && !call.messages?.some(message => message.role === 'tool')
      const delta = first
        ? { role: 'assistant', tool_calls: toolCalls }
        : { role: 'assistant', content: 'OA CLI ready' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({
        ...base, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })}\n\ndata: [DONE]\n\n`)
    } catch (error) {
      errors.push(String(error))
      response.destroy()
    }
  })
  let runtime: HarnessRuntime | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing model fixture listener')
    runtime = new HarnessRuntime({
      dshEntryPath: join(projectRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      nodeEntryPath: join(projectRoot, 'build/harness-node-entry.mjs'),
      nodeExecutablePath: resolveTestNodeExecutable(),
      dshPatchPath: join(projectRoot, 'build/dsh-desktop.patch.yml'),
      dshSafePatchPath: join(projectRoot, 'build/dsh-desktop-safe.patch.yml'),
      dshHome: join(home, 'harness'),
      logPath: join(home, 'harness.log'),
      extraEnvironment: () => ({
        HQHARNESS_MODEL_SOURCE: 'bailian',
        HQHARNESS_BAILIAN_URL: `http://127.0.0.1:${address.port}/v1`,
        HQHARNESS_BAILIAN_TOKEN: token,
        DSH_DESKTOP_DOCUMENTS_DIRECTORY: join(home, 'documents')
      }),
      launchProcess: (file, args, options) => spawn(file, args, options),
      startupTimeoutMs: 30_000,
      preferredPort: 0,
      onChanged() {}
    })
    await runtime.start(home)
    const snapshot = runtime.snapshot()
    expect(snapshot.phase, snapshot.logs.join('\n')).toBe('ready')
    if (!snapshot.url || !snapshot.authToken) throw new Error('Missing local Harness endpoint')
    const login = await fetch(new URL(`/?token=${encodeURIComponent(snapshot.authToken)}`, snapshot.url), { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    const rpc = async (method: string, request?: object) => {
      const response = await fetch(new URL(`/api/${method}`, snapshot.url), {
        method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: request ? { request } : {} } })
      })
      const result = (await response.json()).result
      expect(result?.ok, JSON.stringify(result)).toBe(true)
      return result.value
    }
    const catalog = await rpc('session/modelCatalog')
    expect(catalog).toMatchObject({
      default: { provider, model },
      groups: [{ id: provider, models: [{ id: model, name: 'qwen3.8-27b-nvfp4' }] }]
    })
    const { sessionId } = await rpc('session/create', { cwd: home })
    await rpc('session/prompt', {
      sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Check the installed OA CLI' }]
    })
    await expect.poll(() => calls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    expect(errors).toEqual([])
    expect(calls.map(call => call.model)).toEqual([model, model])
    expect(calls[0]?.tools?.some(tool => tool.function?.name === 'huaqing_oa')).toBe(true)
    const toolResult = calls[1]?.messages?.find(message => message.role === 'tool')?.content
    expect(String(toolResult)).toContain('system.info')
    expect(String(toolResult)).toContain('"ok":true')
  } finally {
    await runtime?.stop()
    if (server.listening) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 55_000)
