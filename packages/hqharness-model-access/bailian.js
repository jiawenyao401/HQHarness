import { InMemoryCredentialStore, createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

const PROVIDER = 'hqharness-bailian'
const PROVIDER_NAME = 'Alibaba Cloud Bailian'
const MODEL = 'qwen3.8-flash'
const API = 'openai-completions'
// Reserve a conservative budget for Desktop sessions and tool histories.
const CONTEXT_WINDOW = 262_144
const MAX_OUTPUT_TOKENS = 16_384

export function applyBailian(ctx) {
  const endpoint = process.env.HQHARNESS_BAILIAN_URL ?? ''
  const token = process.env.HQHARNESS_BAILIAN_TOKEN ?? ''
  const port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/v1$/u.exec(endpoint)?.[1]
  const available = port !== undefined && Number(port) <= 65535 && /^[0-9a-f]{64}$/u.test(token)
  const piProvider = createProvider({
    id: PROVIDER,
    name: PROVIDER_NAME,
    models: [{
      id: MODEL,
      name: 'qwen3.8-27b-nvfp4',
      api: API,
      provider: PROVIDER,
      // Resolve the capability before streaming, including when the bridge is absent.
      baseUrl: available ? endpoint : 'http://127.0.0.1:1/v1',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: CONTEXT_WINDOW,
      maxTokens: MAX_OUTPUT_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' }
    }],
    api: openAICompletionsApi(),
    auth: {
      apiKey: {
        name: 'Huaqing Desktop local capability',
        resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'Huaqing Desktop local capability' })
      }
    }
  })
  const profiles = new Map([[PROVIDER, {
    provider: PROVIDER,
    displayName: PROVIDER_NAME,
    api: API,
    piProvider,
    streamIdleTimeoutMs: 120_000,
    timeoutMs: 300_000,
    transport: 'sse',
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, PROVIDER_NAME),
    configuredMaxTokens: new Map([[MODEL, MAX_OUTPUT_TOKENS]]),
    modelErrors: new Map()
  }]])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => {
      if (!available) {
        throw new LlmError('百炼模型网关不可用 / The Bailian model gateway is unavailable', 'BAILIAN_UNAVAILABLE')
      }
      return token
    },
    auth: { credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref)
  })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'Huaqing Desktop Bailian model')
}
