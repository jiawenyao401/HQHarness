import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const [bundle, expectedVersion, platform, arch] = process.argv.slice(2)
const manifestPath = join(bundle, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(manifest.name, '@huaqing/cli')
assert.equal(manifest.version, expectedVersion)
assert.ok(process.versions.electron, 'The OA CLI must run under the packaged Electron')
assert.equal(process.platform, platform)
assert.equal(process.arch, arch)

const app = join(dirname(bundle), 'app.asar')
if (existsSync(app)) {
  const host = createRequire(join(app, 'package.json'))
  const entry = host.resolve('hqharness-oa-cli')
  assert.equal(entry, join(app, 'node_modules', 'hqharness-oa-cli', 'index.js'))
  const plugin = await import(pathToFileURL(entry).href)
  assert.equal(plugin.name, 'hqharness-oa-cli')
  assert.equal(typeof plugin.apply, 'function')
}

const require = createRequire(manifestPath)
for (const dependency of Object.keys(manifest.dependencies)) {
  const path = relative(join(bundle, 'node_modules'), require.resolve(dependency))
  assert.ok(path && !path.startsWith('..') && !isAbsolute(path), `Missing packaged dependency: ${dependency}`)
}
const Database = require('better-sqlite3')
const database = join(process.cwd(), 'oa CLI smoke.sqlite')
const writer = new Database(database)
try {
  writer.exec('CREATE TABLE receipts (id INTEGER); INSERT INTO receipts VALUES (42);')
} finally {
  writer.close()
}
const reader = new Database(database, { readonly: true })
try {
  assert.equal(reader.prepare('SELECT id FROM receipts').get().id, 42)
} finally {
  reader.close()
}
assert.equal(typeof require('@napi-rs/keyring').AsyncEntry, 'function', 'The packaged keyring binding must load')

const { runOperation } = await import(pathToFileURL(join(bundle, 'examples', 'node-process.mjs')).href)

async function cli(operation, input = {}, execution) {
  const result = await runOperation({ operation, input, execution })
  assert.equal(result.issue, null, `${operation} process issue: ${result.issue}`)
  assert.equal(result.exitCode, 0, `${operation} failed: ${result.envelope?.error?.code}`)
  return result.envelope.data
}

const info = await cli('system.info')
assert.deepEqual(info, { version: expectedVersion, node: process.version, platform: process.platform, arch: process.arch })
const skills = await cli('skills.list')
const upstreamById = new Map(skills.skills.map(skill => [skill.id, skill]))
const closure = new Set()
function expectSkill(id) {
  const skill = upstreamById.get(id)
  assert.ok(skill, `Missing upstream skill ${id}`)
  if (closure.has(skill.directory)) return
  closure.add(skill.directory)
  for (const dependency of skill.dependencies) expectSkill(dependency)
}
expectSkill('oa-workflow-expense')
const exported = join(bundle, 'oa-skills')
assert.deepEqual((await readdir(exported)).sort(), [...closure].sort())
const skillManifest = JSON.parse(await readFile(join(bundle, 'skills', 'manifest.json'), 'utf8'))
for (const directory of closure) {
  const root = join(exported, directory)
  const { references = [] } = skillManifest.skills.find(skill => skill.directory === directory)
  const paths = []
  for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (file.isDirectory()) continue
    assert.ok(file.isFile())
    const path = join(file.parentPath, file.name)
    paths.push(relative(root, path))
    const original = join(bundle, 'skills', relative(exported, path))
    assert.deepEqual(await readFile(path), await readFile(original), `Modified exported Skill file: ${path}`)
  }
  assert.deepEqual(paths.sort(), ['SKILL.md', ...references.map(file => join('references', file))].sort())
}
const preview = await cli('oa.expense.draft', {
  mode: 'incomplete',
  travelerName: 'Synthetic traveler',
  applicationDate: '2026-11-07',
  reason: 'Synthetic purpose',
  destination: 'Synthetic destination',
  travelDates: { start: '2026-05-18', end: '2026-05-21' },
  materials: []
}, { dryRun: true })
assert.equal(preview.dryRun, true)
assert.equal(preview.execution, null)
