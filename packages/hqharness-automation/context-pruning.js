import { freezeMessage } from '@deepseek-ai/dsh-llm'

// Small observations are cheaper to keep than to add durable replacement events.
const MIN_RESULT_BYTES = 16_384
const MIN_SAVED_BYTES = 8_192
const RETAIN_STEPS = 2
const RETAIN_OBSERVATIONS = 2
const MIN_OFFLOAD_IMAGES = 4
const AUTOMATION_TOOLS = new Set(['browser_use', 'computer_use'])
const LOCATOR_KEYS = new Set(['ref', 'frame', 'bounds'])
const histories = new WeakMap()
const parsedMessages = new WeakMap()
const unchangedMessages = new WeakSet()

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stepKey = data => `${data.turn}:${data.step}`
const callKey = (data, id) => `${stepKey(data)}:${id}`

/** Index tool provenance incrementally without copying any conversation content. */
function callsFor(session, events) {
  let state = histories.get(session)
  if (!state) {
    state = { cursor: 0, calls: new Map() }
    histories.set(session, state)
  }
  for (; state.cursor < events.length; state.cursor++) {
    const event = events[state.cursor]
    if (event.type === 'tool/call' && AUTOMATION_TOOLS.has(event.data.name)) state.calls.set(callKey(event.data, event.data.callId), event.data.name)
  }
  return state.calls
}

/** Parse only this plugin's JSON observations; unknown or failed output is opaque. */
function observation(message) {
  if (parsedMessages.has(message)) return parsedMessages.get(message)
  let parsed
  if (!message.isError) {
    const blocks = []
    for (const [index, block] of message.content.entries()) {
      if (block.type !== 'text') continue
      let value
      try { value = JSON.parse(block.text) } catch { continue }
      if (!record(value) || (typeof value.snapshot !== 'string' && !record(value.archived_observation)) || value.observation_required || (value.sequence && value.sequence.status !== 'completed')) continue
      // Raw messages remain reachable from the durable log. Cache only this
      // small classification, never a second copy of every parsed screen tree.
      blocks.push({ index, archived: record(value.archived_observation) })
    }
    if (blocks.length > 0) parsed = blocks
  }
  parsedMessages.set(message, parsed)
  return parsed
}

/** Keep every row, order, duplicate and semantic field; remove only expired locators. */
function compactObservation(value, seq) {
  if (value.archived_observation) return value
  const next = { ...value }
  let changed = false
  for (const key of ['nodes', 'elements']) {
    if (!Array.isArray(value[key])) continue
    next[key] = value[key].map(node => {
      if (!record(node)) return node
      const entries = Object.entries(node).filter(([field]) => !LOCATOR_KEYS.has(field))
      if (entries.length !== Object.keys(node).length) changed = true
      return Object.fromEntries(entries)
    })
  }
  if (!changed) return value
  delete next.snapshot
  for (const key of ['coordinate_width', 'coordinate_height', 'coordinates', 'nativeCoordinates']) delete next[key]
  next.archived_observation = {
    source_seq: seq,
    note: 'Expired interaction locators omitted. All semantic rows and action outcomes are retained in order. Original observation remains in the session log. Observe again before input.'
  }
  return next
}

const contentBytes = content => content.reduce((bytes, block) => bytes + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)

/**
 * Prune only old successful Browser/Computer Use observations via public durable
 * Session replacements. The two latest model steps and each capability's two
 * latest observations stay intact. Raw history, tool pairing and user messages
 * are never changed. Image omission requires the host's registered interpreter.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {import('@deepseek-ai/dsh-token-meter').TokenMeter} tokenMeter
 * @param {{events: readonly import('@deepseek-ai/dsh-session').SessionEvent[], offloadImages?: boolean, signal?: AbortSignal}} options
 * @returns {{results: number, images: number, bytesBefore: number, bytesAfter: number, tokensBefore: number, tokensAfter: number}}
 */
