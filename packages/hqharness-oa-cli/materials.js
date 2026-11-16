import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const within = (root, path) => {
  const tail = relative(root, path)
  return tail.length > 0 && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
}

const materialDenied = () => new HarnessError(
  'Use regular files in the current workspace or files uploaded by the user to this conversation. Save downloaded files inside the workspace using a new name.',
  'HUAQING_OA_MATERIAL_OUTSIDE_WORKSPACE'
)

/** The model sees the same local path from the Harness attachment projection.
 * Only exact file refs from human messages in this Session grant read access.
 */
function uploadedFiles(ctx, session) {
  const attachments = ctx.get('attachments')
  const files = new Set()
  if (!attachments?.fileHostPath) return files
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue
    for (const block of event.data.content) {
      if (block.type === 'file' && block.attachment) {
        const path = attachments.fileHostPath(block.attachment)
        if (typeof path === 'string' && isAbsolute(path)) files.add(path)
      }
    }
  }
  return files
}

/** OA operations taking original files use path, paths, material.path, and
 * materials[].path. Preserve the single canonical path across prepare/apply.
 * A destination is exclusive, and its real parent must be inside the workspace.
 */
export async function scopeMaterials(ctx, exec, input, allowDestination) {
  const hasDestination = allowDestination && Object.hasOwn(input, 'targetPath')
  const single = Object.hasOwn(input, 'path')
  const multiple = Array.isArray(input.paths)
  const material = record(input.material) && Object.hasOwn(input.material, 'path')
  const materials = Array.isArray(input.materials) && input.materials.some(item => record(item) && Object.hasOwn(item, 'path'))
  if (!hasDestination && !single && !multiple && !material && !materials) return input

  const session = exec.agent?.session
  if (!session?.header?.cwd) throw materialDenied()
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (hasDestination && policy.mode === 'read-only') throw new HarnessError('Enable workspace writes before downloading an OA attachment.', 'HUAQING_OA_WORKSPACE_READ_ONLY')
  try {
    const root = await realpath(policy.workspaceRoot)
    if (root !== await realpath(session.header.cwd) || !(await lstat(root)).isDirectory()) throw materialDenied()
    const validatePath = path => {
      exec.signal?.throwIfAborted()
      if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw materialDenied()
    }
    let uploaded
    const read = async path => {
      validatePath(path)
      const canonical = await realpath(path)
      if (within(root, canonical) && (await lstat(canonical)).isFile()) return canonical
      uploaded ??= uploadedFiles(ctx, session)
      if (uploaded.has(path) && (await lstat(path)).isFile()) return path
      throw materialDenied()
    }

    const normalized = { ...input }
    if (single) normalized.path = await read(input.path)
    if (multiple) {
      if (input.paths.length > 10) throw materialDenied()
      normalized.paths = await Promise.all(input.paths.map(read))
    }
    if (material) normalized.material = { ...input.material, path: await read(input.material.path) }
    if (materials) {
      if (input.materials.length > 10) throw materialDenied()
      normalized.materials = await Promise.all(input.materials.map(async item =>
        record(item) && Object.hasOwn(item, 'path') ? { ...item, path: await read(item.path) } : item))
    }
    if (hasDestination) {
      validatePath(input.targetPath)
      const parent = await realpath(dirname(input.targetPath))
      const destination = join(parent, basename(input.targetPath))
      if (!within(root, destination) || !(await lstat(parent)).isDirectory()) throw materialDenied()
      normalized.targetPath = destination
    }
    return normalized
  } catch {
    exec.signal?.throwIfAborted()
    throw materialDenied()
  }
}
