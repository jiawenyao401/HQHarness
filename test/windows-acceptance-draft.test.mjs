import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import { deliverWindowsAcceptanceDraft, requirePrivateDestination } from '../.github/scripts/deliver-windows-acceptance-draft.mjs'
import { requirePrivateXaspRelease, verifyWindowsSigningInput } from '../.github/scripts/xasp-ci.mjs'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', HQHARNESS_DRAFT_DELIVERY: 'true',
  GITHUB_REPOSITORY: 'owner/private-harness', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
const installer = Buffer.from('MZ acceptance installer fixture')
const sha256 = createHash('sha256').update(installer).digest('hex')
const version = '0.1.13'
const file = `Huaqing-Desktop-${version}-x64-${sha256}-20261104T080000Z.exe`
const logNames = ['browser-local-execution.log', 'windows-uia-local-execution.log']

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hqharness-draft-'))
  roots.push(root)
  await mkdir(path.join(root, 'dist'))
  await mkdir(path.join(root, '.build/automation-acceptance'), { recursive: true })
  const manifest = { source: env.GITHUB_SHA, signed: false, file, sha256, version }
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
    // GitHub's tag endpoint cannot resolve an unpublished draft, even after all
    // assets are uploaded. gh release view also resolves the pending draft tag.
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) throw new Error('HTTP 404: Not Found')
    if (args[0] === 'release' && args[1] === 'view') return JSON.stringify({ databaseId: release.id })
    if (args[0] === 'api' && args[1] === `repos/${env.GITHUB_REPOSITORY}/releases/456`) return JSON.stringify(release)
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

it('verifies a fully uploaded unpublished draft when the REST tag endpoint returns 404', async () => {
  const { root, manifest, calls, gh } = await fixture()
  const result = await deliverWindowsAcceptanceDraft(root, env, gh)
  expect(result).toMatchObject({ tag: 'acceptance-windows-123-2', source: env.GITHUB_SHA, draft: true,
    releaseId: 456, file, sha256: manifest.sha256 })
  const create = calls.find(args => args[0] === 'release')
  expect(create.slice(0, 3)).toEqual(['release', 'create', result.tag])
  expect(create.slice(3, 7).map(name => path.basename(name))).toEqual([file, 'windows-acceptance.json', ...logNames])
  expect(create.slice(7, 13)).toEqual(['--repo', env.GITHUB_REPOSITORY, '--target', env.GITHUB_SHA, '--draft', '--prerelease'])
  expect(calls).toContainEqual(['release', 'view', result.tag, '--repo', env.GITHUB_REPOSITORY, '--json', 'databaseId'])
  expect(calls).toContainEqual(['api', `repos/${env.GITHUB_REPOSITORY}/releases/456`])
  expect(calls.at(-1)).toEqual(['api', `repos/${env.GITHUB_REPOSITORY}`])
})

it.each([undefined, null, 0, -1, '456', '456/other', Number.MAX_SAFE_INTEGER + 1])('rejects an invalid draft database ID %s', async databaseId => {
  const { root, calls, gh } = await fixture()
  const invalidIdGh = args => args[0] === 'release' && args[1] === 'view'
    ? JSON.stringify({ databaseId }) : gh(args)
  await expect(deliverWindowsAcceptanceDraft(root, env, invalidIdGh)).rejects.toThrow('draft release ID')
  expect(calls.some(args => args[0] === 'api' && args[1].includes('/releases/'))).toBe(false)
})

