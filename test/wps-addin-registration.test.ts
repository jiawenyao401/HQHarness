import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerWpsAddins, removeWpsAddins, WpsAddinRegistrationError } from '../src/main/wps/addin-registration'

// Keep real filesystem behavior; replace individual operations only to model
// another writer or a failure at a precise transaction boundary.
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const directories: string[] = []
const baseUrl = `http://127.0.0.1:18766/${'a'.repeat(64)}`
const externalPublish = '<?xml version="1.0"?>\n<jsplugins>\n  <!-- Other product: do not remove -->\n  <jspluginonline name="ThirdParty" url="http://localhost:1234/addin/" type="et" enable="enable"/>\n</jsplugins>\n'
const externalAuth = '{\n  "et": { "unrelated": true },\n  "wps": { "abc": { "name": "OtherWriter", "custom": 7 }, "namelist": "abc" }\n}\n'

async function temporaryDirectory() {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'huaqing-wps-registration-')))
  directories.push(directory)
  return directory
}

async function seed() {
  const directory = await temporaryDirectory()
  await fs.writeFile(join(directory, 'publish.xml'), externalPublish)
  await fs.writeFile(join(directory, 'authaddin.json'), externalAuth)
  return directory
}

async function assertOriginals(directory: string) {
  expect(await fs.readFile(join(directory, 'publish.xml'), 'utf8')).toBe(externalPublish)
  expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(externalAuth)
}

