import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { it, expect } from 'vitest'
import { electronExecutable } from '../scripts/electron-node-loader.mjs'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { prepareHostPluginSourcesPatch } from '../src/main/state/host-plugin-sources'
import { ensureSafeModeProfile, SAFE_MODE_PROFILE } from '../src/main/state/safe-mode-profile'

const root = resolve(import.meta.dirname, '..')
const workflows = ['oa-travel-expense', 'oa-home-travel-expense', 'oa-business-travel-application', 'oa-reception-expense']
const original = { name: '出差原件.txt', text: '会话原件测试' }
const replacement = { name: '更新的原件.txt', text: '原件更新测试' }
const fileReference = ({ name, text }) => ({
  attachmentId: `sha256:${createHash('sha256').update(text).digest('hex')}`, name, bytes: Buffer.byteLength(text)
})

it('mounts the bundled OA skills and tool through normal Harness composition and isolates Safe Mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-oa-harness-'))
  const neutral = join(home, 'neutral')
  const resources = process.env.XASP_SOURCE_ROOT ? join(root, '.build/xasp-runtime') : join(home, 'fixture')
  const calls = []
  const token = 'a'.repeat(64)
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    calls.push({ path: request.url, authorized: request.headers.authorization === `Bearer ${token}`, body })
    const materials = body.operation === 'check' && body.materials.length
      ? { materials: body.materials.map((_item, index) => ({ materialIndex: index + 1 })) } : {}
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'GAPS', ...materials }))
  })
  let runtime
  try {
    await mkdir(neutral)
    if (!process.env.XASP_SOURCE_ROOT) {
      for (const name of workflows) {
        const directory = join(resources, 'xasp', 'skill', 'oa', name)
        await mkdir(join(directory, 'references'), { recursive: true })
        await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n# OA\n\n## 执行步骤\nUse Hermes only.\n\n## 业务输入\nRequired facts.\n`)
        await writeFile(join(directory, 'references', 'schema.md'), 'Reference fixture')
      }
      for (const name of ['oa-shared', 'oa-expense-common', 'oa-invoice', 'oa-person', 'oa-workflow']) {
        const directory = join(resources, 'xasp', 'skill', 'common', name)
        await mkdir(join(directory, 'references'), { recursive: true })
        await writeFile(join(directory, 'SKILL.md'), 'Shared fixture')
      }
    }
    await new Promise((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    })
    const dshEntryPath = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    const normal = await prepareHostPluginSourcesPatch(home, join(root, 'build/dsh-desktop.patch.yml'), dshEntryPath)
    const diagnostic = join(home, 'oa-probe.mjs')
    const patch = join(home, 'oa-probe.patch.yml')
    await writeFile(diagnostic, `
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
export const name = 'oa-probe'
export const inject = ['skills', 'tools', 'agents', 'attachments']
export async function apply(ctx) {
  for (let i = 0; i < 100; i++) {
    const tool = ctx.tools.get('oa_business')
    const skill = await ctx.skills.get('oa-business-travel-application')
    if (tool && skill) {
      const exec = { signal: new AbortController().signal, agent: { session: { header: { id: 'probe-session' } } } }
      const result = await tool.execute({ action: 'check', workflow: skill.name }, exec)
      const traversal = await tool.execute({ action: 'reference', workflow: skill.name, reference: '../SKILL.md' }, exec)
      const { agent } = await ctx.agents.create({
        sessionId: 'probe-revise', meta: { cwd: process.cwd() }, agentOptions: { provider: 'test', model: 'test' }
      })
      const revision = { action: 'revise', workflow: skill.name, intake: { city: { index: 1, name: '保定市' } } }
      const withoutUser = await tool.execute(revision, { ...exec, agent })
      agentEvents(ctx, agent).emit('agent/inbox/claimed', {
        message: createUserMessage({ content: [{ type: 'text', text: '请把第一段改为保定市' }], source: { kind: 'user' } }),
        turn: 1
      })
      const revised = await tool.execute(revision, { ...exec, agent })
      const duplicate = await tool.execute(revision, { ...exec, agent })

      async function createAgent(sessionId) {
        return (await ctx.agents.create({
          sessionId, meta: { cwd: process.cwd() }, agentOptions: { provider: 'test', model: 'test' }
        })).agent
      }
      function claim(owner, turn, text, file) {
        agentEvents(ctx, owner).emit('agent/inbox/claimed', {
          message: createUserMessage({
            content: [{ type: 'text', text }, ...(file ? [{ type: 'file', attachment: file }] : [])],
            source: { kind: 'user' }
          }),
          turn
        })
      }
      const withFiles = await createAgent('probe-originals')
      const other = await createAgent('probe-other')
      const unchecked = await createAgent('probe-unchecked')
      const initial = ${JSON.stringify(original)}
      const next = ${JSON.stringify(replacement)}
      const file = await ctx.attachments.saveFile({ name: initial.name, data: Buffer.from(initial.text) })
      const newFile = await ctx.attachments.saveFile({ name: next.name, data: Buffer.from(next.text) })
      const execute = (action, args = {}, owner = withFiles) =>
        tool.execute({ action, workflow: skill.name, ...args }, { ...exec, agent: owner })
      claim(withFiles, 1, '请检查附件', file)
      const checked = await execute('check')
      const originalsReceipt = checked.originalsReceipt
      const selection = { originalsReceipt, materials: [{ index: 1, kind: 'attachment' }] }
      claim(withFiles, 2, '补充文字信息，请保存出差申请')
      const receiptRequired = await execute('draft', { materials: selection.materials })
      const classificationRequired = await execute('draft', { originalsReceipt })
      const wrongWorkflow = await execute('draft', { ...selection, workflow: 'oa-reception-expense' })
      const uncheckedWorkflow = await execute('draft', { workflow: 'oa-reception-expense' })
      claim(other, 1, '新会话尝试使用旧原件')
      const wrongSession = await execute('draft', selection, other)
      claim(other, 2, '只使用本会话文字填写出差申请')
      const noOriginals = await execute('draft', {}, other)
      claim(unchecked, 1, '这是出差证明原件', file)
      claim(unchecked, 2, '请使用上一轮的证明材料保存出差申请')
      const uncheckedOriginals = await execute('draft', {}, unchecked)
      const lateCheck = await execute('check', {}, unchecked)
      const lateSave = await execute('draft', { ...selection, originalsReceipt: lateCheck.originalsReceipt }, unchecked)
      const saved = await execute('draft', selection)
      claim(withFiles, 3, '请补写目的地')
      const revisedAfterCheck = await execute('revise', { intake: revision.intake })
      claim(withFiles, 4, '使用新原件', newFile)
      const replaced = await execute('draft', selection)
      const revisedWithAttachment = await execute('revise', { intake: revision.intake })
      const newCheck = await execute('check')
      claim(withFiles, 5, '替换为普通路径引用 @"/tmp/测试文件.pdf"')
      const unsupported = await execute('draft', { ...selection, originalsReceipt: newCheck.originalsReceipt })
      claim(withFiles, 6, '补充文字')
      const unsupportedFollowup = await execute('draft', { ...selection, originalsReceipt: newCheck.originalsReceipt })
      const readback = await execute('readback', { ...selection, intake: { requestId: 'fixture' } })
      console.log('OA_PROBE:' + JSON.stringify({
        skill: skill.content.includes('## 华擎桌面客户端执行'),
        replacedHermes: !skill.content.includes('Use Hermes only.'),
        result: result.code, traversal: traversal.code,
        withoutUser: withoutUser.code, revised: revised.code, duplicate: duplicate.code,
        checked: typeof originalsReceipt === 'string' && checked.originals?.[0]?.name === initial.name,
        receiptRequired: receiptRequired.code, offeredSameReceipt: receiptRequired.originalsReceipt === originalsReceipt,
        classificationRequired: classificationRequired.code, wrongWorkflow: wrongWorkflow.code,
        uncheckedWorkflow: uncheckedWorkflow.code, wrongSession: wrongSession.code, noOriginals: noOriginals.code,
        uncheckedOriginals: uncheckedOriginals.code,
        lateCheck: typeof lateCheck.originalsReceipt === 'string' && lateCheck.originals?.[0]?.name === initial.name,
        lateSave: lateSave.code,
        saved: saved.code, revisedAfterCheck: revisedAfterCheck.code, replaced: replaced.code,
        revisedWithAttachment: revisedWithAttachment.code,
        newReceipt: typeof newCheck.originalsReceipt === 'string' && newCheck.originalsReceipt !== originalsReceipt,
        unsupported: unsupported.code, unsupportedFollowup: unsupportedFollowup.code, readback: readback.code
      }))
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('OA tool did not activate')
}
`)
    const source = (await readFile(normal, 'utf8')).replace(/resources: !!js process\.env\.DSH_DESKTOP_OA_RESOURCES/u, `resources: ${JSON.stringify(resources)}`)
    await writeFile(patch, `${source}\n- insert:\n    - id: oa-probe\n      name: ${JSON.stringify(pathToFileURL(diagnostic).href)}\n`)
    runtime = new HarnessRuntime({
      dshEntryPath,
      nodeEntryPath: join(root, 'build/harness-node-entry.mjs'),
      nodeExecutablePath: electronExecutable(root),
      dshPatchPath: patch,
      dshSafePatchPath: join(root, 'build/dsh-desktop-safe.patch.yml'),
      dshHome: home,
      logPath: join(home, 'harness.log'),
      preferredPort: 0,
      startupTimeoutMs: 30_000,
      extraEnvironment: () => ({ HQHARNESS_OA_URL: `http://127.0.0.1:${server.address().port}/operation`, HQHARNESS_OA_TOKEN: token }),
      launchProcess: (executable, args, options) => spawn(executable, args, { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' } }),
      onChanged() {}
    })

    const inspect = async () => {
      const snapshot = runtime.snapshot()
      expect(snapshot.phase, snapshot.logs.join('\n')).toBe('ready')
      const login = await fetch(`${snapshot.url}/?token=${encodeURIComponent(snapshot.authToken)}`, { redirect: 'manual' })
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const rpc = async (method, request) => {
        const response = await fetch(new URL(`/api/${method}`, snapshot.url), {
          method: 'POST',
          headers: { Cookie: cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args: { request } } })
        })
        const envelope = await response.json()
        expect(envelope.result?.ok, JSON.stringify(envelope)).toBe(true)
        return envelope.result.value
      }
      const session = await rpc('session/create', {})
      const catalog = await rpc('skills/list', { sessionId: session.sessionId })
      const page = await fetch(snapshot.url, { headers: { Cookie: cookie } })
      return { snapshot, catalog, html: await page.text() }
    }

    await runtime.start(neutral)
    const normalProfile = await inspect()
    const line = normalProfile.snapshot.logs.find(line => line.includes('OA_PROBE:'))
    expect(line, normalProfile.snapshot.logs.join('\n')).toBeDefined()
    expect(JSON.parse(line.slice(line.indexOf('OA_PROBE:') + 9))).toEqual({
      skill: true, replacedHermes: true, result: 'GAPS', traversal: 'OA_REFERENCE_NOT_FOUND',
      withoutUser: 'OA_NEW_USER_TURN_REQUIRED', revised: 'GAPS', duplicate: 'OA_NEW_USER_TURN_REQUIRED',
      checked: true, receiptRequired: 'OA_ORIGINALS_RECEIPT_REQUIRED', offeredSameReceipt: true,
      classificationRequired: 'OA_CLASSIFY_ATTACHMENTS', wrongWorkflow: 'OA_ORIGINALS_CHANGED',
      uncheckedWorkflow: 'OA_ORIGINALS_CHECK_REQUIRED', wrongSession: 'OA_ORIGINALS_CHANGED', noOriginals: 'GAPS',
      uncheckedOriginals: 'OA_ORIGINALS_CHECK_REQUIRED', lateCheck: true, lateSave: 'GAPS',
      saved: 'GAPS', revisedAfterCheck: 'GAPS', replaced: 'OA_ORIGINALS_CHANGED',
      revisedWithAttachment: 'OA_REVISION_REQUIRES_ORIGINAL_DRAFT', newReceipt: true,
      unsupported: 'OA_ORIGINALS_REQUIRED', unsupportedFollowup: 'OA_ORIGINALS_REQUIRED', readback: 'GAPS'
    })
    expect(normalProfile.catalog.skills.filter(skill => workflows.includes(skill.name)).map(skill => skill.name).sort()).toEqual([...workflows].sort())
    expect(normalProfile.html).toContain('hqharness-oa')
    const originalsCall = (operation, materials, intake = {}, sessionId = 'probe-originals') => ({
      path: '/operation', authorized: true, body: {
        workflow: 'oa-business-travel-application', operation, sessionId, intake, materials
      }
    })
    expect(calls).toEqual([
      { path: '/operation', authorized: true, body: {
        workflow: 'oa-business-travel-application', operation: 'check', sessionId: 'probe-session', intake: {}, materials: []
      } },
      { path: '/operation', authorized: true, body: {
        workflow: 'oa-business-travel-application', operation: 'revise', sessionId: 'probe-revise',
        intake: { city: { index: 1, name: '保定市' } }, materials: []
      } },
      originalsCall('check', [{ ...fileReference(original), kind: 'attachment' }]),
      originalsCall('draft', [], {}, 'probe-other'),
      originalsCall('check', [{ ...fileReference(original), kind: 'attachment' }], {}, 'probe-unchecked'),
      originalsCall('draft', [{ ...fileReference(original), kind: 'attachment' }], {}, 'probe-unchecked'),
      originalsCall('draft', [{ ...fileReference(original), kind: 'attachment' }]),
      originalsCall('revise', [], { city: { index: 1, name: '保定市' } }),
      originalsCall('check', [{ ...fileReference(replacement), kind: 'attachment' }]),
      originalsCall('readback', [])
    ])

    await runtime.stop()
    await ensureSafeModeProfile(home)
    await runtime.start(neutral, SAFE_MODE_PROFILE)
    const safe = await inspect()
    expect(safe.catalog.skills.some(skill => workflows.includes(skill.name))).toBe(false)
    expect(safe.html).not.toContain('hqharness-oa')
    expect(calls).toHaveLength(10)
  } finally {
    await runtime?.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}, 90_000)
