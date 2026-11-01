import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { managedProfile, PROVIDER } from './profile.js'

export const name = 'hqharness-model-access'
export const inject = ['llm', 'connection', 'agentDefaultModel']

export function apply(ctx) {
  if (process.env.HQHARNESS_MODEL_SOURCE === 'huaqing-switch') return import('./huaqing-switch.js').then(module => module.applySwitch(ctx))
  const endpoint = process.env.HQHARNESS_MODEL_BRIDGE_URL
  const token = process.env.HQHARNESS_MODEL_BRIDGE_TOKEN
  // Safe Mode and standalone Harness can omit the desktop-owned bridge.
  if (!endpoint || !token) return
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || !/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid Huaqing Desktop model bridge configuration')
  let profiles = new Map()
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async (_provider, profile) => profile.bridgeToken,
    auth: { credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref)
  })
  ctx.effect(() => {
    let registration
    let disposed = false
    let running
    let fingerprint = ''
    let warned = false
    const controller = new AbortController()
    const sync = () => running ??= (async () => {
      const response = await fetch(`${url.origin}/managed-model`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
      if (!response.ok) { await response.body?.cancel(); throw new Error('Huaqing Desktop model bridge unavailable') }
      const metadata = await response.json()
      const lease = metadata.lease
      if (lease && (!['active', 'renewing'].includes(lease.status) || lease.model?.display_name !== 'DeepSeek-V41-Flash' || !Number.isSafeInteger(lease.model.context_window) || !Number.isSafeInteger(lease.model.max_output_tokens) || !Array.isArray(lease.model.input_modalities))) throw new Error('Invalid Huaqing Desktop model metadata')
      if (disposed) return
      const next = JSON.stringify(lease?.model ?? null)
      if (fingerprint !== next) {
        profiles = lease ? new Map([[PROVIDER, managedProfile(lease, `${url.origin}/v1`, token)]]) : new Map()
        if (registration) registration.replace([...profiles.keys()])
        else if (profiles.size) registration = ctx.llm.registerAdapter([PROVIDER], adapter)
        fingerprint = next
      }
      warned = false
      return lease
    })().finally(() => { running = undefined })
    const refresh = () => sync().catch(() => {
      profiles = new Map()
      registration?.replace([])
      fingerprint = ''
      if (!disposed && !warned) { ctx.logger.warn('Huaqing Desktop team model bridge is unavailable; access remains disabled'); warned = true }
    })
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    timer.unref()
    const route = ctx.connection.fetch.register({
      path: '/api/hqharness-team-model/default', methods: ['POST'],
      fetch: async () => {
        try {
          const lease = await sync()
          if (!lease || disposed) return Response.json({ ok: false }, { status: 409 })
          await ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: lease.model.id })
          return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
        } catch { return Response.json({ ok: false }, { status: 503 }) }
      }
    })
    return () => { disposed = true; controller.abort(); clearInterval(timer); registration?.(); route?.() }
  }, 'Huaqing Desktop managed model route')
}
