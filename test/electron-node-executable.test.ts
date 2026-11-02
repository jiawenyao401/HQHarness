import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { electronNodeExecutable } from '../src/main/runtime/electron-node-executable'

const fixtures: string[] = []
afterEach(() => { for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function packagedMacFixture(): { main: string; contents: string } {
  const directory = mkdtempSync(join(tmpdir(), 'huaqing-helper-path-')).replace(/\\/gu, '/')
  fixtures.push(directory)
  const contents = `${directory}/HQHarness.app/Contents`
  mkdirSync(`${contents}/MacOS`, { recursive: true })
  mkdirSync(`${contents}/Frameworks`)
  const main = `${contents}/MacOS/HQHarness`
  writeFileSync(main, 'fixture executable', { mode: 0o755 })
  return { main, contents }
}
function helper(contents: string, name: string): string {
  const directory = `${contents}/Frameworks/${name}.app/Contents/MacOS`
  mkdirSync(directory, { recursive: true })
  const executable = `${directory}/${name}`
  writeFileSync(executable, 'fixture executable', { mode: 0o755 })
  return executable
}

describe('electronNodeExecutable', () => {
  it('uses the actual generic Helper when display and executable names differ', () => {
    const { main, contents } = packagedMacFixture()
    helper(contents, 'Huaqing Desktop Helper (GPU)')
    helper(contents, 'Huaqing Desktop Helper (Renderer)')
    const expected = helper(contents, 'Huaqing Desktop Helper')
    expect(electronNodeExecutable(main, 'darwin')).toBe(expected)
  })
  it('refuses an incomplete or ambiguous real packaged Helper layout', () => {
    const { main, contents } = packagedMacFixture()
    expect(() => electronNodeExecutable(main, 'darwin')).toThrow('generic Electron Helper')
    helper(contents, 'Old Brand Helper')
    helper(contents, 'New Brand Helper')
    expect(() => electronNodeExecutable(main, 'darwin')).toThrow('generic Electron Helper')
  })
  it('refuses a missing Frameworks directory or a directory masquerading as an executable', () => {
    const { main, contents } = packagedMacFixture()
    const fake = `${contents}/Frameworks/Huaqing Desktop Helper.app/Contents/MacOS/Huaqing Desktop Helper`
    mkdirSync(fake, { recursive: true })
    expect(() => electronNodeExecutable(main, 'darwin')).toThrow('generic Electron Helper')
    rmSync(`${contents}/Frameworks`, { recursive: true })
    expect(() => electronNodeExecutable(main, 'darwin')).toThrow('generic Electron Helper directory')
  })
  it('uses the app Helper on macOS', () => {
    const { main, contents } = packagedMacFixture()
    const expected = helper(contents, 'HQHarness Helper')
    expect(electronNodeExecutable(main, 'darwin')).toBe(expected)
    expect(electronNodeExecutable(expected, 'darwin')).toBe(expected)
  })

  it('leaves a standalone Node path unchanged on macOS', () => {
    expect(electronNodeExecutable('/usr/local/bin/node', 'darwin')).toBe('/usr/local/bin/node')
  })

  it('uses the main executable elsewhere', () => {
    expect(electronNodeExecutable('C:\\DSH Desktop\\DSH Desktop.exe', 'win32')).toBe('C:\\DSH Desktop\\DSH Desktop.exe')
    expect(electronNodeExecutable('/opt/dsh/dsh-desktop', 'linux')).toBe('/opt/dsh/dsh-desktop')
  })

  it('resolves an existing binary for the Electron build in use', () => {
    const electron = createRequire(import.meta.url)('electron') as string
    expect(existsSync(electronNodeExecutable(electron))).toBe(true)
  })
})
