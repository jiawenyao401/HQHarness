import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, readdir, stat, open, rename } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { readWpsFailureDetails, type WpsOperation, type WpsCallMeta } from '../../../packages/hqharness-wps/protocol.js'
import { WpsError, type WpsTarget, type WpsDocument } from './connection'

interface Bridge {
  documents(): WpsTarget[]
  resolve(target: WpsTarget): WpsDocument
  execute(target: WpsTarget, operation: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>
  stop(): void
}
export interface WpsConsent {
  kind: 'documents' | 'read' | 'write' | 'save' | 'recover'
  document?: WpsDocument
  outsideWorkspace?: boolean
}
interface Handle { owner: string; target: WpsTarget; identity: string; aliases: string[] }
interface Frame { owner: string; key: string; peer: string; expires: number; disk?: string }
const mutations = new Set(['sheet_write', 'writer_replace', 'slide_text', 'save'])
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const folded = (path: string): string => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) {
    if (!Buffer.isBuffer(chunk)) throw new WpsError('WPS_FILE_CHANGED', 'Cannot verify the local WPS file')
    digest.update(chunk)
  }
  return digest.digest('hex')
}

/** WPS has application privileges, so authorization is enforced here, not
 * inferred from MCP annotations or from the Harness subprocess sandbox. */
