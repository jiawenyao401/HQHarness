import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('activates both built-in tools through the actual Harness loader and tool schema compiler', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'hq-automation-harness-')))
  const moduleUrl = (name: string) => pathToFileURL(path.join(root, 'node_modules', name, 'lib/index.js')).href
  const config = path.join(home, 'cordis.yml')
  const entry = path.join(home, 'entry.mjs')
  try {
    await writeFile(config, JSON.stringify([
      { id: 'prompt', name: moduleUrl('@deepseek-ai/dsh-system-prompt') },
      { id: 'tools', name: moduleUrl('@deepseek-ai/dsh-tools') },
      { id: 'automation', name: pathToFileURL(path.join(root, 'packages/hqharness-automation/index.js')).href }
    ]))
    await writeFile(entry, `
      import assert from 'node:assert/strict'
      import { boot } from ${JSON.stringify(moduleUrl('@deepseek-ai/dsh-app-boot'))}
      const ctx = await boot('automation-qualification', ${JSON.stringify(config)}, [], ctx => {
        ctx.provide('attachments', { saveImage() { throw new Error('This registration test must not store images') } })
      })
      try {
        const names = ['browser_use', 'computer_use']
        for (const name of names) {
          const definition = ctx.tools.get(name)
          assert(definition && typeof definition.execute === 'function', name + ' did not activate')
          assert.equal(definition.isConcurrencySafe({ action: 'observe' }), false)
        }
        const schemas = ctx.tools.schemas().filter(schema => names.includes(schema.name))
        assert.equal(schemas.length, 2)
        assert(schemas.every(schema => schema.parameters.properties.action))
        console.log('AUTOMATION_HARNESS_PASS ' + JSON.stringify(schemas.map(schema => schema.name)))
      } finally { await ctx.fiber.dispose() }
    `)
    const result = spawnSync(process.execPath, [path.join(root, 'build/harness-node-entry.mjs'), entry], {
      env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 15_000, cwd: home
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('AUTOMATION_HARNESS_PASS ["browser_use","computer_use"]')
  } finally { await rm(home, { recursive: true, force: true }) }
})
