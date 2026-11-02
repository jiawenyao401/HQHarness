import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, symlink, link, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WpsCallMeta, WpsOperation } from '../packages/hqharness-wps/protocol.js'
import { WpsDocuments, type WpsConsent } from '../src/main/wps/documents'
import { WpsError, type WpsDocument, type WpsTarget } from '../src/main/wps/connection'

type Result = Record<string, unknown>
type BridgeHandler = (operation: Result, signal: AbortSignal) => Promise<Result>
const directories: string[] = []
const managers: WpsDocuments[] = []
const mutating = new Set(['sheet_write', 'writer_replace', 'slide_text', 'save'])
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

class FakeBridge {
  readonly calls: Array<{ target: WpsTarget; operation: Result }> = []
  handler: BridgeHandler | undefined
  stops = 0
  constructor(readonly document: WpsDocument) {}
  documents(): WpsTarget[] { return [{ peer: 'peer-one', document: { ...this.document } }] }
  resolve(target: WpsTarget): WpsDocument {
    if (target.peer !== 'peer-one' || target.document.key !== this.document.key) throw new WpsError('WPS_NOT_CONNECTED', 'Document disconnected')
    return { ...this.document }
  }
  async execute(target: WpsTarget, operation: Result, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted()
    this.calls.push({ target, operation })
    if (this.handler) return this.handler(operation, signal)
    return this.result(operation)
  }
  result(operation: Result): Result {
    return {
      snapshot: mutating.has(String(operation.action)) ? operation.nextSnapshot : operation.snapshot,
      text: 'observed body',
      ...(operation.action === 'save' ? { saved: true } : {}),
    }
  }
  stop(): void { this.stops += 1 }
}

function stringField(value: Result, name: string): string {
  const result = value[name]
  if (typeof result !== 'string') throw new Error(`Missing ${name} field in test response`)
  return result
}

function documentList(value: Result): Array<WpsDocument & { frozen: boolean }> {
  if (!Array.isArray(value.documents)) throw new Error('Missing document list')
  return value.documents as Array<WpsDocument & { frozen: boolean }>
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hqharness-wps-documents-')))
  directories.push(directory)
  const workspace = join(directory, 'workspace')
  const state = join(directory, 'state')
  await mkdir(workspace)
  const file = join(workspace, 'document.docx')
  await writeFile(file, 'original on-disk content')
  const bridge = new FakeBridge({ key: 'addin-document-key', name: 'document.docx', path: file, type: 'writer', saved: true, readOnly: false })
  let decision: (request: WpsConsent) => boolean | Promise<boolean> = () => true
  const consent = vi.fn(async (request: WpsConsent, signal: AbortSignal) => {
    signal.throwIfAborted()
    return decision(request)
  })
  function meta(owner = 'session-one'): WpsCallMeta {
    return { owner, policy: { mode: 'workspace-write', workspaceRoot: workspace } }
  }
  function createManager(): WpsDocuments {
    const manager = new WpsDocuments(state, bridge, consent)
    managers.push(manager)
    return manager
  }
  const manager = createManager()
  await manager.initialize()
  const call = (operation: WpsOperation, callMeta = meta(), target = manager) => target.execute(operation, callMeta, new AbortController().signal)
  async function list(callMeta = meta(), target = manager) { return documentList(await call({ action: 'documents' }, callMeta, target)) }
  async function inspect(key: string, callMeta = meta(), target = manager) { return call({ action: 'inspect', key }, callMeta, target) }
  async function journals(): Promise<Result[]> {
    return Promise.all((await readdir(join(state, 'operations'))).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(state, 'operations', name), 'utf8')) as Result))
  }
  return { directory, workspace, state, file, bridge, consent, meta, manager, createManager, call, list, inspect, journals,
    decide: (next: (request: WpsConsent) => boolean | Promise<boolean>) => { decision = next } }
}

