import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

export const PROVIDER = 'hqharness-team'
export function managedProfile(lease, baseURL, bridgeToken) {
  const descriptor = {
    id: lease.model.id, name: lease.model.display_name, api: 'openai-completions', provider: PROVIDER, baseUrl: baseURL,
    reasoning: false, input: [...lease.model.input_modalities], contextWindow: lease.model.context_window,
    maxTokens: lease.model.max_output_tokens,
    // Billing is authoritative at AgentOS; the client does not invent a tariff.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: false }
  }
  const piProvider = createProvider({
    id: PROVIDER, name: 'Huaqing Desktop · AgentOS', baseUrl: baseURL, models: [descriptor], api: openAICompletionsApi(),
    auth: { apiKey: { name: 'Huaqing Desktop local bridge', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'Huaqing Desktop local bridge' }) } }
  })
  return {
    provider: PROVIDER, displayName: 'Huaqing Desktop · AgentOS', api: 'openai-completions', baseURL, bridgeToken,
    streamIdleTimeoutMs: 300_000, maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 4_194_304, requestImageMaxBytes: 1_048_576,
    retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'Huaqing Desktop team model'),
    configuredMaxTokens: new Map(), modelErrors: new Map(), piProvider
  }
}
