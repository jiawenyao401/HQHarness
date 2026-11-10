import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const client = readFileSync(new URL(
  '../node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js', import.meta.url
), 'utf8')
const start = client.indexOf('var UiWorkspaceService = class')
const end = client.indexOf('\n\t\t/**', client.indexOf('\n\t\t};', start))
const UiWorkspaceService = runInNewContext(client.slice(start, end) + '\nUiWorkspaceService', {
  AbortController,
  AbortSignal,
  recentWorkspace: () => undefined,
  _deepseek_ai_cordis: { Service: class { constructor(ctx) { this.ctx = ctx } } },
  _deepseek_ai_dsh_client_store: { createSnapshotStore: value => ({ getSnapshot: () => value }) }
})

const legacyPath = 'C:\\Users\\Test\\Documents\\deepseek-harness\\default-workspace'
const currentPath = 'C:\\Users\\Test\\Documents\\HuaqingDesktop\\default-workspace'

it.each([
  { name: 'global New Chat from the old default', path: legacyPath, explicit: undefined, preferred: currentPath, target: 'preferred', lookups: 1 },
  { name: 'explicit New Chat in the old workspace', path: legacyPath, explicit: 'current', preferred: currentPath, target: 'current', lookups: 0 },
  { name: 'global New Chat in a custom project', path: 'C:\\Projects\\example', explicit: undefined, preferred: currentPath, target: 'current', lookups: 0 },
  { name: 'a similarly named project outside Documents', path: 'C:\\Projects\\deepseek-harness\\default-workspace', explicit: undefined, preferred: currentPath, target: 'current', lookups: 1 }
])('routes $name', async ({ path, explicit, preferred, target, lookups }) => {
  const initializeDefault = vi.fn(async () => ({ workspaceId: 'preferred', path: preferred }))
  const service = new UiWorkspaceService(
    { effect() {}, layout: { beginNavigation: () => new AbortController().signal } },
    {},
    {
      list: { getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'current', sessionIds: ['existing'], path }] }) },
      initializeDefault
    },
    { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
    {},
    vi.fn()
  )
  service.mainReference = { sessionId: 'existing' }
  service.openWorkspace = vi.fn(async () => {})
  service.startSession(explicit)
  await expect.poll(() => service.openWorkspace.mock.calls).toEqual([[target, undefined, true]])
  expect(initializeDefault).toHaveBeenCalledTimes(lookups)
})
