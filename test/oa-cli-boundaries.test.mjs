import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createAutomationRoutingPolicy } from '../packages/hqharness-automation/tool-routing.js'
import { apply } from '../packages/hqharness-oa-cli/index.js'

const roots = []
const disposers = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(outcome = 'allowed-once', mode = 'workspace-write') {
  const temp = await mkdtemp(join(tmpdir(), 'hqharness-oa-cli-boundaries-'))
  roots.push(temp)
  const dirs = ['docs/generated', 'examples', 'dist', 'oa-skills/oa-workflow-expense', 'workspace', 'outside']
  await Promise.all(dirs.map(path => mkdir(join(temp, path), { recursive: true })))
  await Promise.all([
    cp(resolve('.build/huaqing-cli/docs/generated/command-catalog.json'), join(temp, 'docs/generated/command-catalog.json')),
    writeFile(join(temp, 'dist/cli.js'), ''),
    writeFile(join(temp, 'oa-skills/oa-workflow-expense/SKILL.md'), ''),
    writeFile(join(temp, 'examples/node-process.mjs'), `
      export function runOperation({ operation, input, profile, execution }) {
        if (operation === 'operations.status') {
          return { issue: null, envelope: { ok: true, data: { operation: 'oa.workflow.submit' } } }
        }
        return { operation, input, profile, execution }
      }
    `)
  ])
  const workspace = join(temp, 'workspace')
  const request = vi.fn(async () => outcome)
  const events = []
  const attachments = new Map()
  let definition
  const tools = { get: () => definition, register: tool => { definition = tool } }
  await apply({
    get: name => {
      if (name === 'approval') return { request }
      if (name === 'attachments') return { fileHostPath: ref => attachments.get(ref.attachmentId) }
    },
    plugin: vi.fn(),
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) },
    effect: effect => disposers.push(effect()),
    systemPrompt: { section() {} },
    logger: { error: error => { throw new Error(error) } },
    tools
  }, { resources: temp })
  const agent = { session: { header: { cwd: workspace }, snapshotEvents: () => events } }
  const exec = { agent, name: 'huaqing_oa', callId: 'call1' }
  return { agent, exec, tools, workspace, outside: join(temp, 'outside'), request, events, attachments,
    call: (operation, input, execution) => definition.execute({ operation, profile: 'oa-test', input, ...(execution ? { execution } : {}) }, exec) }
}

it('keeps write approval tied to the actual execution and does not grant it through the JSON confirm option', async () => {
  const { call, request, agent } = await fixture('rejected')
  await expect(call('oa.workflow.submit', { targetRequestId: '123' })).rejects.toMatchObject({ code: 'HUAQING_OA_CONFIRMATION_REQUIRED' })
  expect(request).not.toHaveBeenCalled()
  await expect(call('operations.apply', { executionId: 'original', targetRequestId: '123' }, { confirm: true }))
    .rejects.toMatchObject({ code: 'HUAQING_OA_APPROVAL_REQUIRED' })
  expect(request).toHaveBeenCalledOnce()
  const ask = request.mock.calls[0][0]
  expect(ask.agent).toBe(agent)
  expect(ask.toolName).toBe('huaqing_oa')
  expect(ask.displayReason.zh).toContain('oa.workflow.submit')
  expect(ask.displayReason.zh).toContain('123')
})

it('limits material paths to the current workspace before executing or requesting approval', async () => {
  const { call, outside, workspace, request } = await fixture()
  const allowed = join(workspace, 'approved.pdf')
  await writeFile(allowed, '%PDF-1.7')
  const outsidePath = join(outside, 'outside.pdf')
  await writeFile(outsidePath, '%PDF-1.7')
  await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(call('operations.prepare', { operation: 'oa.expense.draft', materials: [{ path: join(workspace, 'escape', 'outside.pdf') }] }))
    .rejects.toMatchObject({ code: 'HUAQING_OA_MATERIAL_OUTSIDE_WORKSPACE' })
  await expect(call('operations.apply', { executionId: 'original', input: { materials: [{ path: outsidePath }] } }, { confirm: true }))
    .rejects.toMatchObject({ code: 'HUAQING_OA_INVALID_INPUT' })
  await expect(call('oa.invoice.recognize', { path: allowed }, { confirm: true }))
    .resolves.toMatchObject({ operation: 'oa.invoice.recognize', input: { path: await realpath(allowed) } })
  expect(request).toHaveBeenCalledOnce()
})

it('rejects provider changes, download writes in read-only mode, and unreviewed commands', async () => {
  const { call, workspace, request } = await fixture('allowed-once', 'read-only')
  await expect(call('auth.status', { provider: 'agentos' })).rejects.toMatchObject({ code: 'HUAQING_OA_INVALID_INPUT' })
  await expect(call('oa.file.download', { targetPath: join(workspace, 'new.pdf') })).rejects.toMatchObject({ code: 'HUAQING_OA_WORKSPACE_READ_ONLY' })
  await expect(call('api.raw', {})).rejects.toMatchObject({ code: 'HUAQING_OA_OPERATION_UNAVAILABLE' })
  expect(request).not.toHaveBeenCalled()
})

it('admits only exact uploaded material paths from this conversation’s human messages', async () => {
  const { call, outside, events, attachments } = await fixture()
  const uploaded = join(outside, 'original.pdf')
  const unreferenced = join(outside, 'other.pdf')
  await Promise.all([writeFile(uploaded, '%PDF-1.7'), writeFile(unreferenced, '%PDF-1.7')])
  const attachmentId = 'user-file'
  attachments.set(attachmentId, uploaded)
  attachments.set('other-session-file', unreferenced)
  events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'file', attachment: { attachmentId } }] } })
  await expect(call('oa.file.inspect', { paths: [uploaded] })).resolves.toMatchObject({ input: { paths: [uploaded] } })
  await expect(call('oa.file.inspect', { paths: [unreferenced] })).rejects.toMatchObject({ code: 'HUAQING_OA_MATERIAL_OUTSIDE_WORKSPACE' })
})

it('admits one strict PTC wrapper only when the built-in OA definition is registered', async () => {
  const { tools, agent, exec } = await fixture()
  const policy = createAutomationRoutingPolicy(undefined, undefined, tools)
  const ptc = { ...exec, name: 'run_code', arguments: { code: 'return await tools.huaqing_oa({"operation":"system.info","input":{}});' } }
  expect(policy.guard(ptc)).toBeUndefined()
  expect(policy.guard({ ...ptc, arguments: { code: ptc.arguments.code + ' await import("node:fs");' } })).toContain('HQ_ROUTING_DIRECT_REQUIRED')
  expect(createAutomationRoutingPolicy(undefined, undefined, { get: () => ({ name: 'huaqing_oa' }) }).guard(ptc)).toContain('HQ_ROUTING_UNTRUSTED')
  policy.claim({ agent, turn: 1, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '工具模式：全程界面' }] } })
  expect(policy.guard(ptc)).toContain('HQ_ROUTING_PREFERRED')
})
