import { AutomationError, type AutomationResult, type AutomationStep } from '../../shared/automation'

/** Execute a bounded declarative plan, never replaying a failed/uncertain input. */
export async function runAutomationSequence(
  steps: AutomationStep[],
  signal: AbortSignal,
  perform: (step: AutomationStep, signal: AbortSignal) => Promise<AutomationResult>
): Promise<AutomationResult> {
  if (!steps.length || steps.length > 8) throw new AutomationError('INVALID_INPUT', 'A plan must contain 1 to 8 steps')
  signal.throwIfAborted()
  const started = performance.now()
  const timeout = new AbortController()
  const deadline = setTimeout(() => timeout.abort(new AutomationError('SEQUENCE_TIMEOUT', 'The local plan exceeded its 15 second budget; observe before planning the remaining steps.')), 15_000)
  const bounded = AbortSignal.any([signal, timeout.signal])
  let completed = 0
  let observed: AutomationResult = {}
  try {
    for (const step of steps) {
      bounded.throwIfAborted()
      // Cancellation bounds the tool response even if a platform call is slow
      // to unwind. The adapters check the same signal before every further
      // input; an already dispatched action is uncertain and is never replayed.
      let abort = (): void => undefined
      try {
        observed = await Promise.race([
          perform(step, bounded),
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(bounded.reason)
            if (bounded.aborted) abort()
            else bounded.addEventListener('abort', abort, { once: true })
          })
        ])
      } finally { bounded.removeEventListener('abort', abort) }
      bounded.throwIfAborted()
      completed++
    }
    return { ...observed, sequence: { status: 'completed', completed, total: steps.length, elapsed_ms: Math.round(performance.now() - started) } }
  } catch (cause) {
    // Explicit stop/disconnect must remain authoritative at the host gate.
    signal.throwIfAborted()
    const error: unknown = timeout.signal.aborted ? timeout.signal.reason : cause
    return {
      observation_required: true,
      sequence: {
        status: 'failed', completed, total: steps.length, failed_step: completed + 1,
        error: { code: error instanceof AutomationError ? error.code : 'STEP_FAILED', message: error instanceof AutomationError ? error.message : 'The step could not be verified. Observe the target before continuing; do not replay the input.' },
        elapsed_ms: Math.round(performance.now() - started)
      }
    }
  } finally { clearTimeout(deadline) }
}
