export const TEAM_MODEL_PROVIDER = 'hqharness-team'
export const LEASE_MS = 3 * 60 * 60 * 1000
export const RENEW_WINDOW_MS = 10 * 60 * 1000

export interface TeamModel {
  id: string
  display_name: 'DeepSeek-V41-Flash'
  context_window: number
  max_output_tokens: number
  input_modalities: ('text' | 'image')[]
  tool_calls_verified: boolean
}
export interface ModelLease {
  id: string
  status: 'reserved' | 'active' | 'renewing' | 'revoking' | 'revoked' | 'failed' | 'expired'
  issued_at: string
  initial_expires_at: string
  expires_at: string
  auto_renewed: boolean
  server_time: string
  test_environment: boolean
  inference_path: '/desktop/model-access/v1'
  model: TeamModel
}
export interface ModelAccessConfiguration { baseUrl: string; allowInsecureTest: boolean }
export interface ModelAccessStatus {
  configured: boolean
  server: string
  insecureTest: boolean
  signedIn: boolean
  accountName?: string
  busy: boolean
  lease?: ModelLease
  usable: boolean
  remainingMs: number
  error?: string
  pendingRevocation: boolean
}
export interface ModelAccessResult { ok: boolean; status: ModelAccessStatus; error?: string }
export class ModelAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message)
    this.name = 'ModelAccessError'
  }
}
export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelAccessError('INVALID_RESPONSE', 'Invalid service response')
  return value as Record<string, unknown>
}
export function requiredText(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) throw new ModelAccessError('INVALID_RESPONSE', 'Invalid text field')
  return value
}
function timestamp(value: unknown): string {
  const text = requiredText(value, 40)
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) throw new ModelAccessError('INVALID_RESPONSE', 'Invalid service time')
  return text
}
export function validateModelLease(value: unknown): ModelLease {
  const row = objectValue(value)
  const model = objectValue(row.model)
  const issued = timestamp(row.issued_at), initial = timestamp(row.initial_expires_at), expiry = timestamp(row.expires_at)
  if (Date.parse(initial) - Date.parse(issued) !== LEASE_MS || Date.parse(expiry) - Date.parse(initial) !== (row.auto_renewed === true ? LEASE_MS : 0)) throw new ModelAccessError('INVALID_RESPONSE', 'The service returned an invalid lease duration')
  if (!['reserved', 'active', 'renewing', 'revoking', 'revoked', 'failed', 'expired'].includes(String(row.status)) || typeof row.auto_renewed !== 'boolean' || typeof row.test_environment !== 'boolean' || row.inference_path !== '/desktop/model-access/v1') throw new ModelAccessError('INVALID_RESPONSE', 'Invalid model lease')
  if (model.display_name !== 'DeepSeek-V41-Flash' || !Number.isSafeInteger(model.context_window) || Number(model.context_window) <= 0 || !Number.isSafeInteger(model.max_output_tokens) || Number(model.max_output_tokens) <= 0 || typeof model.tool_calls_verified !== 'boolean' || !Array.isArray(model.input_modalities) || !model.input_modalities.includes('text') || model.input_modalities.some(m => m !== 'text' && m !== 'image')) throw new ModelAccessError('INVALID_RESPONSE', 'Invalid team model capabilities')
  return {
    id: requiredText(row.id, 80), status: row.status as ModelLease['status'], issued_at: issued, initial_expires_at: initial,
    expires_at: expiry, auto_renewed: row.auto_renewed, server_time: timestamp(row.server_time),
    test_environment: row.test_environment, inference_path: row.inference_path,
    model: { id: requiredText(model.id, 160), display_name: model.display_name, context_window: Number(model.context_window), max_output_tokens: Number(model.max_output_tokens), input_modalities: [...model.input_modalities] as TeamModel['input_modalities'], tool_calls_verified: model.tool_calls_verified }
  }
}
export function validateModelAccessConfiguration(value: unknown): ModelAccessConfiguration {
  const config = objectValue(value)
  if (Object.keys(config).some(k => !['baseUrl', 'allowInsecureTest'].includes(k)) || typeof config.allowInsecureTest !== 'boolean') throw new ModelAccessError('INVALID_INPUT', 'Invalid team service configuration')
  let url: URL
  try { url = new URL(requiredText(config.baseUrl, 2048)) } catch { throw new ModelAccessError('INVALID_INPUT', 'Enter a valid AgentOS service URL') }
  if (url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) throw new ModelAccessError('INVALID_INPUT', 'The service URL cannot contain credentials, queries or encoded separators')
  const privateIpv4 = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)$/.test(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.allowInsecureTest && privateIpv4)) throw new ModelAccessError('TLS_REQUIRED', 'HTTPS is required; HTTP is available only for an explicitly configured private test address')
  if (!['', '/', '/api', '/api/', '/web-api', '/web-api/'].includes(url.pathname)) throw new ModelAccessError('INVALID_INPUT', 'Use the AgentOS BFF root, /api or /web-api address')
  return { baseUrl: url.href.replace(/\/$/, ''), allowInsecureTest: url.protocol === 'http:' }
}
export function shouldAutoRenew(lease: ModelLease, serverNow: number, lastUsed: number, activeRequests: number): boolean {
  const remaining = Date.parse(lease.initial_expires_at) - serverNow
  // A durable pending renewal is reconciliation of an already accepted attempt.
  if (lease.status === 'renewing') return !lease.auto_renewed && remaining > -LEASE_MS
  return !lease.auto_renewed && ['active', 'renewing'].includes(lease.status) && remaining > 0 && remaining <= RENEW_WINDOW_MS && (activeRequests > 0 || lastUsed > 0 && serverNow - lastUsed <= RENEW_WINDOW_MS)
}