function replace(key: string, snapshot: string): WpsOperation {
  return { action: 'writer_replace', key, snapshot, oldText: 'old', replaceText: 'new' }
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('WPS document owner and policy isolation', () => {
  it('binds independent opaque handles, approvals and snapshots to each Harness owner', async () => {
    const f = await fixture()
    const first = (await f.list())[0]
    const secondOwner = f.meta('session-two')
    const second = (await f.list(secondOwner))[0]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    const firstKey = first?.key ?? ''
    const secondKey = second?.key ?? ''
    expect(firstKey).not.toBe(secondKey)
    expect(firstKey).not.toBe(f.bridge.document.key)
    const read = await f.inspect(firstKey)
    const snapshot = stringField(read, 'snapshot')
    await expect(f.inspect(firstKey, secondOwner)).rejects.toMatchObject({ code: 'WPS_STALE_DOCUMENT', outcome: 'not_executed' })
    await expect(f.call(replace(secondKey, snapshot), secondOwner)).rejects.toMatchObject({ code: 'WPS_STALE_SNAPSHOT' })
    const otherRead = await f.inspect(secondKey, secondOwner)
    await expect(f.call(replace(firstKey, stringField(otherRead, 'snapshot')))).rejects.toMatchObject({ code: 'WPS_STALE_SNAPSHOT' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(0)
    expect(f.consent.mock.calls.filter(([request]) => request.kind === 'read')).toHaveLength(2)
    expect(f.bridge.calls[0]?.operation.key).toBe(firstKey)
    expect(f.bridge.calls[0]?.target.document.key).toBe('addin-document-key')
  })

  it('rejects stale/expired snapshots, policy read-only, and WPS read-only without dispatch', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const first = await f.inspect(key)
    const second = await f.inspect(key)
    await expect(f.call(replace(key, stringField(first, 'snapshot')))).rejects.toMatchObject({ code: 'WPS_STALE_SNAPSHOT' })
    const readonly = f.meta()
    readonly.policy.mode = 'read-only'
    await expect(f.call(replace(key, stringField(second, 'snapshot')), readonly)).rejects.toMatchObject({ code: 'WPS_READ_ONLY' })
    f.bridge.document.readOnly = true
    await expect(f.call(replace(key, stringField(second, 'snapshot')))).rejects.toMatchObject({ code: 'WPS_READ_ONLY' })
    f.bridge.document.readOnly = false
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1)
    await expect(f.call(replace(key, stringField(second, 'snapshot')))).rejects.toMatchObject({ code: 'WPS_STALE_SNAPSHOT' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(0)
  })

  it('revokes a changed-path handle and listing provides a working new handle', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    await f.inspect(key)
    const renamed = join(f.workspace, 'renamed.docx')
    await writeFile(renamed, 'human SaveAs result')
    f.bridge.document.path = renamed
    f.bridge.document.name = 'renamed.docx'
    await expect(f.inspect(key)).rejects.toMatchObject({ code: 'WPS_STALE_DOCUMENT' })
    const newKey = (await f.list())[0]?.key ?? ''
    expect(newKey).not.toBe(key)
    await expect(f.inspect(newKey)).resolves.toHaveProperty('snapshot')
  })

  it('maps an unconfirmed read to WPS_READ_TIMEOUT without freezing later confirmed writes', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    f.bridge.handler = async () => { throw new WpsError('WPS_NOT_CONNECTED', 'Read response was lost', 'unknown') }
    await expect(f.inspect(key)).rejects.toMatchObject({ code: 'WPS_READ_TIMEOUT', outcome: 'not_executed' })
    expect((await f.list())[0]?.frozen).toBe(false)
    expect(await f.journals()).toEqual([])
    f.bridge.handler = undefined
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    await expect(f.call(replace(key, snapshot))).resolves.toHaveProperty('snapshot')
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(1)
  })

  it('retains a prior unknown write freeze when a later read times out', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.bridge.handler = async () => { throw new WpsError('WPS_NOT_CONNECTED', 'Operation response was lost', 'unknown') }
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    await expect(f.inspect(key)).rejects.toMatchObject({ code: 'WPS_READ_TIMEOUT' })
    expect((await f.list())[0]?.frozen).toBe(true)
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    expect((await f.journals()).filter(entry => entry.state === 'unknown')).toHaveLength(1)
  })
})

