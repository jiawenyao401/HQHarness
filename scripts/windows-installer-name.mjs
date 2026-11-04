import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`
const versionPattern = new RegExp(`^${VERSION}$`)
const filenamePattern = new RegExp(String.raw`^Huaqing-Desktop-(${VERSION})-x64-([a-f0-9]{64})-(\d{8}T\d{6}Z)\.exe$`)

export const STAGED_WINDOWS_INSTALLER = 'hqharness-windows-x64-setup.exe'

export function windowsInstallerName(version, sha256, date) {
  if (!versionPattern.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Expected a Windows installer version and a full lowercase SHA-256 digest.')
  }
  const timestamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `Huaqing-Desktop-${version}-x64-${sha256}-${timestamp}.exe`
}

export function parseWindowsInstallerName(filename) {
  const match = filenamePattern.exec(filename)
  if (!match) return undefined
  const [, version, sha256, timestamp] = match
  return { version, sha256, timestamp }
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
