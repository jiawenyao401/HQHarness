import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'

export const OA_WORKFLOWS = [
  'oa-travel-expense', 'oa-home-travel-expense', 'oa-business-travel-application', 'oa-reception-expense'
] as const
export type OaWorkflow = typeof OA_WORKFLOWS[number]
export type OaOperation = 'check' | 'draft' | 'revise' | 'readback'
export const OA_REQUEST_LIMIT = 96 * 1024
const MATERIAL_LIMIT = 20 * 1024 * 1024
const FILE_LIMIT = 12 * 1024 * 1024
const RESULT_LIMIT = 128 * 1024
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.ofd', '.xml', '.docx', '.xlsx', '.txt'])

interface Material {
  attachmentId: string
  bytes: number
  name: string
  kind: 'invoice' | 'attachment'
}

interface OaTestBindings {
  account?: 'lgw' | 'wwb'
  travelWorkflowBinding?: {
    workflowId: string
    formId: string
    schemaSha256: string
    invoiceSourceFlag?: number
  }
  homeInvoiceSourceFlag?: number
}

interface OaRevision {
  payment?: { payee: string; bank: string; account: string }
  home?: string
  city?: { index: number; name: string }
}

export type OaJob = {
  workflow: OaWorkflow
  sessionId: string
  materials: Material[]
} & (
  | { operation: 'revise'; intake: OaRevision }
  | { operation: Exclude<OaOperation, 'revise'>; intake: Record<string, unknown> }
)

export class OaJobError extends Error {
  constructor(readonly code: string) { super(code) }
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function material(value: unknown): value is Material {
  return object(value) && typeof value.attachmentId === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.attachmentId)
    && typeof value.name === 'string' && Buffer.byteLength(value.name) <= 255
    && !/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value.name) && DOCUMENT_EXTENSIONS.has(extname(value.name).toLowerCase())
    && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= FILE_LIMIT
    && (value.kind === 'invoice' || value.kind === 'attachment')
}

function revisionText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\p{C}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new OaJobError('OA_INVALID_INPUT')
  }
  return value.trim()
}

function parseRevision(value: Record<string, unknown>, workflow: OaWorkflow): OaRevision {
  const result: OaRevision = {}
  for (const [key, field] of Object.entries(value)) {
    if (key === 'payment' && workflow !== 'oa-business-travel-application'
      && object(field) && Object.keys(field).length === 3) {
      result.payment = { payee: revisionText(field.payee, 160), bank: revisionText(field.bank, 200), account: revisionText(field.account, 80) }
    } else if (key === 'home' && workflow === 'oa-home-travel-expense') {
      result.home = revisionText(field, 80)
    } else if (key === 'city' && workflow === 'oa-business-travel-application'
      && object(field) && Object.keys(field).length === 2 && typeof field.index === 'number'
      && Number.isSafeInteger(field.index) && field.index >= 1 && field.index <= 120) {
      result.city = { index: field.index, name: revisionText(field.name, 80) }
    } else throw new OaJobError('OA_INVALID_INPUT')
  }
  if (!Object.keys(result).length) throw new OaJobError('OA_INVALID_INPUT')
  return result
}

export function parseOaJob(value: unknown): OaJob {
  if (!object(value)) throw new OaJobError('OA_INVALID_INPUT')
  const workflow = OA_WORKFLOWS.find(name => name === value.workflow)
  if (!workflow || (value.operation !== 'check' && value.operation !== 'draft' && value.operation !== 'revise' && value.operation !== 'readback')
    || typeof value.sessionId !== 'string' || !/^[a-z0-9_-]{1,128}$/iu.test(value.sessionId)
    || !object(value.intake) || Buffer.byteLength(JSON.stringify(value.intake)) > 65_536
    || !Array.isArray(value.materials) || value.materials.length > 8 || !value.materials.every(material)
    || value.materials.reduce((total, item) => total + item.bytes, 0) > MATERIAL_LIMIT
    || new Set(value.materials.map(item => item.attachmentId)).size !== value.materials.length
    || ((value.operation === 'readback' || value.operation === 'revise') && value.materials.length)
    || (value.operation === 'readback' && Object.keys(value.intake).length)) {
    throw new OaJobError('OA_INVALID_INPUT')
  }
  const job = { workflow, sessionId: value.sessionId, materials: value.materials }
  return value.operation === 'revise'
    ? { ...job, operation: value.operation, intake: parseRevision(value.intake, workflow) }
    : { ...job, operation: value.operation, intake: value.intake }
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new OaJobError('OA_STORAGE_UNAVAILABLE')
  }
}

