import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import { deliverWindowsAcceptanceDraft, requirePrivateDestination } from '../.github/scripts/deliver-windows-acceptance-draft.mjs'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', HQHARNESS_DRAFT_DELIVERY: 'true',
  GITHUB_REPOSITORY: 'owner/private-harness', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
const file = 'hqharness-0.1.3-win-x64-acceptance.exe'
const logNames = ['browser-local-execution.log', 'windows-uia-local-execution.log']

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hqharness-draft-'))
  roots.push(root)
  await mkdir(path.join(root, 'dist'))
  await mkdir(path.join(root, '.build/automation-acceptance'), { recursive: true })
  const installer = Buffer.from('MZ acceptance installer fixture')
  const manifest = { source: env.GITHUB_SHA, signed: false, file, sha256: createHash('sha256').update(installer).digest('hex') }
  await writeFile(path.join(root, 'dist', file), installer)
  await writeFile(path.join(root, 'dist/windows-acceptance.json'), '\uFEFF' + JSON.stringify(manifest))
  for (const name of logNames) await writeFile(path.join(root, '.build/automation-acceptance', name), 'native acceptance passed')
  const calls = []
  const release = { id: 456, draft: true, prerelease: true, tag_name: 'acceptance-windows-123-2',
    target_commitish: env.GITHUB_SHA, html_url: 'https://github.com/owner/private-harness/releases/456',
    assets: [{ name: file, state: 'uploaded', size: installer.length },
      { name: 'windows-acceptance.json', state: 'uploaded', size: Buffer.byteLength('\uFEFF' + JSON.stringify(manifest)) },
      ...logNames.map(name => ({ name, state: 'uploaded', size: Buffer.byteLength('native acceptance passed') }))] }
  const gh = args => {
    calls.push(args)
    if (args[0] === 'api' && args[1] === `repos/${env.GITHUB_REPOSITORY}`) {
      return JSON.stringify({ full_name: env.GITHUB_REPOSITORY, private: true })
    }
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) return JSON.stringify(release)
    if (args[0] === 'release' && args[1] === 'create') return release.html_url
    throw new Error(`Unexpected gh invocation: ${args.join(' ')}`)
  }
  return { root, manifest, calls, release, gh }
}

it('requires an explicit manual request and verifies the actual private repository before mutations', () => {
  const calls = []
  const publicGh = args => { calls.push(args); return JSON.stringify({ full_name: env.GITHUB_REPOSITORY, private: false }) }
  for (const unsafeEnv of [{ ...env, GITHUB_EVENT_NAME: 'push' }, { ...env, HQHARNESS_DRAFT_DELIVERY: 'false' }]) {
    expect(() => requirePrivateDestination(unsafeEnv, publicGh)).toThrow('explicit manual')
  }
  expect(calls).toHaveLength(0)
  expect(() => requirePrivateDestination(env, publicGh)).toThrow('current private repository')
  expect(calls).toEqual([['api', `repos/${env.GITHUB_REPOSITORY}`]])
  expect(() => requirePrivateDestination(env, () => JSON.stringify({ private: true, full_name: 'other/repo' }))).toThrow('current private repository')
})

it('uploads the verified installer, BOM-aware manifest and both logs to a unique draft bound to the source SHA', async () => {
  const { root, manifest, calls, gh } = await fixture()
  const result = await deliverWindowsAcceptanceDraft(root, env, gh)
  expect(result).toMatchObject({ tag: 'acceptance-windows-123-2', source: env.GITHUB_SHA, draft: true,
    releaseId: 456, file, sha256: manifest.sha256 })
  const create = calls.find(args => args[0] === 'release')
  expect(create.slice(0, 3)).toEqual(['release', 'create', result.tag])
  expect(create.slice(3, 7).map(name => path.basename(name))).toEqual([file, 'windows-acceptance.json', ...logNames])
  expect(create.slice(7, 13)).toEqual(['--repo', env.GITHUB_REPOSITORY, '--target', env.GITHUB_SHA, '--draft', '--prerelease'])
  expect(calls.at(-1)).toEqual(['api', `repos/${env.GITHUB_REPOSITORY}`])
})

