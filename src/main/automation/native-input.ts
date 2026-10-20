import type { CuaDriverLike, ToolResult } from '@trycua/cua-driver'
import { AutomationError } from '../../shared/automation'

export interface InputPoint { x: number; y: number }
const MAC_KEYS: Record<string, number> = { A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29, O: 31, U: 32, I: 34, P: 35, ENTER: 36, L: 37, J: 38, K: 40, N: 45, M: 46, TAB: 48, SPACE: 49, BACKSPACE: 51, ESCAPE: 53, DELETE: 117, HOME: 115, END: 119, PAGEUP: 116, PAGEDOWN: 121, LEFT: 123, RIGHT: 124, DOWN: 125, UP: 126 }
const WIN_KEYS: Record<string, number> = { ENTER: 13, TAB: 9, SPACE: 32, BACKSPACE: 8, ESCAPE: 27, DELETE: 46, HOME: 36, END: 35, PAGEUP: 33, PAGEDOWN: 34, LEFT: 37, RIGHT: 39, UP: 38, DOWN: 40 }
export function parseAutomationKey(value: string, platform = process.platform): { key: string; modifiers: string[]; code: number } {
  const parts = value.toUpperCase().split('+')
  const key = parts.pop() ?? ''
  const modifiers = parts.map(item => item === 'MOD' ? platform === 'darwin' ? 'CMD' : 'CTRL' : item)
  if (modifiers.some(item => !['CMD', 'CTRL', 'ALT', 'SHIFT'].includes(item)) || new Set(modifiers).size !== modifiers.length || (platform === 'win32' && modifiers.includes('CMD'))) throw new AutomationError('INVALID_KEY', 'Use MOD, CTRL, ALT or SHIFT with a supported key')
  const code = platform === 'darwin' ? MAC_KEYS[key] : WIN_KEYS[key] ?? (/^[A-Z0-9]$/u.test(key) ? key.charCodeAt(0) : undefined)
  if (code === undefined) throw new AutomationError('INVALID_KEY', 'Unsupported key; use type for text')
  return { key, modifiers, code }
}

let sdk: Promise<typeof import('@trycua/cua-driver')> | undefined
async function loadSdk(): Promise<typeof import('@trycua/cua-driver')> {
  // Keep the generated native binding outside the main bundle. Loading it
  // lazily also leaves recovery and Browser Use available if native init fails.
  sdk ??= import('@trycua/cua-driver').then(async module => { await module.uniffiInitAsync(); return module }).catch(error => { sdk = undefined; throw error })
  return sdk
}

/** The host owns admission/consent; Cua owns platform input and capture.
 * Generic calls are restricted here to fixed names and validated arguments. */
export class NativeInput {
  private pending?: Promise<CuaDriverLike>
  private closing: Promise<void> = Promise.resolve()
  private async runtime(signal: AbortSignal): Promise<CuaDriverLike> {
    await this.closing
    signal.throwIfAborted()
    const pending = this.pending ??= loadSdk().then(module => module.CuaDriver.create(undefined)).catch(error => {
      this.pending = undefined
      // Init errors describe package/native loading, never operation payloads.
      console.error('[automation] Cua Driver native initialization failed', error)
      throw new AutomationError('NATIVE_DRIVER_UNAVAILABLE', `Cua Driver could not initialize for ${process.platform}/${process.arch}`, { cause: error })
    })
    const driver = await pending
    signal.throwIfAborted()
    return driver
  }
  async close(): Promise<void> {
    const pending = this.pending
    this.pending = undefined
    const previous = this.closing
    const task = (async () => {
      await previous
      if (!pending) return
      const driver = await pending
      try { await driver.shutdown() } finally {
        // The generated factory exposes the interface type; only the native
        // binding object has this optional handle-release method.
        if ('uniffiDestroy' in driver && typeof driver.uniffiDestroy === 'function') driver.uniffiDestroy()
      }
    })()
    // Keep concurrent teardown ordered. A failed teardown stays visible to
    // its caller without poisoning later initialization attempts.
    this.closing = task.catch(() => undefined)
    await task
  }
  private async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const driver = await this.runtime(signal)
    signal.throwIfAborted()
    let result: ToolResult
    try {
      const { StartSessionInput } = await loadSdk()
      // Cua reuses an implicit transport session, but does not revive it after
      // five idle minutes. The host's session-scoped consent remains the gate;
      // explicitly attach/revive before each call instead of caching an ended
      // session until the entire application is restarted.
      const session = await driver.startSession(StartSessionInput.new({}), { signal })
      signal.throwIfAborted()
      if (!session.active) throw new AutomationError('NATIVE_SESSION_UNAVAILABLE', 'The native desktop session could not start. Observe again to retry.')
      if (session.revived && name !== 'get_desktop_state' && name !== 'get_screen_size') throw new AutomationError('STALE_SNAPSHOT', 'The native desktop session was reopened. Observe again before sending input; the previous action was not replayed.')
      result = await driver.callTool(name, JSON.stringify(args), { signal })
    }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof AutomationError) throw error
      throw new AutomationError('NATIVE_OPERATION_FAILED', `Cua Driver ${name} failed. Verify system permissions and observe again before retrying.`, { cause: error })
    }
    signal.throwIfAborted()
    const { ActionEffect } = await loadSdk()
    if (result.isError || result.action?.effect === ActionEffect.Refused) throw new AutomationError(result.errorCode ?? 'INPUT_REFUSED', result.text || `Cua Driver refused ${name}`)
    if (result.action?.effect === ActionEffect.Partial || result.action?.effect === ActionEffect.SuspectedNoop) throw new AutomationError('INPUT_UNCONFIRMED', 'Native input may have been partial or ineffective. Observe again and verify the target before continuing.')
    return result
  }
  async observe(signal: AbortSignal): Promise<ToolResult> { return this.call('get_desktop_state', {}, signal) }
  private target(): Record<string, unknown> { return { target: { kind: 'desktop', display_id: 'primary' }, delivery_mode: 'foreground' } }
  async click(point: InputPoint, button: 'left' | 'right' = 'left', count = 1, signal: AbortSignal): Promise<void> {
    await this.call('click', { ...this.target(), ...point, button, count }, signal)
  }
  async text(text: string, signal: AbortSignal): Promise<void> { await this.call('type_text', { ...this.target(), text }, signal) }
  async key(value: string, signal: AbortSignal): Promise<void> {
    const { key, modifiers } = parseAutomationKey(value)
    await this.call(modifiers.length ? 'hotkey' : 'press_key', { ...this.target(), ...(modifiers.length ? { keys: [...modifiers, key] } : { key }) }, signal)
  }
  async scroll(point: InputPoint, dx: number, dy: number, signal: AbortSignal): Promise<void> {
    for (const [direction, delta] of [[dx > 0 ? 'right' : 'left', dx], [dy > 0 ? 'down' : 'up', dy]] as const) {
      if (delta) await this.call('scroll', { ...this.target(), ...point, direction, amount: Math.min(50, Math.max(1, Math.round(Math.abs(delta) / 100))), by: 'line' }, signal)
    }
  }
  async drag(from: InputPoint, to: InputPoint, signal: AbortSignal): Promise<void> {
    await this.call('drag', { ...this.target(), from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, duration_ms: 350 }, signal)
  }
}
