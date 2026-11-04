import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWindowsInstallerName, sha256File, STAGED_WINDOWS_INSTALLER, windowsInstallerName } from './windows-installer-name.mjs'

const require = createRequire(import.meta.url)
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')

async function sha512(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

export async function finalizeRelease(releaseDir, version, date = new Date()) {
  const files = (await readdir(releaseDir, { withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => entry.name)
  const staged = files.includes(STAGED_WINDOWS_INSTALLER)
  const branded = files.filter(name => parseWindowsInstallerName(name)?.version === version)
  if (!staged && branded.length !== 1) {
    throw new Error(`Expected a staged Windows installer or one completed installer for ${version}.`)
  }

  const input = join(releaseDir, staged ? STAGED_WINDOWS_INSTALLER : branded[0])
  const digest256 = await sha256File(input)
  const filename = staged ? windowsInstallerName(version, digest256, date) : basename(input)
  if (parseWindowsInstallerName(filename)?.sha256 !== digest256) {
    throw new Error('Windows installer SHA-256 does not match its filename.')
  }
  const installer = join(releaseDir, filename)
  const blockmap = `${installer}.blockmap`
  const fileStat = await stat(input)
  const digest512 = await sha512(input)
  const temporaryBlockmap = `${blockmap}.tmp`
  const metadataPath = join(releaseDir, 'latest.yml')
  const temporaryMetadata = `${metadataPath}.tmp`
  try {
    const updateInfo = await buildBlockMap(input, 'gzip', temporaryBlockmap)
    if (updateInfo.size !== fileStat.size || updateInfo.sha512 !== digest512) {
      throw new Error('Generated update metadata does not match the final installer.')
    }
    await writeFile(temporaryMetadata, [
      `version: ${version}`,
      'files:',
      `  - url: ${JSON.stringify(filename)}`,
      `    sha512: ${digest512}`,
      `    size: ${fileStat.size}`,
      `path: ${JSON.stringify(filename)}`,
      `sha512: ${digest512}`,
      `releaseDate: ${JSON.stringify(date.toISOString())}`,
      ''
    ].join('\n'), 'utf8')
    if (staged) await rename(input, installer)
    await rename(temporaryBlockmap, blockmap)
    await rename(temporaryMetadata, metadataPath)
    if (staged) await rm(`${input}.blockmap`, { force: true })
    return { installer, blockmap }
  } finally {
    await Promise.all([rm(temporaryBlockmap, { force: true }), rm(temporaryMetadata, { force: true })])
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [releaseDir = 'dist', versionArg] = process.argv.slice(2)
  const version = versionArg ?? JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  const result = await finalizeRelease(resolve(releaseDir), version)
  console.log(`Finalized Windows installer metadata for ${basename(result.installer)}.`)
}
