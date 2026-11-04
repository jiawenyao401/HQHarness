import { writeFile } from 'node:fs/promises'
import { createUserMessage, isAgentLoopRequest, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'llm', 'webRuntime']
const model = 'hq-private-routing-id-v1'

export function apply(ctx, config) {
  let captured
  class IdentityProbe extends LlmAdapter {
    async *stream(request) {
      const system = request.messages.filter(message => message.role === 'system')
      if (isAgentLoopRequest(request)) captured = { model: request.model, system }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture reply' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['desktop-identity-probe'], new IdentityProbe())
  setImmediate(async () => {
    try {
      const { agent } = await ctx.agents.create({
        sessionId: 'desktop-identity-probe',
        meta: { cwd: config.workspace },
        agentOptions: { provider: 'desktop-identity-probe', model }
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好，你是谁？' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await writeFile(config.output, JSON.stringify(captured ?? { error: 'Agent never reached the fixture provider' }))
    } catch (error) {
      await writeFile(config.output, JSON.stringify({ error: String(error) }))
    }
  })
}
