import { describe, expect, it } from 'vitest'
import { validateAutomationRequest } from '../src/shared/automation'

const request = (operation: Record<string, unknown>, capability = 'computer') => ({ capability, owner: 's1', operation })
describe('structured automation and bounded plans', () => {
  it('accepts exact native windows and semantic input without screen coordinates', () => {
    expect(validateAutomationRequest(request({ action: 'windows' })).operation.action).toBe('windows')
    expect(validateAutomationRequest(request({ action: 'windows', pid: 42 })).operation.pid).toBe(42)
    expect(validateAutomationRequest(request({ action: 'observe', pid: 42, window: '18446744073709551615', screenshot: false })).operation.window).toBe('18446744073709551615')
    expect(validateAutomationRequest(request({ action: 'click', pid: 42, window: '123', snapshot: 'frame', ref: 'e1' })).operation.ref).toBe('e1')
  })
  it('accepts finite semantic plans and preserves an empty expected value', () => {
    const operation = { action: 'run', pid: 42, window: '123', snapshot: 'frame', steps: [
      { action: 'type', target: { name: 'Search', role: 'edit' }, text: 'hello', replace: true },
      { action: 'key', target: { name: 'Search' }, key: 'ENTER' },
      { action: 'wait', target: { name: 'Results' }, value: '' }
    ] }
    expect(validateAutomationRequest(request(operation)).operation.steps).toEqual(operation.steps)
    expect(validateAutomationRequest(request({ action: 'run', tab: 'tab', snapshot: 'frame', steps: [{ action: 'key', key: 'ENTER' }] }, 'browser')).operation.steps).toHaveLength(1)
  })
  it('rejects missing, excessive, nested or script-like plans before execution', () => {
    for (const steps of [[], Array.from({ length: 9 }, () => ({ action: 'wait', target: { name: 'A' } })), [{ action: 'run', steps: [] }], [{ action: 'execute', script: 'anything' }], [{ action: 'click', x: 1, y: 2 }], [{ action: 'click', ref: 'old' }], [{ action: 'type', text: 'unbound' }], [{ action: 'key', key: 'ENTER' }]]) {
      expect(() => validateAutomationRequest(request({ action: 'run', snapshot: 'f', steps }))).toThrow()
    }
  })
  it('rejects malformed or cross-capability window selectors', () => {
    for (const fields of [{ pid: -1, window: '1' }, { pid: 1.5, window: '1' }, { pid: 1 }, { window: '1' }, { pid: 1, window: '18446744073709551616' }, { pid: 1, window: '0' }, { pid: 1, window: '01' }, { pid: 1, window: '1e3' }]) {
      expect(() => validateAutomationRequest(request({ action: 'observe', ...fields }))).toThrow()
    }
    expect(() => validateAutomationRequest(request({ action: 'observe', pid: 42, window: '1' }, 'browser'))).toThrow()
    expect(() => validateAutomationRequest(request({ action: 'click', target: { name: 'A', script: 'bad' } }))).toThrow()
  })
})
