import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  dialog: vi.fn(async (_window: unknown, _options: { detail: string; signal: AbortSignal }) => ({ response: 0 })),
  handlers: new Map<string, (sender: unknown, input?: unknown) => Promise<unknown>>(),
  encrypted: new Map<string, string>(),
  asyncEncryptionAvailable: vi.fn(async () => true)
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: { showMessageBox: electron.dialog },
  ipcMain: {
    handle: (name: string, callback: (sender: unknown, input?: unknown) => Promise<unknown>) => {
      electron.handlers.set(name, callback)
    }
  },
  safeStorage: (() => {
    const encrypt = (value: string) => {
      const blob = `encrypted-fixture-${electron.encrypted.size}`
      electron.encrypted.set(blob, value)
      return Buffer.from(blob)
    }
    const decrypt = (bytes: Buffer) => electron.encrypted.get(bytes.toString())
    return {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'fixture',
      encryptString: encrypt,
      decryptString: decrypt,
      isAsyncEncryptionAvailable: electron.asyncEncryptionAvailable,
      encryptStringAsync: async (value: string) => encrypt(value),
      decryptStringAsync: async (bytes: Buffer) => ({ result: decrypt(bytes), shouldReEncrypt: false })
    }
  })()
}))
import { DesktopOaService } from '../src/main/oa/service'
import type { OaConfigurationInput } from '../src/main/oa/credentials'
import type { OaJob } from '../src/main/oa/job-runner'

const office = resolve(import.meta.dirname, '../.build/office-runtime')
const configuration: OaConfigurationInput = {
  environment: 'test', account: 'wwb', corpid: 'fixture-corp', appKey: 'fixture-key',
  appSecret: 'fixture-secret', tenantKey: 'fixture-tenant', operatorName: '测试人员'
}
const status = { available: true, configured: true, account: configuration.account, operatorName: configuration.operatorName }
const operatorId = '100001'
const fixtureFile = 'OA 原件测试'
const requestId = '900001'
const revision = {
  home: '测试市',
  payment: { payee: '示例收款人', bank: '示例银行', account: '0012345' }
}
const baseJob: OaJob = {
  operation: 'check', workflow: 'oa-business-travel-application', sessionId: 'session-one', intake: {}, materials: []
}

// Use the same spawned Python entry protocol as the packaged worker without OA access.
// A failed child after recording its draft simulates a lost response after a remote save.
const worker = `
import json, os, sys
from pathlib import Path
payload = json.load(sys.stdin)
cfg = payload.get("configuration", {})
op = payload["operation"]
job = Path(payload["jobDir"])
assert Path.cwd().resolve() == job.resolve()
assert not {"HQHARNESS_OA_TOKEN", "OA_APP_SECRET", "HTTPS_PROXY"} & os.environ.keys()
assert ${JSON.stringify(configuration.appSecret)} not in " ".join(sys.argv)
if op == "identity":
    assert cfg["appSecret"] == ${JSON.stringify(configuration.appSecret)}
    print(json.dumps({"ok": True, "operatorId": ${JSON.stringify(operatorId)}, "operatorName": cfg["operatorName"]}))
elif op == "check":
    contents = [Path(material["path"]).read_text(encoding="utf-8") for material in payload["materials"]]
    print(json.dumps({"ok": True, "contents": contents, "configuration": cfg}))
elif op == "draft":
    assert cfg["operatorId"] == ${JSON.stringify(operatorId)}
    assert cfg["appSecret"] == ${JSON.stringify(configuration.appSecret)}
    assert cfg["homeInvoiceSourceFlag"] == 13
    with (job / "saved.txt").open("a", encoding="utf-8") as draft:
        draft.write(${JSON.stringify(requestId + '\n')})
    sys.exit(3)
elif op == "revise":
    draft = job / "saved.txt"
    if draft.is_file():
        assert payload["intake"] == json.loads(${JSON.stringify(JSON.stringify(revision))})
        assert not payload["materials"]
        (job / "revised.txt").write_text(draft.read_text(encoding="utf-8"), encoding="utf-8")
        print(json.dumps({"ok": True, "verified": True, "requestId": draft.read_text(encoding="utf-8").strip()}))
    else:
        print(json.dumps({"ok": False, "code": "DRAFT_NOT_FOUND"}))
elif op == "readback":
    draft = job / "saved.txt"
    if draft.is_file():
        requests = draft.read_text(encoding="utf-8").splitlines()
        print(json.dumps({"ok": True, "verified": True, "requestId": requests[0], "attempts": len(requests),
                          "revised": (job / "revised.txt").is_file()}))
    else:
        print(json.dumps({"ok": False, "code": "DRAFT_NOT_FOUND"}))
`

