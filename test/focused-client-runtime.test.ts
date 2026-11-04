import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { ensureSafeModeProfile, SAFE_MODE_PROFILE } from '../src/main/state/safe-mode-profile'
import { resolveTestNodeExecutable } from './node-executable'
import { projectRoot } from './patch-path'

it.each(['web', SAFE_MODE_PROFILE])('boots %s without market modules and retains its bundled client surface', async (profile) => {
  const home = await mkdtemp(join(tmpdir(), 'hq-focused-runtime-'))
  const source = join(projectRoot, profile === SAFE_MODE_PROFILE ? 'build/dsh-desktop-safe.patch.yml' : 'build/dsh-desktop.patch.yml')
  const patch = join(home, 'desktop-test.patch.yml')
  const request = join(home, 'identity-request.json')
  const provider = pathToFileURL(join(projectRoot, 'test/fixtures/desktop-identity-provider.mjs')).href
  await writeFile(patch, await readFile(source, 'utf8') + `
- insert:
    - id: desktop-identity-probe
      name: ${JSON.stringify(provider)}
      config:
        output: ${JSON.stringify(request)}
        workspace: ${JSON.stringify(home)}
`)
  const runtime = new HarnessRuntime({
    dshEntryPath: join(projectRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    nodeEntryPath: join(projectRoot, 'build/harness-node-entry.mjs'),
    nodeExecutablePath: resolveTestNodeExecutable(),
    dshPatchPath: patch,
    dshSafePatchPath: patch,
    dshHome: home,
    logPath: join(home, 'harness.log'),
    launchProcess: (executable, args, options) => spawn(executable, args, options),
    startupTimeoutMs: 30_000,
    preferredPort: 0,
    onChanged() {}
  })
  try {
    if (profile === SAFE_MODE_PROFILE) await ensureSafeModeProfile(home)
    await runtime.start(home, profile)
    const state = runtime.snapshot()
    expect(state.phase, state.logs.join('\n')).toBe('ready')
    if (!state.url || !state.authToken) throw new Error('Missing actual Harness endpoint')
    await expect.poll(async () => {
      try { return await readFile(request, 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return ''
      }
    }, { timeout: 8_000 }).not.toBe('')
    const captured = JSON.parse(await readFile(request, 'utf8')) as { model?: string; system?: unknown; error?: string }
    expect(captured.error).toBeUndefined()
    expect(captured.model).toBe('hq-private-routing-id-v1')
    const system = JSON.stringify(captured.system)
    expect(system).toContain('You are Huaqing Harness')
    expect(system).toContain('through Huaqing Desktop')
    expect(system).not.toContain('DeepSeek Harness')
    expect(system).not.toContain('hq-private-routing-id-v1')
    const login = await fetch(`${state.url}/?token=${encodeURIComponent(state.authToken)}`, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const html = await (await fetch(state.url, { headers: { Cookie: cookie } })).text()
    const bootScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)]
      .map(match => match[1]).find(script => script?.includes('__DSH_BOOT__'))
    if (!bootScript) throw new Error('Missing actual client graph')
    const window: { __DSH_BOOT__?: { entries?: { id: string; url: string }[] } } = {}
    runInNewContext(bootScript, { window, globalThis: window })
    const ids = window.__DSH_BOOT__?.entries?.map(entry => entry.id)
    if (profile === 'web') {
      expect(ids).toContain('hqharness-automation')
      expect(ids).toContain('hqharness-wps')
      const wps = window.__DSH_BOOT__?.entries?.find(entry => entry.id === 'hqharness-wps')
      if (!wps) throw new Error('Missing actual WPS client graph entry')
      const client = await fetch(new URL(wps.url, state.url), { headers: { Cookie: cookie } })
      expect(client.status).toBe(200)
      expect(client.headers.get('content-type')).toContain('javascript')
      const registered: string[] = []
      runInNewContext(await client.text(), { window: { __ModuleLoader__: { load: (entry: { id: string }) => registered.push(entry.id) } } })
      expect(registered).toContain('hqharness-wps')
    } else {
      expect(ids).not.toContain('hqharness-automation')
      expect(ids).not.toContain('hqharness-wps')
    }
    // The model backend stays loaded without contributing an employee-login editor.
    expect(ids).not.toContain('hqharness-model-access')
    expect(ids).toContain('@deepseek-ai/dsh-client-ui-settings-plugins')
    for (const name of ['dsh-desktop-workbenches', 'dsh-desktop-market-installer', '@deepseek-ai/dsh-client-ui-plugin-manager', '@deepseek-ai/dsh-client-ui-settings-plugin-inventory']) {
      expect(ids).not.toContain(name)
    }
    const catalog = await fetch(new URL('/dsh-desktop/workbenches/catalog', state.url), { headers: { Cookie: cookie } })
    expect(catalog.status).toBe(404)
    // The product switch is composition-owned, so old saved browser preferences
    // cannot activate a workbench or hide its previously bound chat sessions.
    if (profile === 'web') expect(await readFile(join(home, 'desktop-host-sources.patch.yml'), 'utf8')).toContain('disabled: true')
    const scriptUrls = [...html.matchAll(/<script[^>]+src="([^"]+)"/gu)].map(match => match[1])
    const bootstrap = scriptUrls.find(src => src?.includes('@deepseek-ai/dsh-client-modules/client.js'))
    if (!bootstrap) throw new Error('Missing module bootstrap')
    const response = await fetch(new URL(bootstrap.replaceAll('&amp;', '&'), state.url), { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    const registered: string[] = []
    runInNewContext(await response.text(), { window: { __ModuleLoader__: { load: (entry: { id: string }) => registered.push(entry.id) } } })
    expect(registered).toContain('@deepseek-ai/dsh-client-modules')
  } finally {
    await runtime.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 45_000)
