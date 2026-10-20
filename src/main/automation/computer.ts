import { nativeImage, screen, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { WindowElement } from '@trycua/cua-driver'
import { AutomationError, type AutomationOperation, type AutomationResult, type AutomationStep, type AutomationTarget } from '../../shared/automation'
import { NativeInput, type InputPoint, type NativeWindowTarget } from './native-input'
import { runAutomationSequence } from './sequence'

export interface DesktopFrame { id: string; display: string; width: number; height: number; bounds: { x: number; y: number; width: number; height: number }; topology: string; capturedAt: number }
export function framePoint(frame: DesktopFrame, x: number, y: number): InputPoint {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new AutomationError('INVALID_COORDINATES', 'Coordinates are outside the observed display')
  return { x: frame.bounds.x + x * frame.bounds.width / frame.width, y: frame.bounds.y + y * frame.bounds.height / frame.height }
}
interface WindowFrame extends NativeWindowTarget {
  id: string
  topology: string
  capturedAt: number
  elements: Map<string, WindowElement>
}
const normalized = (value: string): string => value.trim().toLowerCase()
function sameValueControl(before: WindowElement, after: WindowElement): boolean {
  if (before.role !== after.role) return false
  if (before.label === after.label) return true
  // Windows uses the value as the label when a provider has no name. A value
  // write then changes both. Only accept that case at the same observed frame;
  // otherwise the post-write identity remains unknown and must be reobserved.
  return before.value !== undefined && before.label === before.value && after.label === after.value && !!before.frame && !!after.frame &&
    before.frame.x === after.frame.x && before.frame.y === after.frame.y && before.frame.w === after.frame.w && before.frame.h === after.frame.h
}
function uniqueElement(frame: WindowFrame, target: AutomationTarget): WindowElement {
  const matches = [...frame.elements.values()].filter(element => normalized(element.label ?? '') === normalized(target.name) && (!target.role || normalized(element.role) === normalized(target.role)))
  if (!matches.length) throw new AutomationError('TARGET_NOT_FOUND', 'No exact named control was found in the bounded window snapshot. Observe with a screenshot or use desktop coordinates if the control is not exposed by accessibility.')
  if (matches.length !== 1) throw new AutomationError('AMBIGUOUS_TARGET', 'More than one control matches this name and role. Observe again and choose its current ref; no input was sent.')
  const element = matches[0]
  if (!element) throw new AutomationError('TARGET_NOT_FOUND', 'The control is no longer available')
  return element
}
export class ComputerAutomation {
  private frames = new Map<string, DesktopFrame>()
  private windowFrames = new Map<string, WindowFrame>()
  private input = new NativeInput()
  permissions(): { supported: boolean; accessibility: boolean; screenCapture: boolean } {
    return {
      supported: ['darwin', 'win32'].includes(process.platform),
      accessibility: process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false),
      screenCapture: process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted'
    }
  }
  stop(): void {
    this.frames.clear()
    this.windowFrames.clear()
    // Service stop first aborts admitted calls. Shutdown removes the native
    // session/cursor; later work waits for teardown before creating a new one.
    void this.input.close().catch(error => console.warn('[automation] native driver shutdown failed', error))
  }
  async close(): Promise<void> { this.frames.clear(); this.windowFrames.clear(); await this.input.close() }
  private topology(): string { return JSON.stringify(screen.getAllDisplays().map(({ id, bounds, scaleFactor, rotation }) => ({ id, bounds, scaleFactor, rotation }))) }
  private prune(): void {
    for (const collection of [this.frames, this.windowFrames]) for (const [owner, frame] of collection) if (Date.now() - frame.capturedAt > 90_000) collection.delete(owner)
  }
  private capacity(owner: string): void {
    this.prune()
    if (!this.frames.has(owner) && !this.windowFrames.has(owner) && this.frames.size + this.windowFrames.size >= 128) throw new AutomationError('BUSY', 'Too many desktop observations; stop automation to clear them')
  }
  private async observeWindow(owner: string, target: NativeWindowTarget, screenshot: boolean, signal: AbortSignal): Promise<AutomationResult> {
    this.capacity(owner)
    const topology = this.topology()
    const capture = await this.input.observeWindow(target, screenshot, signal)
    signal.throwIfAborted()
    if (capture.pid !== target.pid || capture.windowId.toString() !== target.window) throw new AutomationError('WINDOW_MISMATCH', 'The native observation does not match the requested process and window')
    if (topology !== this.topology()) throw new AutomationError('STALE_SNAPSHOT', 'Display configuration changed during observation; observe again')
    const frame: WindowFrame = { ...target, id: randomUUID(), topology, capturedAt: Date.now(), elements: new Map() }
    const elements = (capture.elements ?? []).slice(0, 250).map(element => {
      // Native tokens stay in the trusted main process. Model-facing refs are
      // valid only with this owner's current host snapshot and exact window.
      const ref = element.elementToken ? randomUUID() : undefined
      if (ref) frame.elements.set(ref, element)
      return {
        ...(ref ? { ref } : {}), name: (element.label ?? '').slice(0, 500), role: element.role,
        value: element.value?.slice(0, 2000), ...(element.value && element.value.length > 2000 ? { value_truncated: true } : {}),
        enabled: element.enabled, selected: element.selected, actions: element.actions ?? [],
        depth: element.depth, frame: element.frame
      }
    })
    this.frames.delete(owner)
    this.windowFrames.set(owner, frame)
    const png = screenshot ? capture.images.find(image => image.mimeType === 'image/png') : undefined
    const coordinates = png && capture.screenshotWidth && capture.screenshotHeight ? { width: capture.screenshotWidth, height: capture.screenshotHeight } : undefined
    return {
      snapshot: frame.id, pid: target.pid, window: target.window, observationScope: 'window',
      app: capture.appName, title: capture.windowTitle, elements,
      truncated: capture.truncated ?? false, complete: capture.elementsComplete ?? false,
      degraded: capture.degraded ?? false, degraded_reason: capture.degradedReason,
      ...(screenshot && !coordinates ? { screenshot_unavailable: true } : {}),
      ...(png && coordinates ? { coordinates, image: { png: png.dataBase64, ...coordinates }, next: 'Window screenshot coordinates are visual evidence. Use current refs here; observe the desktop before coordinate input.' } : {})
    }
  }
  private currentWindow(owner: string, op: AutomationOperation): WindowFrame {
    const frame = this.windowFrames.get(owner)
    if (!frame || op.snapshot !== frame.id || (op.pid !== undefined && op.pid !== frame.pid) || (op.window !== undefined && op.window !== frame.window) || op.display !== undefined || Date.now() - frame.capturedAt > 90_000 || frame.topology !== this.topology()) throw new AutomationError('STALE_SNAPSHOT', 'Observe the exact window again before sending input')
    return frame
  }
  private resolve(frame: WindowFrame, op: AutomationOperation): WindowElement {
    if (op.ref && op.target) throw new AutomationError('INVALID_INPUT', 'Choose one current ref or a unique name and role')
    const element = op.ref ? frame.elements.get(op.ref) : op.target ? uniqueElement(frame, op.target) : undefined
    if (!element?.elementToken) throw new AutomationError('TARGET_NOT_FOUND', 'Window input requires a current control ref or a unique name and role')
    if (element.enabled === false) throw new AutomationError('TARGET_DISABLED', 'The target control is disabled; no input was sent')
    return element
  }
  private async windowInput(owner: string, op: AutomationOperation, signal: AbortSignal): Promise<AutomationResult> {
    const frame = this.currentWindow(owner, op)
    const element = this.resolve(frame, op)
    const target = { pid: frame.pid, window: frame.window, token: element.elementToken ?? '' }
    const actions = element.actions ?? []
    if (op.action === 'click' && !actions.some(action => ['invoke', 'toggle', 'select', 'expand', 'press'].includes(action))) throw new AutomationError('UNSUPPORTED_CONTROL', 'This control exposes no semantic click action. Observe the desktop for coordinate input.')
    if (op.action === 'type' && (!actions.includes('set_value') || element.inWebContent)) throw new AutomationError('UNSUPPORTED_CONTROL', 'This control does not expose a trusted writable value. Observe the desktop and use foreground text input instead.')
    if (op.action === 'scroll' && !actions.includes('scroll')) throw new AutomationError('UNSUPPORTED_CONTROL', 'This control exposes no scroll action. Choose a scroll container or use desktop coordinates.')
    if (!['click', 'type', 'key', 'scroll'].includes(op.action)) throw new AutomationError('UNSUPPORTED_CONTROL', 'Use desktop observation for this input action')
    // Consume before dispatch. Even a failed/uncertain action cannot replay a
    // token against a UI that may already have changed.
    this.windowFrames.delete(owner)
    signal.throwIfAborted()
    if (op.action === 'click') await this.input.elementClick(target, op.button, op.clicks, signal)
    else if (op.action === 'type' && op.text !== undefined) await this.input.elementText(target, op.text, op.replace === true, signal)
    else if (op.action === 'key' && op.key !== undefined) await this.input.elementKey(target, op.key, signal)
    else if (op.action === 'scroll') await this.input.elementScroll(target, op.deltaX ?? 0, op.deltaY ?? 500, signal)
    else throw new AutomationError('INVALID_INPUT', 'Incomplete window operation')
    let observation = await this.observeWindow(owner, frame, op.screenshot === true, signal)
    if (op.action === 'type') {
      const expected = op.replace ? op.text : `${element.value ?? ''}${op.text ?? ''}`
      const deadline = performance.now() + 1000
      for (;;) {
        const current = this.windowFrames.get(owner)
        const matches = current ? [...current.elements.values()].filter(candidate => sameValueControl(element, candidate)) : []
        if (expected !== undefined && matches.length === 1 && matches[0]?.value === expected) break
        if (performance.now() >= deadline || matches.length > 1) {
          this.windowFrames.delete(owner)
          throw new AutomationError('INPUT_UNCONFIRMED', 'The text write could not be verified by a fresh unique control value. Observe and check the result; do not replay the input automatically.')
        }
        await delay(80, undefined, { signal })
        observation = await this.observeWindow(owner, frame, op.screenshot === true, signal)
      }
    }
    return { ...observation, inputSent: op.action, ...(op.action === 'type' ? { verified: true } : { verification: 'Fresh accessibility observation returned; verify the intended change.' }) }
  }
  private async sequenceStep(owner: string, target: NativeWindowTarget, step: AutomationStep, signal: AbortSignal): Promise<AutomationResult> {
    const deadline = performance.now() + 2500
    for (;;) {
      const observation = await this.observeWindow(owner, target, false, signal)
      const frame = this.windowFrames.get(owner)
      if (!frame || !step.target) throw new AutomationError('INVALID_INPUT', 'Every window plan step requires a unique semantic target')
      if (step.action !== 'wait') return this.windowInput(owner, { ...step, snapshot: frame.id, pid: frame.pid, window: frame.window }, signal)
      try {
        const element = uniqueElement(frame, step.target)
        if (step.value === undefined || element.value === step.value) return observation
      } catch (error) {
        if (!(error instanceof AutomationError) || error.code !== 'TARGET_NOT_FOUND') throw error
      }
      if (performance.now() >= deadline) throw new AutomationError('VERIFY_TIMEOUT', 'The expected control or exact value did not appear in the bounded wait')
      await delay(100, undefined, { signal })
    }
  }
  async execute(owner: string, op: AutomationOperation, signal: AbortSignal): Promise<AutomationResult> {
    signal.throwIfAborted()
    const permissions = this.permissions()
    if (op.action === 'status') return permissions
    if (!permissions.supported || !permissions.accessibility || !permissions.screenCapture) throw new AutomationError('PERMISSION_REQUIRED', 'Open Settings > Plugins > Computer Use and grant screen recording and accessibility access, then retry. Restart the app if macOS requires it.')
    if (op.action === 'windows') {
      const result = await this.input.windows(op.pid, signal)
      signal.throwIfAborted()
      return { windows: result.windows.slice(0, 200).map(window => ({ pid: window.pid, window: window.windowId.toString(), app: window.appName, title: window.title, bounds: window.bounds, on_screen: window.isOnScreen, minimized: window.minimized })), truncated: result.windows.length > 200, next: 'Observe one exact pid/window. Window identifiers are strings; no foreground window is guessed.' }
    }
    if (op.action === 'observe' && (op.pid !== undefined || op.window !== undefined)) {
      if (op.pid === undefined || !op.window) throw new AutomationError('INVALID_INPUT', 'Window observation requires both pid and window')
      return this.observeWindow(owner, { pid: op.pid, window: op.window }, op.screenshot === true, signal)
    }
    if (op.action === 'run') {
      const frame = this.currentWindow(owner, op)
      if (!op.steps) throw new AutomationError('INVALID_INPUT', 'A local plan requires steps')
      let result: AutomationResult
      try { result = await runAutomationSequence(op.steps, signal, (step, stepSignal) => this.sequenceStep(owner, frame, step, stepSignal)) }
      catch (error) { this.windowFrames.delete(owner); throw error }
      if (result.observation_required) { this.windowFrames.delete(owner); return result }
      if (op.screenshot) return { ...await this.observeWindow(owner, frame, true, signal), sequence: result.sequence }
      return result
    }
    if (op.action !== 'observe' && this.windowFrames.has(owner)) return this.windowInput(owner, op, signal)
    if (op.action === 'observe') {
      this.capacity(owner)
      const display = screen.getPrimaryDisplay()
      const topology = this.topology()
      if (op.display && op.display !== String(display.id) && op.display !== 'primary') throw new AutomationError('UNSUPPORTED_DISPLAY', 'This native driver supports the primary display. Move the target window to the primary display and observe again.')
      const capture = await this.input.observe(signal)
      signal.throwIfAborted()
      if (topology !== this.topology()) throw new AutomationError('STALE_SNAPSHOT', 'Display configuration changed during capture; observe again')
      const png = capture.images.find(image => image.mimeType === 'image/png')
      if (!png) throw new AutomationError('CAPTURE_FAILED', 'The native driver returned no desktop screenshot; verify system permission')
      const original = nativeImage.createFromBuffer(Buffer.from(png.dataBase64, 'base64'))
      if (original.isEmpty()) throw new AutomationError('CAPTURE_FAILED', 'The native desktop screenshot could not be decoded')
      const nativeSize = original.getSize()
      const thumbnail = nativeSize.width > nativeSize.height ? original.resize({ width: Math.min(nativeSize.width, 1280) }) : original.resize({ height: Math.min(nativeSize.height, 1280) })
      const size = thumbnail.getSize()
      // Cua's desktop input uses the pixels of its native capture, including
      // Retina/Windows DPI scaling. Never derive these from Electron DIP.
      const frame: DesktopFrame = { id: randomUUID(), display: String(display.id), width: size.width, height: size.height, bounds: { x: 0, y: 0, ...nativeSize }, topology, capturedAt: Date.now() }
      this.windowFrames.delete(owner)
      this.frames.set(owner, frame)
      return { snapshot: frame.id, display: frame.display, coordinates: size, nativeCoordinates: nativeSize, displayScope: 'primary', displays: [{ id: String(display.id), bounds: display.bounds, scaleFactor: display.scaleFactor }], image: { png: thumbnail.toPNG().toString('base64'), ...size } }
    }
    const frame = this.frames.get(owner)
    if (!frame || frame.id !== op.snapshot || frame.display !== op.display || frame.topology !== this.topology() || Date.now() - frame.capturedAt > 90_000) throw new AutomationError('STALE_SNAPSHOT', 'Observe the desktop again before sending input')
    // One snapshot authorizes one input; even a failed operation cannot silently
    // reuse coordinates after the desktop may have changed.
    this.frames.delete(owner)
    const point = (x: number, y: number): InputPoint => framePoint(frame, x, y)
    signal.throwIfAborted()
    if (op.action === 'click' && op.x !== undefined && op.y !== undefined) await this.input.click(point(op.x, op.y), op.button, op.clicks, signal)
    else if (op.action === 'type' && op.text !== undefined) await this.input.text(op.text, signal)
    else if (op.action === 'key' && op.key !== undefined) await this.input.key(op.key, signal)
    else if (op.action === 'scroll' && op.x !== undefined && op.y !== undefined) await this.input.scroll(point(op.x, op.y), op.deltaX ?? 0, op.deltaY ?? 500, signal)
    else if (op.action === 'drag' && op.x !== undefined && op.y !== undefined && op.toX !== undefined && op.toY !== undefined) await this.input.drag(point(op.x, op.y), point(op.toX, op.toY), signal)
    else throw new AutomationError('INVALID_INPUT', 'Incomplete computer operation')
    // Input delivery is asynchronous. This bounded, cancellable settle lets the
    // next screenshot see modifier/edit changes without blocking Electron.
    await delay(150, undefined, { signal })
    return { ...await this.execute(owner, { action: 'observe' }, signal), inputSent: op.action }
  }
}
