import type { CuaDriverLike, ListWindowsOutput, ToolResult, WindowStateOutput } from '@trycua/cua-driver'
import { AutomationError } from '../../shared/automation'

export interface InputPoint { x: number; y: number }
export interface NativeWindowTarget { pid: number; window: string }
export interface NativeElementTarget extends NativeWindowTarget { token: string }
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
  private async ready(readOnly: boolean, signal: AbortSignal): Promise<CuaDriverLike> {
    const driver = await this.runtime(signal)
    signal.throwIfAborted()
    try {
      const { StartSessionInput } = await loadSdk()
      // Cua reuses an implicit transport session, but does not revive it after
      // five idle minutes. The host's session-scoped consent remains the gate;
      // explicitly attach/revive before each call instead of caching an ended
      // session until the entire application is restarted.
      const session = await driver.startSession(StartSessionInput.new({}), { signal })
      signal.throwIfAborted()
      if (!session.active) throw new AutomationError('NATIVE_SESSION_UNAVAILABLE', 'The native desktop session could not start. Observe again to retry.')
      if (session.revived && !readOnly) throw new AutomationError('STALE_SNAPSHOT', 'The native desktop session was reopened. Observe again before sending input; the previous action was not replayed.')
      return driver
    }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof AutomationError) throw error
      throw new AutomationError('NATIVE_OPERATION_FAILED', 'Cua Driver session attachment failed. Observe again before retrying.', { cause: error })
    }
  }
  private async invoke<T>(readOnly: boolean, name: string, signal: AbortSignal, perform: (driver: CuaDriverLike) => Promise<T>): Promise<T> {
    const driver = await this.ready(readOnly, signal)
    try {
      const result = await perform(driver)
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof AutomationError) throw error
      throw new AutomationError('NATIVE_OPERATION_FAILED', `Cua Driver ${name} failed. Verify the target and observe again before retrying.`, { cause: error })
    }
  }
  private async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const result = await this.invoke(name === 'get_desktop_state' || name === 'get_screen_size', name, signal, driver => driver.callTool(name, JSON.stringify(args), { signal }))
    signal.throwIfAborted()
    const { ActionEffect } = await loadSdk()
    if (result.isError || result.action?.effect === ActionEffect.Refused) throw new AutomationError(result.errorCode ?? 'INPUT_REFUSED', result.text || `Cua Driver refused ${name}`)
    if (result.action?.effect === ActionEffect.Partial || result.action?.effect === ActionEffect.SuspectedNoop) throw new AutomationError('INPUT_UNCONFIRMED', 'Native input may have been partial or ineffective. Observe again and verify the target before continuing.')
    return result
  }
  async windows(pid: number | undefined, signal: AbortSignal): Promise<ListWindowsOutput> {
    const { ListWindowsInput } = await loadSdk()
    return this.invoke(true, 'list_windows', signal, driver => driver.listWindows(ListWindowsInput.new({ pid, onScreenOnly: true }), { signal }))
  }
  async observeWindow(target: NativeWindowTarget, screenshot: boolean, signal: AbortSignal): Promise<WindowStateOutput> {
    if (!/^[1-9]\d{0,19}$/u.test(target.window) || BigInt(target.window) > 18_446_744_073_709_551_615n) throw new AutomationError('INVALID_WINDOW', 'Use an exact window identifier returned by windows')
    const { GetWindowStateInput } = await loadSdk()
    return this.invoke(true, 'get_window_state', signal, driver => driver.getWindowState(GetWindowStateInput.new({
      pid: target.pid, windowId: BigInt(target.window), includeAccessibilityTree: true,
      includeScreenshot: screenshot, maxElements: 250, maxDepth: 12, maxDimension: 1280
    }), { signal }))
  }
  // 0.28's typed key/text inputs omit element_token and delivery_mode. These
  // fixed generic calls preserve exact token targeting and explicit delivery;
  // the token carries the original HWND without converting bigint to number.
  private element(target: NativeElementTarget, delivery: 'foreground' | 'background' = 'foreground'): Record<string, unknown> {
    return { pid: target.pid, element_token: target.token, delivery_mode: delivery }
  }
  async elementClick(target: NativeElementTarget, button: 'left' | 'right' = 'left', count = 1, signal: AbortSignal): Promise<void> {
    // Windows foreground clicks bypass UIA and tap the cached screen center.
    // Prefer the exact token's UIA/PostMessage route instead: another window
    // owning foreground must not turn a semantic click into blind SendInput.
    // Refusal stays authoritative; never retry on a different delivery route.
    await this.call('click', { ...this.element(target, process.platform === 'win32' ? 'background' : 'foreground'), button, count }, signal)
  }
  async elementText(target: NativeElementTarget, text: string, replace: boolean, signal: AbortSignal): Promise<void> {
    if (!replace && process.platform === 'win32') {
      // 0.28's Windows foreground type_text inserts at the current selection.
      // Establish append semantics without rewriting the observed baseline;
      // both calls retain the exact token and native foreground checks.
      const positioned = await this.call('hotkey', { ...this.element(target), keys: ['CTRL', 'END'] }, signal)
      if (positioned.action?.escalation) throw new AutomationError('INPUT_UNCONFIRMED', 'The native provider could not position the append caret. No text was sent. Observe the window and verify it before retrying.')
    }
    // set_value is a separate 0.28 tool whose schema has no delivery_mode.
    const result = replace
      ? await this.call('set_value', { pid: target.pid, element_token: target.token, value: text }, signal)
      : await this.call('type_text', { ...this.element(target), text }, signal)
    // Cua 0.28 can normalize text delivery to Unverifiable. The host verifies
    // both replacement and append against a fresh unique control value before
    // reporting success; append additionally requires its observed baseline.
    // Explicit escalation remains authoritative, and no input is replayed here.
    if (result.action?.escalation) throw new AutomationError('INPUT_UNCONFIRMED', 'The native provider could not confirm the text write. Observe the window and verify it before retrying; input was not replayed.')
  }
  async elementKey(target: NativeElementTarget, value: string, signal: AbortSignal): Promise<void> {
    const { key, modifiers } = parseAutomationKey(value)
    await this.call(modifiers.length ? 'hotkey' : 'press_key', { ...this.element(target), ...(modifiers.length ? { keys: [...modifiers, key] } : { key }) }, signal)
  }
  async elementScroll(target: NativeElementTarget, dx: number, dy: number, signal: AbortSignal): Promise<void> {
    for (const [direction, delta] of [[dx > 0 ? 'right' : 'left', dx], [dy > 0 ? 'down' : 'up', dy]] as const) {
      if (delta) await this.call('scroll', { ...this.element(target), direction, amount: Math.min(50, Math.max(1, Math.round(Math.abs(delta) / 100))), by: 'line' }, signal)
    }
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
