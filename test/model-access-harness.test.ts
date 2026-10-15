import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('loads the managed provider through Harness and preserves streaming tool calls through Pi AI', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'hq-model-harness-')))
  const moduleUrl = (name: string) => pathToFileURL(path.join(root, 'node_modules', name, 'lib/index.js')).href
  const config = path.join(home, 'cordis.yml'), entry = path.join(home, 'entry.mjs')
  try {
    await writeFile(config, JSON.stringify([
      { id: 'llm', name: moduleUrl('@deepseek-ai/dsh-llm') },
      { id: 'team-model', name: pathToFileURL(path.join(root, 'packages/hqharness-model-access/index.js')).href }
    ]))
    await writeFile(entry, `
      import assert from 'node:assert/strict'
      import { createServer } from 'node:http'
      import { setTimeout as delay } from 'node:timers/promises'
      import { boot } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-app-boot'))}
      const calls = [], routes = new Map(), defaults = []
      const token = 'b'.repeat(64)
      let available = true
      const model = { id: 'leased-model', display_name: 'DeepSeek-V41-Flash', context_window: 65536, max_output_tokens: 4096, input_modalities: ['text'], tool_calls_verified: true }
      const bridge = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer ' + token)
        if (req.url === '/managed-model') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ lease: available ? { status: 'active', model } : null }))
          return
        }
        assert.equal(req.url, '/v1/chat/completions')
        let body = ''; for await (const chunk of req) body += chunk
        calls.push(JSON.parse(body))
        res.setHeader('content-type', 'text/event-stream')
        const base = { id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: model.id }
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'browser_use', arguments: '{"action":"status"}' } }] }, finish_reason: null }] }) + '\\n\\n')
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\\n\\n')
        res.end('data: [DONE]\\n\\n')
      })
      await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve))
      process.env.HQHARNESS_MODEL_BRIDGE_URL = 'http://127.0.0.1:' + bridge.address().port
      process.env.HQHARNESS_MODEL_BRIDGE_TOKEN = token
      const ctx = await boot('team-model-qualification', ${JSON.stringify(config)}, [], ctx => {
        ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
        ctx.provide('agentDefaultModel', { async saveSelection(value) { defaults.push(value) } })
      })
      try {
        for (let i = 0; i < 100 && !ctx.llm.listProviders().some(p => p.id === 'hqharness-team'); i++) await delay(20)
        const models = await ctx.llm.listModels('hqharness-team')
        assert.equal(models.length, 1)
        const chunks = []
        for await (const chunk of ctx.llm.stream({ provider: 'hqharness-team', model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Check the browser' }] }], tools: [{ name: 'browser_use', description: 'Browser operation', parameters: { type: 'object', properties: { action: { type: 'string' } } } }] })) chunks.push(chunk)
        assert.equal(calls.length, 1, JSON.stringify(chunks))
        assert.equal(calls[0].model, model.id)
        assert.equal(calls[0].tools[0].function.name, 'browser_use')
        assert(JSON.stringify(chunks).includes('browser_use'), JSON.stringify(chunks))
        assert(!chunks.some(c => c.type === 'error'), JSON.stringify(chunks))
        const route = routes.get('/api/hqharness-team-model/default')
        assert(route)
        assert.equal((await route.fetch()).status, 200)
        assert.deepEqual(defaults, [{ provider: 'hqharness-team', model: model.id }])
        available = false
        assert.equal((await route.fetch()).status, 409)
        assert.equal(ctx.llm.listProviders().some(p => p.id === 'hqharness-team'), false)
        console.log('TEAM_MODEL_HARNESS_PASS')
      } finally { await ctx.fiber.dispose(); await new Promise(resolve => bridge.close(resolve)) }
      assert.equal(routes.size, 0)
    `)
    const result = spawnSync(process.execPath, [path.join(root, 'build/harness-node-entry.mjs'), entry], { cwd: home, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 15000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain('TEAM_MODEL_HARNESS_PASS')
  } finally { await rm(home, { recursive: true, force: true }) }
})
