/**
 * WPS registration layout and XML span editing are adapted from
 * humoumou1215/wps-assistant, commit dda67065086a46450d0aa72eab77954b61ba42d6.
 * https://github.com/humoumou1215/wps-assistant/blob/dda67065086a46450d0aa72eab77954b61ba42d6/src/addin-registration.ts
 *
 * MIT License — Copyright (c) 2026 humoumou1215
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { SaxesParser } from 'saxes'

const HOSTS = [
  { host: 'et', name: 'HuaqingDesktopET' },
  { host: 'wpp', name: 'HuaqingDesktopWPP' },
  { host: 'wps', name: 'HuaqingDesktopWPS' }
] as const
const MAX_REGISTRY_BYTES = 1024 * 1024
const LOCK_NAME = '.huaqing-desktop-registration.lock'

export interface WpsAddinRegistrationOptions {
  directory: string
  platform: NodeJS.Platform
}

export interface RegisterWpsAddinsOptions extends WpsAddinRegistrationOptions {
  baseUrl: string
}

export interface WpsAddinRegistrationResult {
  changed: boolean
  files: string[]
}

/** Recovery paths belong to this operation, never to a historical backup. */
export class WpsAddinRegistrationError extends Error {
  readonly recoveryPaths: string[]

  constructor(message: string, recoveryPaths: string[], cause: unknown) {
    super(message, { cause })
    this.name = 'WpsAddinRegistrationError'
    this.recoveryPaths = recoveryPaths
  }
}

interface Snapshot {
  bytes: Buffer
  stat: Stats
}

interface Change {
  path: string
  before: Snapshot | null
  after: string
  staged?: string
  stagedSnapshot?: Snapshot
  claimed?: string
  published?: boolean
}

interface XmlSpan {
  name: string
  start: number
  openingEnd: number
  end: number
  closingStart: number
  selfClosing: boolean
  host?: typeof HOSTS[number]
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateOptions(options: WpsAddinRegistrationOptions): string {
  if (options.platform !== 'win32' && options.platform !== 'darwin') throw new Error('WPS Add-ins require Windows or macOS')
  if (typeof options.directory !== 'string' || !isAbsolute(options.directory) || options.directory.includes('\0')) {
    throw new Error('The WPS Add-in directory must be an absolute path')
  }
  return resolve(options.directory)
}

function validateBaseUrl(value: string): void {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/[a-fA-F0-9]{64}$/.exec(value)
  if (!match || Number(match[1]) > 65535) throw new Error('The WPS Add-in URL must use an explicit loopback port and a 64-character hex path')
}

function scanPublish(text: string): { root: XmlSpan; owned: XmlSpan[] } {
  const parser = new SaxesParser({ xmlns: false })
  const stack: XmlSpan[] = []
  const owned: XmlSpan[] = []
  let root: XmlSpan | undefined
  parser.on('error', () => { throw new Error('Invalid WPS publish.xml; no registrations were changed') })
  parser.on('doctype', () => { throw new Error('WPS publish.xml must not contain a document type') })
  parser.on('opentag', (tag) => {
    const span: XmlSpan = {
      name: tag.name,
      start: text.lastIndexOf('<', parser.position - 1),
      openingEnd: parser.position,
      end: parser.position,
      closingStart: parser.position,
      selfClosing: tag.isSelfClosing
    }
    if (stack.length === 0) {
      if (tag.name.toLowerCase() !== 'jsplugins') throw new Error('WPS publish.xml must have a jsplugins root')
      root = span
    } else if (stack.length === 1 && ['jsplugin', 'jspluginonline'].includes(tag.name.toLowerCase())) {
      const name = tag.attributes.name?.toLowerCase()
      span.host = HOSTS.find(host => host.name.toLowerCase() === name)
      if (span.host) owned.push(span)
    }
    stack.push(span)
  })
  parser.on('closetag', () => {
    const span = stack.pop()
    if (!span) throw new Error('Invalid WPS publish.xml nesting')
    span.end = parser.position
    span.closingStart = span.selfClosing ? span.openingEnd : text.lastIndexOf('<', parser.position - 1)
  })
  parser.write(text).close()
  if (!root) throw new Error('WPS publish.xml must have a jsplugins root')
  return { root, owned }
}

function editPublish(text: string, baseUrl?: string): string {
  const { root, owned } = scanPublish(text)
  const edits: { start: number; end: number; text: string }[] = []
  const seen = new Set<string>()
  // WPS's online Add-in enable enum matches upstream's portable installer.
  // This is a per-Add-in value, not a change to macro or global security policy.
  // Loading still needs native verification for the installed WPS build.
  const entry = (host: typeof HOSTS[number]) => `<jspluginonline name="${host.name}" url="${baseUrl}/addins/${host.host}/" type="${host.host}" enable="enable_dev" debug="" install="null"/>`
  for (const span of owned) {
    if (!span.host) continue
    const replacement = baseUrl && !seen.has(span.host.host) ? entry(span.host) : ''
    edits.push({ start: span.start, end: span.end, text: replacement })
    seen.add(span.host.host)
  }
  const missing = baseUrl ? HOSTS.filter(host => !seen.has(host.host)) : []
  if (missing.length) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const additions = missing.map(host => `  ${entry(host)}`).join(eol)
    if (root.selfClosing) {
      edits.push({ start: root.start, end: root.end, text: `${text.slice(root.start, root.openingEnd).replace(/\/>$/, '>')}${eol}${additions}${eol}</${root.name}>` })
    } else {
      const lineStart = text.lastIndexOf('\n', root.closingStart - 1) + 1
      const insertion = /^[\t ]*$/.test(text.slice(lineStart, root.closingStart)) ? lineStart : root.closingStart
      edits.push({ start: insertion, end: insertion, text: `${additions}${eol}` })
    }
  }
  let result = text
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  scanPublish(result)
  return result
}

