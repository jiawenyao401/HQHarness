import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSwitchManifest } from '../packages/hqharness-model-access/switch-connector.js'
import { switchProfile } from '../packages/hqharness-model-access/switch-profile.js'

const roots = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  )
})
async function connector() {
  const root = await mkdtemp(join(tmpdir(), 'huaqing-connector-'))
  roots.push(root)
  const path = join(root, 'connector.json')
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      product: 'huaqing-switch',
      endpoint: 'http://127.0.0.1:17621',
      token: 'a'.repeat(64),
    }),
    { mode: 0o600 },
  )
  return path
}
const metadata = {
  version: 1,
  product: 'huaqing-switch',
  defaultModel: 'hq-11111111-1111-4111-8111-111111111111-v1',
  models: [
    {
      id: 'hq-11111111-1111-4111-8111-111111111111-v1',
      name: 'Example',
      protocol: 'openai-chat',
      baseUrl:
        'http://127.0.0.1:17621/hq/connections/11111111-1111-4111-8111-111111111111/1/v1',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      supportsImages: false,
    },
  ],
}
describe('Huaqing Switch connector', () => {
  it('uses only authenticated loopback metadata and builds the native Pi provider', async () => {
    const path = await connector()
    const fetcher = vi.fn(async () => Response.json(metadata))
    vi.stubGlobal('fetch', fetcher)
    const manifest = await readSwitchManifest(path)
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:17621/hq/manifest')
    expect(fetcher.mock.calls[0][1].redirect).toBe('error')
    expect(switchProfile(manifest).provider).toBe('huaqing-switch')
  })
  it('rejects a model catalog that tries to send local credentials elsewhere', async () => {
    const path = await connector()
    vi.stubGlobal('fetch', async () =>
      Response.json({
        ...metadata,
        models: [
          { ...metadata.models[0], baseUrl: 'https://outside.invalid/v1' },
        ],
      }),
    )
    await expect(readSwitchManifest(path)).rejects.toThrow('loopback')
  })
  it('rejects symlinked capability files', async () => {
    const path = await connector()
    await symlink(path, path + '.link')
    await expect(readSwitchManifest(path + '.link')).rejects.toThrow(
      'permissions',
    )
  })
  it.skipIf(process.platform === 'win32')(
    'rejects capability files readable by other users',
    async () => {
      const path = await connector()
      await chmod(path, 0o644)
      await expect(readSwitchManifest(path)).rejects.toThrow('permissions')
    },
  )
  it('bounds metadata before parsing it', async () => {
    const path = await connector()
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(512 * 1024 + 1)))
    await expect(readSwitchManifest(path)).rejects.toThrow('too large')
  })
})

describe('Huaqing Switch desktop policy', () => {
  afterEach(() => vi.unstubAllEnvs())

  async function startWithSelection(selection) {
    const { applySwitch } = await import(
      '../packages/hqharness-model-access/huaqing-switch.js'
    )
    let adapter
    let dispose
    const registration = Object.assign(vi.fn(), { replace: vi.fn() })
    const state = { selection }
    await applySwitch({
      llm: {
        registerAdapter: (_providers, value) => {
          adapter = value
          return registration
        },
      },
      agentDefaultModel: {
        currentSelection: () => state.selection,
        saveSelection: async (value) => {
          state.selection = value
        },
      },
      effect: (setup) => {
        dispose = setup()
      },
      logger: { warn: vi.fn() },
      get: () => undefined,
    })
    return { state, adapter, dispose }
  }

  it('replaces the direct-provider default while Switch is offline', async () => {
    vi.stubEnv(
      'HUAQING_SWITCH_CONNECTOR_PATH',
      '/missing-huaqing-connector.json',
    )
    const app = await startWithSelection({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    })
    try {
      expect(app.state.selection).toEqual({
        provider: 'huaqing-switch',
        model: 'awaiting-connection',
      })
      await expect(
        app.adapter.prepareCall('huaqing-switch', 'awaiting-connection'),
      ).rejects.toMatchObject({ code: 'HUAQING_SWITCH_NO_DEFAULT' })
    } finally {
      app.dispose()
    }
  })

  it('clears a stale default when Switch has no configured default', async () => {
    vi.stubEnv('HUAQING_SWITCH_CONNECTOR_PATH', await connector())
    vi.stubGlobal('fetch', async () =>
      Response.json({ ...metadata, models: [], defaultModel: null }),
    )
    const app = await startWithSelection({
      provider: 'huaqing-switch',
      model: metadata.defaultModel,
    })
    try {
      expect(app.state.selection.model).toBe('awaiting-connection')
    } finally {
      app.dispose()
    }
  })
})