it.each(['source', 'sha256', 'signed', 'file'])('rejects a mismatched %s manifest before any upload', async key => {
  const { root, manifest, calls, gh } = await fixture()
  manifest[key] = { source: 'b'.repeat(40), sha256: '0'.repeat(64), signed: true, file: '../other.exe' }[key]
  await writeFile(path.join(root, 'dist/windows-acceptance.json'), JSON.stringify(manifest))
  await expect(deliverWindowsAcceptanceDraft(root, env, gh)).rejects.toThrow()
  expect(calls.every(args => args[0] === 'api')).toBe(true)
})

it.each(['missing log', 'directory', 'duplicate installer'])('rejects %s before any upload', async failure => {
  const { root, calls, gh } = await fixture()
  const log = path.join(root, '.build/automation-acceptance', logNames[0])
  if (failure === 'missing log') await rm(log)
  if (failure === 'directory') { await rm(log); await mkdir(log) }
  if (failure === 'duplicate installer') await writeFile(path.join(root, 'dist/other-acceptance.exe'), 'extra')
  await expect(deliverWindowsAcceptanceDraft(root, env, gh)).rejects.toThrow()
  expect(calls.every(args => args[0] === 'api')).toBe(true)
})

it.each(['published', 'wrong commit', 'incomplete asset', 'wrong size'])('fails explicitly if server confirmation reports %s', async failure => {
  const { root, release, gh } = await fixture()
  if (failure === 'published') release.draft = false
  if (failure === 'wrong commit') release.target_commitish = 'main'
  if (failure === 'incomplete asset') release.assets[0].state = 'new'
  if (failure === 'wrong size') release.assets[0].size += 1
  await expect(deliverWindowsAcceptanceDraft(root, env, gh)).rejects.toThrow(/draft bound|upload is incomplete/)
})

it('keeps write permission exclusive to manual delivery and preserves every native build gate in the shared job', async () => {
  const workflowRoot = new URL('../.github/workflows/', import.meta.url)
  const entry = parse(await readFile(new URL('windows-acceptance.yml', workflowRoot), 'utf8'))
  const shared = parse(await readFile(new URL('windows-acceptance-build.yml', workflowRoot), 'utf8'))
  expect(entry.on.workflow_dispatch.inputs.draft_delivery).toMatchObject({ type: 'boolean', default: false })
  expect(entry.permissions).toEqual({ contents: 'read' })
  expect(entry.jobs.windows.permissions).toEqual({ contents: 'read' })
  expect(entry.jobs['windows-draft'].permissions).toEqual({ contents: 'write' })
  expect(entry.jobs.windows.if).toBe("${{ github.event_name != 'workflow_dispatch' || !inputs.draft_delivery }}")
  expect(entry.jobs['windows-draft'].if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.draft_delivery }}")
  expect(entry.jobs.windows.uses).toBe(entry.jobs['windows-draft'].uses)
  expect(entry.jobs.windows.with.draft_delivery).toBe(false)
  expect(entry.jobs['windows-draft'].with.draft_delivery).toBe(true)
  expect(shared.permissions).toBeUndefined()
  const steps = shared.jobs.windows.steps
  const commands = steps.map(step => step.run).filter(Boolean).join('\n')
  for (const gate of ['npm ci', 'npm run typecheck', 'signed-test-build.test.ts', 'automation-performance-smoke.mjs',
    'automation-window-smoke.mjs', 'npm test -- --maxWorkers=4', 'automation-consent-smoke.mjs', 'npm run package:win',
    "automation-native-package-smoke.mjs 'dist/win-unpacked/HQHarness.exe' 'dist/win-unpacked/resources/app.asar'"]) {
    expect(commands).toContain(gate)
  }
  const uploadSteps = steps.filter(step => step.uses === 'actions/upload-artifact@v4')
  expect(uploadSteps).toHaveLength(3)
  expect(uploadSteps.every(step => step.if.includes('!inputs.draft_delivery'))).toBe(true)
  const delivery = steps.find(step => step.run === 'node .github/scripts/deliver-windows-acceptance-draft.mjs')
  expect(delivery.if).toBe('inputs.draft_delivery')
  expect(steps.indexOf(delivery)).toBeGreaterThan(steps.findIndex(step => step.name === 'Record exact artifact identity and outstanding manual acceptance'))
})
