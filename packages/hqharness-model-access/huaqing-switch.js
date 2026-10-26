import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  LlmError,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { readSwitchManifest, PROVIDER } from './switch-connector.js'
import { switchProfile } from './switch-profile.js'

const WAITING_MODEL = 'awaiting-connection'

/** Desktop deployment policy: external configuration, no renderer credential editor. */
export async function applySwitch(ctx) {
  const controller = new AbortController()
  let disposed = false
  let updating = false
  let fingerprint = ''
  let warned = false
  const snapshot = async (signal) => {
    try {
      const manifest = await readSwitchManifest(
        process.env.HUAQING_SWITCH_CONNECTOR_PATH,
        signal ?? controller.signal,
      )
      const profile = switchProfile(manifest)
      const profiles = new Map([[PROVIDER, profile]])
      return {
        manifest,
        adapter: new PiAiAdapter({
          profiles: () => profiles,
          resolveApiKey: async (_provider, profile) => profile.bridgeToken,
          auth: {
            credentials: new InMemoryCredentialStore(),
            authContext: {
              env: async () => undefined,
              fileExists: async () => false,
            },
          },
          resolveAttachments: () => ctx.get('attachments'),
          resolveImageAccess: (attachments, ref) =>
            resolveImageAttachmentAccess(
              attachments,
              (path) => ctx.get('fs')?.processPathFromHostPath(path),
              ref,
            ),
        }),
      }
    } catch (error) {
      if (signal?.aborted || controller.signal.aborted) throw error
      throw new LlmError(
        '无法连接 Huaqing Switch，请启动它并设置默认连接 / Start Huaqing Switch and select a default connection',
        'HUAQING_SWITCH_UNAVAILABLE',
      )
    }
  }
  const requireConfiguredModel = (model) => {
    if (model === WAITING_MODEL)
      throw new LlmError(
        '请在 Huaqing Switch 设置默认连接，然后新建会话 / Select a default connection in Huaqing Switch, then start a new session',
        'HUAQING_SWITCH_NO_DEFAULT',
      )
  }
  const adapter = {
    providerInfo: () => ({ id: PROVIDER, name: 'Huaqing Switch' }),
    providerRetryPolicy: () =>
      resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'Huaqing Switch'),
    listModels: async (provider) =>
      (await snapshot()).adapter.listModels(provider),
    resolveModel: async (provider, model, signal) => {
      requireConfiguredModel(model)
      return (await snapshot(signal)).adapter.resolveModel(
        provider,
        model,
        signal,
      )
    },
    prepareCall: async (provider, model, signal) => {
      requireConfiguredModel(model)
      return (await snapshot(signal)).adapter.prepareCall(
        provider,
        model,
        signal,
      )
    },
    async *stream(options) {
      const call = await this.prepareCall(
        options.provider,
        options.model,
        options.signal,
      )
      yield* call.stream(options)
    },
  }
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  const syncDefault = async () => {
    if (disposed || updating) return
    updating = true
    try {
      const { manifest } = await snapshot()
      if (disposed) return
      const next = JSON.stringify([manifest.models, manifest.defaultModel])
      if (next !== fingerprint) {
        registration.replace([PROVIDER])
        fingerprint = next
      }
      const model = manifest.defaultModel ?? WAITING_MODEL
      const current = ctx.agentDefaultModel.currentSelection()
      if (current.provider !== PROVIDER || current.model !== model)
        await ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model })
      warned = false
    } catch {
      if (!disposed && !warned) {
        ctx.logger.warn(
          'Huaqing Switch is unavailable; direct model fallback remains disabled',
        )
        warned = true
      }
    } finally {
      updating = false
    }
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      void syncDefault()
    }, 5000)
    timer.unref()
    return () => {
      disposed = true
      controller.abort()
      clearInterval(timer)
      registration()
    }
  }, 'Huaqing Switch connection lifetime')
  // Remove the upstream direct-provider default even when Switch is not running.
  if (ctx.agentDefaultModel.currentSelection().provider !== PROVIDER) {
    await ctx.agentDefaultModel.saveSelection({
      provider: PROVIDER,
      model: WAITING_MODEL,
    })
  }
  await syncDefault()
}