const fixtures: { directory: string; service: DesktopOaService }[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ directory, service }) => {
    await service.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }))
  electron.dialog.mockReset().mockResolvedValue({ response: 0 })
  electron.asyncEncryptionAvailable.mockReset().mockResolvedValue(true)
  electron.handlers.clear()
  electron.encrypted.clear()
  vi.unstubAllEnvs()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'hq-oa-service-test-'))
  const resources = join(directory, 'resources')
  const userData = join(directory, 'oa')
  const attachments = join(directory, 'attachments')
  const window = Object.assign(new BrowserWindow({ show: false }), {
    isDestroyed: () => false, isVisible: () => true, isFocused: () => true
  })
  const service = new DesktopOaService(userData, attachments, () => window, () => 'zh')
  fixtures.push({ directory, service })
  await mkdir(resources)
  await writeFile(join(resources, 'worker.py'), worker)
  await writeFile(join(resources, 'manifest.json'), JSON.stringify({
    enabled: true, format: 1, platform: process.platform, arch: process.arch,
    testBindings: { account: 'wwb', homeInvoiceSourceFlag: 13 }
  }))
  await service.start(resources, office)
  const environment = service.environment()
  const url = environment.HQHARNESS_OA_URL
  if (!url) throw new Error('Missing OA test endpoint or prepared Office Python')
  const authorization = `Bearer ${environment.HQHARNESS_OA_TOKEN}`
  const trustedSender = {}
  service.registerIpc(sender => {
    if (sender !== trustedSender) throw new Error('Untrusted frame')
  })
  const ipc = (action: 'status' | 'configure' | 'clear', input?: unknown, sender = trustedSender) => {
    const handler = electron.handlers.get(`hq:oa:${action}`)
    if (!handler) throw new Error(`Missing OA handler ${action}`)
    return handler(sender, input)
  }
  const request = (job: unknown, headers: Record<string, string> = { authorization }) => {
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(job) })
  }
  return { service, attachments, userData, ipc, request, authorization }
}

it('verifies credentials over trusted IPC and stages original bytes for a secret-free local check', async () => {
  vi.stubEnv('HQHARNESS_OA_TOKEN', 'ambient-capability')
  vi.stubEnv('OA_APP_SECRET', 'ambient-secret')
  vi.stubEnv('HTTPS_PROXY', 'http://invalid.example')
  const { attachments, userData, ipc, request, authorization } = await setup()
  await expect(ipc('configure', configuration, {})).rejects.toThrow('Untrusted frame')
  await expect(readdir(userData)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(ipc('configure', configuration)).resolves.toEqual({ ok: true, status })
  expect(await readdir(userData)).toEqual(['credentials.bin'])
  expect(await readFile(join(userData, 'credentials.bin'), 'utf8')).toBe('encrypted-fixture-0')

  const bytes = Buffer.from(fixtureFile)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const fileObject = join(attachments, 'file-objects', digest.slice(0, 2), digest)
  await mkdir(dirname(fileObject), { recursive: true })
  await writeFile(fileObject, bytes)
  const job: OaJob = { ...baseJob, materials: [{
    attachmentId: `sha256:${digest}`, name: '原件.txt', bytes: bytes.length, kind: 'attachment'
  }] }

  const deniedHeaders: Record<string, string>[] = [
    { authorization: 'Bearer wrong' }, { authorization, origin: 'https://invalid.example' }
  ]
  for (const headers of deniedHeaders) {
    const response = await request(job, headers)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ ok: false, code: 'OA_ACCESS_DENIED' })
  }
  expect(await (await request(job)).json()).toEqual({ ok: true, contents: [fixtureFile], configuration: { operatorId } })
  expect(await readdir(userData)).toEqual(['credentials.bin'])
  expect(electron.dialog).not.toHaveBeenCalled()

  // The altered bytes have the same length and fail the content-addressed check.
  await writeFile(fileObject, Buffer.alloc(bytes.length))
  expect(await (await request(job)).json()).toEqual({ ok: false, code: 'OA_ATTACHMENT_CHANGED' })
  expect(await readdir(userData)).toEqual(['credentials.bin'])
  await expect(ipc('clear')).resolves.toEqual({ ok: true, status: { available: true, configured: false } })
  expect(await readdir(userData)).toEqual([])
})

it('requires native confirmation and reads back the same draft after a lost worker response', async () => {
  const { userData, ipc, request } = await setup()
  const draft: OaJob = { ...baseJob, operation: 'draft' }
  expect(await (await request(draft)).json()).toEqual({ ok: false, code: 'OA_NOT_CONFIGURED' })
  expect(electron.dialog).not.toHaveBeenCalled()
  await expect(ipc('configure', configuration)).resolves.toEqual({ ok: true, status })
  expect(await (await request(draft)).json()).toEqual({ ok: false, code: 'OA_WRITE_DECLINED' })
  expect(await readdir(userData)).toEqual(['credentials.bin'])

  electron.dialog.mockResolvedValueOnce({ response: 1 })
  expect(await (await request(draft)).json()).toEqual({ ok: false, code: 'OA_UNKNOWN_OUTCOME' })
  const readback: OaJob = { ...baseJob, operation: 'readback' }
  expect(await (await request(readback)).json()).toEqual({ ok: true, verified: true, requestId, attempts: 1, revised: false })
  expect(await (await request({ ...readback, sessionId: 'session-two' })).json())
    .toEqual({ ok: false, code: 'DRAFT_NOT_FOUND' })
  expect(electron.dialog).toHaveBeenCalledTimes(2)
})