function editWriterAuth(text: string | null, baseUrl?: string): string | null {
  let parsed: unknown
  try { parsed = text === null ? {} : JSON.parse(text) } catch {
    // JSON parser messages can include registry contents and the bridge token.
    throw new Error('Invalid WPS authaddin.json; no registrations were changed')
  }
  if (!isRecord(parsed) || (parsed.wps !== undefined && !isRecord(parsed.wps))) throw new Error('Invalid WPS authaddin.json; no registrations were changed')
  const writer = parsed.wps ?? {}
  if (!isRecord(writer) || (writer.namelist !== undefined && typeof writer.namelist !== 'string')) throw new Error('Invalid WPS Writer registration list')
  const ids = Object.keys(writer).filter(id => id !== 'namelist' && isRecord(writer[id]) && writer[id].name === 'HuaqingDesktopWPS')
  if (!baseUrl && ids.length === 0) return text
  let retainedId = ids[0]
  if (retainedId === undefined) {
    do { retainedId = randomBytes(16).toString('hex') } while (Object.hasOwn(writer, retainedId))
  }
  for (const id of ids) delete writer[id]
  const names = typeof writer.namelist === 'string' ? writer.namelist.split(';') : []
  const unrelatedNames = names.filter(id => !ids.includes(id))
  if (baseUrl) {
    writer[retainedId] = { enable: true, isload: true, md5: '', mode: 2, name: 'HuaqingDesktopWPS', path: `${baseUrl}/addins/wps/` }
    if (!unrelatedNames.includes(retainedId)) unrelatedNames.push(retainedId)
  }
  writer.namelist = unrelatedNames.join(';')
  parsed.wps = writer
  return JSON.stringify(parsed, null, 2) + '\n'
}

function removeOwnedAuth(text: string | null): string | null {
  if (text === null) return null
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    throw new Error('Invalid WPS authaddin.json; no registrations were changed')
  }
  if (!isRecord(parsed)) throw new Error('Invalid WPS authaddin.json; no registrations were changed')
  const sections: { value: Record<string, unknown>; name: string }[] = []
  for (const { host, name } of HOSTS) {
    const value = parsed[host]
    if (value === undefined) continue
    if (!isRecord(value) || (value.namelist !== undefined && typeof value.namelist !== 'string')) {
      throw new Error(`Invalid WPS ${host} authorization list; no registrations were changed`)
    }
    sections.push({ value, name })
  }
  let changed = false
  for (const { value, name } of sections) {
    // WPS creates ET/WPP authorization records itself, including disabled and
    // unlisted duplicates. Removal owns only this host's exact product name.
    const ids = Object.keys(value).filter(id => id !== 'namelist' && isRecord(value[id]) && value[id].name === name)
    if (!ids.length) continue
    for (const id of ids) delete value[id]
    if (typeof value.namelist === 'string') value.namelist = value.namelist.split(';').filter(id => !ids.includes(id)).join(';')
    changed = true
  }
  return changed ? JSON.stringify(parsed, null, 2) + '\n' : text
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode
}

function sameSnapshot(left: Snapshot | null, right: Snapshot | null): boolean {
  return left === null || right === null ? left === right : sameIdentity(left.stat, right.stat) && left.bytes.equals(right.bytes)
}

