import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { huaqingSwitchEnvironment } from '../src/main/huaqing-switch'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { resolveTestNodeExecutable } from './node-executable'
import { projectRoot } from './patch-path'

it('hides and rejects direct providers in the actual Harness LLM service', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'hq-switch-policy-')))
  const moduleUrl = (name: string) => pathToFileURL(join(projectRoot, 'node_modules', name, 'lib/index.js')).href
  const config = join(home, 'cordis.json')
  const entry = join(home, 'policy.mjs')
  try {
    await writeFile(config, JSON.stringify([{ id: 'llm', name: moduleUrl('@deepseek-ai/dsh-llm') }]))
    await writeFile(entry, `
      import assert from 'node:assert/strict'
      import { boot } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-app-boot'))}
      const ctx = await boot('switch-policy-qualification', ${JSON.stringify(config)}, [], ctx => {
        ctx.provide('connection', { fetch: { register() { return () => {} } } })
      })
      try {
        for (const provider of ['legacy', 'huaqing-switch']) ctx.llm.registerAdapter([provider], {
          providerInfo: () => ({ id: provider, name: provider }),
          providerRetryPolicy: () => undefined
        })
        assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), ['huaqing-switch'])
        await assert.rejects(ctx.llm.resolveModelInfo('legacy', 'fixture'), error => error.code === 'HUAQING_SWITCH_REQUIRED')
        console.log('SWITCH_PROVIDER_POLICY_PASS')
      } finally { await ctx.fiber.dispose() }
    `)
    const result = spawnSync(process.execPath, [join(projectRoot, 'build/harness-node-entry.mjs'), entry], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, ...huaqingSwitchEnvironment(home) },
      encoding: 'utf8',
      timeout: 15_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain('SWITCH_PROVIDER_POLICY_PASS')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('boots the actual desktop profile with Switch offline and omits the employee model editor', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hq-switch-runtime-'))
  const runtime = new HarnessRuntime({
    dshEntryPath: join(projectRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    nodeEntryPath: join(projectRoot, 'build/harness-node-entry.mjs'),
    nodeExecutablePath: resolveTestNodeExecutable(),
    dshPatchPath: join(projectRoot, 'build/dsh-desktop.patch.yml'),
    dshSafePatchPath: join(projectRoot, 'build/dsh-desktop-safe.patch.yml'),
    dshHome: home,
    logPath: join(home, 'harness.log'),
    extraEnvironment: () => huaqingSwitchEnvironment(home),
    launchProcess: (executable, args, options) => spawn(executable, args, options),
    startupTimeoutMs: 30_000,
    onChanged() {}
  })
  try {
    await runtime.start(home)
    const state = runtime.snapshot()
    expect(state.phase, state.logs.join('\n')).toBe('ready')
    if (!state.url || !state.authToken) throw new Error('Missing actual Harness endpoint')
    const login = await fetch(`${state.url}/?token=${encodeURIComponent(state.authToken)}`, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const response = await fetch(state.url, { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    const html = await response.text()
    const bootScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)]
      .map(match => match[1]).find(script => script?.includes('__DSH_BOOT__'))
    if (!bootScript) throw new Error('Missing actual client graph')
    const window: { __DSH_BOOT__?: { entries?: { id: string }[] } } = {}
    runInNewContext(bootScript, { window, globalThis: window })
    const ids = window.__DSH_BOOT__?.entries?.map(entry => entry.id)
    expect(ids).toContain('hqharness-automation')
    expect(ids).not.toContain('hqharness-model-access')
    const scriptUrls = [...html.matchAll(/<script[^>]+src="([^"]+)"/gu)].map(match => match[1])
    const bootstrap = scriptUrls.find(src => src?.includes('@deepseek-ai/dsh-client-modules/client.js'))
    if (!bootstrap) throw new Error('Missing module bootstrap')
    const script = await fetch(new URL(bootstrap.replaceAll('&amp;', '&'), state.url), { headers: { Cookie: cookie } })
    expect(script.status).toBe(200)
    const registered: string[] = []
    runInNewContext(await script.text(), { window: { __ModuleLoader__: { load: (entry: { id: string }) => registered.push(entry.id) } } })
    expect(registered).toContain('@deepseek-ai/dsh-client-modules')
  } finally {
    await runtime.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 45_000)
