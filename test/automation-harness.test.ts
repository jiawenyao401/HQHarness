import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('executes both built-in tools with real Agents through the actual Harness loader and authenticated bridge', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'hq-automation-harness-')))
  const moduleUrl = (name: string) => pathToFileURL(path.join(root, 'node_modules', name, 'lib/index.js')).href
  const config = path.join(home, 'cordis.yml')
  const entry = path.join(home, 'entry.mjs')
  try {
    await writeFile(config, JSON.stringify([
      { id: 'prompt', name: moduleUrl('@deepseek-ai/dsh-system-prompt') },
      { id: 'tools', name: moduleUrl('@deepseek-ai/dsh-tools') },
      ...['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop'].map(name => ({ id: name, name: moduleUrl('@deepseek-ai/' + name) })),
      { id: 'automation', name: pathToFileURL(path.join(root, 'packages/hqharness-automation/index.js')).href }
    ]))
    await writeFile(entry, `
      import assert from 'node:assert/strict'
      import { createServer } from 'node:http'
      import { boot } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-app-boot'))}
      const calls = []
      const bridge = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer ' + process.env.HQHARNESS_AUTOMATION_TOKEN)
        let body = ''; for await (const chunk of req) body += chunk
        const input = JSON.parse(body)
        calls.push(input)
        res.setHeader('content-type', 'application/json')
        if (input.operation.action === 'observe' && input.owner === 'session-another-owner') {
          res.writeHead(403)
          res.end(JSON.stringify({ error: 'The user declined automation access', code: 'DENIED' }))
        } else if (input.operation.action === 'observe') {
          res.end(JSON.stringify({ snapshot: 'frame-1', coordinates: { width: 1000, height: 600 }, image: { png: 'AA==' } }))
        } else res.end(JSON.stringify({ available: true }))
      })
      await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve))
      process.env.HQHARNESS_AUTOMATION_URL = 'http://127.0.0.1:' + bridge.address().port + '/operation'
      const ctx = await boot('automation-qualification', ${JSON.stringify(config)}, [], ctx => {
        ctx.provide('attachments', { async saveImage() { return { attachmentId: 'test-frame', mediaType: 'image/png', width: 500, height: 300, bytes: 1 } } })
      })
      try {
        const names = ['browser_use', 'computer_use']
        for (const name of names) {
          const definition = ctx.tools.get(name)
          assert(definition && typeof definition.execute === 'function', name + ' did not activate')
          assert.equal(definition.isConcurrencySafe({ action: 'observe' }), false)
        }
        const schemas = ctx.tools.schemas().filter(schema => names.includes(schema.name))
        assert.equal(schemas.length, 2)
        assert(schemas.every(schema => schema.parameters.properties.action))
        const agent = await ctx.agentLoop.create('session-native-owner')
        const second = await ctx.agentLoop.create('session-another-owner')
        assert.equal(agent.session.header.id, 'session-native-owner')
        assert.equal(agent.sessionId, undefined)
        for (const name of names) {
          const result = await ctx.tools.execute({ callId: name, name, arguments: { action: 'status' }, agent, signal: new AbortController().signal })
          assert.equal(result.isError, false, JSON.stringify(result.content))
          assert.deepEqual(result.value, { available: true })
          const observed = await ctx.tools.execute({ callId: name + '-image', name, arguments: { action: 'observe' }, agent, signal: new AbortController().signal })
          assert.equal(observed.isError, false, JSON.stringify(observed.content))
          assert.equal(observed.value.coordinate_width, 500)
          assert.equal(observed.value.image.attachmentId, 'test-frame')
          assert(!Object.hasOwn(observed.value, 'coordinates'))
          const denied = await ctx.tools.execute({ callId: name + '-denied', name, arguments: { action: 'observe' }, agent: second, signal: new AbortController().signal })
          assert.equal(denied.isError, true)
          assert(denied.content.some(block => block.text?.includes('declined automation access')))
        }
        assert.deepEqual(calls.map(call => call.owner), ['session-native-owner', 'session-native-owner', 'session-another-owner', 'session-native-owner', 'session-native-owner', 'session-another-owner'])
        console.log('AUTOMATION_HARNESS_PASS ' + JSON.stringify(schemas.map(schema => schema.name)))
      } finally { await ctx.fiber.dispose(); await new Promise(resolve => bridge.close(resolve)) }
    `)
    const result = spawnSync(process.execPath, [path.join(root, 'build/harness-node-entry.mjs'), entry], {
      env: { ...process.env, DSH_HOME: home, HQHARNESS_AUTOMATION_TOKEN: 'a'.repeat(64) }, encoding: 'utf8', timeout: 15_000, cwd: home
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('AUTOMATION_HARNESS_PASS ["browser_use","computer_use"]')
  } finally { await rm(home, { recursive: true, force: true }) }
})
