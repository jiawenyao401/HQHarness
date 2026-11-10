import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage, isAgentLoopRequest, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'llm', 'webRuntime', 'workspaceController', 'workspaceRegistry']
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
      let legacyId
      if (config.legacyWorkspace) {
        const legacy = await ctx.workspaceRegistry.initializeDefault(() => config.legacyWorkspace)
        legacyId = legacy.id
        await writeFile(join(config.legacyWorkspace, 'existing.txt'), 'existing workspace')
      }
      const signal = new AbortController().signal
      const [initialized, repeated] = await Promise.all([
        ctx.workspaceController.initializeDefault(signal),
        ctx.workspaceController.initializeDefault(signal)
      ])
      if (!initialized) throw new Error('Fixture could not initialize the default workspace')
      if (repeated?.workspace.workspaceId !== initialized.workspace.workspaceId) {
        throw new Error('Concurrent default initialization returned different workspaces')
      }
      const { workspace } = initialized
      const { agent } = await ctx.agents.create({
        sessionId: 'desktop-identity-probe',
        meta: { cwd: workspace.path },
        agentOptions: { provider: 'desktop-identity-probe', model }
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好，你是谁？' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const legacyPath = legacyId === undefined ? undefined : ctx.workspaceRegistry.get(legacyId)?.path
      await writeFile(config.output, JSON.stringify(captured ? { ...captured, workspace, legacyPath } : { error: 'Agent never reached the fixture provider' }))
    } catch (error) {
      await writeFile(config.output, JSON.stringify({ error: String(error) }))
    }
  })
}