async function readRegistry(path: string): Promise<Snapshot | null> {
  let stat: Stats
  try { stat = await fs.lstat(path) } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`WPS registry is not a regular file: ${path}`)
  if (stat.size > MAX_REGISTRY_BYTES) throw new Error(`WPS registry exceeds ${MAX_REGISTRY_BYTES} bytes: ${path}`)
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!sameIdentity(stat, opened) || !opened.isFile()) throw new Error(`WPS registry changed while opening: ${path}`)
    const buffer = Buffer.alloc(MAX_REGISTRY_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (bytesRead > MAX_REGISTRY_BYTES || !sameIdentity(opened, after) || bytesRead !== after.size) throw new Error(`WPS registry changed while reading: ${path}`)
    return { bytes: buffer.subarray(0, bytesRead), stat: after }
  } finally { await handle.close() }
}

function registryText(snapshot: Snapshot | null): string | null {
  return snapshot ? new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes) : null
}

async function writePrepared(path: string, value: string | Buffer, mode: number): Promise<void> {
  const handle = await fs.open(path, 'wx', mode)
  try { await handle.writeFile(value); await handle.sync() } finally { await handle.close() }
}

async function syncDirectory(directory: string): Promise<void> {
  // Node cannot open directory handles for fsync on Windows. File contents are
  // still flushed; the journal and exclusive lock retain crash recovery state.
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function directoryIdentity(directory: string): Promise<Stats> {
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The WPS Add-in directory must not be a symbolic link or a non-directory')
  return stat
}

async function verifyDirectory(directory: string, expected: Stats): Promise<void> {
  const actual = await directoryIdentity(directory)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('The WPS Add-in directory changed during registration')
}

async function assertUnchanged(change: Change): Promise<void> {
  if (!sameSnapshot(change.before, await readRegistry(change.path))) throw new Error(`WPS registry changed concurrently: ${change.path}`)
  if (change.before) {
    if ((change.before.stat.mode & 0o222) === 0) throw new Error(`WPS registry is read-only: ${change.path}`)
    await fs.access(change.path, constants.W_OK)
  }
}

async function restoreClaim(claimed: string, path: string): Promise<void> {
  // A hard link publishes exclusively: it cannot overwrite a concurrent writer.
  await fs.link(claimed, path)
}

async function rollback(changes: Change[], recoveryDirectory: string): Promise<string[]> {
  const failures: string[] = []
  for (const [index, change] of [...changes].reverse().entries()) {
    try {
      if (change.published && change.staged) {
        if (!change.stagedSnapshot || !sameSnapshot(change.stagedSnapshot, await readRegistry(change.path))) throw new Error('A concurrent writer changed the published registry')
        const displaced = join(recoveryDirectory, `rollback-${index}`)
        await fs.rename(change.path, displaced)
        if (!sameSnapshot(change.stagedSnapshot, await readRegistry(displaced))) {
          await restoreClaim(displaced, change.path)
          throw new Error('A concurrent registry was preserved during rollback')
        }
      }
      if (change.claimed) await restoreClaim(change.claimed, change.path)
    } catch (error) {
      failures.push(`${change.path}: ${error instanceof Error ? error.message : 'restore failed'}`)
    }
  }
  return failures
}

async function commitChanges(directory: string, identity: Stats, changes: Change[]): Promise<void> {
  if (changes.length === 0) return
  const recoveryDirectory = await fs.mkdtemp(join(directory, '.huaqing-wps-registration-'))
  try {
    await fs.chmod(recoveryDirectory, 0o700)
    for (const [index, change] of changes.entries()) {
      change.staged = join(recoveryDirectory, `after-${index}`)
      await writePrepared(change.staged, change.after, change.before ? change.before.stat.mode & 0o777 : 0o600)
      const staged = await readRegistry(change.staged)
      if (!staged) throw new Error('WPS registry staging disappeared')
      change.stagedSnapshot = staged
      if (change.before) await writePrepared(join(recoveryDirectory, `before-${index}`), change.before.bytes, 0o600)
    }
    await writePrepared(join(recoveryDirectory, 'transaction.json'), JSON.stringify({
      version: 1,
      files: changes.map((change, index) => ({ path: change.path, before: change.before ? `before-${index}` : null, after: `after-${index}`, claimed: `claimed-${index}` }))
    }, null, 2) + '\n', 0o600)
    await syncDirectory(recoveryDirectory)
    await syncDirectory(directory)
    // Check every input, including the second registry, before the first mutation.
    for (const change of changes) await assertUnchanged(change)
    for (const [index, change] of changes.entries()) {
      await verifyDirectory(directory, identity)
      await assertUnchanged(change)
      if (change.before) {
        const claimed = join(recoveryDirectory, `claimed-${index}`)
        await fs.rename(change.path, claimed)
        change.claimed = claimed
        if (!sameSnapshot(change.before, await readRegistry(claimed))) throw new Error(`WPS registry changed while being claimed: ${change.path}`)
      }
      if (!change.staged) throw new Error('WPS registry staging was not completed')
      // rename(temp, live) would overwrite a third party's new file after our
      // last check. Claim + exclusive link instead preserves both versions.
      // WPS must be closed: there is a short pathname gap, and a crash leaves
      // the journal and lock for recovery rather than guessing what to restore.
      await fs.link(change.staged, change.path)
      change.published = true
    }
    for (const change of changes) {
      if (!change.stagedSnapshot || !sameSnapshot(change.stagedSnapshot, await readRegistry(change.path))) throw new Error(`WPS registry changed before registration completed: ${change.path}`)
    }
    await syncDirectory(directory)
  } catch (cause) {
    const failures = await rollback(changes, recoveryDirectory)
    throw new WpsAddinRegistrationError(
      `WPS registration failed; recovery material is preserved at ${recoveryDirectory}${failures.length ? `; rollback incomplete: ${failures.join('; ')}` : ''}`,
      [recoveryDirectory], cause
    )
  }
  try { await fs.rm(recoveryDirectory, { recursive: true }) } catch (cause) {
    throw new WpsAddinRegistrationError('WPS registration was updated but recovery-file cleanup failed', [recoveryDirectory], cause)
  }
}

async function updateRegistrations(options: WpsAddinRegistrationOptions, baseUrl?: string): Promise<WpsAddinRegistrationResult> {
  let directory = validateOptions(options)
  if (baseUrl !== undefined) validateBaseUrl(baseUrl)
  try { await directoryIdentity(directory) } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    if (!baseUrl) return { changed: false, files: [] }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await directoryIdentity(directory)
  }
  // Resolve existing parent aliases once; never follow a final directory link.
  directory = await fs.realpath(directory)
  const identity = await directoryIdentity(directory)
  const lockPath = join(directory, LOCK_NAME)
  let lock: fs.FileHandle
  try { lock = await fs.open(lockPath, 'wx', 0o600) } catch (cause) {
    const message = errorCode(cause) === 'EEXIST'
      ? 'Another WPS registration or an interrupted transaction needs recovery before continuing'
      : 'Cannot acquire the WPS registration lock'
    throw new WpsAddinRegistrationError(message, [lockPath], cause)
  }
  const lockIdentity = await lock.stat()
  let operationFailure: unknown
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n')
    await lock.sync()
    const publishPath = join(directory, 'publish.xml')
    const authPath = join(directory, 'authaddin.json')
    const [publish, auth] = await Promise.all([
      readRegistry(publishPath),
      options.platform === 'darwin' ? readRegistry(authPath) : Promise.resolve(null)
    ])
    const publishText = registryText(publish)
    const authText = registryText(auth)
    // Parse both before staging or editing either live registry.
    const nextPublish = publishText === null && !baseUrl ? null : editPublish(publishText ?? '<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n</jsplugins>\n', baseUrl)
    const nextAuth = options.platform === 'darwin'
      ? baseUrl === undefined ? removeOwnedAuth(authText) : editWriterAuth(authText, baseUrl)
      : null
    const changes: Change[] = []
    if (nextPublish !== null && nextPublish !== publishText) changes.push({ path: publishPath, before: publish, after: nextPublish })
    if (nextAuth !== null && nextAuth !== authText) changes.push({ path: authPath, before: auth, after: nextAuth })
    await commitChanges(directory, identity, changes)
    return { changed: changes.length > 0, files: changes.map(change => change.path) }
  } catch (error) {
    operationFailure = error
    throw error
  } finally {
    try {
      await lock.close()
      const current = await fs.lstat(lockPath)
      if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) throw new Error('The WPS registration lock was replaced concurrently')
      await fs.unlink(lockPath)
    } catch (cause) {
      const recoveryPaths = operationFailure instanceof WpsAddinRegistrationError ? operationFailure.recoveryPaths : []
      throw new WpsAddinRegistrationError(
        'WPS registration lock cleanup failed; inspect the registries before retrying',
        [...recoveryPaths, lockPath],
        operationFailure === undefined ? cause : new AggregateError([operationFailure, cause], 'Registry operation and lock cleanup failed')
      )
    }
  }
}

/** Call only after the host has confirmed that WPS documents are closed. */
export async function registerWpsAddins(options: RegisterWpsAddinsOptions): Promise<WpsAddinRegistrationResult> {
  return updateRegistrations(options, options.baseUrl)
}

/** Remove only this product's three registrations, never global WPS policy. */
export async function removeWpsAddins(options: WpsAddinRegistrationOptions): Promise<WpsAddinRegistrationResult> {
  return updateRegistrations(options)
}