export class WpsDocuments {
  private handles = new Map<string, Handle>()
  private frames = new Map<string, Frame>()
  private grants = new Map<string, number>()
  private frozen = new Set<string>()
  private frozenPrimary = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private generation = 0
  private active = new Set<AbortController>()
  constructor(private readonly directory: string, private readonly bridge: Bridge,
    private readonly consent: (request: WpsConsent, signal: AbortSignal) => Promise<boolean>) {}
  async initialize(): Promise<void> {
    await mkdir(join(this.directory, 'operations'), { recursive: true, mode: 0o700 })
    for (const name of await readdir(join(this.directory, 'operations'))) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue
      const path = join(this.directory, 'operations', name)
      const info = await stat(path)
      if (!info.isFile() || info.size > 16_384) throw new WpsError('WPS_RECOVERY_REQUIRED', 'Invalid WPS recovery journal; preserve it and use the recovery settings')
      const entry: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!record(entry) || typeof entry.identity !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.identity)) throw new WpsError('WPS_RECOVERY_REQUIRED', 'Invalid WPS recovery identity')
      if (entry.state === 'started' || entry.state === 'unknown') {
        this.frozenPrimary.add(entry.identity)
        this.frozen.add(entry.identity)
        if (Array.isArray(entry.aliases)) for (const alias of entry.aliases) {
          if (typeof alias !== 'string' || !/^[a-f0-9]{64}$/u.test(alias)) throw new WpsError('WPS_RECOVERY_REQUIRED', 'Invalid WPS recovery alias')
          this.frozen.add(alias)
        }
      }
    }
  }
  stop(): void {
    this.generation++; this.grants.clear(); this.frames.clear(); this.handles.clear()
    for (const controller of this.active) controller.abort(new WpsError('WPS_STOPPED', 'WPS automation was stopped'))
    this.bridge.stop()
  }
  private async identity(document: WpsDocument): Promise<{ identity: string; aliases: string[] }> {
    if (!document.path) {
      const identity = hash(`${document.type}\0unsaved\0${document.name}`)
      return { identity, aliases: [identity] }
    }
    const path = await this.localFile(document.path)
    const info = await stat(path, { bigint: true })
    const identity = hash(`${document.type}\0${folded(path)}`)
    // Canonical paths catch symlinks; a second identity catches hard links.
    // Retain the path identity when WPS atomically replaces a file on save.
    const aliases = [identity, ...(info.ino !== 0n ? [hash(`${document.type}\0file\0${info.dev}\0${info.ino}`)] : [])]
    return { identity, aliases }
  }
  get frozenDocuments(): number { return this.frozenPrimary.size }
  private async approve(request: WpsConsent, owner: string, identity: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const key = `${owner}:${identity}:${request.kind}`
    if (!['save', 'recover'].includes(request.kind) && (this.grants.get(key) ?? 0) > Date.now()) return
    const approved = await this.consent(request, signal)
    signal.throwIfAborted()
    if (!approved) throw new WpsError('WPS_DENIED', 'WPS document access was declined. Wait for a new user instruction.')
    if (this.grants.size >= 512) this.grants.clear()
    this.grants.set(key, Date.now() + 30 * 60_000)
  }
  private async localFile(path: string): Promise<string> {
    // WPS cloud URLs, UNC/network paths and device paths are outside this
    // connector's local-document contract, even in danger-full-access mode.
    if (!isAbsolute(path) || /^[\\/]{2}/u.test(path) || /[\0\r\n]/u.test(path)) throw new WpsError('WPS_UNSUPPORTED_PATH', 'Only regular local WPS files are supported')
    const physical = await realpath(path)
    const info = await stat(physical)
    if (/^[\\/]{2}/u.test(physical) || !info.isFile() || info.size > 256 * 1024 * 1024) throw new WpsError('WPS_UNSUPPORTED_PATH', 'Only regular local WPS files up to 256 MiB are supported')
    return physical
  }
  async execute(operation: WpsOperation, meta: WpsCallMeta, externalSignal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.queued >= 8) throw new WpsError('WPS_BUSY', 'The WPS operation queue is full')
    const generation = this.generation
    this.queued++
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, externalSignal, AbortSignal.timeout(165_000)])
    this.active.add(controller)
    const task = this.tail.catch(() => undefined).then(async () => {
      signal.throwIfAborted()
      if (generation !== this.generation) throw new WpsError('WPS_STOPPED', 'WPS automation was stopped before dispatch')
      return this.perform(operation, meta, signal)
    }).catch((error: unknown) => {
      if (signal.aborted && !(error instanceof WpsError)) {
        const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
        throw new WpsError(timedOut ? 'WPS_TIMEOUT' : 'WPS_STOPPED', timedOut ? 'WPS authorization or queue timed out before dispatch. Bring the Desktop dialog forward and request authorization again; no change was sent.' : 'WPS operation was stopped before a confirmed modification')
      }
      throw error
    }).finally(() => { this.queued--; this.active.delete(controller) })
    this.tail = task
    return task
  }
  private async perform(operation: WpsOperation, meta: WpsCallMeta, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (operation.action === 'status') return { connected: this.bridge.documents().length > 0, component: 'local-wps', frozenDocuments: this.frozenDocuments, supported: process.platform === 'win32' || process.platform === 'darwin' }
    if (operation.action === 'documents') {
      await this.approve({ kind: 'documents' }, meta.owner, 'list', signal)
      const documents = await Promise.all(this.bridge.documents().map(async target => {
        let identity: { identity: string; aliases: string[] }
        try { identity = await this.identity(target.document) }
        catch { return { name: target.document.name, path: target.document.path, type: target.document.type, supported: false, reason: 'WPS_UNSUPPORTED_PATH' } }
        let handle = [...this.handles].find(([, value]) => value.owner === meta.owner && value.target.peer === target.peer && value.target.document.key === target.document.key && value.identity === identity.identity)?.[0]
        if (!handle) {
          if (this.handles.size >= 2048) throw new WpsError('WPS_BUSY', 'Too many WPS document handles; restart the Harness session')
          const priorAliases = [...this.handles.values()].filter(value => value.target.peer === target.peer && value.target.document.key === target.document.key).flatMap(value => value.aliases)
          handle = randomUUID(); this.handles.set(handle, { owner: meta.owner, target, ...identity, aliases: [...new Set([...identity.aliases, ...priorAliases])] })
        }
        const bound = this.handles.get(handle)
        return { ...target.document, key: handle, frozen: bound?.aliases.some(alias => this.frozen.has(alias)) ?? false }
      }))
      return { documents, ...(documents.length ? {} : { guidance: 'Open a local WPS document after enabling the Huaqing Desktop Add-in. WPS must be restarted once after first registration.' }) }
    }
    if (!('key' in operation)) throw new WpsError('WPS_INVALID_INPUT', 'A WPS document key is required')
    const handle = this.handles.get(operation.key)
    if (!handle || handle.owner !== meta.owner) throw new WpsError('WPS_STALE_DOCUMENT', 'List WPS documents again in this session')
    const document = this.bridge.resolve(handle.target)
    const current = await this.identity(document)
    if (current.identity !== handle.identity) throw new WpsError('WPS_STALE_DOCUMENT', 'The WPS document changed its path; list documents again')
    handle.aliases = [...new Set([...handle.aliases, ...current.aliases])]
    const mutating = mutations.has(operation.action)
    if (mutating && handle.aliases.some(alias => this.frozen.has(alias))) throw new WpsError('WPS_UNKNOWN_OUTCOME', 'This document has an unconfirmed operation. Use recover with explicit user confirmation before further writes.', 'unknown')
    if (mutating && meta.policy.mode === 'read-only') throw new WpsError('WPS_READ_ONLY', 'The current Harness policy does not permit WPS document changes')
    if (mutating && document.readOnly) throw new WpsError('WPS_READ_ONLY', 'WPS reports that this document is read-only')
    const path = document.path ? await this.localFile(document.path) : ''
    const root = meta.policy.workspaceRoot ? await realpath(meta.policy.workspaceRoot) : ''
    const outsideWorkspace = Boolean(path && root && folded(path) !== folded(root) && !folded(path).startsWith(folded(root) + (process.platform === 'win32' ? '\\' : '/')))
    await this.approve({ kind: mutating ? 'write' : 'read', document, outsideWorkspace }, meta.owner, handle.identity, signal)
    if (operation.action === 'recover') {
      await this.approve({ kind: 'recover', document }, meta.owner, handle.identity, signal)
      const snapshot = randomUUID()
      const value = await this.bridge.execute(handle.target, { action: 'inspect', snapshot }, signal)
      signal.throwIfAborted()
      if (value.snapshot !== snapshot) throw new WpsError('WPS_PROTOCOL_ERROR', 'WPS recovery did not produce a fresh observation')
      // Resolve all unresolved entries for this document only after a new WPS
      // operation has completed. This never replays the uncertain write.
      for (const name of await readdir(join(this.directory, 'operations'))) {
        signal.throwIfAborted()
        if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue
        const journalPath = join(this.directory, 'operations', name)
        const entry: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
        if (record(entry) && (entry.identity === handle.identity || Array.isArray(entry.aliases) && entry.aliases.some(alias => handle.aliases.includes(String(alias)))) && ['started', 'unknown'].includes(String(entry.state))) {
          await this.store(journalPath, { ...entry, state: 'recovered' })
          if (Array.isArray(entry.aliases)) for (const alias of entry.aliases) this.frozen.delete(String(alias))
          this.frozen.delete(String(entry.identity))
          this.frozenPrimary.delete(String(entry.identity))
        }
      }
      signal.throwIfAborted()
      for (const alias of handle.aliases) this.frozen.delete(alias)
      this.frozenPrimary.delete(handle.identity)
      await this.remember(snapshot, operation.key, handle, meta.owner)
      return { ...value, key: operation.key, recovered: true }
    }
    const snapshot = mutating && 'snapshot' in operation ? operation.snapshot : randomUUID()
    let priorFrame: Frame | undefined
    if (mutating) {
      const frame = typeof snapshot === 'string' ? this.frames.get(snapshot) : undefined
      if (!frame || frame.owner !== meta.owner || frame.key !== operation.key || frame.peer !== handle.target.peer || frame.expires < Date.now()) throw new WpsError('WPS_STALE_SNAPSHOT', 'Read this WPS document or range again before changing it')
      priorFrame = frame
    }
    const nextSnapshot = randomUUID()
    let backup: string | undefined
    let beforeHash: string | undefined
    if (operation.action === 'save') {
      if (!path) throw new WpsError('WPS_UNSAVED_DOCUMENT', 'Save this new document to a local file in WPS first')
      if (!priorFrame?.disk || await this.diskStamp(document.path) !== priorFrame.disk) throw new WpsError('WPS_FILE_CHANGED', 'The local file changed after the last WPS observation. Inspect the document and file before saving.')
      await this.approve({ kind: 'save', document }, meta.owner, handle.identity, signal)
      if (folded(await this.localFile(document.path)) !== folded(path) || await this.diskStamp(document.path) !== priorFrame.disk) throw new WpsError('WPS_FILE_CHANGED', 'The WPS file target changed during save authorization; no save was requested')
      await mkdir(join(this.directory, 'backups'), { recursive: true, mode: 0o700 })
      beforeHash = await hashFile(path, signal)
      backup = join(this.directory, 'backups', `${randomUUID()}.backup`)
      await copyFile(path, backup, constants.COPYFILE_EXCL)
      if (await hashFile(backup, signal) !== beforeHash || await hashFile(path, signal) !== beforeHash) throw new WpsError('WPS_FILE_CHANGED', 'The local file changed while preparing its recovery backup; no save was requested')
    }
    const id = randomUUID()
    const journalPath = join(this.directory, 'operations', `${id}.json`)
    const journal = { identity: handle.identity, aliases: handle.aliases, operation: id, action: operation.action, started: Date.now(), state: 'started', ...(backup ? { backup, path } : {}) }
    if (mutating) {
      await this.store(journalPath, journal)
      this.frames.delete(String(snapshot))
    }
    let dispatched = false
    try {
      signal.throwIfAborted()
      if (operation.action === 'save' && (folded(await this.localFile(document.path)) !== folded(path) || await hashFile(path, signal) !== beforeHash)) throw new WpsError('WPS_FILE_CHANGED', 'The local file changed before WPS save; no save was requested')
      dispatched = true
      const value = await this.bridge.execute(handle.target, { ...operation, snapshot, nextSnapshot, ...(operation.action === 'save' ? { expectedPath: document.path } : {}) }, signal)
      const returned = mutating ? nextSnapshot : snapshot
      if (value.snapshot !== returned) throw new WpsError('WPS_PROTOCOL_ERROR', 'WPS did not return the expected observation identity', mutating ? 'unknown' : 'not_executed')
      let verification: Record<string, unknown> = {}
      if (operation.action === 'save') {
        const savedPath = await this.localFile(document.path)
        const saved = await stat(savedPath)
        if (folded(savedPath) !== folded(path) || !saved.size || value.saved !== true) throw new WpsError('WPS_UNKNOWN_OUTCOME', 'The WPS save result could not be confirmed; preserve the backup', 'unknown')
        verification = { backup, path: savedPath, sha256: await hashFile(savedPath, signal), verification: 'wps_api_and_local_file', coverage: 'observed_content_only' }
      }
      if (mutating) await this.store(journalPath, { ...journal, state: 'completed' })
      await this.remember(String(returned), operation.key, handle, meta.owner, operation.action === 'save' ? undefined : priorFrame?.disk)
      return { ...value, ...verification, key: operation.key, operation: id }
    } catch (error) {
      const knownNotExecuted = !dispatched || error instanceof WpsError && error.outcome === 'not_executed'
      const details = error instanceof WpsError ? readWpsFailureDetails({ causeCode: error.code, completed: error.completed, diagnostic: error.diagnostic }) : {}
      if (mutating) {
        if (!knownNotExecuted) { this.frozenPrimary.add(handle.identity); for (const alias of handle.aliases) this.frozen.add(alias) }
        await this.store(journalPath, { ...journal, state: knownNotExecuted ? 'not_executed' : 'unknown', ...(!knownNotExecuted ? details : {}) })
      }
      if (mutating && !knownNotExecuted) throw new WpsError('WPS_UNKNOWN_OUTCOME', 'A WPS change may have completed partially. It was not retried. Inspect the document and explicitly recover before continuing.' + (details.causeCode ? ` [cause=${details.causeCode}]` : ''), 'unknown', details.completed, details)
      if (!mutating && error instanceof WpsError && error.outcome === 'unknown') {
        if (signal.aborted) throw signal.reason
        throw new WpsError('WPS_READ_TIMEOUT', 'The read-only WPS operation did not complete. Check the document connection before reading again; no write was sent.')
      }
      throw error
    }
  }
  private async diskStamp(path: string): Promise<string> {
    const physical = await this.localFile(path)
    const info = await stat(physical, { bigint: true })
    return JSON.stringify([folded(physical), String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)])
  }
  private async remember(snapshot: string, key: string, handle: Handle, owner: string, priorDisk?: string): Promise<void> {
    for (const [id, frame] of this.frames) if (frame.expires < Date.now() || frame.owner === owner && frame.key === key) this.frames.delete(id)
    if (this.frames.size >= 1024) this.frames.clear()
    const path = this.bridge.resolve(handle.target).path
    this.frames.set(snapshot, { owner, key, peer: handle.target.peer, expires: Date.now() + 5 * 60_000, ...(path ? { disk: priorDisk ?? await this.diskStamp(path) } : {}) })
  }
  private async store(path: string, value: Record<string, unknown>): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
  }
}