it('does not report success when the pending draft cannot be resolved', async () => {
  const { root, gh } = await fixture()
  const missingDraftGh = args => {
    if (args[0] === 'release' && args[1] === 'view') throw new Error('release not found')
    return gh(args)
  }
  await expect(deliverWindowsAcceptanceDraft(root, env, missingDraftGh)).rejects.toThrow('release not found')
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

it.each(['wrong ID', 'published', 'wrong commit', 'wrong tag', 'not prerelease', 'incomplete asset', 'wrong size'])('fails explicitly if server confirmation reports %s', async failure => {
  const { root, release, gh } = await fixture()
  const confirmGh = args => args[0] === 'release' && args[1] === 'view' ? JSON.stringify({ databaseId: 456 }) : gh(args)
  if (failure === 'wrong ID') release.id = 457
  if (failure === 'published') release.draft = false
  if (failure === 'wrong commit') release.target_commitish = 'main'
  if (failure === 'wrong tag') release.tag_name = 'another-tag'
  if (failure === 'not prerelease') release.prerelease = false
  if (failure === 'incomplete asset') release.assets[0].state = 'new'
  if (failure === 'wrong size') release.assets[0].size += 1
  await expect(deliverWindowsAcceptanceDraft(root, env, confirmGh)).rejects.toThrow(/draft bound|upload is incomplete/)
})

it('keeps write permission exclusive to manual delivery and preserves every native build gate in the shared job', async () => {
  const workflowRoot = new URL('../.github/workflows/', import.meta.url)
  const entry = parse(await readFile(new URL('windows-acceptance.yml', workflowRoot), 'utf8'))
  const shared = parse(await readFile(new URL('windows-acceptance-build.yml', workflowRoot), 'utf8'))
  expect(entry.on.workflow_dispatch.inputs.draft_delivery).toMatchObject({ type: 'boolean', default: false })
  expect(entry.on.workflow_dispatch.inputs.xasp_bundle).toMatchObject({ type: 'boolean', default: false })
  expect(entry.permissions).toEqual({ contents: 'read' })
  expect(entry.jobs.windows.permissions).toEqual({ contents: 'read' })
  expect(entry.jobs['windows-draft'].permissions).toEqual({ contents: 'write' })
  expect(entry.jobs.windows.if).toBe("${{ github.event_name != 'workflow_dispatch' || !inputs.draft_delivery }}")
  expect(entry.jobs['windows-draft'].if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.draft_delivery }}")
  expect(entry.jobs.windows.uses).toBe(entry.jobs['windows-draft'].uses)
  expect(entry.jobs.windows.with.draft_delivery).toBe(false)
  expect(entry.jobs['windows-draft'].with.draft_delivery).toBe(true)
  expect(entry.jobs.windows.secrets).toBeUndefined()
  expect(entry.jobs['windows-draft'].secrets).toEqual({
    XASP_CHECKOUT_TOKEN: '${{ secrets.XASP_CHECKOUT_TOKEN }}',
    XASP_CHECKOUT_KEY: '${{ secrets.XASP_CHECKOUT_KEY }}'
  })
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
  expect(uploadSteps.every(step => step.if.includes('!inputs.draft_delivery') && step.if.includes('!inputs.xasp_bundle'))).toBe(true)
  const requirePrivate = steps.find(step => step.name === 'Require private draft delivery for XASP')
  const verifyPrivate = steps.find(step => step.name === 'Verify private draft delivery destination')
  const checkout = steps.find(step => step.uses === './.github/actions/prepare-private-xasp')
  expect(requirePrivate.if).toBe('inputs.xasp_bundle && !inputs.draft_delivery')
  expect(steps.indexOf(requirePrivate)).toBeLessThan(steps.indexOf(checkout))
  expect(steps.indexOf(verifyPrivate)).toBeLessThan(steps.indexOf(checkout))
  expect(checkout).toMatchObject({
    if: 'inputs.xasp_bundle',
    with: {
      'read-token': '${{ secrets.XASP_CHECKOUT_TOKEN }}',
      'read-key': '${{ secrets.XASP_CHECKOUT_KEY }}'
    }
  })
  const action = parse(await readFile(new URL('../.github/actions/prepare-private-xasp/action.yml', import.meta.url), 'utf8'))
  expect(action.runs.steps[0].env).toEqual({
    XASP_READ_TOKEN_CONFIGURED: "${{ inputs.read-token != '' }}",
    XASP_READ_KEY_CONFIGURED: "${{ inputs.read-key != '' }}"
  })
  const sourceCheckout = action.runs.steps.find(step => step.with?.repository === 'hqzyai/xasp')
  expect(sourceCheckout).toMatchObject({
    uses: 'actions/checkout@v4',
    with: {
      ref: '${{ steps.lock.outputs.revision }}',
      token: '${{ inputs.read-token || github.token }}',
      'ssh-key': '${{ inputs.read-key }}',
      'ssh-strict': true,
      'persist-credentials': false
    }
  })
  expect(action.runs.steps.map(step => step.run ?? step.uses)).toEqual([
    'node .github/scripts/xasp-ci.mjs resolve-revision',
    'actions/checkout@v4',
    'node .github/scripts/xasp-ci.mjs enable-bundle'
  ])
  expect(commands).toContain("-VerifyXasp:($env:XASP_REQUIRE_BUNDLE -eq '1')")
  expect(commands).toContain('installedActivation =')
  const delivery = steps.find(step => step.run === 'node .github/scripts/deliver-windows-acceptance-draft.mjs')
  expect(delivery.if).toBe('inputs.draft_delivery')
  expect(steps.indexOf(delivery)).toBeGreaterThan(steps.findIndex(step => step.name === 'Record exact artifact identity and outstanding manual acceptance'))
})

it.each([
  ['no credential', false, false, false],
  ['token only', true, false, true],
  ['SSH key only', false, true, true],
  ['both credentials', true, true, false]
])('only emits the pinned XASP revision for an unambiguous checkout configuration (%s)', async (_label, token, key, allowed) => {
  const root = await mkdtemp(path.join(tmpdir(), 'hqharness-xasp-checkout-'))
  roots.push(root)
  const output = path.join(root, 'step-output')
  await writeFile(output, '')
  const cli = fileURLToPath(new URL('../.github/scripts/xasp-ci.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'resolve-revision'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output,
      XASP_READ_TOKEN_CONFIGURED: String(token), XASP_READ_KEY_CONFIGURED: String(key) }
  })
  if (allowed) {
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const { revision } = JSON.parse(await readFile(new URL('../scripts/xasp-runtime/lock.json', import.meta.url), 'utf8'))
    expect(await readFile(output, 'utf8')).toBe(`revision=${revision}\n`)
  } else {
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Configure exactly one of XASP_CHECKOUT_KEY or XASP_CHECKOUT_TOKEN')
    expect(await readFile(output, 'utf8')).toBe('')
  }
})