export async function stageMaterials(root: string, destination: string, materials: readonly Material[], signal: AbortSignal) {
  if (!materials.length) return []
  await privateDirectory(destination)
  const canonicalRoot = await realpath(root)
  const files = []
  for (const [index, item] of materials.entries()) {
    signal.throwIfAborted()
    const digest = item.attachmentId.slice(7)
    // Harness's attachment provider stores one canonical file per digest.
    const requested = join(canonicalRoot, 'file-objects', digest.slice(0, 2), digest)
    const source = await realpath(requested)
    const within = relative(canonicalRoot, source)
    if (source !== requested || isAbsolute(within) || within.startsWith(`..${sep}`)) throw new OaJobError('OA_ATTACHMENT_CHANGED')
    const handle = await open(source, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== item.bytes) throw new OaJobError('OA_ATTACHMENT_CHANGED')
      const bytes = Buffer.alloc(item.bytes + 1)
      const result = await handle.read({ buffer: bytes, position: 0 })
      const data = bytes.subarray(0, result.bytesRead)
      if (result.bytesRead !== item.bytes || createHash('sha256').update(data).digest('hex') !== digest) {
        throw new OaJobError('OA_ATTACHMENT_CHANGED')
      }
      const folder = join(destination, `${index + 1}-${digest}`)
      await privateDirectory(folder)
      const path = join(folder, item.name)
      try {
        await writeFile(path, data, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const stat = await lstat(path)
        if (!stat.isFile() || stat.size !== item.bytes || !(await readFile(path)).equals(data)) {
          throw new OaJobError('OA_ATTACHMENT_CHANGED')
        }
      }
      files.push({ path, kind: item.kind })
    } finally {
      await handle.close()
    }
  }
  return files
}

export async function findOaRuntime(resources: string, officeResources: string) {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(resources, 'manifest.json'), 'utf8'))
    if (!object(manifest) || manifest.enabled !== true) return undefined
    if (manifest.format !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw new OaJobError('OA_RUNTIME_UNAVAILABLE')
    }
    const worker = join(resources, 'worker.py')
    const python = join(officeResources, 'primary-runtime', 'dependencies', 'python',
      ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']))
    if (!(await lstat(worker)).isFile() || !(await lstat(await realpath(python))).isFile()) return undefined
    const bindings: OaTestBindings = {}
    if (manifest.testBindings !== undefined) {
      const value = manifest.testBindings
      if (!object(value) || (value.account !== 'lgw' && value.account !== 'wwb')) throw new OaJobError('OA_RUNTIME_UNAVAILABLE')
      bindings.account = value.account
      const travel = value.travelWorkflowBinding
      const home = value.homeInvoiceSourceFlag
      if (travel !== undefined) {
        if (!object(travel) || typeof travel.workflowId !== 'string' || typeof travel.formId !== 'string'
          || typeof travel.schemaSha256 !== 'string'
          || (travel.invoiceSourceFlag !== undefined && typeof travel.invoiceSourceFlag !== 'number')) {
          throw new OaJobError('OA_RUNTIME_UNAVAILABLE')
        }
        bindings.travelWorkflowBinding = {
          workflowId: travel.workflowId, formId: travel.formId, schemaSha256: travel.schemaSha256,
          ...(travel.invoiceSourceFlag !== undefined && { invoiceSourceFlag: travel.invoiceSourceFlag })
        }
      }
      if (home !== undefined) {
        if (typeof home !== 'number') throw new OaJobError('OA_RUNTIME_UNAVAILABLE')
        bindings.homeInvoiceSourceFlag = home
      }
    }
    return { worker, python, bindings }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function runOaWorker(
  runtime: NonNullable<Awaited<ReturnType<typeof findOaRuntime>>>, payload: { operation: string; jobDir: string },
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    // OA configuration travels on stdin. The child inherits neither the
    // Harness capability tokens nor ambient OA, proxy or Python configuration.
    const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8' }
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    const child = spawn(runtime.python, ['-I', '-B', '-X', 'utf8', runtime.worker], {
      cwd: payload.jobDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
    })
    const output: Buffer[] = []
    let size = 0
    let invalid = false
    const stop = () => { child.kill('SIGKILL') }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > RESULT_LIMIT) { invalid = true; stop() }
      else output.push(chunk)
    })
    child.stdin.on('error', () => { /* A closed pipe is handled by the worker result. */ })
    child.once('error', () => {
      signal.removeEventListener('abort', stop)
      reject(new OaJobError('OA_RUNTIME_UNAVAILABLE'))
    })
    child.once('close', (code) => {
      signal.removeEventListener('abort', stop)
      try {
        if (signal.aborted || invalid || code !== 0) throw new Error('worker interrupted')
        const result: unknown = JSON.parse(Buffer.concat(output).toString('utf8'))
        if (!object(result) || typeof result.ok !== 'boolean') throw new Error('invalid worker result')
        resolve(result)
      } catch {
        reject(new OaJobError(payload.operation === 'draft' || payload.operation === 'revise' ? 'OA_UNKNOWN_OUTCOME' : 'OA_RUNTIME_FAILED'))
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}
