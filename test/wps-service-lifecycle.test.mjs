import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakes = vi.hoisted(() => ({ home: '', dialog: vi.fn(), handlers: new Map() }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal(), homedir: () => fakes.home }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  // Registration checks for running WPS through execFile, never a shell. This
  // fixture owns its fake WPS home and reports no running application.
  execFile(_file, _args, _options, callback) { callback(null, { stdout: '', stderr: '' }); return {} }
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() }, dialog: { showMessageBox: fakes.dialog },
  ipcMain: { removeHandler: name => fakes.handlers.delete(name), handle: (name, callback) => fakes.handlers.set(name, callback) }
}))
import { DesktopWpsService } from '../src/main/wps/service.ts'
import * as registration from '../src/main/wps/addin-registration.ts'

describe('WPS service registration lifecycle', () => {
  it.skipIf(!['darwin', 'win32'].includes(process.platform))('closing the service cancels pending registration consent before any registry change', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'huaqing-wps-register-close-')))
    fakes.home = join(directory, 'fake-user')
    const registryParent = process.platform === 'darwin'
      ? join(fakes.home, 'Library', 'Containers', 'com.kingsoft.wpsoffice.mac', 'Data', '.kingsoft', 'wps')
      : join(directory, 'fake-appdata', 'kingsoft', 'wps')
    if (process.platform === 'win32') {
      vi.stubEnv('APPDATA', join(directory, 'fake-appdata'))
      vi.stubEnv('SystemRoot', 'C:\\Windows')
    }
    await mkdir(registryParent, { recursive: true })
    const service = new DesktopWpsService(join(directory, 'connector'), () => ({ isDestroyed: () => false, show() {}, focus() {} }), () => 'en')
    let release
    let dialogSignal
    let opened
    const started = new Promise(resolve => { opened = resolve })
    fakes.dialog.mockImplementation((_window, options) => {
      dialogSignal = options.signal
      opened()
      return new Promise(resolve => {
        release = resolve
        options.signal.addEventListener('abort', () => resolve({ response: 0 }), { once: true })
      })
    })
    let outcome
    try {
      await service.start()
      service.registerIpc(() => {})
      const register = fakes.handlers.get('hq:wps:register')
      expect(typeof register).toBe('function')
      outcome = register({}).then(value => ({ value }), error => ({ error }))
      await started
      await service.close()
      expect(dialogSignal.aborted).toBe(true)
      expect((await outcome).error).toBeInstanceOf(Error)
      await expect(readFile(join(registryParent, 'jsaddons', 'publish.xml'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(directory, 'connector', 'registered.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release?.({ response: 0 })
      await outcome
      await service.close()
      await rm(directory, { recursive: true, force: true })
      fakes.dialog.mockReset(); fakes.handlers.clear(); vi.unstubAllEnvs()
    }
  })
  it.skipIf(!['darwin', 'win32'].includes(process.platform))('closing waits for an already-started registration transaction to settle', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'huaqing-wps-register-drain-')))
    fakes.home = join(directory, 'fake-user')
    const registryParent = process.platform === 'darwin'
      ? join(fakes.home, 'Library', 'Containers', 'com.kingsoft.wpsoffice.mac', 'Data', '.kingsoft', 'wps')
      : join(directory, 'fake-appdata', 'kingsoft', 'wps')
    if (process.platform === 'win32') {
      vi.stubEnv('APPDATA', join(directory, 'fake-appdata'))
      vi.stubEnv('SystemRoot', 'C:\\Windows')
    }
    await mkdir(registryParent, { recursive: true })
    const service = new DesktopWpsService(join(directory, 'connector'), () => ({ isDestroyed: () => false, show() {}, focus() {} }), () => 'en')
    let release
    let entered
    const started = new Promise(resolve => { entered = resolve })
    const barrier = new Promise(resolve => { release = resolve })
    const transaction = vi.spyOn(registration, 'registerWpsAddins').mockImplementation(async () => {
      entered()
      await barrier
      return { changed: true, files: [] }
    })
    fakes.dialog.mockResolvedValue({ response: 1 })
    let outcome
    let closing
    try {
      await service.start()
      outcome = service.enableAddin().then(value => ({ value }), error => ({ error }))
      await started
      let settled = false
      closing = service.close().then(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      release()
      expect((await outcome).error).toBeUndefined()
      await closing
      expect(transaction).toHaveBeenCalledOnce()
      expect(service.status().registered).toBe(true)
      expect(JSON.parse(await readFile(join(directory, 'connector', 'registered.json'), 'utf8')).baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/)
    } finally {
      release()
      await outcome
      await closing
      await service.close()
      transaction.mockRestore()
      await rm(directory, { recursive: true, force: true })
      fakes.dialog.mockReset(); vi.unstubAllEnvs()
    }
  })
})
