import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('HQHarness Profile infrastructure without a market UI', () => {
  it('retains the backend and generation exports without a discoverable browser entry', () => {
    const manifest = JSON.parse(readFileSync(new URL('../packages/dsh-desktop-market-installer/package.json', import.meta.url), 'utf8'))
    expect(manifest.main).toBe('./index.js')
    expect(manifest.exports['./generations/projection']).toBeDefined()
    expect(manifest.dsh?.client).toBeUndefined()
    expect(manifest.exports['./client']).toBeUndefined()
  })
})
