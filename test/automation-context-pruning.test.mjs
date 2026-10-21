import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionStore, { Session, SessionId, buildForkSeed } from '@deepseek-ai/dsh-session'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { pruneAutomationHistory, registerAutomationContextPruning } from '../packages/hqharness-automation/context-pruning.js'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SessionProjections)
  await ctx.plugin(TokenMeter)
  cleanups.push(() => ctx.fiber.dispose())
  const session = Session.create(SessionId('session-pruning'), undefined, undefined, undefined, [imageOffloadProjection])
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Keep every budget row and save my report.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return { ctx, session, user }
}

function observe(session, step, { name = 'computer_use', error = false, image = false, small = false, partial = false } = {}) {
  const callId = ToolCallId('call-' + step)
  session.append('step/start', { turn: 1, step })
  const args = JSON.stringify({ action: step === 1 ? 'run' : 'observe', snapshot: 'previous', steps: [{ action: 'click', target: { name: 'Save' } }] })
  session.append('assistant/message', { turn: 1, step, stream: [], message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: callId, name, arguments: args }] }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step, callId, name, arguments: args })
  const data = {
    snapshot: 'snapshot-' + step, pid: 10, window: '20', url: 'https://example.test/budget', title: 'Budget',
    inputSent: 'click', verified: false, verification: 'Delivery confirmed; inspect the result.',
    sequence: { status: partial ? 'partial' : 'completed', completed: 1, total: 1, elapsed_ms: 9 },
    host_timing: { queue_and_consent_ms: 0, execute_ms: 10, total_ms: 10 },
    elements: Array.from({ length: small ? 1 : 220 }, (_, index) => ({ ref: 'snapshot-' + step + ':' + index, role: 'cell', name: 'Budget row ' + index, value: 'Amount ' + index, bounds: { x: 100, y: index * 20, width: 800, height: 20 }, properties: { checked: index % 2 === 0 } }))
  }
  const content = [{ type: 'text', text: JSON.stringify(data) }]
  if (image) content.push({ type: 'image', attachment: { attachmentId: 'frame-' + step, mediaType: 'image/png', width: 1024, height: 768, bytes: 100 } })
  const event = session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId, content, isError: error }), ...(error ? { error: { name: 'HarnessError', code: 'TEST_ERROR' } } : {}) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step })
  return { event, data }
}

function currentResult(session, callId) {
  return session.surface.nodes.map(seq => session.eventAt(seq)).find(event => event.type === 'tool/result' && event.data.message.source.callId === callId)
}