async function failureOf(operation: Promise<unknown>): Promise<WpsAddinRegistrationError> {
  try { await operation } catch (error) {
    expect(error).toBeInstanceOf(WpsAddinRegistrationError)
    if (error instanceof WpsAddinRegistrationError) return error
    throw error
  }
  throw new Error('Expected registration to fail')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('WPS Add-in registration', () => {
  it('creates exactly three owned registrations and Mac Writer authorization', async () => {
    const directory = join(await temporaryDirectory(), 'jsaddons')
    const result = await registerWpsAddins({ directory, baseUrl, platform: 'darwin' })
    expect(result).toEqual({ changed: true, files: [join(directory, 'publish.xml'), join(directory, 'authaddin.json')] })
    const publish = await fs.readFile(join(directory, 'publish.xml'), 'utf8')
    for (const [host, suffix] of [['et', 'ET'], ['wpp', 'WPP'], ['wps', 'WPS']]) {
      expect(publish).toContain(`name="HuaqingDesktop${suffix}" url="${baseUrl}/addins/${host}/" type="${host}"`)
    }
    const auth = JSON.parse(await fs.readFile(join(directory, 'authaddin.json'), 'utf8'))
    const id = auth.wps.namelist
    expect(id).toMatch(/^[a-f0-9]{32}$/)
    expect(auth.wps[id]).toEqual({ enable: true, isload: true, md5: '', mode: 2, name: 'HuaqingDesktopWPS', path: `${baseUrl}/addins/wps/` })
    expect(auth.et).toBeUndefined()
    expect(auth.wpp).toBeUndefined()
    expect((await fs.readdir(directory)).sort()).toEqual(['authaddin.json', 'publish.xml'])
  })

  it('uses only publish.xml on Windows and preserves unrelated records and comments', async () => {
    const directory = await seed()
    await registerWpsAddins({ directory, baseUrl, platform: 'win32' })
    const publish = await fs.readFile(join(directory, 'publish.xml'), 'utf8')
    expect(publish).toContain(externalPublish.slice(externalPublish.indexOf('  <!--'), externalPublish.indexOf('</jsplugins>')))
    expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(externalAuth)
  })

  it('is idempotent, updates owned URLs and keeps the existing Writer identity', async () => {
    const directory = await seed()
    await registerWpsAddins({ directory, baseUrl, platform: 'darwin' })
    const original = await fs.readFile(join(directory, 'authaddin.json'), 'utf8')
    const stat = await fs.stat(join(directory, 'publish.xml'))
    expect(await registerWpsAddins({ directory, baseUrl, platform: 'darwin' })).toEqual({ changed: false, files: [] })
    expect((await fs.stat(join(directory, 'publish.xml'))).mtimeMs).toBe(stat.mtimeMs)
    const nextUrl = `http://127.0.0.1:27777/${'B'.repeat(64)}`
    await registerWpsAddins({ directory, baseUrl: nextUrl, platform: 'darwin' })
    const before = JSON.parse(original)
    const after = JSON.parse(await fs.readFile(join(directory, 'authaddin.json'), 'utf8'))
    expect(after.wps.namelist).toBe(before.wps.namelist)
    expect(after.wps.abc).toEqual({ name: 'OtherWriter', custom: 7 })
    expect(after.et).toEqual({ unrelated: true })
    expect(await fs.readFile(join(directory, 'publish.xml'), 'utf8')).not.toContain(baseUrl)
  })

  it('deduplicates owned XML entries without removing unrelated nested content', async () => {
    const directory = await temporaryDirectory()
    const nested = '<other><jspluginonline name="HuaqingDesktopET" value="nested"/></other>'
    await fs.writeFile(join(directory, 'publish.xml'), `<jsplugins><!-- keep -->${nested}<jsplugin name="HuaqingDesktopET"><old/></jsplugin><jspluginonline name="huaqingdesktopet"/></jsplugins>`)
    await registerWpsAddins({ directory, baseUrl, platform: 'win32' })
    const value = await fs.readFile(join(directory, 'publish.xml'), 'utf8')
    expect(value).toContain(`<!-- keep -->${nested}`)
    expect(value.match(/url="[^\"]+\/addins\/et\/"/g)).toHaveLength(1)
    expect(value).not.toContain('<old/>')
  })

  it('supports an empty self-closing root and XML attribute entities', async () => {
    const directory = await temporaryDirectory()
    await fs.writeFile(join(directory, 'publish.xml'), '<?xml version="1.0"?>\r\n<!-- keep -->\r\n<jsplugins />\r\n')
    await registerWpsAddins({ directory, baseUrl, platform: 'win32' })
    expect(await fs.readFile(join(directory, 'publish.xml'), 'utf8')).toContain('<!-- keep -->\r\n<jsplugins >\r\n')
    await fs.writeFile(join(directory, 'publish.xml'), '<jsplugins><jspluginonline name="HuaqingDesktop&#69;T"/><third attr="&lt;keep&gt;"/></jsplugins>')
    await removeWpsAddins({ directory, platform: 'win32' })
    expect(await fs.readFile(join(directory, 'publish.xml'), 'utf8')).toBe('<jsplugins><third attr="&lt;keep&gt;"/></jsplugins>')
  })

  it('removes only owned entries and leaves other Writer registrations unchanged', async () => {
    const directory = await seed()
    await registerWpsAddins({ directory, baseUrl, platform: 'darwin' })
    expect((await removeWpsAddins({ directory, platform: 'darwin' })).changed).toBe(true)
    const publish = await fs.readFile(join(directory, 'publish.xml'), 'utf8')
    expect(publish).not.toContain('HuaqingDesktop')
    expect(publish).toContain('<!-- Other product: do not remove -->')
    expect(publish).toContain('name="ThirdParty"')
    expect(JSON.parse(await fs.readFile(join(directory, 'authaddin.json'), 'utf8'))).toEqual(JSON.parse(externalAuth))
    expect(await removeWpsAddins({ directory, platform: 'darwin' })).toEqual({ changed: false, files: [] })
  })

  it('removes WPS-generated ET/PPT/Writer authorizations, including disabled duplicate entries, without touching other state', async () => {
    const directory = await seed()
    await registerWpsAddins({ directory, baseUrl, platform: 'darwin' })
    const etFirst = '1'.repeat(32)
    const etSecond = '2'.repeat(32)
    const etOther = '3'.repeat(32)
    const wrongHost = '4'.repeat(32)
    const wppOwned = '5'.repeat(32)
    const wppOther = '6'.repeat(32)
    const writerOwned = '7'.repeat(32)
    const writerOther = '8'.repeat(32)
    const foreignEt = { name: 'OtherET', enable: true, custom: { preserve: 1 } }
    const wrongHostEntry = { name: 'HuaqingDesktopWPS', enable: false, custom: 'not owned by ET' }
    const foreignWpp = { name: 'HuaqingDesktopWPP-extra', enable: true, custom: [1, 2] }
    const foreignWriter = { name: 'OtherWriter', custom: 7 }
    const auth = {
      et: {
        [etFirst]: { name: 'HuaqingDesktopET', enable: false, isload: false, mode: 2, md5: '' },
        [etSecond]: { name: 'HuaqingDesktopET', enable: false, isload: false, mode: 2, md5: '' },
        [etOther]: foreignEt,
        [wrongHost]: wrongHostEntry,
        namelist: `${etFirst};${etOther};${etFirst};;${wrongHost};`,
        featureFlag: true,
        metadata: { nestedName: 'HuaqingDesktopET', preserve: true }
      },
      wpp: {
        [wppOwned]: { name: 'HuaqingDesktopWPP', enable: false, isload: false, mode: 2 },
        [wppOther]: foreignWpp,
        namelist: `${wppOwned};${wppOther}`,
        unknown: ['preserve']
      },
      wps: {
        [writerOwned]: { name: 'HuaqingDesktopWPS', enable: true, isload: true, mode: 2 },
        [writerOther]: foreignWriter,
        namelist: `${writerOther};${writerOwned}`
      },
      futureHost: { name: 'HuaqingDesktopET', arbitrary: [1, false] }
    }
    await fs.writeFile(join(directory, 'authaddin.json'), JSON.stringify(auth, null, 3) + '\n')
    expect(await removeWpsAddins({ directory, platform: 'darwin' })).toEqual({
      changed: true, files: [join(directory, 'publish.xml'), join(directory, 'authaddin.json')]
    })
    expect(JSON.parse(await fs.readFile(join(directory, 'authaddin.json'), 'utf8'))).toEqual({
      et: {
        [etOther]: foreignEt, [wrongHost]: wrongHostEntry,
        namelist: `${etOther};;${wrongHost};`, featureFlag: true, metadata: auth.et.metadata
      },
      wpp: { [wppOther]: foreignWpp, namelist: wppOther, unknown: ['preserve'] },
      wps: { [writerOther]: foreignWriter, namelist: writerOther },
      futureHost: auth.futureHost
    })
    const publish = await fs.readFile(join(directory, 'publish.xml'), 'utf8')
    expect(publish).not.toContain('HuaqingDesktop')
    expect(publish).toContain('name="ThirdParty"')
    const cleaned = await fs.readFile(join(directory, 'authaddin.json'), 'utf8')
    expect(await removeWpsAddins({ directory, platform: 'darwin' })).toEqual({ changed: false, files: [] })
    expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(cleaned)
  })

  it('removes owned ET entries without manufacturing absent host sections or namelists', async () => {
    const directory = await temporaryDirectory()
    const id = 'a'.repeat(32)
    await fs.writeFile(join(directory, 'authaddin.json'), JSON.stringify({ et: { [id]: { name: 'HuaqingDesktopET', enable: false }, custom: 42 }, future: null }))
    expect(await removeWpsAddins({ directory, platform: 'darwin' })).toEqual({ changed: true, files: [join(directory, 'authaddin.json')] })
    expect(JSON.parse(await fs.readFile(join(directory, 'authaddin.json'), 'utf8'))).toEqual({ et: { custom: 42 }, future: null })
    await expect(fs.stat(join(directory, 'publish.xml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves existing ET/PPT authorization and unknown fields intact during Writer registration', async () => {
    const directory = await seed()
    const auth = {
      et: { ['1'.repeat(32)]: { name: 'HuaqingDesktopET', enable: false, isload: false, custom: 1 }, namelist: '1'.repeat(32), unknown: true },
      wpp: { ['2'.repeat(32)]: { name: 'HuaqingDesktopWPP', enable: false, isload: false, custom: 2 }, namelist: '2'.repeat(32) },
      wps: { other: { name: 'OtherWriter', custom: 3 }, namelist: 'other' },
      unknown: { preserve: true }
    }
    await fs.writeFile(join(directory, 'authaddin.json'), JSON.stringify(auth))
    await registerWpsAddins({ directory, baseUrl, platform: 'darwin' })
    const after = JSON.parse(await fs.readFile(join(directory, 'authaddin.json'), 'utf8'))
    expect(after.et).toEqual(auth.et)
    expect(after.wpp).toEqual(auth.wpp)
    expect(after.unknown).toEqual(auth.unknown)
  })

  it.each([
    ['invalid-json', 'not json'], ['root-array', '[]'], ['root-null', 'null'],
    ['et-array', '{"et":[]}'], ['wpp-null', '{"wpp":null}'], ['wps-string', '{"wps":"invalid"}'],
    ['et-list-number', '{"et":{"namelist":7}}'], ['wpp-list-array', '{"wpp":{"namelist":[]}}'], ['wps-list-null', '{"wps":{"namelist":null}}']
  ])('refuses damaged Mac auth during removal before changing publish.xml: %s', async (_label, auth) => {
    const directory = await seed()
    await registerWpsAddins({ directory, baseUrl, platform: 'darwin' })
    const before = await fs.readFile(join(directory, 'publish.xml'), 'utf8')
    await fs.writeFile(join(directory, 'authaddin.json'), auth)
    await expect(removeWpsAddins({ directory, platform: 'darwin' })).rejects.toThrow('Invalid WPS')
    expect(await fs.readFile(join(directory, 'publish.xml'), 'utf8')).toBe(before)
    expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(auth)
    expect((await fs.readdir(directory)).sort()).toEqual(['authaddin.json', 'publish.xml'])
  })

  it('does not create a missing directory when removing', async () => {
    const directory = join(await temporaryDirectory(), 'missing')
    expect(await removeWpsAddins({ directory, platform: 'darwin' })).toEqual({ changed: false, files: [] })
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    `http://localhost:18766/${'a'.repeat(64)}`,
    `https://127.0.0.1:18766/${'a'.repeat(64)}`,
    `http://127.0.0.1:0/${'a'.repeat(64)}`,
    `http://127.0.0.1:65536/${'a'.repeat(64)}`,
    `http://127.0.0.1:18766/${'a'.repeat(63)}`,
    `${baseUrl}/`, `${baseUrl}?key=x`, `http://user@127.0.0.1:18766/${'a'.repeat(64)}`
  ])('rejects noncanonical or untrusted base URL %s before creating a directory', async (untrusted) => {
    const directory = join(await temporaryDirectory(), 'missing')
    await expect(registerWpsAddins({ directory, baseUrl: untrusted, platform: 'win32' })).rejects.toThrow('URL')
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['<jsplugins><broken></jsplugins>', '<root/>', '<!DOCTYPE jsplugins><jsplugins/>'])('rejects malformed or unsupported XML without changing the other registry', async (xml) => {
    const directory = await seed()
    await fs.writeFile(join(directory, 'publish.xml'), xml)
    await expect(registerWpsAddins({ directory, baseUrl, platform: 'darwin' })).rejects.toThrow()
    expect(await fs.readFile(join(directory, 'publish.xml'), 'utf8')).toBe(xml)
    expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(externalAuth)
    expect((await fs.readdir(directory)).sort()).toEqual(['authaddin.json', 'publish.xml'])
  })

  it.each(['not json', '[]', '{"wps":[]}', '{"wps":{"namelist":23}}'])('validates Mac auth before modifying publish.xml: %s', async (auth) => {
    const directory = await seed()
    await fs.writeFile(join(directory, 'authaddin.json'), auth)
    await expect(registerWpsAddins({ directory, baseUrl, platform: 'darwin' })).rejects.toThrow()
    expect(await fs.readFile(join(directory, 'publish.xml'), 'utf8')).toBe(externalPublish)
    expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(auth)
  })

  it('rejects final directory and registry symlinks without following them', async () => {
    const directory = await temporaryDirectory()
    const target = join(directory, 'target')
    await fs.mkdir(target)
    await fs.symlink(target, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(registerWpsAddins({ directory: join(directory, 'linked'), baseUrl, platform: 'win32' })).rejects.toThrow('symbolic link')
    const original = join(directory, 'original.xml')
    await fs.writeFile(original, externalPublish)
    await fs.symlink(original, join(target, 'publish.xml'), 'file')
    await expect(registerWpsAddins({ directory: target, baseUrl, platform: 'darwin' })).rejects.toThrow('regular file')
    expect(await fs.readFile(original, 'utf8')).toBe(externalPublish)
  })

  it('rejects directories, oversized registries and invalid UTF-8', async () => {
    const directory = await temporaryDirectory()
    const publish = join(directory, 'publish.xml')
    await fs.mkdir(publish)
    await expect(registerWpsAddins({ directory, baseUrl, platform: 'win32' })).rejects.toThrow('regular file')
    await fs.rmdir(publish)
    await fs.writeFile(publish, Buffer.alloc(1024 * 1024 + 1))
    await expect(registerWpsAddins({ directory, baseUrl, platform: 'win32' })).rejects.toThrow('exceeds')
    await fs.writeFile(publish, Buffer.from([0xff, 0xfe]))
    await expect(registerWpsAddins({ directory, baseUrl, platform: 'win32' })).rejects.toThrow()
    expect(await fs.readFile(publish)).toEqual(Buffer.from([0xff, 0xfe]))
  })

  it('honors read-only registries even when the parent directory is writable', async () => {
    const directory = await seed()
    await fs.chmod(join(directory, 'publish.xml'), 0o444)
    try {
      const failure = await failureOf(registerWpsAddins({ directory, baseUrl, platform: 'darwin' }))
      expect(failure.cause).toBeInstanceOf(Error)
      expect(failure.recoveryPaths).toHaveLength(1)
      await assertOriginals(directory)
    } finally { await fs.chmod(join(directory, 'publish.xml'), 0o644) }
  })

  it('refuses a concurrent or interrupted registration lock without deleting it', async () => {
    const directory = await seed()
    const lockPath = join(directory, '.huaqing-desktop-registration.lock')
    await fs.writeFile(lockPath, 'another operation')
    const failure = await failureOf(registerWpsAddins({ directory, baseUrl, platform: 'darwin' }))
    expect(failure.recoveryPaths).toEqual([lockPath])
    expect(await fs.readFile(lockPath, 'utf8')).toBe('another operation')
    await assertOriginals(directory)
  })

  it('serializes competing calls with a shared filesystem lock', async () => {
    const directory = await seed()
    let unblock: (() => void) | undefined
    const wait = new Promise<void>(resolve => { unblock = resolve })
    let reached: (() => void) | undefined
    const paused = new Promise<void>(resolve => { reached = resolve })
    const realLink = fs.link
    let first = true
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (first && String(source).includes('after-')) {
        first = false
        reached?.()
        await wait
      }
      return realLink(source, target)
    })
    const running = registerWpsAddins({ directory, baseUrl, platform: 'darwin' })
    await paused
    try {
      const competing = await failureOf(removeWpsAddins({ directory, platform: 'darwin' }))
      expect(competing.message).toContain('Another WPS registration')
    } finally { unblock?.() }
    expect((await running).changed).toBe(true)
    expect(await fs.readFile(join(directory, 'publish.xml'), 'utf8')).toContain('HuaqingDesktopET')
  })

  it('keeps live originals intact when preparing the second file fails', async () => {
    const directory = await seed()
    const realOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('after-1')) throw Object.assign(new Error('Injected staging failure'), { code: 'ENOSPC' })
      return realOpen(path, flags, mode)
    })
    const failure = await failureOf(registerWpsAddins({ directory, baseUrl, platform: 'darwin' }))
    await assertOriginals(directory)
    const recovery = failure.recoveryPaths[0]
    if (!recovery) throw new Error('Missing recovery directory')
    expect(await fs.readFile(join(recovery, 'before-0'), 'utf8')).toBe(externalPublish)
  })

  it('rolls back the first file from this transaction when the second publish fails', async () => {
    const directory = await seed()
    const historical = join(directory, 'publish.xml.backup-before-huaqing-desktop')
    await fs.writeFile(historical, '<jsplugins><!-- old unrelated state --></jsplugins>')
    const realLink = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (String(source).includes('after-') && target === join(directory, 'authaddin.json')) throw Object.assign(new Error('Injected access failure'), { code: 'EACCES' })
      return realLink(source, target)
    })
    const failure = await failureOf(registerWpsAddins({ directory, baseUrl, platform: 'darwin' }))
    await assertOriginals(directory)
    const recovery = failure.recoveryPaths[0]
    if (!recovery) throw new Error('Missing recovery directory')
    expect(await fs.readFile(join(recovery, 'before-0'), 'utf8')).toBe(externalPublish)
    expect(await fs.readFile(join(recovery, 'before-1'), 'utf8')).toBe(externalAuth)
    expect(JSON.parse(await fs.readFile(join(recovery, 'transaction.json'), 'utf8')).version).toBe(1)
    expect(await fs.readFile(historical, 'utf8')).toBe('<jsplugins><!-- old unrelated state --></jsplugins>')
    await expect(fs.stat(join(directory, '.huaqing-desktop-registration.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a concurrent edit made immediately before claiming an original', async () => {
    const directory = await seed()
    const publish = join(directory, 'publish.xml')
    const concurrent = '<jsplugins><!-- concurrent source edit --></jsplugins>'
    const realRename = fs.rename
    let edited = false
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (!edited && source === publish) { edited = true; await fs.writeFile(publish, concurrent) }
      return realRename(source, target)
    })
    const failure = await failureOf(registerWpsAddins({ directory, baseUrl, platform: 'darwin' }))
    expect(failure.recoveryPaths).toHaveLength(1)
    expect(await fs.readFile(publish, 'utf8')).toBe(concurrent)
    expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(externalAuth)
  })

  it('does not overwrite a new target created by another writer after the claim', async () => {
    const directory = await seed()
    const publish = join(directory, 'publish.xml')
    const concurrent = '<jsplugins><!-- concurrently created --></jsplugins>'
    const realLink = fs.link
    let edited = false
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (!edited && target === publish && String(source).includes('after-')) {
        edited = true
        await fs.writeFile(publish, concurrent, { flag: 'wx' })
      }
      return realLink(source, target)
    })
    const failure = await failureOf(registerWpsAddins({ directory, baseUrl, platform: 'darwin' }))
    expect(failure.message).toContain('rollback incomplete')
    expect(await fs.readFile(publish, 'utf8')).toBe(concurrent)
    expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(externalAuth)
  })

  it('does not replace an in-place concurrent edit while rolling back', async () => {
    const directory = await seed()
    const publish = join(directory, 'publish.xml')
    const concurrent = '<jsplugins><!-- written after our first commit --></jsplugins>'
    const realLink = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (target === join(directory, 'authaddin.json') && String(source).includes('after-')) {
        await fs.writeFile(publish, concurrent)
        throw Object.assign(new Error('Injected second-file failure'), { code: 'EACCES' })
      }
      return realLink(source, target)
    })
    const failure = await failureOf(registerWpsAddins({ directory, baseUrl, platform: 'darwin' }))
    expect(failure.message).toContain('rollback incomplete')
    expect(await fs.readFile(publish, 'utf8')).toBe(concurrent)
    expect(await fs.readFile(join(directory, 'authaddin.json'), 'utf8')).toBe(externalAuth)
  })

  it('preserves the transaction failure and recovery paths if lock cleanup also fails', async () => {
    const directory = await seed()
    const realLink = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (String(source).includes('after-') && target === join(directory, 'authaddin.json')) throw new Error('Injected publication failure')
      return realLink(source, target)
    })
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('Injected lock cleanup failure'))
    const failure = await failureOf(registerWpsAddins({ directory, baseUrl, platform: 'darwin' }))
    expect(failure.message).toContain('lock cleanup failed')
    expect(failure.cause).toBeInstanceOf(AggregateError)
    expect(failure.recoveryPaths).toHaveLength(2)
    await assertOriginals(directory)
    expect(await fs.readFile(join(directory, '.huaqing-desktop-registration.lock'), 'utf8')).toContain('pid')
  })
})
