import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DesktopBailianTestModel, readBailianTestKey } from '../src/main/enterprise/bailian-test-model'

const fixtureKey = 'sk-local-fixture-only'
const model = 'qwen3.8-flash'
const sse = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'

it('reads only a bounded, regular credential file at an explicitly supplied path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-bailian-test-'))
  const file = join(dir, 'bailian-test-key.json')
  try {
    await expect(readBailianTestKey(file)).resolves.toBeUndefined()
    await expect(readBailianTestKey(dir)).resolves.toBeUndefined()
    await expect(readBailianTestKey('bailian-test-key.json')).resolves.toBeUndefined()
    await writeFile(file, JSON.stringify({ apikey: `  ${fixtureKey}\n` }))
    await expect(readBailianTestKey(file)).resolves.toBe(fixtureKey)
    if (process.platform !== 'win32') {
      const link = join(dir, 'link.json')
      await symlink(file, link)
      await expect(readBailianTestKey(link)).resolves.toBeUndefined()
    }
    await writeFile(file, '{broken')
    await expect(readBailianTestKey(file)).resolves.toBeUndefined()
    await writeFile(file, JSON.stringify({ apikey: 'sk-key-with\r\nheader' }))
    await expect(readBailianTestKey(file)).resolves.toBeUndefined()
    await writeFile(file, JSON.stringify({ apikey: fixtureKey, padding: ' '.repeat(4096) }))
    await expect(readBailianTestKey(file)).resolves.toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('uses a rotating loopback capability and forwards only the pinned Bailian request', async () => {
  const upstream = vi.fn<typeof fetch>().mockImplementation(async () => new Response(sse, {
    headers: { 'Content-Type': 'text/event-stream; charset=UTF-8', 'Set-Cookie': 'do-not-copy=test' }
  }))
  const service = new DesktopBailianTestModel(fixtureKey, upstream)
  try {
    expect(service.environment()).toEqual({ HQHARNESS_MODEL_SOURCE: 'bailian' })
    await Promise.all([service.start(), service.start()])
    const env = service.environment()
    expect(env.HQHARNESS_MODEL_SOURCE).toBe('bailian')
    expect(env.HQHARNESS_BAILIAN_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u)
    expect(env.HQHARNESS_BAILIAN_TOKEN).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.stringify(env)).not.toContain(fixtureKey)
    const url = `${env.HQHARNESS_BAILIAN_URL}/chat/completions`
    const headers = {
      Authorization: `Bearer ${env.HQHARNESS_BAILIAN_TOKEN}`, 'Content-Type': 'application/json'
    }
    const call = (body: object = {}, extra: Record<string, string> = {}, path = url): Promise<Response> => fetch(path, {
      method: 'POST', headers: { ...headers, ...extra },
      body: JSON.stringify({
        model, messages: [{ role: 'user', content: 'fixture message' }], stream: true,
        enable_thinking: true, preserve_thinking: true, user: 'ignored', ...body
      })
    })
    expect((await call({}, { Origin: 'https://invalid.example' })).status).toBe(403)
    expect((await call({}, { Authorization: 'Bearer bad' })).status).toBe(403)
    // Fetch normalizes Host to the URL. Use HTTP directly for the bad-host case.
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(url, { method: 'POST', headers: { ...headers, Host: 'invalid.example' } }, incoming => {
        incoming.resume()
        resolve(incoming.statusCode)
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
    expect(wrongHost).toBe(403)
    expect((await call({}, {}, `${url}?unexpected=1`)).status).toBe(404)
    expect((await call({ model: 'alternate' })).status).toBe(403)
    expect((await call({ max_tokens: 16_385 })).status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()

    const response = await call({ max_tokens: 42, tools: [{ type: 'function' }] })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toBe(sse)
    const [destination, options] = upstream.mock.calls[0] ?? []
    expect(destination).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${fixtureKey}` })
    expect(options?.redirect).toBe('error')
    expect(JSON.parse(String(options?.body))).toEqual({
      model, messages: [{ role: 'user', content: 'fixture message' }], stream: true,
      max_tokens: 42, tools: [{ type: 'function' }], enable_thinking: false, preserve_thinking: false
    })

    const rotated = service.environment()
    expect(rotated.HQHARNESS_BAILIAN_TOKEN).not.toBe(env.HQHARNESS_BAILIAN_TOKEN)
    expect((await call()).status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(1)
  } finally {
    await Promise.all([service.close(), service.close()])
  }
  expect(service.environment()).toEqual({ HQHARNESS_MODEL_SOURCE: 'bailian' })
})

it('sanitizes upstream errors and cancels a streaming request when its Harness capability rotates', async () => {
  const stopStream = vi.fn()
  const upstream = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(`Echoed temporary credential ${fixtureKey}`, { status: 401 }))
    .mockRejectedValueOnce(new Error(`Transport error referencing ${fixtureKey}`))
    .mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('data: first\n\n')) },
      cancel: stopStream
    }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const service = new DesktopBailianTestModel(fixtureKey, upstream)
  try {
    await service.start()
    const env = service.environment()
    const call = (): Promise<Response> => fetch(`${env.HQHARNESS_BAILIAN_URL}/chat/completions`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${env.HQHARNESS_BAILIAN_TOKEN}`, 'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages: [], stream: true })
    })
    const denied = await call()
    expect(denied.status).toBe(401)
    expect(await denied.text()).not.toContain(fixtureKey)
    const failed = await call()
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain(fixtureKey)
    const active = await call()
    const reader = active.body?.getReader()
    expect(Buffer.from((await reader?.read())?.value ?? []).toString()).toBe('data: first\n\n')
    service.environment()
    await expect(reader?.read()).rejects.toThrow()
    const signal = upstream.mock.calls[2]?.[1]?.signal
    expect(signal?.aborted).toBe(true)
    expect(stopStream).toHaveBeenCalledOnce()
  } finally {
    await service.close()
  }
})