describe('WPS unknown-outcome journal and recovery', () => {
  it('retains safe failure causes and progress in the unknown journal without retaining provider content or replaying', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.bridge.handler = async () => { throw new WpsError('WPS_READBACK_MISMATCH', 'private document body', 'unknown', 1) }
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME', causeCode: 'WPS_READBACK_MISMATCH', outcome: 'unknown', completed: 1 })
    const journal = (await f.journals())[0]
    expect(journal).toMatchObject({ state: 'unknown', causeCode: 'WPS_READBACK_MISMATCH', completed: 1 })
    expect(JSON.stringify(journal)).not.toContain('private document body')
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(1)
  })
  it('persists unknown outcomes across restarts and requires both explicit consent and a fresh completed inspect to recover', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.bridge.handler = async operation => {
      if (operation.action === 'writer_replace') throw new WpsError('WPS_NATIVE_FAILURE', 'Partial write', 'unknown', 1)
      return f.bridge.result(operation)
    }
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME', outcome: 'unknown', completed: 1 })
    expect((await f.journals())[0]).toMatchObject({ state: 'unknown', action: 'writer_replace' })
    expect((await f.list())[0]?.frozen).toBe(true)
    const restarted = f.createManager()
    await restarted.initialize()
    const restartedKey = (await f.list(f.meta(), restarted))[0]?.key ?? ''
    const fresh = stringField(await f.inspect(restartedKey, f.meta(), restarted), 'snapshot')
    await expect(f.call(replace(restartedKey, fresh), f.meta(), restarted)).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    f.decide(request => request.kind !== 'recover')
    const callsBeforeDenial = f.bridge.calls.length
    await expect(f.call({ action: 'recover', key: restartedKey }, f.meta(), restarted)).rejects.toMatchObject({ code: 'WPS_DENIED' })
    expect(f.bridge.calls).toHaveLength(callsBeforeDenial)
    f.decide(() => true)
    f.bridge.handler = async operation => ({ ...f.bridge.result(operation), snapshot: 'wrong-observation' })
    await expect(f.call({ action: 'recover', key: restartedKey }, f.meta(), restarted)).rejects.toMatchObject({ code: 'WPS_PROTOCOL_ERROR' })
    expect((await f.list(f.meta(), restarted))[0]?.frozen).toBe(true)
    expect((await f.journals())[0]?.state).toBe('unknown')
    f.bridge.handler = undefined
    const recovered = await f.call({ action: 'recover', key: restartedKey }, f.meta(), restarted)
    expect(recovered.recovered).toBe(true)
    expect((await f.journals())[0]?.state).toBe('recovered')
    expect((await f.list(f.meta(), restarted))[0]?.frozen).toBe(false)
    await f.call(replace(restartedKey, stringField(recovered, 'snapshot')), f.meta(), restarted)
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(2)
    const cleanRestart = f.createManager()
    await cleanRestart.initialize()
    expect((await f.list(f.meta(), cleanRestart))[0]?.frozen).toBe(false)
    expect(f.consent.mock.calls.filter(([request]) => request.kind === 'recover')).toHaveLength(3)
  })

  it('keeps a crash-started operation frozen regardless of completed/recovered journal file ordering', async () => {
    const f = await fixture()
    const identity = hash('writer\0' + (process.platform === 'win32' ? f.file.toLowerCase() : f.file))
    await writeFile(join(f.state, 'operations', '00000000-0000-0000-0000-000000000001.json'), JSON.stringify({ identity, state: 'started' }))
    await writeFile(join(f.state, 'operations', 'ffffffff-ffff-ffff-ffff-ffffffffffff.json'), JSON.stringify({ identity, state: 'recovered' }))
    const restarted = f.createManager()
    await restarted.initialize()
    expect((await f.list(f.meta(), restarted))[0]?.frozen).toBe(true)
    expect(f.bridge.calls).toHaveLength(0)
  })

  it('does not freeze or replay a write that the add-in proved was not executed', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.bridge.handler = async () => { throw new WpsError('WPS_STALE_SNAPSHOT', 'Before setter', 'not_executed') }
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_STALE_SNAPSHOT', outcome: 'not_executed' })
    expect((await f.journals())[0]?.state).toBe('not_executed')
    expect((await f.list())[0]?.frozen).toBe(false)
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_STALE_SNAPSHOT' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(1)
  })

  it('keeps aliases of the same physical file frozen after symlink or hard-link reopening', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.bridge.handler = async () => { throw new WpsError('WPS_NATIVE_FAILURE', 'Unknown', 'unknown') }
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    const symbolic = join(f.workspace, 'symlink.docx')
    await symlink(f.file, symbolic)
    f.bridge.document.path = symbolic
    f.bridge.document.name = 'symlink.docx'
    expect((await f.list())[0]?.frozen).toBe(true)
    const hard = join(f.workspace, 'hardlink.docx')
    await link(f.file, hard)
    f.bridge.document.path = hard
    f.bridge.document.name = 'hardlink.docx'
    expect((await f.list())[0]?.frozen).toBe(true)
    const restarted = f.createManager()
    await restarted.initialize()
    expect((await f.list(f.meta(), restarted))[0]?.frozen).toBe(true)
  })

  it('inherits an unresolved operation when the same Add-in document is saved under a new path', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.bridge.handler = async () => { throw new WpsError('WPS_NATIVE_FAILURE', 'Unknown partial edit', 'unknown') }
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    const newFile = join(f.workspace, 'saved-as-new-name.docx')
    await writeFile(newFile, 'human SaveAs output after uncertain edit')
    f.bridge.document.path = newFile
    f.bridge.document.name = 'saved-as-new-name.docx'
    const rebound = (await f.list())[0]
    expect(rebound?.key).not.toBe(key)
    expect(rebound?.frozen).toBe(true)
    f.bridge.handler = undefined
    const reboundKey = rebound?.key ?? ''
    const observed = await f.inspect(reboundKey)
    await expect(f.call(replace(reboundKey, stringField(observed, 'snapshot')))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(1)
    const recovered = await f.call({ action: 'recover', key: reboundKey })
    expect(recovered.recovered).toBe(true)
    expect((await f.journals())[0]?.state).toBe('recovered')
    expect((await f.list())[0]?.frozen).toBe(false)
  })

  it('does not unfreeze or mark recovery complete when an inspect returns after stop', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.bridge.handler = async () => { throw new WpsError('WPS_NATIVE_FAILURE', 'Unknown partial edit', 'unknown') }
    await expect(f.call(replace(key, snapshot))).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME' })
    let notifyStarted: (() => void) | undefined
    let returnLate: (() => void) | undefined
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    f.bridge.handler = async operation => new Promise<Result>(resolve => {
      // A WPS invocation already running cannot be physically cancelled. This
      // fake deliberately completes after the stop signal instead of aborting.
      returnLate = () => resolve(f.bridge.result(operation))
      notifyStarted?.()
    })
    const recovering = f.call({ action: 'recover', key }).then(() => ({ code: 'unexpected-success' }), error => error as WpsError)
    await started
    f.manager.stop()
    returnLate?.()
    await expect(recovering).resolves.toMatchObject({ code: 'WPS_STOPPED', outcome: 'not_executed' })
    expect((await f.journals())[0]?.state).toBe('unknown')
    expect((await f.list())[0]?.frozen).toBe(true)
    const restarted = f.createManager()
    await restarted.initialize()
    expect((await f.list(f.meta(), restarted))[0]?.frozen).toBe(true)
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(1)
  })
})

