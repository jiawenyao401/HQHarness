import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { expect, it } from 'vitest'

function desktopPromptConfig(file) {
  const yaml = readFileSync(new URL('../build/' + file, import.meta.url), 'utf8')
  const entries = parseDocument(yaml).toJS()
  return entries.find(entry => entry.id === 'system-prompt')?.config
    ?? { personaPrefix: 'You are a coding agent powered by the {{model}} model.', personaSuffix: 'Your working directory is {{cwd}}.' }
}

it.each(['dsh-desktop.patch.yml', 'dsh-desktop-safe.patch.yml'])('assembles the desktop assistant identity with %s', async (file) => {
  const ctx = new Context()
  ctx.plugin(SystemPrompt, desktopPromptConfig(file))
  const prompt = await new Promise((resolve, reject) => {
    ctx.inject(['systemPrompt'], async scope => {
      try {
        scope.systemPrompt.variable('cwd', () => '/workspace')
        scope.systemPrompt.variable('model', () => 'hq-private-routing-id-v1')
        resolve(renderPrompt(await scope.systemPrompt.assemble()))
      } catch (error) {
        reject(error)
      }
    })
  })
  expect(prompt).toContain('You are Huaqing Harness')
  expect(prompt).not.toContain('DeepSeek Harness')
  expect(prompt).not.toContain('hq-private-routing-id-v1')
  expect(prompt).toContain('Your working directory is /workspace.')
})
