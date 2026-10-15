import { ModelAccessError, objectValue, type ModelAccessConfiguration } from '../../shared/model-access'

export class AgentOsClient {
  constructor(private readonly configuration: ModelAccessConfiguration, private readonly fetcher: typeof fetch = fetch) {}
  async request(path: string, method: 'GET' | 'POST' | 'DELETE', token?: string, body?: object): Promise<Record<string, unknown>> {
    if (!/^\/(?:auth\/(?:login-options|login|refresh|logout)|desktop\/model-access\/leases(?:\/current\?installation_id=[a-zA-Z0-9_-]{16,80}|\/[a-zA-Z0-9_-]{1,80}(?:\/renew)?)?)$/.test(path)) throw new ModelAccessError('INVALID_INPUT', 'Unsupported account operation')
    let response: Response
    try {
      response = await this.fetcher(`${this.configuration.baseUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    } catch { throw new ModelAccessError('NETWORK', 'Cannot reach the AgentOS service') }
    if (!response.ok) {
      await response.body?.cancel()
      const code = response.status === 401 ? 'LOGIN_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : response.status === 404 ? 'SERVICE_UNAVAILABLE' : response.status === 409 ? 'LEASE_CONFLICT' : response.status === 429 ? 'RATE_LIMIT' : 'SERVICE_ERROR'
      throw new ModelAccessError(code, `AgentOS request failed (${response.status})`, response.status)
    }
    if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new ModelAccessError('INVALID_RESPONSE', 'AgentOS returned an invalid response') }
    const reader = response.body?.getReader()
    if (!reader) throw new ModelAccessError('INVALID_RESPONSE', 'AgentOS returned an empty response')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > 65_536) throw new ModelAccessError('INVALID_RESPONSE', 'AgentOS response exceeded the size limit')
        chunks.push(next.value)
      }
      return objectValue(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (error) {
      await reader.cancel().catch(() => { /* The transport may already be closed. */ })
      if (error instanceof ModelAccessError) throw error
      throw new ModelAccessError('INVALID_RESPONSE', 'AgentOS returned invalid JSON')
    } finally { reader.releaseLock() }
  }
}
