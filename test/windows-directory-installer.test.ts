import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertWindowsExecutable, directoryAssistedInstaller, directoryInstallModes, directoryInstallSection, directoryInstallerExits, directoryInstallUtil } from '../scripts/windows-directory-installer.mjs'

const require = createRequire(import.meta.url)
const template = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis', 'installSection.nsh')
const installUtil = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis', 'include', 'installUtil.nsh')

describe('pinned NSIS directory transaction', () => {
  it('accepts Windows PE headers and rejects host binaries', () => {
    // Header validation is independent of the machine running the build.
    const pe = Buffer.alloc(0x48)
    pe.write('MZ')
    pe.writeUInt32LE(0x40, 0x3c)
    pe.write('PE\0\0', 0x40)
    pe.writeUInt16LE(0x14c, 0x44)
    expect(() => assertWindowsExecutable(pe)).not.toThrow()
    expect(() => assertWindowsExecutable(Buffer.from('Mach-O'))).toThrow('not a Windows PE')
    pe.writeUInt16LE(0xaa64, 0x44)
    expect(() => assertWindowsExecutable(pe)).toThrow('unsupported PE machine')
  })
  it('stages before app shutdown and promotes before registration', async () => {
    const source = await readFile(template, 'utf8')
    const adapted = directoryInstallSection(source)
    expect(adapted.indexOf('!insertmacro dshStageApplication'))
      .toBeLessThan(adapted.indexOf('!insertmacro CHECK_APP_RUNNING'))
    expect(adapted.indexOf('Call dshPromoteDirectories'))
      .toBeLessThan(adapted.indexOf('!insertmacro registryAddInstallInfo'))
    expect(adapted).toContain('!macroundef uninstallOldVersion')
    expect(adapted).not.toContain('Call uninstallOldVersion')
    expect(adapted).not.toContain('!insertmacro installApplicationFiles\n!insertmacro registryAddInstallInfo')
    expect(directoryInstallerExits('Quit\n')).toContain('Call dshCleanupDirectories')
    const adaptedUtil = directoryInstallUtil(await readFile(installUtil, 'utf8'))
    expect(adaptedUtil).not.toContain('Function uninstallOldVersion')
    expect(adaptedUtil).not.toContain('Function GetInQuotes')
    expect(adaptedUtil).not.toContain('Function GetFileParent')
  })

  it('sets the Documents default only after checking the registered per-user path', async () => {
    const modes = directoryInstallModes(await readFile(join(dirname(template), 'multiUser.nsh'), 'utf8'))
    const currentUser = modes.slice(modes.indexOf('!macro setInstallModePerUser'), modes.indexOf('!macro setInstallModePerAllUsers'))
    expect(currentUser.indexOf('StrCpy $INSTDIR $perUserInstallationFolder')).toBeLessThan(currentUser.indexOf('${HQHARNESS_DOCUMENTS_APP}'))
    expect(currentUser.indexOf('${HQHARNESS_DOCUMENTS_APP}')).toBeLessThan(currentUser.indexOf('!insertmacro GetDParameter'))
    expect(modes.slice(modes.indexOf('!macro setInstallModePerAllUsers'))).not.toContain('HQHARNESS_DOCUMENTS_APP')

    const assisted = directoryAssistedInstaller(await readFile(join(dirname(template), 'assistedInstaller.nsh'), 'utf8'))
    expect(assisted.indexOf('If} $0 == "$1\\app"')).toBeLessThan(assisted.indexOf('${StrContains} $0 "${APP_FILENAME}"'))
  })

  it('rejects a changed electron-builder template', () => {
    expect(() => directoryInstallSection('!include installer.nsh'))
      .toThrow('electron-builder NSIS template changed')
  })
})
