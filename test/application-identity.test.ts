import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { applicationIdentity, applicationUserData } from '../src/main/application-identity'

describe('Huaqing Desktop application identity', () => {
  it('uses a deliberate absolute QA profile without changing the production default', () => {
    const data = resolve('test-app-data')
    expect(applicationUserData(data, false)).toBe(join(data, 'hqharness'))
    expect(applicationUserData(data, true)).toBe(join(data, 'hqharness-dev'))
    expect(applicationUserData(data, false, resolve('isolated-qa'))).toBe(resolve('isolated-qa'))
    expect(() => applicationUserData(data, false, 'relative')).toThrow('absolute')
  })
  it('keeps production and development data separate from each other and upstream', () => {
    const production = applicationIdentity(false)
    const development = applicationIdentity(true)
    expect(production).toEqual({ name: 'Huaqing Desktop', directory: 'hqharness' })
    expect(development).toEqual({ name: 'Huaqing Desktop Dev', directory: 'hqharness-dev' })
    expect(production.directory).not.toBe(development.directory)
    expect([production.directory, development.directory]).not.toContain('dsh-desktop')
    expect([production.directory, development.directory]).not.toContain('dsh-desktop-dev')
  })
})