it('authorizes XASP signed artifacts only in the configured private repository', () => {
  const brand = { releaseRepository: env.GITHUB_REPOSITORY }
  const release = { ...env, RELEASE_MODE: 'signed' }
  const calls = []
  const privateRepo = { full_name: env.GITHUB_REPOSITORY, private: true, visibility: 'private' }
  const gh = args => { calls.push(args); return JSON.stringify(privateRepo) }
  expect(() => requirePrivateXaspRelease(release, brand, gh)).not.toThrow()
  expect(() => requirePrivateXaspRelease({ ...release, RELEASE_MODE: 'prerelease' }, brand, gh)).not.toThrow()
  for (const mode of ['release', 'development', 'resign', 'smoke']) {
    expect(() => requirePrivateXaspRelease({ ...release, RELEASE_MODE: mode }, brand, gh)).toThrow('manual signed or prerelease')
  }
  expect(() => requirePrivateXaspRelease({ ...release, GITHUB_EVENT_NAME: 'push' }, brand, gh)).toThrow('manual signed or prerelease')
  expect(() => requirePrivateXaspRelease(release, { releaseRepository: 'elsewhere/repo' }, gh)).toThrow('must match')
  expect(calls).toEqual([['api', `repos/${env.GITHUB_REPOSITORY}`], ['api', `repos/${env.GITHUB_REPOSITORY}`]])
  for (const mismatch of [{ private: false, visibility: 'public' }, { visibility: 'internal' }, { full_name: 'elsewhere/repo' }]) {
    expect(() => requirePrivateXaspRelease(release, brand, () => JSON.stringify({ ...privateRepo, ...mismatch }))).toThrow('exact configured private repository')
  }
})

