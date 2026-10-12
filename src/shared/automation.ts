export type AutomationCapability = 'browser' | 'computer'
export interface AutomationOperation {
  action: string
  screenshot?: boolean
  tab?: string
  url?: string
  snapshot?: string
  ref?: string
  display?: string
  x?: number
  y?: number
  toX?: number
  toY?: number
  text?: string
  key?: string
  button?: 'left' | 'right'
  clicks?: number
  deltaX?: number
  deltaY?: number
}
export interface AutomationRequest {
  capability: AutomationCapability
  owner: string
  operation: AutomationOperation
}
export class AutomationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AutomationError'
  }
}
const ACTIONS = {
  browser: ['status', 'tabs', 'open', 'observe', 'navigate', 'back', 'forward', 'click', 'type', 'key', 'scroll', 'close'],
  computer: ['status', 'observe', 'click', 'type', 'key', 'scroll', 'drag']
}
const FIELDS = new Set(['action', 'screenshot', 'tab', 'url', 'snapshot', 'ref', 'display', 'x', 'y', 'toX', 'toY', 'text', 'key', 'button', 'clicks', 'deltaX', 'deltaY'])
export function validateAutomationRequest(value: unknown): AutomationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationError('INVALID_INPUT', 'Expected an operation object')
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(key => !['capability', 'owner', 'operation'].includes(key))) throw new AutomationError('INVALID_INPUT', 'Unknown request field')
  if (r.capability !== 'browser' && r.capability !== 'computer') throw new AutomationError('INVALID_INPUT', 'Unknown capability')
  if (typeof r.owner !== 'string' || !r.owner.trim() || r.owner.length > 160 || /[\x00-\x1f]/u.test(r.owner)) throw new AutomationError('INVALID_INPUT', 'An owning session is required')
  if (!r.operation || typeof r.operation !== 'object' || Array.isArray(r.operation)) throw new AutomationError('INVALID_INPUT', 'Missing operation')
  const op = r.operation as Record<string, unknown>
  if (op.screenshot !== undefined && typeof op.screenshot !== 'boolean') throw new AutomationError('INVALID_INPUT', 'Invalid screenshot preference')
  if (Object.keys(op).some(key => !FIELDS.has(key)) || typeof op.action !== 'string' || !ACTIONS[r.capability].includes(op.action)) throw new AutomationError('INVALID_INPUT', 'Unsupported operation')
  for (const key of ['tab', 'url', 'snapshot', 'ref', 'display', 'text', 'key']) {
    if (op[key] !== undefined && (typeof op[key] !== 'string' || op[key].length > (key === 'text' ? 2000 : 2048))) throw new AutomationError('INVALID_INPUT', `Invalid ${key}`)
  }
  for (const key of ['x', 'y', 'toX', 'toY', 'deltaX', 'deltaY', 'clicks']) {
    if (op[key] !== undefined && (typeof op[key] !== 'number' || !Number.isFinite(op[key]) || Math.abs(op[key]) > 100_000)) throw new AutomationError('INVALID_INPUT', `Invalid ${key}`)
  }
  if (op.button !== undefined && !['left', 'right'].includes(String(op.button))) throw new AutomationError('INVALID_INPUT', 'Invalid mouse button')
  if (op.clicks !== undefined && op.clicks !== 1 && op.clicks !== 2) throw new AutomationError('INVALID_INPUT', 'Click count must be 1 or 2')
  if (['navigate', 'open'].includes(op.action)) automationUrl(op.url)
  if (['type', 'key'].includes(op.action) && (typeof op[op.action === 'type' ? 'text' : 'key'] !== 'string')) throw new AutomationError('INVALID_INPUT', 'Missing text or key')
  if (['click', 'scroll', 'drag'].includes(op.action) && (!op.ref || r.capability === 'computer') && (typeof op.x !== 'number' || typeof op.y !== 'number')) throw new AutomationError('INVALID_INPUT', 'Coordinates are required')
  if (op.action === 'drag' && (typeof op.toX !== 'number' || typeof op.toY !== 'number')) throw new AutomationError('INVALID_INPUT', 'Drag destination is required')
  return { capability: r.capability, owner: r.owner, operation: Object.assign({ action: op.action }, op) }
}
export function automationUrl(value: unknown): string {
  if (typeof value !== 'string') throw new AutomationError('INVALID_URL', 'An HTTP or HTTPS URL is required')
  let url: URL
  try { url = new URL(value) } catch { throw new AutomationError('INVALID_URL', 'Invalid URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AutomationError('INVALID_URL', 'Only HTTP and HTTPS URLs without embedded credentials are allowed')
  return url.href
}
export interface AutomationImage { png: string; width: number; height: number }
export interface AutomationResult { [key: string]: unknown; image?: AutomationImage }
export interface AutomationStatus {
  supported: boolean
  accessibility: boolean
  screenCapture: boolean
  activeSessions: number
  shortcut: boolean
}
