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

describe('WPS installation and replay contracts', () => {
  it('includes WPS in the actual dsh installation resolution closure', async () => {
    const resolution = await createRuntimeResolution({ installAnchor: resolve('@deepseek-ai/dsh/package.json'), home: await temporary('wps-closure-') })
    const entry = resolution.entries.find(entry => entry.name === 'hqharness-wps')
    expect(entry, 'Run the current dsh patch during dependency installation; a YAML insertion alone does not update the installation closure.').toBeDefined()
    expect(entry?.scope).toBe('installation')
    expect(await realpath(entry.packageDir)).toBe(await realpath('node_modules/hqharness-wps'))
  })
  it('replays the exact dsh patch headers without recount or repository mutations', async () => {
    const directory = await temporary('wps-patch-replay-')
    const packageDirectory = join(directory, 'node_modules/@deepseek-ai/dsh')
    await mkdir(join(packageDirectory, 'lib'), { recursive: true })
    let manifest = await readFile(resolve('@deepseek-ai/dsh/package.json'), 'utf8')
    // Establish the intended patched endpoint even on a working copy whose
    // existing node_modules predates this change. Only these two copied files
    // participate; neither the root checkout nor its Git metadata is changed.
    if (!Object.hasOwn(JSON.parse(manifest).dependencies, 'hqharness-wps')) {
      manifest = manifest.replace('    "hqharness-automation": "0.1.0",', '    "hqharness-automation": "0.1.0",\n    "hqharness-wps": "0.1.0",')
    }
    const bin = await readFile(resolve('@deepseek-ai/dsh/lib/bin.js'), 'utf8')
    await writeFile(join(packageDirectory, 'package.json'), manifest)
    await writeFile(join(packageDirectory, 'lib/bin.js'), bin)
    const patch = join(process.cwd(), 'patches/@deepseek-ai+dsh+0.2.0-rc.2.patch')
    for (const args of [['--reverse', '--check'], ['--reverse'], ['--check'], []]) await run('git', ['apply', ...args, patch], { cwd: directory })
    expect(await readFile(join(packageDirectory, 'package.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(packageDirectory, 'lib/bin.js'), 'utf8')).toBe(bin)
  })
})