it('refuses to sign a Windows candidate with an unexpected, absent or mismatched XASP payload', async () => {
  const resources = await mkdtemp(path.join(tmpdir(), 'hqharness-sign-xasp-'))
  roots.push(resources)
  await expect(verifyWindowsSigningInput(resources, false)).resolves.toBeUndefined()
  await expect(verifyWindowsSigningInput(resources, true)).rejects.toThrow('ENOENT')
  const runtime = path.join(resources, 'xasp-runtime')
  await mkdir(runtime)
  const manifest = path.join(runtime, 'manifest.json')
  const { revision } = JSON.parse(await readFile(new URL('../scripts/xasp-runtime/lock.json', import.meta.url), 'utf8'))
  const enabled = { format: 1, enabled: true, revision, platform: 'win32', arch: 'x64' }
  await writeFile(manifest, JSON.stringify(enabled))
  await expect(verifyWindowsSigningInput(resources, true)).resolves.toBeUndefined()
  await expect(verifyWindowsSigningInput(resources, false)).rejects.toThrow('requested XASP bundle state')
  for (const mismatch of [{ revision: '0'.repeat(40) }, { platform: 'darwin' }, { arch: 'arm64' }]) {
    await writeFile(manifest, JSON.stringify({ ...enabled, ...mismatch }))
    await expect(verifyWindowsSigningInput(resources, true)).rejects.toThrow('locked revision and Windows x64 target')
  }
})

it('requires private validation before native XASP release builds and installation before delivery', async () => {
  const release = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  expect(release.on.workflow_dispatch.inputs.xasp_bundle).toMatchObject({ type: 'boolean', default: false })
  const validate = release.jobs['validate-dispatch'].steps.find(step => step.run?.includes('verify-private-release'))
  expect(validate.if).toBe("github.event_name == 'workflow_dispatch' && inputs.xasp_bundle")
  for (const name of ['macos', 'windows-x64']) {
    const job = release.jobs[name]
    expect(job.needs).toBe('validate-dispatch')
    const checkout = job.steps.find(step => step.uses === './.github/actions/prepare-private-xasp')
    expect(checkout.if).toBe(validate.if)
    expect(checkout.with).toEqual({
      'read-token': '${{ secrets.XASP_CHECKOUT_TOKEN }}',
      'read-key': '${{ secrets.XASP_CHECKOUT_KEY }}'
    })
    expect(job.steps.indexOf(checkout)).toBeLessThan(job.steps.findIndex(step => step.run === 'npm run build'))
  }
  const mac = release.jobs.macos.steps
  const macProbe = mac.findIndex(step => step.run?.includes('scripts/xasp-runtime/verify-installed.mjs'))
  expect(macProbe).toBeGreaterThanOrEqual(0)
  expect(mac[macProbe].run).toContain('hdiutil attach -readonly')
  expect(macProbe).toBeLessThan(mac.findIndex(step => step.uses === 'actions/upload-artifact@v4'))
  const smoke = release.jobs['smoke-signed-windows'].steps
  const windowsProbe = smoke.findIndex(step => step.run?.includes('-VerifyXasp:($env:VERIFY_XASP'))
  expect(windowsProbe).toBeGreaterThan(smoke.findIndex(step => step.run === 'npm ci --ignore-scripts'))
  expect(smoke[windowsProbe].env.VERIFY_XASP).toBe("${{ inputs.xasp_bundle && '1' || '' }}")
  const publish = release.jobs['publish-prerelease']
  expect(publish.if).toContain("needs.smoke-signed-windows.result == 'success'")
  const upload = publish.steps.find(step => step.run?.includes('gh release upload')).run
  expect(upload.indexOf('verify-private-release')).toBeGreaterThanOrEqual(0)
  expect(upload.indexOf('verify-private-release')).toBeLessThan(upload.indexOf('gh release upload'))
  expect(upload).toContain(`[ "$existing_prerelease" != 'true' ]`)
})

it('checks the installed OA desktop after native runtime verification in both Windows smoke paths', async () => {
  for (const name of ['smoke-windows-documents-install.ps1', 'smoke-signed-windows-installer.ps1']) {
    const script = await readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8')
    const native = script.indexOf('xasp-runtime/verify.mjs')
    const activation = script.indexOf('xasp-runtime/verify-installed.mjs')
    expect(native).toBeGreaterThanOrEqual(0)
    expect(activation).toBeGreaterThan(native)
    expect(script.slice(activation, activation + 250)).toContain("if ($LASTEXITCODE -ne 0) { throw")
  }
})
