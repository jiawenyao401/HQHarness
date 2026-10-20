export type AutomationCapability = 'browser' | 'computer'
export const MAX_AUTOMATION_REQUEST_BYTES = 65_536
export interface AutomationTarget { name: string; role?: string }
export interface AutomationStep {
  action: 'click' | 'type' | 'key' | 'scroll' | 'wait'
  target?: AutomationTarget
  text?: string
  key?: string
  deltaX?: number
  deltaY?: number
  replace?: boolean
  value?: string
}
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
  pid?: number
  window?: string
  target?: AutomationTarget
  replace?: boolean
  steps?: AutomationStep[]
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
  browser: ['status', 'tabs', 'open', 'observe', 'navigate', 'back', 'forward', 'click', 'type', 'key', 'scroll', 'close', 'run'],
  computer: ['status', 'windows', 'observe', 'click', 'type', 'key', 'scroll', 'drag', 'run']
}
const FIELDS = new Set(['action', 'screenshot', 'tab', 'url', 'snapshot', 'ref', 'display', 'x', 'y', 'toX', 'toY', 'text', 'key', 'button', 'clicks', 'deltaX', 'deltaY', 'pid', 'window', 'target', 'replace', 'steps'])
const STEP_FIELDS = new Set(['action', 'target', 'text', 'key', 'deltaX', 'deltaY', 'replace', 'value'])
function automationTarget(value: unknown): AutomationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationError('INVALID_INPUT', 'Expected a semantic target')
  const target = value as Record<string, unknown>
  if (Object.keys(target).some(key => !['name', 'role'].includes(key)) || typeof target.name !== 'string' || !target.name.trim() || target.name.length > 300 || (target.role !== undefined && (typeof target.role !== 'string' || !target.role.trim() || target.role.length > 80))) throw new AutomationError('INVALID_INPUT', 'Invalid semantic target name or role')
  return { name: target.name, ...(typeof target.role === 'string' ? { role: target.role } : {}) }
}
function automationStep(value: unknown, capability: AutomationCapability): AutomationStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationError('INVALID_INPUT', 'Expected a plan step')
  const step = value as Record<string, unknown>
  if (Object.keys(step).some(key => !STEP_FIELDS.has(key)) || !['click', 'type', 'key', 'scroll', 'wait'].includes(String(step.action))) throw new AutomationError('INVALID_INPUT', 'Unsupported plan step')
  for (const key of ['text', 'key', 'value']) if (step[key] !== undefined && (typeof step[key] !== 'string' || step[key].length > 2000)) throw new AutomationError('INVALID_INPUT', `Invalid step ${key}`)
  for (const key of ['deltaX', 'deltaY']) if (step[key] !== undefined && (typeof step[key] !== 'number' || !Number.isFinite(step[key]) || Math.abs(step[key]) > 100_000)) throw new AutomationError('INVALID_INPUT', `Invalid step ${key}`)
  if (step.replace !== undefined && typeof step.replace !== 'boolean') throw new AutomationError('INVALID_INPUT', 'Invalid replacement preference')
  for (const [key, action] of [['text', 'type'], ['replace', 'type'], ['key', 'key'], ['value', 'wait'], ['deltaX', 'scroll'], ['deltaY', 'scroll']]) {
    if (key && step[key] !== undefined && step.action !== action) throw new AutomationError('INVALID_INPUT', `Step ${key} does not apply to this action`)
  }
  const target = step.target === undefined ? undefined : automationTarget(step.target)
  if ((step.action !== 'key' || capability === 'computer') && !target) throw new AutomationError('INVALID_INPUT', 'This step requires a unique semantic target')
  if (step.action === 'type' && typeof step.text !== 'string') throw new AutomationError('INVALID_INPUT', 'Missing step text')
  if (step.action === 'key' && (typeof step.key !== 'string' || !step.key.trim())) throw new AutomationError('INVALID_INPUT', 'Missing step key')
  // The action whitelist above narrows the external string at this boundary.
  return { ...step, action: step.action as AutomationStep['action'], ...(target ? { target } : {}) }
}
export function validateAutomationRequest(value: unknown): AutomationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationError('INVALID_INPUT', 'Expected an operation object')
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(key => !['capability', 'owner', 'operation'].includes(key))) throw new AutomationError('INVALID_INPUT', 'Unknown request field')
  if (r.capability !== 'browser' && r.capability !== 'computer') throw new AutomationError('INVALID_INPUT', 'Unknown capability')
  const capability = r.capability
  if (typeof r.owner !== 'string' || !r.owner.trim() || r.owner.length > 160 || /[\x00-\x1f]/u.test(r.owner)) throw new AutomationError('INVALID_INPUT', 'An owning session is required')
  if (!r.operation || typeof r.operation !== 'object' || Array.isArray(r.operation)) throw new AutomationError('INVALID_INPUT', 'Missing operation')
  const op = r.operation as Record<string, unknown>
  if (op.screenshot !== undefined && typeof op.screenshot !== 'boolean') throw new AutomationError('INVALID_INPUT', 'Invalid screenshot preference')
  if (op.replace !== undefined && typeof op.replace !== 'boolean') throw new AutomationError('INVALID_INPUT', 'Invalid replacement preference')
  if (Object.keys(op).some(key => !FIELDS.has(key)) || typeof op.action !== 'string' || !ACTIONS[r.capability].includes(op.action)) throw new AutomationError('INVALID_INPUT', 'Unsupported operation')
  for (const key of ['tab', 'url', 'snapshot', 'ref', 'display', 'text', 'key']) {
    if (op[key] !== undefined && (typeof op[key] !== 'string' || op[key].length > (key === 'text' ? 2000 : 2048))) throw new AutomationError('INVALID_INPUT', `Invalid ${key}`)
  }
  for (const key of ['x', 'y', 'toX', 'toY', 'deltaX', 'deltaY', 'clicks']) {
    if (op[key] !== undefined && (typeof op[key] !== 'number' || !Number.isFinite(op[key]) || Math.abs(op[key]) > 100_000)) throw new AutomationError('INVALID_INPUT', `Invalid ${key}`)
  }
  if (op.button !== undefined && !['left', 'right'].includes(String(op.button))) throw new AutomationError('INVALID_INPUT', 'Invalid mouse button')
  if (op.clicks !== undefined && op.clicks !== 1 && op.clicks !== 2) throw new AutomationError('INVALID_INPUT', 'Click count must be 1 or 2')
  if (op.pid !== undefined && (!Number.isSafeInteger(op.pid) || typeof op.pid !== 'number' || op.pid < 1 || op.pid > 0xffff_ffff)) throw new AutomationError('INVALID_INPUT', 'Invalid process id')
  if (op.window !== undefined && (typeof op.window !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(op.window) || BigInt(op.window) > 0xffff_ffff_ffff_ffffn)) throw new AutomationError('INVALID_INPUT', 'Invalid native window id')
  // Window discovery accepts an optional process filter; observing or operating
  // a native window always binds both ids to the same exact target.
  const processFilter = capability === 'computer' && op.action === 'windows' && op.window === undefined
  if ((op.pid !== undefined || op.window !== undefined) && !processFilter && (capability !== 'computer' || op.pid === undefined || op.window === undefined)) throw new AutomationError('INVALID_INPUT', 'Native window targets require both process and window ids')
  const target = op.target === undefined ? undefined : automationTarget(op.target)
  if (target && op.ref) throw new AutomationError('INVALID_INPUT', 'Choose a semantic target or a current ref')
  if ((target || op.ref) && (op.x !== undefined || op.y !== undefined)) throw new AutomationError('INVALID_INPUT', 'Do not mix semantic targets and coordinates')
  let steps: AutomationStep[] | undefined
  if (op.action === 'run') {
    if (typeof op.snapshot !== 'string' || !op.snapshot || !Array.isArray(op.steps) || op.steps.length < 1 || op.steps.length > 8) throw new AutomationError('INVALID_INPUT', 'A plan requires a current snapshot and 1 to 8 steps')
    steps = op.steps.map(step => automationStep(step, capability))
  } else if (op.steps !== undefined) throw new AutomationError('INVALID_INPUT', 'Steps are only valid for run')
  if (['navigate', 'open'].includes(op.action)) automationUrl(op.url)
  if (['type', 'key'].includes(op.action) && (typeof op[op.action === 'type' ? 'text' : 'key'] !== 'string')) throw new AutomationError('INVALID_INPUT', 'Missing text or key')
  if (['click', 'scroll', 'drag'].includes(op.action) && !op.ref && !target && (typeof op.x !== 'number' || typeof op.y !== 'number')) throw new AutomationError('INVALID_INPUT', 'Coordinates or a current semantic target are required')
  if (op.action === 'drag' && (typeof op.toX !== 'number' || typeof op.toY !== 'number')) throw new AutomationError('INVALID_INPUT', 'Drag destination is required')
  return { capability: r.capability, owner: r.owner, operation: Object.assign({ action: op.action }, op, target ? { target } : {}, steps ? { steps } : {}) }
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
