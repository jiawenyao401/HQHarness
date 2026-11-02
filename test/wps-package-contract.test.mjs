import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeResolution } from '@deepseek-ai/dsh-app-boot'

const run = promisify(execFile)
const resolve = createRequire(import.meta.url).resolve
const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function temporary(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}
const lf = text => text.replace(/\r\n/gu, '\n')
const lineEnding = (text, ending) => lf(text).replace(/\n/gu, ending)
async function replayFixture(patchEnding, packageEnding) {
  const directory = await temporary('wps-patch-replay-')
  const packageDirectory = join(directory, 'node_modules/@deepseek-ai/dsh')
  await mkdir(join(packageDirectory, 'lib'), { recursive: true })
  let manifest = lf(await readFile(resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
  // Establish the intended patched endpoint even on a working copy whose
  // existing node_modules predates this change. Only these two copied files
  // participate; neither the root checkout nor its Git metadata is changed.
  if (!Object.hasOwn(JSON.parse(manifest).dependencies, 'hqharness-wps')) {
    manifest = manifest.replace('    "hqharness-automation": "0.1.0",', '    "hqharness-automation": "0.1.0",\n    "hqharness-wps": "0.1.0",')
  }
  const bin = lf(await readFile(resolve('@deepseek-ai/dsh/lib/bin.js'), 'utf8'))
  const patch = await readFile(join(process.cwd(), 'patches/@deepseek-ai+dsh+0.2.0-rc.2.patch'), 'utf8')
  return { directory, packageDirectory, manifest: lineEnding(manifest, packageEnding), bin: lineEnding(bin, packageEnding), patch: lineEnding(patch, patchEnding) }
}
async function writeReplayFixture(fixture) {
  // Windows Git checkout can use CRLF while npm extracts LF. Normalize only
  // temporary text copies, preserving exact hunk headers, counts and context.
  // The checked-out patch, installed files and Git configuration stay intact.
  await writeFile(join(fixture.packageDirectory, 'package.json'), lf(fixture.manifest))
  await writeFile(join(fixture.packageDirectory, 'lib/bin.js'), lf(fixture.bin))
  const patch = join(fixture.directory, 'replay.patch')
  await writeFile(patch, lf(fixture.patch))
  return patch
}

describe('WPS installation and replay contracts', () => {
  it('includes WPS in the actual dsh installation resolution closure', async () => {
    const resolution = await createRuntimeResolution({ installAnchor: resolve('@deepseek-ai/dsh/package.json'), home: await temporary('wps-closure-') })
    const entry = resolution.entries.find(entry => entry.name === 'hqharness-wps')
    expect(entry, 'Run the current dsh patch during dependency installation; a YAML insertion alone does not update the installation closure.').toBeDefined()
    expect(entry?.scope).toBe('installation')
    expect(await realpath(entry.packageDir)).toBe(await realpath('node_modules/hqharness-wps'))
  })
  it.each([
    { checkout: 'LF', patchEnding: '\n', package: 'LF', packageEnding: '\n' },
    { checkout: 'CRLF', patchEnding: '\r\n', package: 'LF', packageEnding: '\n' },
    { checkout: 'LF', patchEnding: '\n', package: 'CRLF', packageEnding: '\r\n' },
    { checkout: 'CRLF', patchEnding: '\r\n', package: 'CRLF', packageEnding: '\r\n' }
  ])('replays exact dsh patch headers with $checkout checkout and $package package EOL without recount or repository mutations', async ({ patchEnding, packageEnding }) => {
    const fixture = await replayFixture(patchEnding, packageEnding)
    const patch = await writeReplayFixture(fixture)
    for (const autoCrlf of ['false', 'true']) {
      for (const args of [['--reverse', '--check'], ['--reverse'], ['--check'], []]) await run('git', ['-c', `core.autocrlf=${autoCrlf}`, 'apply', ...args, patch], { cwd: fixture.directory })
      // apply may emit CRLF under core.autocrlf=true. Compare the entire text
      // after the same EOL-only normalization, never ignoring other whitespace.
      expect(lf(await readFile(join(fixture.packageDirectory, 'package.json'), 'utf8'))).toBe(lf(fixture.manifest))
      expect(lf(await readFile(join(fixture.packageDirectory, 'lib/bin.js'), 'utf8'))).toBe(lf(fixture.bin))
    }
  })
  it('still rejects incorrect exact dsh patch hunk counts after newline normalization', async () => {
    const fixture = await replayFixture('\r\n', '\n')
    const corrupt = fixture.patch.replace('@@ -227,7 +227,8 @@', '@@ -227,7 +227,7 @@')
    expect(corrupt).not.toBe(fixture.patch)
    fixture.patch = corrupt
    const patch = await writeReplayFixture(fixture)
    await expect(run('git', ['-c', 'core.autocrlf=true', 'apply', '--reverse', '--check', patch], { cwd: fixture.directory })).rejects.toThrow()
  })
})
