import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAutomationSequence } from '../src/main/automation/sequence'
import { AutomationError, type AutomationStep } from '../src/shared/automation'

afterEach(() => vi.useRealTimers())
const steps: AutomationStep[] = [{ action: 'click', target: { name: 'Search' } }, { action: 'wait', target: { name: 'Results' } }]
describe('local bounded sequence', () => {
  it('returns only the final verified observation after executing every step', async () => {
    const work = vi.fn(async (step: AutomationStep) => ({ snapshot: step.action }))
    const result = await runAutomationSequence(steps, new AbortController().signal, work)
    expect(result).toMatchObject({ snapshot: 'wait', sequence: { status: 'completed', completed: 2, total: 2 } })
    expect(work).toHaveBeenCalledTimes(2)
  })
  it('reports partial failure without publishing a stale snapshot or replaying input', async () => {
    const work = vi.fn().mockResolvedValueOnce({ snapshot: 'old' }).mockRejectedValueOnce(new AutomationError('AMBIGUOUS_TARGET', 'Select a unique control'))
    const result = await runAutomationSequence([...steps, steps[0] as AutomationStep], new AbortController().signal, work)
    expect(result).toMatchObject({ observation_required: true, sequence: { status: 'failed', completed: 1, failed_step: 2, error: { code: 'AMBIGUOUS_TARGET' } } })
    expect(result).not.toHaveProperty('snapshot')
    expect(work).toHaveBeenCalledTimes(2)
  })
  it('returns a bounded timeout even when an in-flight platform operation is slow to unwind', async () => {
    vi.useFakeTimers()
    const work = vi.fn(async () => new Promise<Record<string, unknown>>(() => undefined))
    const result = runAutomationSequence(steps, new AbortController().signal, work)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(await result).toMatchObject({ observation_required: true, sequence: { status: 'failed', completed: 0, failed_step: 1, error: { code: 'SEQUENCE_TIMEOUT' } } })
    expect(work).toHaveBeenCalledOnce()
  })
  it('preserves explicit stop while cancelling a pending action', async () => {
    const controller = new AbortController()
    const reason = new AutomationError('STOPPED', 'Stopped')
    const work = vi.fn(async () => new Promise<Record<string, unknown>>(() => undefined))
    const result = runAutomationSequence(steps, controller.signal, work)
    const assertion = expect(result).rejects.toBe(reason)
    controller.abort(reason)
    await assertion
    expect(work).toHaveBeenCalledOnce()
  })
})
