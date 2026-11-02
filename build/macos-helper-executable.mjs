import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { posix } from 'node:path'

function executableFile(file) {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch { return false }
}

/** Resolve the generic Electron Helper from an installed bundle's real layout.
 * executableName and productName can differ, so neither label is a safe Helper
 * filename. Renderer/GPU/Plugin helpers are never candidates for Node work. */
export function macHelperExecutable(executable) {
  const macos = posix.dirname(executable)
  const contents = posix.dirname(macos)
  const bundle = posix.dirname(contents)
  // Standalone Node paths are already suitable for Node work.
  if (posix.basename(macos) !== 'MacOS' || posix.basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return executable
  const name = posix.basename(bundle, '.app')
  // A utility process or PTC child can already run under the generic Helper.
  if (name.endsWith(' Helper') && posix.basename(executable) === name) {
    if (!executableFile(executable)) throw new Error(`The generic Electron Helper is not executable: ${executable}`)
    return executable
  }
  const frameworks = posix.join(contents, 'Frameworks')
  let entries
  try { entries = readdirSync(frameworks, { withFileTypes: true }) }
  catch (cause) { throw new Error(`Cannot locate the generic Electron Helper directory: ${frameworks}`, { cause }) }
  const candidates = entries.filter(entry => entry.isDirectory() && entry.name.endsWith(' Helper.app'))
    .map(entry => posix.join(frameworks, entry.name, 'Contents', 'MacOS', entry.name.slice(0, -4)))
    .filter(executableFile)
  if (candidates.length !== 1) throw new Error(`Cannot locate one unique generic Electron Helper in ${frameworks}: found ${candidates.length} executable candidates`)
  return candidates[0]
}
