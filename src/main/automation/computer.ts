import { nativeImage, screen, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { AutomationError, type AutomationOperation, type AutomationResult } from '../../shared/automation'
import { NativeInput, type InputPoint } from './native-input'

export interface DesktopFrame { id: string; display: string; width: number; height: number; bounds: { x: number; y: number; width: number; height: number }; topology: string; capturedAt: number }
export function framePoint(frame: DesktopFrame, x: number, y: number): InputPoint {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new AutomationError('INVALID_COORDINATES', 'Coordinates are outside the observed display')
  return { x: frame.bounds.x + x * frame.bounds.width / frame.width, y: frame.bounds.y + y * frame.bounds.height / frame.height }
}
export class ComputerAutomation {
  private frames = new Map<string, DesktopFrame>()
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
    // Service stop first aborts admitted calls. Shutdown removes the native
    // session/cursor; later work waits for teardown before creating a new one.
    void this.input.close().catch(error => console.warn('[automation] native driver shutdown failed', error))
  }
  async close(): Promise<void> { this.frames.clear(); await this.input.close() }
  private topology(): string { return JSON.stringify(screen.getAllDisplays().map(({ id, bounds, scaleFactor, rotation }) => ({ id, bounds, scaleFactor, rotation }))) }
  async execute(owner: string, op: AutomationOperation, signal: AbortSignal): Promise<AutomationResult> {
    signal.throwIfAborted()
    const permissions = this.permissions()
    if (op.action === 'status') return permissions
    if (!permissions.supported || !permissions.accessibility || !permissions.screenCapture) throw new AutomationError('PERMISSION_REQUIRED', 'Open Settings > Plugins > Computer Use and grant screen recording and accessibility access, then retry. Restart the app if macOS requires it.')
    if (op.action === 'observe') {
      for (const [id, frame] of this.frames) if (Date.now() - frame.capturedAt > 90_000) this.frames.delete(id)
      if (!this.frames.has(owner) && this.frames.size >= 128) throw new AutomationError('BUSY', 'Too many desktop observations; stop automation to clear them')
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
    return { inputSent: op.action, next: 'Observe again to verify the result before taking another action' }
  }
}
