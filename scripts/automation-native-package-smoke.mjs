import { spawnSync } from 'node:child_process'
import { electronExecutable } from './electron-node-loader.mjs'
import path from 'node:path'

const source = `
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
async function run() {
  const appRoot = process.argv[1]
  const folder = join(appRoot, 'node_modules', '@trycua', 'cua-driver')
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '0.28.0')
  const entry = manifest.exports?.['.']?.import
  assert.equal(typeof entry, 'string')
  const sdk = await import(pathToFileURL(resolve(folder, entry)).href)
  await sdk.uniffiInitAsync()
  const driver = sdk.CuaDriver.create(undefined)
  try {
    const catalog = JSON.parse(await driver.listToolsJson())
    const tools = Array.isArray(catalog) ? catalog : catalog.tools
    for (const name of ['get_desktop_state', 'click', 'type_text', 'press_key', 'scroll', 'drag']) assert(tools.some(tool => tool.name === name), name)
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, electron: process.versions.electron, driver: manifest.version, tools: tools.length, qualification: 'native import/catalog only; GUI input requires manual acceptance' }))
  } finally {
    await driver.shutdown()
    if ('uniffiDestroy' in driver && typeof driver.uniffiDestroy === 'function') driver.uniffiDestroy()
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
`

const [packagedExecutable, appRoot] = process.argv.slice(2)
if ((packagedExecutable && !appRoot) || (!packagedExecutable && appRoot)) throw new Error('Provide both the packaged Electron executable and app.asar path, or neither')
const executable = packagedExecutable ? path.resolve(packagedExecutable) : electronExecutable(process.cwd())
const result = spawnSync(executable, ['-e', source, path.resolve(appRoot ?? process.cwd())], {
  cwd: appRoot ? path.dirname(path.resolve(appRoot)) : process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', timeout: 30_000, windowsHide: true
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Cua native package smoke failed: ${result.status ?? result.signal}`)
