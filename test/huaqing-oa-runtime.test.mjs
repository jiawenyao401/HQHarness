import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { electronExecutable } from '../scripts/electron-node-loader.mjs'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { createHuaqingOaFixture } from './fixtures/huaqing-oa.mjs'

const root = resolve(import.meta.dirname, '..')
const exec = promisify(execFile)

it('discovers the installed reimbursement skill and calls the bundled CLI through the real Harness tool runtime', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'hq-oa-harness-')))
  let fixture
  let runtime
  try {
    fixture = await createHuaqingOaFixture(home)
    const executable = electronExecutable(root)
    const cli = join(root, '.build/huaqing-cli/dist/cli.js')
    const env = { ...process.env, ...fixture.env, ELECTRON_RUN_AS_NODE: '1' }
    delete env.HUAQING_CREDENTIAL_MASTER_KEY
    await exec(executable, [cli, 'auth', 'login', '--provider', 'oa', '--profile', fixture.profile, '--format', 'json', '--non-interactive'], {
      cwd: home, env, timeout: 15_000, windowsHide: true
    })

    const probe = join(home, 'probe.mjs')
    await writeFile(probe, `
import assert from 'node:assert/strict'
export const name = 'huaqing-oa-probe'
export const inject = ['agentLoop', 'tools', 'skills', 'approval']
export async function apply(ctx) {
  for (let attempt = 0; !ctx.tools.get('huaqing_oa'); attempt++) {
    assert(attempt < 100, 'huaqing_oa did not register in the normal profile')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const agent = await ctx.agentLoop.create('huaqing-oa-probe')
  const signal = AbortSignal.timeout(15_000)
  const call = (callId, operation, input, execution) => ctx.tools.execute({
    callId, name: 'huaqing_oa', agent, signal,
    arguments: { operation, profile: ${JSON.stringify(fixture.profile)}, input, ...(execution ? { execution } : {}) }
  })
  const result = await call('fixture-detail', 'oa.workflow.detail', { requestId: ${JSON.stringify(fixture.requestId)} })
  const draft = {
    mode: 'incomplete', travelerName: 'Fixture traveler', applicationDate: '2026-11-07',
    reason: 'Fixture purpose', destination: 'Fixture destination',
    travelDates: { start: '2026-05-18', end: '2026-05-21' }, materials: []
  }
  const preview = await call('fixture-preview', 'oa.expense.draft', draft, { dryRun: true })
  agent.session.append('approval/policy', { policy: 'never' })
  agent.session.append('turn/start', { turn: 1 })
  const denied = await call('fixture-denied', 'oa.expense.draft', draft, { confirm: true, idempotencyKey: 'fixture-draft' })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const skill = await ctx.skills.get('oa-workflow-expense')
  console.log('HUAQING_OA_PROBE:' + JSON.stringify({ result, preview, denied, hasDraftInstructions: skill?.content.includes('oa expense draft') }))
}
`)
    const source = await readFile(join(root, 'build/dsh-desktop.patch.yml'), 'utf8')
    const patch = join(home, 'probe.patch.yml')
    await writeFile(patch, `${source}\n- insert:\n    - id: huaqing-oa-probe\n      name: ${JSON.stringify(pathToFileURL(probe).href)}\n`)
    runtime = new HarnessRuntime({
      dshEntryPath: join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      nodeEntryPath: join(root, 'build/harness-node-entry.mjs'),
      nodeExecutablePath: executable,
      dshPatchPath: patch,
      dshSafePatchPath: join(root, 'build/dsh-desktop-safe.patch.yml'),
      dshHome: join(home, 'harness'),
      logPath: join(home, 'harness.log'),
      startupTimeoutMs: 35_000,
      launchProcess: (file, args, options) => {
        const env = { ...options.env, ...fixture.env, ELECTRON_RUN_AS_NODE: '1' }
        delete env.HUAQING_CREDENTIAL_MASTER_KEY
        return spawn(file, args, { ...options, env })
      },
      onChanged() {}
    })
    await runtime.start(home)
    const snapshot = runtime.snapshot()
    expect(snapshot.phase, snapshot.logs.join('\n')).toBe('ready')
    const marker = 'HUAQING_OA_PROBE:'
    let line
    await expect.poll(() => {
      line = runtime.snapshot().logs.find(item => item.includes(marker))
      return Boolean(line)
    }, { timeout: 15_000, message: 'OA tool call did not finish' }).toBe(true)
    const { result, preview, denied, hasDraftInstructions } = JSON.parse(line.slice(line.indexOf(marker) + marker.length))
    expect(hasDraftInstructions).toBe(true)
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(result.value.envelope.data.requestId).toBe(fixture.requestId)
    expect(preview.value?.envelope?.data, JSON.stringify(preview)).toMatchObject({ dryRun: true, execution: null })
    expect(denied).toMatchObject({ isError: true, error: { info: { code: 'HUAQING_OA_APPROVAL_REQUIRED' } } })
    expect(fixture.requests.some(request => request.operator === fixture.operatorId)).toBe(true)
    expect(fixture.requests.map(request => request.route)).toEqual(['authorize', 'token', 'person', 'detail'])

    const login = await fetch(new URL(`/?token=${encodeURIComponent(snapshot.authToken)}`, snapshot.url), { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const rpc = async (method, request) => {
      const response = await fetch(new URL(`/api/${method}`, snapshot.url), {
        method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args: { request } } })
      })
      const envelope = await response.json()
      expect(envelope.result?.ok, JSON.stringify(envelope)).toBe(true)
      return envelope.result.value
    }
    const session = await rpc('session/create', {})
    const { skills } = await rpc('skills/list', { sessionId: session.sessionId })
    expect(skills).toEqual(expect.arrayContaining(['oa-workflow-expense', 'oa-invoice', 'oa-file', 'huaqing-shared'].map(name => (
      expect.objectContaining({ name, modelInvocable: true })
    ))))
    expect(skills.map(skill => skill.name)).not.toContain('huaqing-qcc')
    expect(skills.map(skill => skill.name)).not.toContain('huaqing-knowledge')
  } finally {
    await runtime?.stop()
    await fixture?.close()
    await rm(home, { recursive: true, force: true })
  }
}, 65_000)