describe('WPS stop and save orchestration', () => {
  it('revokes old document handles on stop without closing the native document', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    await f.inspect(key)
    f.manager.stop()
    await expect(f.inspect(key)).rejects.toMatchObject({ code: 'WPS_STALE_DOCUMENT', outcome: 'not_executed' })
    const current = (await f.list())[0]?.key ?? ''
    expect(current).not.toBe(key)
    await expect(f.inspect(current)).resolves.toHaveProperty('snapshot')
    expect(f.bridge.stops).toBe(1)
    expect(f.bridge.documents()).toHaveLength(1)
    expect(f.consent.mock.calls.filter(([request]) => request.kind === 'documents')).toHaveLength(2)
    expect(f.consent.mock.calls.filter(([request]) => request.kind === 'read')).toHaveLength(2)
  })

  it('stops queued work before dispatch and freezes an in-flight write without retrying it', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    f.bridge.handler = async (_operation, signal) => new Promise<Result>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new WpsError('WPS_UNKNOWN_OUTCOME', 'Native dispatch cannot be undone', 'unknown')), { once: true })
      notifyStarted?.()
    })
    const running = f.call(replace(key, snapshot)).then(() => ({ code: 'unexpected-success' }), error => error as WpsError)
    await started
    const queued = f.call(replace(key, snapshot)).then(() => ({ code: 'unexpected-success' }), error => error as WpsError)
    f.manager.stop()
    await expect(running).resolves.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME', outcome: 'unknown' })
    await expect(queued).resolves.toMatchObject({ code: 'WPS_STOPPED', outcome: 'not_executed' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'writer_replace')).toHaveLength(1)
    expect((await f.journals()).filter(entry => entry.state === 'unknown')).toHaveLength(1)
    expect((await f.list())[0]?.frozen).toBe(true)
  })

  it('backs up the real on-disk original before saving, keeps the backup, and verifies API plus file only', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const read = await f.inspect(key)
    let backupSeenBeforeSave = false
    f.bridge.handler = async operation => {
      if (operation.action === 'save') {
        const backups = await readdir(join(f.state, 'backups'))
        backupSeenBeforeSave = backups.length === 1 && await readFile(join(f.state, 'backups', backups[0] ?? ''), 'utf8') === 'original on-disk content'
        expect(operation.expectedPath).toBe(f.file)
        await writeFile(f.file, 'saved current WPS content including human edits')
      }
      return f.bridge.result(operation)
    }
    const result = await f.call({ action: 'save', key, snapshot: stringField(read, 'snapshot') })
    expect(backupSeenBeforeSave).toBe(true)
    expect(result).toMatchObject({ saved: true, path: f.file, coverage: 'observed_content_only', verification: 'wps_api_and_local_file' })
    expect(result.sha256).toBe(hash('saved current WPS content including human edits'))
    expect(await readFile(stringField(result, 'backup'), 'utf8')).toBe('original on-disk content')
    expect((await f.journals())[0]).toMatchObject({ state: 'completed', backup: result.backup, path: f.file })
    expect(f.consent.mock.calls.filter(([request]) => request.kind === 'save')).toHaveLength(1)
    await expect(f.call({ action: 'save', key, snapshot: stringField(read, 'snapshot') })).rejects.toMatchObject({ code: 'WPS_STALE_SNAPSHOT' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'save')).toHaveLength(1)
  })

  it('retains a save backup after unknown completion and never automatically replays after restart', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.bridge.handler = async operation => {
      if (operation.action === 'save') {
        await writeFile(f.file, 'save may already have completed')
        throw new WpsError('WPS_NOT_CONNECTED', 'Lost response', 'unknown')
      }
      return f.bridge.result(operation)
    }
    await expect(f.call({ action: 'save', key, snapshot })).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME', outcome: 'unknown' })
    const journal = (await f.journals())[0]
    expect(journal).toMatchObject({ state: 'unknown', action: 'save' })
    const backup = stringField(journal ?? {}, 'backup')
    expect(await readFile(backup, 'utf8')).toBe('original on-disk content')
    const restarted = f.createManager()
    await restarted.initialize()
    const reopened = (await f.list(f.meta(), restarted))[0]
    expect(reopened?.frozen).toBe(true)
    expect(f.bridge.calls.filter(call => call.operation.action === 'save')).toHaveLength(1)
    expect(await readFile(f.file, 'utf8')).toBe('save may already have completed')
    expect(await readFile(backup, 'utf8')).toBe('original on-disk content')
  })

  it('requires a separate save confirmation and performs no save or backup when it is declined', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.decide(request => request.kind !== 'save')
    await expect(f.call({ action: 'save', key, snapshot })).rejects.toMatchObject({ code: 'WPS_DENIED' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'save')).toHaveLength(0)
    await expect(readdir(join(f.state, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.file, 'utf8')).toBe('original on-disk content')
  })

  it('refuses save before native dispatch if a symlink target changed during consent', async () => {
    const f = await fixture()
    const alias = join(f.workspace, 'opened-via-link.docx')
    const other = join(f.workspace, 'other-document.docx')
    await symlink(f.file, alias)
    await writeFile(other, 'other document must remain untouched')
    f.bridge.document.path = alias
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    f.decide(async request => {
      if (request.kind === 'save') {
        await unlink(alias)
        await symlink(other, alias)
      }
      return true
    })
    await expect(f.call({ action: 'save', key, snapshot })).rejects.toMatchObject({ outcome: 'not_executed' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'save')).toHaveLength(0)
    expect(await readFile(f.file, 'utf8')).toBe('original on-disk content')
    expect(await readFile(other, 'utf8')).toBe('other document must remain untouched')
  })

  it('rejects save when the on-disk file changed after the observed snapshot', async () => {
    const f = await fixture()
    const key = (await f.list())[0]?.key ?? ''
    const snapshot = stringField(await f.inspect(key), 'snapshot')
    await writeFile(f.file, 'newer external edit that WPS has not observed')
    f.bridge.handler = async operation => {
      if (operation.action === 'save') await writeFile(f.file, 'stale WPS buffer would overwrite the external edit')
      return f.bridge.result(operation)
    }
    await expect(f.call({ action: 'save', key, snapshot })).rejects.toMatchObject({ code: 'WPS_FILE_CHANGED', outcome: 'not_executed' })
    expect(f.bridge.calls.filter(call => call.operation.action === 'save')).toHaveLength(0)
    expect(await readFile(f.file, 'utf8')).toBe('newer external edit that WPS has not observed')
  })
})