it('reduces only stale automation structure while retaining every semantic row, outcome and raw event', async () => {
  const { ctx, session, user } = await fixture()
  const first = observe(session, 1)
  const unrelated = observe(session, 2, { name: 'read' })
  const failure = observe(session, 3, { error: true })
  const partial = observe(session, 4, { partial: true })
  const small = observe(session, 5, { small: true })
  const recent = [observe(session, 6), observe(session, 7)]
  const before = ctx.tokenMeter.measure(session)
  const stats = pruneAutomationHistory(session, ctx.tokenMeter, { events: session.snapshotEvents(), offloadImages: true })
  expect(stats.results).toBe(1)
  expect(stats.bytesBefore - stats.bytesAfter).toBeGreaterThan(8192)
  const replacement = currentResult(session, first.event.data.message.source.callId)
  const result = JSON.parse(replacement.data.message.content[0].text)
  expect(result.elements).toHaveLength(first.data.elements.length)
  expect(result.elements.map(({ role, name, value, properties }) => ({ role, name, value, properties }))).toEqual(first.data.elements.map(({ role, name, value, properties }) => ({ role, name, value, properties })))
  expect(result.elements.every(node => !Object.hasOwn(node, 'ref') && !Object.hasOwn(node, 'bounds'))).toBe(true)
  expect(result).toMatchObject({ url: first.data.url, inputSent: 'click', verified: false, verification: first.data.verification, sequence: first.data.sequence, host_timing: first.data.host_timing })
  expect(result.archived_observation.source_seq).toBe(first.event.seq)
  expect(session.eventAt(first.event.seq)).toBe(first.event)
  expect(session.deriveEventMessage(session.eventAt(user.seq))).toEqual(user.data)
  for (const { event } of [unrelated, failure, partial, small, ...recent]) expect(currentResult(session, event.data.message.source.callId)).toBe(event)
  const shadow = session.snapshotEvents().find(event => event.type === 'compaction/prune')
  expect(shadow.data.shadowedTokenCount).toBe(ctx.tokenMeter.estimateMessage(first.event.data.message))
  expect(before.totalTokens - ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThan(2000)
  const length = session.seq
  expect(pruneAutomationHistory(session, ctx.tokenMeter, { events: session.snapshotEvents(), offloadImages: true }).results).toBe(0)
  expect(session.seq).toBe(length)
  expect(ctx.sessionProjections.snapshot(session).values.contextBreakdown.messageTokens).toBe(ctx.tokenMeter.measure(session).surfaceTokens)
  session.append('turn/end', { turn: 1, reason: 'completed' })
  for (const seed of [session.snapshotEvents(), buildForkSeed(session.snapshotEvents(), session.snapshotEvents().at(-1).seq)]) {
    const replay = Session.create(SessionId('session-replay'), seed, undefined, undefined, [imageOffloadProjection])
    expect(replay.surface.nodes.map(seq => replay.deriveEventMessage(replay.eventAt(seq)))).toEqual(session.surface.nodes.map(seq => session.deriveEventMessage(session.eventAt(seq))))
    const beforeReplay = replay.seq
    expect(pruneAutomationHistory(replay, ctx.tokenMeter, { events: replay.snapshotEvents(), offloadImages: true }).results).toBe(0)
    expect(replay.seq).toBe(beforeReplay)
  }
})

it('offloads only old automation screenshots in a durable batch and retains latest observations per capability', async () => {
  const { ctx, session } = await fixture()
  const old = Array.from({ length: 4 }, (_, index) => observe(session, index + 1, { image: true, small: true }))
  const latestComputer = [observe(session, 5, { image: true }), observe(session, 6, { image: true })]
  const latestBrowser = [observe(session, 7, { name: 'browser_use', image: true }), observe(session, 8, { name: 'browser_use', image: true })]
  const stats = pruneAutomationHistory(session, ctx.tokenMeter, { events: session.snapshotEvents(), offloadImages: true })
  expect(stats.images).toBe(4)
  for (const { event } of old) {
    const projected = session.deriveEventMessage(currentResult(session, event.data.message.source.callId))
    expect(projected.content[1]).toEqual({ ...event.data.message.content[1], offloaded: true })
    expect(event.data.message.content[1].offloaded).toBeUndefined()
  }
  for (const { event } of [...latestComputer, ...latestBrowser]) expect(session.deriveEventMessage(event)).toBe(event.data.message)
  const replay = Session.create(SessionId('session-replay-images'), session.snapshotEvents(), undefined, undefined, [imageOffloadProjection])
  expect(replay.surface.nodes.map(seq => replay.deriveEventMessage(replay.eventAt(seq)))).toEqual(session.surface.nodes.map(seq => session.deriveEventMessage(session.eventAt(seq))))
  const seq = replay.seq
  expect(pruneAutomationHistory(replay, ctx.tokenMeter, { events: replay.snapshotEvents(), offloadImages: true }).images).toBe(0)
  expect(replay.seq).toBe(seq)
})

it('does no durable work for small observations, too few old images, absent image interpretation or cancellation', async () => {
  const { ctx, session } = await fixture()
  for (let step = 1; step <= 5; step++) observe(session, step, { image: true, small: true })
  const seq = session.seq
  expect(pruneAutomationHistory(session, ctx.tokenMeter, { events: session.snapshotEvents(), offloadImages: true })).toMatchObject({ results: 0, images: 0 })
  expect(session.seq).toBe(seq)
  observe(session, 6, { image: true, small: true })
  const noInterpreterSeq = session.seq
  expect(pruneAutomationHistory(session, ctx.tokenMeter, { events: session.snapshotEvents(), offloadImages: false })).toMatchObject({ results: 0, images: 0 })
  expect(session.seq).toBe(noInterpreterSeq)
  const abort = new AbortController()
  abort.abort(new Error('cancelled'))
  expect(() => pruneAutomationHistory(session, ctx.tokenMeter, { events: session.snapshotEvents(), offloadImages: true, signal: abort.signal })).toThrow('cancelled')
  expect(session.seq).toBe(noInterpreterSeq)
})

it('skips failed/stale optional reads, honors cancellation and removes its scoped listener on unload', async () => {
  const { ctx, session } = await fixture()
  await ctx.plugin(SessionStore)
  let mode = 'failure', calls = 0, releases = 0
  const abort = new AbortController()
  ctx.provide('sessionQuery', {
    async observeSession() {
      calls++
      if (mode === 'failure') throw new Error('sensitive fixture content must not be logged')
      if (mode === 'cancel') abort.abort(new Error('stop maintenance'))
      return { cursor: mode === 'stale' ? session.seq - 2 : session.seq - 1, events: session.snapshotEvents(), [Symbol.dispose]() { releases++ } }
    }
  })
  const scope = ctx.plugin({ name: 'maintenance-lifetime-test', apply: registerAutomationContextPruning })
  await scope
  const decision = { kind: 'enter', messages: [] }
  const dispatch = () => ctx.waterfall('agent/pre-step', { agent: { session }, signal: abort.signal }, () => Promise.resolve(decision))
  expect(await dispatch()).toBe(decision)
  mode = 'stale'
  expect(await dispatch()).toBe(decision)
  expect(releases).toBe(1)
  mode = 'cancel'
  await expect(dispatch()).rejects.toThrow('stop maintenance')
  expect(releases).toBe(2)
  await scope.dispose()
  const previous = calls
  expect(await dispatch()).toBe(decision)
  expect(calls).toBe(previous)
})

it('skips optional pricing failure before any write and propagates a failure after a committed rewrite', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  let mode = 'estimate', measured = 0
  class FaultMeter extends TokenMeter {
    estimateMessage(message) {
      if (mode === 'estimate') throw new Error('private estimate diagnostic')
      return super.estimateMessage(message)
    }
    measure(session, header) {
      measured++
      if (mode === 'measure' || (mode === 'after' && measured === 2)) throw new Error('private measurement diagnostic')
      return super.measure(session, header)
    }
  }
  for (const plugin of [SessionProjections, SessionStore, FaultMeter]) await ctx.plugin(plugin)
  await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
  const session = ctx.sessions.create(SessionId('session-fault-pricing'))
  session.append('turn/start', { turn: 1 })
  for (let step = 1; step <= 3; step++) observe(session, step)
  await ctx.plugin({ name: 'pricing-failure-test', apply: registerAutomationContextPruning })
  const decision = { kind: 'enter', messages: [] }
  const dispatch = () => ctx.waterfall('agent/pre-step', { agent: { session }, signal: new AbortController().signal }, () => Promise.resolve(decision))
  const seq = session.seq
  expect(await dispatch()).toBe(decision)
  expect(session.seq).toBe(seq)
  mode = 'measure'
  expect(await dispatch()).toBe(decision)
  expect(session.seq).toBe(seq)
  mode = 'after'; measured = 0
  await expect(dispatch()).rejects.toThrow('private measurement diagnostic')
  expect(session.seq).toBe(seq + 2)
  expect(JSON.parse(currentResult(session, ToolCallId('call-1')).data.message.content[0].text).archived_observation).toBeDefined()
})

