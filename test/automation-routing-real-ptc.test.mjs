import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it.each(['refused-input', 'partial-plan'])('does not let real Node PTC replace failed GUI input with direct filesystem writes (%s)', async failureMode => {
  const root = path.resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'hq-routing-real-ptc-')))
  const moduleUrl = name => pathToFileURL(path.join(root, 'node_modules', name, 'lib/index.js')).href
  const config = path.join(home, 'cordis.yml')
  const entry = path.join(home, 'entry.mjs')
  try {
    await writeFile(config, JSON.stringify([
      { id: 'prompt', name: moduleUrl('@deepseek-ai/dsh-system-prompt') },
      { id: 'tools', name: moduleUrl('@deepseek-ai/dsh-tools'), config: { mode: 'both' } },
      ...['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-fs-local', 'dsh-subprocess-local', 'dsh-sandbox-local'].map(name => ({ id: name, name: moduleUrl('@deepseek-ai/' + name) })),
      { id: 'policy', name: moduleUrl('@deepseek-ai/dsh-sandbox-policy'), config: { mode: 'workspace-write', workspaceRoot: home } },
      { id: 'runtime', name: moduleUrl('@deepseek-ai/dsh-ptc-runtime-node') },
      { id: 'automation', name: pathToFileURL(path.join(root, 'packages/hqharness-automation/index.js')).href }
    ]))
    await writeFile(entry, `
      import assert from 'node:assert/strict'
      import { existsSync, readFileSync } from 'node:fs'
      import { createServer } from 'node:http'
      import { boot } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-app-boot'))}
      import { createUserMessage } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-llm'))}
      import { agentEvents } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-agent'))}
      const calls = []
      const failureMode = ${JSON.stringify(failureMode)}
      const bridge = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer ' + process.env.HQHARNESS_AUTOMATION_TOKEN)
        let body = ''; for await (const chunk of req) body += chunk
        const input = JSON.parse(body); calls.push(input)
        res.setHeader('content-type', 'application/json')
        if (input.operation.action === 'run') {
          res.end(JSON.stringify({ observation_required: true, sequence: { status: 'failed', completed: 1, total: 2, failed_step: 2, error: { code: 'INPUT_REFUSED', message: 'Fixture plan stopped after its first step' } } }))
        } else if (input.operation.action === 'click') {
          res.writeHead(400)
          res.end(JSON.stringify({ code: 'INPUT_REFUSED', error: 'Fixture foreground mismatch; no input was dispatched' }))
        } else res.end(JSON.stringify({ snapshot: 'fixture-frame', pid: 1, window: '2', elements: [{ ref: 'fixture-ref', role: 'Button', name: 'Fixture' }] }))
      })
      let ctx
      try {
        await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve))
        process.env.HQHARNESS_AUTOMATION_URL = 'http://127.0.0.1:' + bridge.address().port + '/operation'
        ctx = await boot('automation-real-ptc-qualification', ${JSON.stringify(config)}, [], ctx => {
          ctx.provide('attachments', { async saveImage() { throw new Error('Fixture must not capture a real desktop') } })
        })
        assert.equal(ctx.ptcRuntime.isolation, 'process')
        assert.equal(ctx.ptcRuntime.language, 'typescript')
        const { agent } = await ctx.agents.create({ sessionId: 'session-real-ptc', meta: { cwd: ${JSON.stringify(home)} }, agentOptions: { provider: 'test', model: 'test' } })
        agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: createUserMessage({ content: [{ type: 'text', text: 'Inspect and edit my local file through the application.' }], source: { kind: 'user' } }), turn: 1 })
        let serial = 0
        const call = (name, args) => ctx.tools.execute({ callId: 'real-ptc-' + ++serial, name, arguments: args, agent, signal: new AbortController().signal })
        const control = await call('run_code', { code: 'return await tools.computer_use({"action":"observe","pid":1,"window":"2"});', description: 'Observe using the real isolated Node PTC GUI binding' })
        assert.equal(control.isError, false, JSON.stringify(control))
        assert.equal(control.value.result.snapshot, 'fixture-frame')
        assert.equal(control.value.sandbox.mode, 'workspace-write')
        assert.equal(control.value.sandbox.denied, false)
        const refused = await call('computer_use', failureMode === 'refused-input'
          ? { action: 'click', pid: 1, window: '2', snapshot: 'fixture-frame', target: { name: 'Fixture', role: 'Button' } }
          : { action: 'run', pid: 1, window: '2', snapshot: 'fixture-frame', steps: [{ action: 'click', target: { name: 'Fixture', role: 'Button' } }, { action: 'click', target: { name: 'Fixture', role: 'Button' } }] })
        if (failureMode === 'refused-input') {
          assert.equal(refused.isError, true)
          assert.equal(refused.error.info.code, 'INPUT_REFUSED')
        } else {
          assert.equal(refused.isError, false)
          assert.equal(refused.value.observation_required, true)
          assert.equal(refused.value.sequence.completed, 1)
        }
        const marker = ${JSON.stringify(path.join(home, 'script-took-over.txt'))}
        const code = 'const fs = await import("node:fs/promises"); await fs.writeFile(' + JSON.stringify(marker) + ', "script took over"); return "wrote marker"'
        const attempted = await call('run_code', { code, description: 'Replace the refused GUI task using a script' })
        console.log('REAL_PTC_ROUTING_PROBE ' + JSON.stringify({ nativeFailure: failureMode, scriptIsError: attempted.isError, markerWritten: existsSync(marker), sandbox: attempted.value?.sandbox }))
        assert.equal(existsSync(marker), false, 'A refused/partial computer_use input must not silently turn into a successful direct Node filesystem write')
        assert.equal(attempted.isError, true)
        assert(attempted.content.some(block => /HQ_ROUTING_/.test(block.text ?? '')), JSON.stringify(attempted))
        // New observations may verify a refused/uncertain input without granting
        // raw-code authority or replaying a click.
        const reobserved = await call('run_code', { code: 'return await tools.computer_use({"action":"observe","pid":1,"window":"2"});', description: 'Verify the application after refused input' })
        assert.equal(reobserved.isError, false, JSON.stringify(reobserved))
        agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: createUserMessage({ content: [{ type: 'text', text: '工具模式：直接工具' }], source: { kind: 'user' } }), turn: 1 })
        const steering = await call('run_code', { code, description: 'Same-turn instructions cannot bypass unconfirmed input' })
        assert.equal(steering.isError, true)
        assert.equal(existsSync(marker), false)
        agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: createUserMessage({ content: [{ type: 'text', text: '工具模式：直接工具' }], source: { kind: 'user' } }), turn: 2 })
        const explicit = await call('run_code', { code, description: 'Write only the owned fixture after explicit new-turn direct authorization' })
        assert.equal(explicit.isError, false, JSON.stringify(explicit))
        assert.equal(readFileSync(marker, 'utf8'), 'script took over')
        agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: createUserMessage({ content: [{ type: 'text', text: 'Inspect a new local file.' }], source: { kind: 'user' } }), turn: 3 })
        const resetMarker = ${JSON.stringify(path.join(home, 'script-after-reset.txt'))}
        const resetCode = 'const fs = await import("node:fs/promises"); await fs.writeFile(' + JSON.stringify(resetMarker) + ', "forbidden"); return "wrote marker"'
        const reset = await call('run_code', { code: resetCode, description: 'A new default turn cannot inherit direct Node writes' })
        assert.equal(reset.isError, true)
        assert.equal(existsSync(resetMarker), false)
        for (const program of [
          'return await tools["computer_use"]({"action":"observe"})',
          'return await tools.computer_use.constructor("return process")()',
          'return await tools.computer_use({"action":"observe"}); await import("node:fs")',
          'return await tools.computer_use({action:"observe"})'
        ]) {
          const rejected = await call('run_code', { code: program, description: 'Only the exact GUI JSON wrapper is available by default' })
          assert.equal(rejected.isError, true, JSON.stringify(rejected))
          assert(rejected.content.some(block => /HQ_ROUTING_/.test(block.text ?? '')), JSON.stringify(rejected))
        }
        assert.equal(calls.length, 3, 'Qualification must never dispatch real desktop input')
        console.log('AUTOMATION_REAL_PTC_ROUTING_PASS')
      } finally {
        await ctx?.fiber.dispose()
        bridge.closeAllConnections()
        await new Promise(resolve => bridge.close(resolve))
      }
    `)
    const result = spawnSync(process.execPath, [path.join(root, 'build/harness-node-entry.mjs'), entry], {
      cwd: home, env: { ...process.env, DSH_HOME: home, HQHARNESS_AUTOMATION_TOKEN: 'b'.repeat(64) },
      encoding: 'utf8', timeout: 30_000
    })
    expect(result.error, result.stderr + result.stdout).toBeUndefined()
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain('AUTOMATION_REAL_PTC_ROUTING_PASS')
  } finally { await rm(home, { recursive: true, force: true }) }
})
