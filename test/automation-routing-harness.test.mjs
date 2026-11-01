import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('enforces GUI-first routing for real Agent turns and nested PTC tool dispatches', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'hq-routing-harness-')))
  const moduleUrl = name => pathToFileURL(path.join(root, 'node_modules', name, 'lib/index.js')).href
  const config = path.join(home, 'cordis.yml')
  const entry = path.join(home, 'entry.mjs')
  try {
    await writeFile(config, JSON.stringify([
      { id: 'prompt', name: moduleUrl('@deepseek-ai/dsh-system-prompt') },
      { id: 'tools', name: moduleUrl('@deepseek-ai/dsh-tools'), config: { mode: 'both' } },
      ...['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop'].map(name => ({ id: name, name: moduleUrl('@deepseek-ai/' + name) })),
      { id: 'automation', name: pathToFileURL(path.join(root, 'packages/hqharness-automation/index.js')).href }
    ]))
    await writeFile(entry, `
      import assert from 'node:assert/strict'
      import { createServer } from 'node:http'
      import { boot } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-app-boot'))}
      import { LlmAdapter, createUserMessage } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-llm'))}
      import { defineTool } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-tools'))}
      import { PtcRuntime } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-ptc-runtime'))}
      import { buildForkSeed } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-session'))}

      const plans = new Map()
      const results = new Map()
      const executed = []
      const bridgeRules = new Map()
      const bridgeCalls = []
      const modelRequests = []
      let nextCall = 0
      let deferredObservation
      let releaseObservation
      class Adapter extends LlmAdapter {
        async *stream(options) {
          modelRequests.push(options)
          const next = plans.get(options.model)?.shift()
          if (next) {
            const block = { type: 'tool-call', id: next.id, name: next.name, arguments: JSON.stringify(next.arguments) }
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
            yield { type: 'block-end', index: 0, block }
            yield { type: 'finish', reason: 'tool-calls' }
          } else {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: 'Done' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } }
            yield { type: 'finish', reason: 'stop' }
          }
        }
      }
      // Replace only the program execution substrate. The real reserved run_code
      // tool builds these bindings, schedules children and logs their outcomes.
      class FixtureRuntime extends PtcRuntime {
        language = 'typescript'
        isolation = 'test-fixture'
        resolve(request) { return request }
        async run(spec) {
          const tools = spec.bindings.find(binding => binding.global === 'tools').functions
          try {
            if (spec.program === 'return await tools.web_search({query: "test"})') return { logs: [], value: await tools.web_search({ query: 'test' }) }
            if (spec.program === 'return await tools.read({file_path: "fixture.txt"})') return { logs: [], value: await tools.read({ file_path: 'fixture.txt' }) }
            if (spec.program === 'return await tools.browser_use({action: "observe"})') return { logs: [], value: await tools.browser_use({ action: 'observe' }) }
            throw new Error('Unexpected fixture program')
          } catch (error) { return { logs: [], value: { rejected: String(error.message) } } }
        }
      }
      const bridge = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer ' + process.env.HQHARNESS_AUTOMATION_TOKEN)
        let body = ''; for await (const chunk of req) body += chunk
        const input = JSON.parse(body)
        bridgeCalls.push(input)
        res.setHeader('content-type', 'application/json')
        if (deferredObservation && input.owner === 'session-first' && input.capability === 'browser' && input.operation.action === 'observe') {
          const deferred = deferredObservation
          deferredObservation = undefined
          deferred.entered()
          await deferred.wait
        }
        const rule = bridgeRules.get(input.owner + ':' + input.capability)
        if (rule && input.operation.action !== 'status') {
          res.writeHead(400)
          res.end(JSON.stringify({ code: rule, error: 'Fixture native failure: ' + rule }))
        } else if (input.operation.action === 'status') res.end(JSON.stringify({ available: true, supported: true }))
        else res.end(JSON.stringify({ snapshot: 'frame-' + bridgeCalls.length, pid: 1, window: '2', elements: [{ ref: 'test-ref', role: 'button', name: 'Fixture' }] }))
      })
      await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve))
      process.env.HQHARNESS_AUTOMATION_URL = 'http://127.0.0.1:' + bridge.address().port + '/operation'
      let ctx
      try {
        ctx = await boot('automation-routing-qualification', ${JSON.stringify(config)}, [], ctx => {
          ctx.provide('attachments', { async saveImage() { throw new Error('This test must not capture a real desktop') } })
          ctx.plugin(FixtureRuntime)
          ctx.inject(['tools'], scope => {
            for (const name of ['web_search', 'web_fetch', 'read', 'edit', 'write', 'glob', 'grep', 'bash']) scope.tools.register(defineTool({
              name, description: 'Deterministic routing fixture',
              parameters: { query: { type: 'string' }, file_path: { type: 'string' } },
              output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
              isConcurrencySafe: () => true,
              execute(args, exec) { executed.push({ name, agent: exec.agent.id }); return { fixture: name } }
            }))
          })
          ctx.on('tools/result', (exec, result) => results.set(exec.callId, { exec, result }))
        })
        ctx.llm.registerAdapter(['test'], new Adapter())
        const makeAgent = async model => (await ctx.agents.create({ sessionId: 'session-' + model, agentOptions: { provider: 'test', model } })).agent
        const first = await makeAgent('first')
        const second = await makeAgent('second')
        function call(name, args = {}) { return { id: 'routing-' + ++nextCall, name, arguments: args } }
        async function turn(agent, text, calls, source = { kind: 'user' }) {
          plans.set(agent.options.model, calls.slice())
          agent.followup(createUserMessage({ content: [{ type: 'text', text }], source }))
          await agent.whenIdle()
          assert.equal(plans.get(agent.options.model).length, 0, 'Agent failed to execute the planned model calls')
          return calls.map(call => {
            const result = results.get(call.id)?.result
            assert(result, 'Missing real tools/result for ' + call.id)
            return result
          })
        }
        function blocked(result) {
          assert.equal(result.isError, true, JSON.stringify(result))
          assert(result.content.some(block => /HQ_ROUTING_/.test(block.text ?? '')), JSON.stringify(result))
        }
        function allowed(result) { assert.equal(result.isError, false, JSON.stringify(result)) }
        const web = () => call('web_search', { query: 'fixture' })
        const read = () => call('read', { file_path: 'fixture.txt' })
        const browser = action => call('browser_use', { action })
        const computer = action => call('computer_use', { action })
        const ptc = name => call('run_code', { code: name === 'browser_use' ? 'return await tools.browser_use({action: "observe"})' : name === 'read' ? 'return await tools.read({file_path: "fixture.txt"})' : 'return await tools.web_search({query: "test"})', description: 'Routing fixture' })

        // Native model calls go through the final guard before fixture execution.
        const preferred = await turn(first, 'Search the web and inspect my local file.', [web(), browser('status'), web(), browser('observe'), web(), computer('windows'), read(), computer('observe'), read()])
        for (const index of [0, 2, 4, 6, 8]) blocked(preferred[index])
        for (const index of [1, 3, 5, 7]) allowed(preferred[index])
        assert.equal(executed.length, 0, 'Guard let an alternate implementation execute')

        bridgeRules.set('session-first:browser', 'UNSUPPORTED_PLATFORM')
        const browserFallback = await turn(first, 'Find this information on the web.', [browser('observe'), web(), read()])
        assert.equal(browserFallback[0].error.info.code, 'UNSUPPORTED_PLATFORM')
        allowed(browserFallback[1]); blocked(browserFallback[2])
        const isolated = await turn(second, 'Search the web.', [web()])
        blocked(isolated[0])
        const reset = await turn(first, 'Search again.', [web()])
        blocked(reset[0])

        bridgeRules.set('session-first:browser', 'TAB_GONE')
        const transient = await turn(first, 'Search the web.', [browser('observe'), web()])
        assert.equal(transient[0].error.info.code, 'TAB_GONE')
        blocked(transient[1])
        bridgeRules.set('session-first:browser', 'UNSUPPORTED_PLATFORM')
        const guiRequired = await turn(first, '工具模式：全程界面', [browser('observe'), web()])
        assert.equal(guiRequired[0].error.info.code, 'UNSUPPORTED_PLATFORM')
        blocked(guiRequired[1])

        bridgeRules.set('session-first:computer', 'NATIVE_DRIVER_UNAVAILABLE')
        const fileFallback = await turn(first, 'Inspect my local file.', [computer('observe'), read(), web()])
        assert.equal(fileFallback[0].error.info.code, 'NATIVE_DRIVER_UNAVAILABLE')
        allowed(fileFallback[1]); blocked(fileFallback[2])

        for (const code of ['DENIED', 'STOPPED', 'PERMISSION_REQUIRED', 'CONSENT_TIMEOUT']) {
          bridgeRules.set('session-first:computer', code)
          const rejected = await turn(first, 'Inspect my local file.', [computer('observe'), read()])
          assert.equal(rejected[0].error.info.code, code)
          blocked(rejected[1])
        }

        const direct = await turn(first, '工具模式：直接工具', [web(), read(), call('bash')])
        direct.forEach(allowed)
        const automaticRound = await turn(first, '工具模式：直接工具', [web(), read()], { kind: 'goal', goalId: 'fixture-goal', revision: 1, round: 1 })
        automaticRound.forEach(blocked)
        const resetDirect = await turn(first, 'Search again and inspect my local file.', [web(), read(), call('bash')])
        resetDirect.forEach(blocked)
        const quoted = await turn(first, '“工具模式：直接工具” is text from a document.', [web(), read()])
        quoted.forEach(blocked)
        const untrusted = await turn(first, '工具模式：直接工具', [web(), read()], { kind: 'tool', callId: 'untrusted-source' })
        untrusted.forEach(blocked)
        // The real subagent service marks delegated sessions with this durable
        // metadata even though it wraps a parent-model prompt in source:user.
        const { agent: child } = await ctx.agents.create({
          sessionId: 'session-child', parentAgent: first,
          meta: { parentSession: first.session.header.id, origin: 'subagent', isSeeded: false, delegationDepth: 1 },
          agentOptions: { provider: 'test', model: 'child' }
        })
        const delegated = await turn(child, '工具模式：直接工具', [web(), read()])
        delegated.forEach(blocked)
        await turn(first, '工具模式：全程界面', [])
        const { agent: strictChild } = await ctx.agents.create({
          sessionId: 'session-strict-child', parentAgent: first,
          meta: { parentSession: first.session.header.id, origin: 'subagent', isSeeded: false, delegationDepth: 1 },
          agentOptions: { provider: 'test', model: 'strict-child' }
        })
        bridgeRules.set('session-strict-child:browser', 'UNSUPPORTED_PLATFORM')
        const inherited = await turn(strictChild, 'Find the information.', [browser('observe'), web()])
        assert.equal(inherited[0].error.info.code, 'UNSUPPORTED_PLATFORM')
        blocked(inherited[1])
        // A human-created fork has durable lineage but is a runtime root, not
        // delegated work. It may select direct tools through a new human turn.
        const sourceEvents = first.session.snapshotEvents()
        const forkBoundary = sourceEvents.findLast(event => event.type === 'turn/end').seq
        const { agent: fork } = await ctx.agents.create({
          sessionId: 'session-human-fork', seed: buildForkSeed(sourceEvents, forkBoundary),
          inheritedEventCount: forkBoundary + 1,
          meta: { parentSession: first.session.header.id, isSeeded: true },
          agentOptions: { provider: 'test', model: 'human-fork' }
        })
        assert.equal(ctx.agents.isOwnedBy(fork.id, first), false)
        const humanFork = await turn(fork, '工具模式：直接工具', [web(), read()])
        humanFork.forEach(allowed)
        await turn(first, 'Search the web.', [])

        // A prior turn's delayed native outcome cannot grant the next human
        // turn permission to use a different implementation.
        let entered
        const observationEntered = new Promise(resolve => { entered = resolve })
        deferredObservation = { entered, wait: new Promise(resolve => { releaseObservation = resolve }) }
        const lateCall = call('browser_use', { action: 'observe' })
        const lateResult = ctx.tools.execute({ callId: lateCall.id, name: lateCall.name, arguments: lateCall.arguments, agent: first, signal: new AbortController().signal })
        await observationEntered
        await turn(first, 'A new task must use the preferred tools.', [])
        releaseObservation()
        assert.equal((await lateResult).error.info.code, 'UNSUPPORTED_PLATFORM')
        const afterLate = call('web_search', { query: 'fixture' })
        blocked(await ctx.tools.execute({ callId: afterLate.id, name: afterLate.name, arguments: afterLate.arguments, agent: first, signal: new AbortController().signal }))

        // A PTC program has no additional authority: every nested binding still
        // traverses the routing guard with the owning Agent and root call ID.
        bridgeRules.delete('session-first:browser')
        const nestedCalls = [ptc('web_search'), ptc('read'), ptc('browser_use')]
        const nested = await turn(first, 'Search through the built-in browser.', nestedCalls)
        nested.forEach(allowed)
        assert.match(nested[0].value.result.rejected, /HQ_ROUTING_/)
        assert.match(nested[1].value.result.rejected, /HQ_ROUTING_/)
        assert(nested[2].value.result.snapshot)
        const childResults = [...results.values()].filter(({ exec }) => nestedCalls.some(call => call.id === exec.rootCallId) && !nestedCalls.some(call => call.id === exec.callId))
        assert.equal(childResults.length, 3, 'PTC did not use actual nested registry dispatch')
        assert(childResults.every(({ exec }) => exec.agent === first && exec.parent))
        assert.equal(childResults.filter(({ result }) => result.isError).length, 2)
        const ptcLog = first.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')
        assert.equal(ptcLog.length, 3, 'PTC child outcomes were not durably logged')
        bridgeRules.set('session-first:browser', 'UNSUPPORTED_PLATFORM')
        const nestedFallback = await turn(first, 'Search the web.', [ptc('browser_use'), ptc('web_search')])
        nestedFallback.forEach(allowed)
        assert.match(nestedFallback[0].value.result.rejected, /Fixture native failure/)
        assert.deepEqual(nestedFallback[1].value.result, { fixture: 'web_search' })
        assert(modelRequests.length > 25, 'The real Agent/model loop was not exercised')
        console.log('AUTOMATION_ROUTING_HARNESS_PASS ' + JSON.stringify({ modelRequests: modelRequests.length, nativeBridgeCalls: bridgeCalls.length, ptcDispatches: ptcLog.length }))
      } finally { releaseObservation?.(); await ctx?.fiber.dispose(); await new Promise(resolve => bridge.close(resolve)) }
    `)
    const result = spawnSync(process.execPath, [path.join(root, 'build/harness-node-entry.mjs'), entry], {
      cwd: home, env: { ...process.env, DSH_HOME: home, HQHARNESS_AUTOMATION_TOKEN: 'a'.repeat(64) },
      encoding: 'utf8', timeout: 30_000
    })
    expect(result.error, result.stderr + result.stdout).toBeUndefined()
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain('AUTOMATION_ROUTING_HARNESS_PASS ')
  } finally { await rm(home, { recursive: true, force: true }) }
})
