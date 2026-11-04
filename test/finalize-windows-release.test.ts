import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('signed Windows release finalizer', () => {
  it('rebuilds the blockmap and updater metadata after signing', async () => {
    const releaseDir = await mkdtemp(path.join(tmpdir(), 'dsh-windows-release-'))
    try {
      const installerName = 'hqharness-windows-x64-setup.exe'
      const installer = path.join(releaseDir, installerName)
      const content = Buffer.from('signed Windows installer fixture')
      await writeFile(installer, content)
      await writeFile(`${installer}.blockmap`, 'stale blockmap')
      await writeFile(path.join(releaseDir, 'latest.yml'), 'stale metadata')

      const result = spawnSync(
        process.execPath,
        [path.join(process.cwd(), 'scripts', 'finalize-windows-release.mjs'), releaseDir, '1.2.3'],
        { encoding: 'utf8' }
      )
      expect(result.status, result.stderr).toBe(0)

      const digest = createHash('sha512').update(content).digest('base64')
      const sha256 = createHash('sha256').update(content).digest('hex')
      const entries = await readdir(releaseDir)
      const brandedInstaller = entries.find(name => name.endsWith('.exe'))
      if (!brandedInstaller) throw new Error('Missing finalized installer')
      expect(brandedInstaller).toMatch(new RegExp(`^Huaqing-Desktop-1\\.2\\.3-x64-${sha256}-\\d{8}T\\d{6}Z\\.exe$`))
      expect(await readFile(path.join(releaseDir, brandedInstaller))).toEqual(content)
      expect(entries).not.toContain(installerName)
      expect(entries).not.toContain(`${installerName}.blockmap`)
      const metadata = await readFile(path.join(releaseDir, 'latest.yml'), 'utf8')
      expect(metadata).toContain('version: 1.2.3')
      expect(metadata).toContain(`url: "${brandedInstaller}"`)
      expect(metadata).toContain(`sha512: ${digest}`)
      expect(metadata).toContain(`size: ${content.length}`)
      expect((await stat(path.join(releaseDir, `${brandedInstaller}.blockmap`))).size).toBeGreaterThan(0)
    } finally {
      await rm(releaseDir, { recursive: true, force: true })
    }
  })
})
