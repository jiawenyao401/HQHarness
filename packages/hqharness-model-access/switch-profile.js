import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { protocolApi, PROVIDER } from './switch-connector.js'

const apis = {
  'openai-completions': openAICompletionsApi(),
  'openai-responses': openAIResponsesApi(),
  'anthropic-messages': anthropicMessagesApi(),
}

/** One immutable manifest snapshot for Pi AI's native protocol handlers. */
export function switchProfile(manifest) {
  const models = manifest.models.map((model) => ({
    id: model.id,
    name: model.name,
    api: protocolApi(model.protocol),
    provider: PROVIDER,
    baseUrl: model.baseUrl,
    reasoning: false,
    input: model.supportsImages ? ['text', 'image'] : ['text'],
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: true },
  }))
  const api = {
    stream: (model, context, options) =>
      apis[model.api].stream(model, context, options),
    streamSimple: (model, context, options) =>
      apis[model.api].streamSimple(model, context, options),
  }
  const piProvider = createProvider({
    id: PROVIDER,
    name: 'Huaqing Switch',
    models,
    api,
    auth: {
      apiKey: {
        name: 'Huaqing local capability',
        resolve: async ({ credential }) => ({
          auth: { apiKey: credential?.key },
          source: 'Huaqing local capability',
        }),
      },
    },
  })
  return {
    provider: PROVIDER,
    displayName: 'Huaqing Switch',
    api: 'openai-completions',
    bridgeToken: manifest.token,
    streamIdleTimeoutMs: 120_000,
    timeoutMs: 300_000,
    transport: 'sse',
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    retryPolicy: resolveRetryPolicy(
      { mode: 'normal', maxRetries: 0 },
      'Huaqing Switch',
    ),
    configuredMaxTokens: new Map(
      manifest.models.map((model) => [model.id, model.maxOutputTokens]),
    ),
    modelErrors: new Map(),
    piProvider,
  }
}