export function pruneAutomationHistory(session, tokenMeter, options) {
  options.signal?.throwIfAborted()
  const events = options.events
  if (events.length !== session.seq) throw new Error('Automation history cut is stale')
  const calls = callsFor(session, events)
  const nodes = [...session.surface.nodes]
  const recentSteps = new Set(nodes.map(seq => events[seq]).filter(event => event.type === 'assistant/message').slice(-RETAIN_STEPS).map(event => stepKey(event.data)))
  const candidates = []
  const latest = new Map()
  for (const seq of nodes) {
    const event = events[seq]
    if (event.type !== 'tool/result' || event.data.error) continue
    const capability = calls.get(callKey(event.data, event.data.message.source.callId))
    if (!capability) continue
    const message = session.deriveEventMessage(event)
    const blocks = observation(message)
    if (!blocks) continue
    const candidate = { seq, event, message, blocks }
    candidates.push(candidate)
    const retained = latest.get(capability) ?? []
    retained.push(seq)
    latest.set(capability, retained.slice(-RETAIN_OBSERVATIONS))
  }
  const protectedSeqs = new Set([...latest.values()].flat())
  const stats = { results: 0, images: 0, bytesBefore: 0, bytesAfter: 0, tokensBefore: 0, tokensAfter: 0 }
  const offloadTargets = []
  let before
  for (const candidate of candidates) {
    options.signal?.throwIfAborted()
    const { seq, event, message, blocks } = candidate
    if (protectedSeqs.has(seq) || recentSteps.has(stepKey(event.data))) continue
    let targetSeq = seq
    const bytesBefore = contentBytes(message.content)
    if (bytesBefore >= MIN_RESULT_BYTES && !unchangedMessages.has(message)) {
      const content = [...message.content]
      for (const { index, archived } of blocks) {
        if (archived) continue
        const value = JSON.parse(content[index].text)
        const compacted = compactObservation(value, seq)
        if (compacted !== value) content[index] = { ...content[index], text: JSON.stringify(compacted) }
      }
      const bytesAfter = contentBytes(content)
      if (bytesBefore - bytesAfter >= MIN_SAVED_BYTES) {
        // Resolve fallible content/pricing work before the canonical two-event
        // shadow-price/replacement protocol (the upstream pruner uses the same
        // protocol). No await occurs between these appends. Unexpected commit
        // failure propagates; continuing would misrepresent the priced surface.
        const replacementMessage = freezeMessage({ ...message, content })
        const shadowedTokenCount = tokenMeter.estimateMessage(message)
        before ??= tokenMeter.measure(session).totalTokens
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq],
          shadowedTokenCount
        })
        const replacement = session.append('tool/result', { ...event.data, message: replacementMessage }, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq]
        })
        targetSeq = replacement.seq
        stats.results++
        stats.bytesBefore += bytesBefore
        stats.bytesAfter += bytesAfter
      } else unchangedMessages.add(message)
    }
    if (options.offloadImages) {
      const imageIndexes = []
      let index = 0
      for (const block of message.content) if (block.type === 'image') {
        if (block.offloaded !== true) imageIndexes.push(index)
        index++
      }
      if (imageIndexes.length > 0) offloadTargets.push({ seq: targetSeq, imageIndexes })
    }
  }
  const images = offloadTargets.reduce((count, target) => count + target.imageIndexes.length, 0)
  if (images >= MIN_OFFLOAD_IMAGES) {
    options.signal?.throwIfAborted()
    before ??= tokenMeter.measure(session).totalTokens
    session.append('image/offload', { targets: offloadTargets })
    stats.images = images
  }
  if (before !== undefined) {
    stats.tokensBefore = before
    stats.tokensAfter = tokenMeter.measure(session).totalTokens
  }
  return stats
}

/** Attach optional maintenance to the host's existing Agent loop and lifecycle. */
export function registerAutomationContextPruning(ctx) {
  ctx.inject(['sessions', 'sessionQuery', 'tokenMeter'], scoped => {
    scoped.on('agent/pre-step', async ({ agent, signal }, next) => {
      let cut
      try {
        cut = await scoped.sessionQuery.observeSession(agent.session.id, { signal, projectionMode: 'none' })
      } catch {
        // This is optional maintenance. A failed read must not prevent the
        // requested task; cancellation still stops at the existing boundary.
        signal.throwIfAborted()
        scoped.logger.warn('automation history: query unavailable; maintenance skipped')
        return next()
      }
      try {
        signal.throwIfAborted()
        // Input/maintenance can append while the read resolves. Defer this optional
        // optimization if its exact immutable cut is no longer the live tail.
        if (cut.cursor + 1 !== agent.session.seq) return next()
        const beforeSeq = agent.session.seq
        try {
          const stats = pruneAutomationHistory(agent.session, scoped.tokenMeter, {
            events: cut.events, signal,
            offloadImages: scoped.sessions.messageProjections.some(projection => projection.type === 'image/offload')
          })
          if (stats.results || stats.images) scoped.logger.info(`automation history: results=${stats.results} images=${stats.images} text_bytes=${stats.bytesBefore}->${stats.bytesAfter} estimated_request_tokens=${stats.tokensBefore}->${stats.tokensAfter}`)
        } catch (error) {
          signal.throwIfAborted()
          if (agent.session.seq !== beforeSeq) throw error
          scoped.logger.warn('automation history: planning unavailable; maintenance skipped')
        }
      } finally { cut[Symbol.dispose]() }
      return next()
    })
  })
}
