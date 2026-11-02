import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const run = promisify(execFile)
const asar = require('@electron/asar')
const verifyPackagedWps = require('../scripts/verify-packaged-wps.cjs')
const sourceRoot = fileURLToPath(new URL('../packages/', import.meta.url))
const roots = []
const WPS_FILES = [
  'package.json', 'index.js', 'protocol.js', 'client.js', 'THIRD-PARTY-NOTICES.txt',
  'addin/adapter.js', 'addin/index.html', 'addin/main.js', 'addin/manifest.xml', 'addin/ribbon.xml'
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function collectRuntimeTargets(value, targets = new Set()) {
  if (!value || typeof value !== 'object') return targets
  for (const [condition, target] of Object.entries(value)) {
    if (condition === 'types') continue
    if (typeof target === 'string') targets.add(target.slice(2))
    else collectRuntimeTargets(target, targets)
  }
  return targets
}

async function fixture({ platform = 'win32', mutate = () => {}, unpack } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wps-package-gate-'))
  roots.push(directory)
  const input = path.join(directory, 'input')
  const files = new Map()
  for (const file of WPS_FILES) files.set(`node_modules/hqharness-wps/${file}`, await readFile(path.join(sourceRoot, 'hqharness-wps', file)))
  files.set('node_modules/hqharness-automation/package.json', await readFile(path.join(sourceRoot, 'hqharness-automation/package.json')))
  files.set('node_modules/hqharness-automation/wps-routing.js', await readFile(path.join(sourceRoot, 'hqharness-automation/wps-routing.js')))
  const wps = JSON.parse(files.get('node_modules/hqharness-wps/package.json').toString())
  files.set('node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', dependencies: { 'hqharness-wps': wps.version } }))
  files.set('package.json', JSON.stringify({ dependencies: { '@modelcontextprotocol/client': '2.2.0', '@modelcontextprotocol/server': '2.2.0' } }))
  for (const name of ['client', 'server', 'core']) {
    // Real pinned manifests, tiny non-executable module contents. This tests
    // archive inspection, not an accidental import from the checkout's SDK.
    const manifest = JSON.parse(await readFile(new URL(`../node_modules/@modelcontextprotocol/${name}/package.json`, import.meta.url), 'utf8'))
    const base = `node_modules/@modelcontextprotocol/${name}`
    files.set(`${base}/package.json`, JSON.stringify(manifest))
    for (const target of collectRuntimeTargets(manifest.exports)) files.set(`${base}/${target}`, '// fixture module\n')
    files.set(`${base}/dist/index.mjs`, "import './fixture-chunk.mjs'\n")
    files.set(`${base}/dist/index.cjs`, "require('./fixture-chunk.cjs')\n")
    files.set(`${base}/dist/fixture-chunk.mjs`, 'export {}\n')
    files.set(`${base}/dist/fixture-chunk.cjs`, 'module.exports = {}\n')
  }
  await mutate(files)
  for (const [name, content] of files) {
    const target = path.join(input, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  const context = { electronPlatformName: platform, appOutDir: path.join(directory, 'output'), packager: { appInfo: { productFilename: 'Gate App' } } }
  const resources = ['darwin', 'mas'].includes(platform)
    ? path.join(context.appOutDir, 'Gate App.app/Contents/Resources')
    : path.join(context.appOutDir, 'resources')
  await mkdir(resources, { recursive: true })
  const archive = path.join(resources, 'app.asar')
  // ASAR 3.x resolves with its output WriteStream before the final flush.
  const stream = await asar.createPackageWithOptions(input, archive, unpack ? { unpack } : {})
  await finished(stream)
  return { context, input, archive }
}

function editManifest(files, name, mutate) {
  const value = JSON.parse(files.get(name).toString())
  mutate(value)
  files.set(name, JSON.stringify(value))
}

describe('packaged WPS content gate', () => {
  it.each(['win32', 'darwin', 'mas'])('accepts an actual complete %s ASAR', async platform => {
    const { context } = await fixture({ platform })
    await expect(verifyPackagedWps(context)).resolves.toBeUndefined()
  })

  it('uses its source anchor when invoked from an unrelated cwd', async () => {
    const { context } = await fixture()
    const script = fileURLToPath(new URL('../scripts/verify-packaged-wps.cjs', import.meta.url))
    await run(process.execPath, ['-e', 'require(process.argv[1])(JSON.parse(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1 })', script, JSON.stringify(context)], { cwd: context.appOutDir })
  })

  it('fails at the archive stage when only checkout dependencies exist', async () => {
    const { context, archive } = await fixture()
    await rm(archive)
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:archive]')
  })

  it.each(['addin/manifest.xml', 'addin/ribbon.xml', 'THIRD-PARTY-NOTICES.txt'])('rejects missing required source %s', async file => {
    const { context } = await fixture({ mutate: files => files.delete(`node_modules/hqharness-wps/${file}`) })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:resources] Missing ASAR input:')
  })

  it.each(['index.js', 'protocol.js', 'client.js', 'addin/main.js', 'addin/adapter.js', 'addin/index.html'])('rejects stale packaged bytes in %s', async file => {
    const { context } = await fixture({ mutate: files => files.set(`node_modules/hqharness-wps/${file}`, 'stale source\n') })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:resources] Stale packaged source:')
  })

  it('rejects a WPS manifest with an old SDK declaration', async () => {
    const { context } = await fixture({ mutate: files => editManifest(files, 'node_modules/hqharness-wps/package.json', value => { value.dependencies['@modelcontextprotocol/client'] = '2.0.0' }) })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:wps-manifest]')
  })

  it('rejects an absent installation discovery edge', async () => {
    const { context } = await fixture({ mutate: files => editManifest(files, 'node_modules/@deepseek-ai/dsh/package.json', value => { delete value.dependencies['hqharness-wps'] }) })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:installation] Harness')
  })

  it('rejects a missing SDK core instead of resolving checkout dependencies', async () => {
    const { context } = await fixture({ mutate: files => files.delete('node_modules/@modelcontextprotocol/core/package.json') })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:sdk-manifest]')
  })

  it('rejects a mismatched SDK version', async () => {
    const { context } = await fixture({ mutate: files => editManifest(files, 'node_modules/@modelcontextprotocol/server/package.json', value => { value.version = '2.0.0' }) })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:sdk-manifest] Expected @modelcontextprotocol/server@2.2.0')
  })

  it.each(['dist/index.cjs', 'dist/shimsNode.mjs', 'dist/fixture-chunk.cjs'])('rejects missing SDK entry or internal chunk %s', async file => {
    const { context } = await fixture({ mutate: files => files.delete(`node_modules/@modelcontextprotocol/client/${file}`) })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:sdk-closure] Missing ASAR input:')
  })

  it('rejects SDK export traversal outside its known package', async () => {
    const { context } = await fixture({ mutate: files => editManifest(files, 'node_modules/@modelcontextprotocol/client/package.json', value => { value.exports['.'].import.default = './../server/dist/index.mjs' }) })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:sdk-exports]')
  })

  it('rejects a missing automation public export', async () => {
    const { context } = await fixture({ mutate: files => editManifest(files, 'node_modules/hqharness-automation/package.json', value => { delete value.exports['./wps-routing'] }) })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:automation]')
  })

  it('rejects a stale routing implementation', async () => {
    const { context } = await fixture({ mutate: files => files.set('node_modules/hqharness-automation/wps-routing.js', 'export {}\n') })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:resources] Stale packaged source:')
  })

  it('rejects resources stored outside the archive', async () => {
    const { context } = await fixture({ unpack: '**/addin/main.js' })
    await expect(verifyPackagedWps(context)).rejects.toThrow('[wps-package:resources] Input must be stored inside ASAR:')
  })

  it('rejects an ASAR link even when its target has the expected bytes', async () => {
    const f = await fixture()
    const target = path.join(f.input, 'node_modules/hqharness-wps/addin/main.js')
    await writeFile(path.join(f.input, 'entry.js'), await readFile(target))
    await rm(target)
    await symlink('../../../entry.js', target)
    const stream = await asar.createPackageWithOptions(f.input, f.archive, {})
    await finished(stream)
    await expect(verifyPackagedWps(f.context)).rejects.toThrow('[wps-package:resources] Input must be stored inside ASAR:')
  })

  it('rejects a relative output path rather than consulting cwd', async () => {
    await expect(verifyPackagedWps({ electronPlatformName: 'win32', appOutDir: '.', packager: { appInfo: { productFilename: 'Gate App' } } })).rejects.toThrow('[wps-package:context]')
  })
})