it('requires fresh confirmation of the exact revision and keeps it bound to the original session draft', async () => {
  const { ipc, request } = await setup()
  await expect(ipc('configure', configuration)).resolves.toEqual({ ok: true, status })
  const home = { ...baseJob, workflow: 'oa-home-travel-expense' as const }
  electron.dialog.mockResolvedValueOnce({ response: 1 })
  expect(await (await request({ ...home, operation: 'draft' })).json())
    .toEqual({ ok: false, code: 'OA_UNKNOWN_OUTCOME' })

  const update: OaJob = { ...home, operation: 'revise', intake: revision }
  const readback: OaJob = { ...home, operation: 'readback' }
  const file = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'replacement.txt', bytes: 1, kind: 'attachment' }
  for (const invalid of [
    { ...update, intake: { ...revision, requestId: '999999' } },
    { ...update, materials: [file] }
  ]) {
    expect(await (await request(invalid)).json()).toEqual({ ok: false, code: 'OA_INVALID_INPUT' })
  }
  expect(electron.dialog).toHaveBeenCalledTimes(1)
  expect(await (await request(update)).json()).toEqual({ ok: false, code: 'OA_WRITE_DECLINED' })
  expect(await (await request(readback)).json()).toMatchObject({ requestId, attempts: 1, revised: false })

  electron.dialog.mockResolvedValueOnce({ response: 1 })
  expect(await (await request(update)).json()).toEqual({ ok: true, verified: true, requestId })
  expect(electron.dialog.mock.lastCall?.[1].detail).toContain(
    `收款人：${revision.payment.payee}\n开户银行：${revision.payment.bank}\n银行账号：${revision.payment.account}\n居住地：${revision.home}`
  )
  expect(await (await request(readback)).json()).toMatchObject({ requestId, attempts: 1, revised: true })

  electron.dialog.mockResolvedValueOnce({ response: 1 })
  expect(await (await request({ ...update, sessionId: 'session-two' })).json())
    .toEqual({ ok: false, code: 'DRAFT_NOT_FOUND' })
})

it('blocks concurrent work during confirmation and invalidates the pending draft on Harness restart', async () => {
  const { service, userData, ipc, request } = await setup()
  await expect(ipc('configure', configuration)).resolves.toEqual({ ok: true, status })
  let signalOpened: () => void = () => undefined
  const opened = new Promise<void>(resolve => { signalOpened = resolve })
  electron.dialog.mockImplementationOnce(async (_window, { signal }) => new Promise(resolve => {
    // A stale positive response from the native dialog must not authorize a write.
    signal.addEventListener('abort', () => resolve({ response: 1 }), { once: true })
    signalOpened()
  }))
  const pending = request({ ...baseJob, operation: 'draft' })
  await opened
  expect(await (await request(baseJob)).json()).toEqual({ ok: false, code: 'OA_BUSY' })

  const environment = service.environment()
  expect(await (await pending).json()).toMatchObject({ ok: false })
  expect(await readdir(userData)).toEqual(['credentials.bin'])
  expect((await request(baseJob)).status).toBe(403)
  const current = await request(baseJob, { authorization: `Bearer ${environment.HQHARNESS_OA_TOKEN}` })
  expect(await current.json()).toEqual({ ok: true, contents: [], configuration: { operatorId } })
})

it.skipIf(process.platform === 'linux')('keeps the broker responsive and abandons configuration on restart while the native key is pending', async () => {
  const { service, userData, ipc, request } = await setup()
  let signalEntered = () => {}
  let unlock = () => {}
  const entered = new Promise<void>(resolve => { signalEntered = resolve })
  const availability = new Promise<boolean>(resolve => { unlock = () => resolve(true) })
  electron.asyncEncryptionAvailable.mockImplementationOnce(() => {
    signalEntered()
    return availability
  })

  const configure = ipc('configure', configuration)
  await entered
  expect(await (await request(baseJob)).json()).toEqual({ ok: false, code: 'OA_BUSY' })

  service.environment()
  await expect(configure).resolves.toMatchObject({ ok: false })
  unlock()
  expect(await readdir(userData)).toEqual([])
  await expect(ipc('configure', configuration)).resolves.toEqual({ ok: true, status })
})