it('activates packaged helper through the actual Harness loader and prunes before the real Agent assembles its request', async () => {
  const { session } = await fixture()
  for (let step = 1; step <= 6; step++) observe(session, step)
  session.append('turn/end', { turn: 1, reason: 'completed' })
  const root = path.resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'hq-context-harness-')))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const moduleUrl = name => pathToFileURL(path.join(root, 'node_modules', name, 'lib/index.js')).href
  const config = path.join(home, 'cordis.yml')
  await writeFile(path.join(home, 'seed.json'), JSON.stringify(session.snapshotEvents()))
  await writeFile(config, JSON.stringify([
    ...['dsh-system-prompt', 'dsh-tools', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-token-meter'].map(name => ({ id: name, name: moduleUrl('@deepseek-ai/' + name) })),
    { id: 'query', name: moduleUrl('@deepseek-ai/dsh-session-query-sqlite'), config: { path: ':memory:', openAt: 'never' } },
    { id: 'automation', name: pathToFileURL(path.join(root, 'packages/hqharness-automation/index.js')).href }
  ]))
  const entry = path.join(home, 'entry.mjs')
  await writeFile(entry, `
    import assert from 'node:assert/strict'
    import { readFile } from 'node:fs/promises'
    import { boot } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-app-boot'))}
    import { LlmAdapter, createUserMessage } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-llm'))}
    const requests = []
    class Adapter extends LlmAdapter {
      async *stream(options) {
        requests.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } }
        yield { type: 'finish', reason: 'stop' }
      }
    }
    const ctx = await boot('automation-context-qualification', ${JSON.stringify(config)}, [], ctx => {
      ctx.provide('attachments', { async saveImage() { throw new Error('No input must execute in a history test') } })
    })
    try {
      ctx.llm.registerAdapter(['test'], new Adapter())
      const seed = JSON.parse(await readFile(${JSON.stringify(path.join(home, 'seed.json'))}, 'utf8'))
      const { agent } = await ctx.agents.create({ sessionId: 'session-context-live', seed, agentOptions: { provider: 'test', model: 'model' } })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue without using any tools.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      assert.equal(requests.length, 1, 'Agent did not reach its model adapter')
      const messages = requests[0].messages
      const results = messages.filter(message => message.role === 'tool')
      assert.equal(results.length, 6)
      const bodies = results.map(message => JSON.parse(message.content[0].text))
      assert.equal(bodies.filter(body => body.archived_observation).length, 4)
      assert.equal(bodies.filter(body => body.snapshot).length, 2)
      assert.equal(bodies[0].elements.length, 220)
      assert.equal(bodies[0].elements[219].value, 'Amount 219')
      assert(messages.some(message => message.content.some(block => block.text === 'Keep every budget row and save my report.')))
      const cut = await ctx.sessionQuery.observeSession(agent.session.id, { projectionMode: 'none' })
      try {
        assert.equal(cut.events.filter(event => event.type === 'tool/call').length, 6)
        const original = cut.events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append')
        assert.equal(original.length, 6)
        assert.equal(JSON.parse(original[0].data.message.content[0].text).elements[0].ref, 'snapshot-1:0')
        assert.equal(cut.events.filter(event => event.type === 'compaction/prune').length, 4)
      } finally { cut[Symbol.dispose]() }
      console.log('AUTOMATION_CONTEXT_HARNESS_PASS')
    } finally { await ctx.fiber.dispose() }
  `)
  const result = spawnSync(process.execPath, [path.join(root, 'build/harness-node-entry.mjs'), entry], {
    cwd: home, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 30_000
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr + result.stdout).toBe(0)
  expect(result.stdout).toContain('AUTOMATION_CONTEXT_HARNESS_PASS')
})
