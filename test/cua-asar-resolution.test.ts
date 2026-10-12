import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
// The generated SDK delegates native-path resolution to this exact published
// dependency; testing it catches a missing/reverted postinstall patch.
const { resolveLibPath }: { resolveLibPath: (options: { crateName: string; callerUrl: string; npmPackageBase: string; tripleStyle: string }) => string } = require('@ubjs/node/typescript/dist/resolve-lib.js')
const directories: string[] = []
const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron')
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  if (originalElectron) Object.defineProperty(process.versions, 'electron', originalElectron)
  else Reflect.deleteProperty(process.versions, 'electron')
})
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hq-cua-asar-')))
  directories.push(root)
  const triple = process.platform === 'win32' ? `win32-${process.arch}-msvc` : `darwin-${process.arch}`
  const relative = path.join('node_modules', `native-${triple}`)
  const folder = path.join(root, 'app.asar', relative)
  const nativeFolder = path.join(root, 'app.asar.unpacked', relative)
  mkdirSync(folder, { recursive: true }); mkdirSync(nativeFolder, { recursive: true })
  writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: `native-${triple}`, version: '1.0.0' }))
  const library = process.platform === 'win32' ? 'fixture.dll' : 'libfixture.dylib'
  const virtual = path.join(folder, library)
  const physical = path.join(nativeFolder, library)
  writeFileSync(virtual, 'virtual'); writeFileSync(physical, 'physical')
  const options = { crateName: 'fixture', callerUrl: pathToFileURL(path.join(root, 'app.asar', 'caller.js')).href, npmPackageBase: 'native-', tripleStyle: 'node' }
  return { virtual, physical, options }
}
describe('Cua SDK ASAR native resolution', () => {
  it.skipIf(!['darwin', 'win32'].includes(process.platform))('uses physical unpacked libraries in Electron and retains normal Node resolution', () => {
    const { virtual, physical, options } = fixture()
    Reflect.deleteProperty(process.versions, 'electron')
    expect(resolveLibPath(options)).toBe(virtual)
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: '44.7.0' })
    expect(resolveLibPath(options)).toBe(physical)
    rmSync(physical)
    expect(() => resolveLibPath(options)).toThrow('layout is malformed')
  })
})
