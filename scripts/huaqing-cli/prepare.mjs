import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { x as extractTar } from 'tar'
import { electronExecutable } from '../electron-node-loader.mjs'

const execFileAsync = promisify(execFile)
const project = resolve(import.meta.dirname, '../..')
const vendor = join(project, 'packages', 'huaqing-cli-dist')
const lockPath = join(vendor, 'lock.json')
const build = join(project, '.build')
const output = join(build, 'huaqing-cli')
const packageName = '@huaqing/cli'

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function archiveName(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version)) {
    throw new Error('Huaqing CLI: invalid distribution version')
  }
  return `huaqing-cli-${version}.tgz`
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function unpack(bytes, directory) {
  await pipeline(Readable.from([bytes]), extractTar({
    cwd: directory,
    strip: 1,
    strict: true,
    filter(path, entry) {
      const parts = path.replace(/\/$/u, '').split('/')
      if (parts[0] !== 'package' ||
        parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/u.test(part)) ||
        /^(node_modules|\.npmrc)$/iu.test(parts[1] ?? '') ||
        !['File', 'Directory'].includes(entry.type)) {
        throw new Error(`Huaqing CLI: unexpected npm archive entry ${path}`)
      }
      return true
    }
  }))
  const manifest = await readJson(join(directory, 'package.json'))
  const shrinkwrap = await readJson(join(directory, 'npm-shrinkwrap.json'))
  if (manifest.name !== packageName || manifest.bin?.huaqing !== 'dist/cli.js' ||
    shrinkwrap.name !== packageName || shrinkwrap.version !== manifest.version ||
    shrinkwrap.packages?.['']?.version !== manifest.version) {
    throw new Error('Huaqing CLI: inconsistent package metadata, bin entry or npm shrinkwrap')
  }
  await Promise.all([
    'dist/cli.js',
    'docs/generated/command-catalog.json',
    'examples/node-process.mjs',
    'skills/manifest.json',
    'skills/oa-workflow-expense/SKILL.md'
  ].map(file => access(join(directory, file))))
  return manifest.version
}

async function withStaging(prefix, work) {
  await mkdir(build, { recursive: true })
  const staging = await mkdtemp(join(build, prefix))
  try {
    await work(staging)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function prepare() {
  const npm = process.env.npm_execpath
  if (!npm) throw new Error('Run npm run huaqing-cli:prepare')
  const lock = await readJson(lockPath)
  const bytes = await readFile(join(vendor, archiveName(lock.version)))
  if (hash(bytes) !== lock.sha256) throw new Error('Huaqing CLI: distribution checksum mismatch')

  await withStaging('.huaqing-cli-', async staging => {
    if (await unpack(bytes, staging) !== lock.version) throw new Error('Huaqing CLI: distribution version mismatch')
    // Use the upstream shrinkwrap separately from Desktop's dependency graph.
    // The pinned SQLite and keyring packages ship Node-API bindings in npm.
    try {
      await execFileAsync(process.execPath, [
        npm, 'ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--no-bin-links'
      ], { cwd: staging, timeout: 10 * 60_000, windowsHide: true })
    } catch (cause) {
      throw new Error(`Huaqing CLI: locked dependency installation failed\n${cause.stderr ?? cause.message}`, { cause })
    }

    const prebuilds = join(staging, 'node_modules', 'better-sqlite3', 'prebuilds')
    const native = `${process.platform}-${process.arch}.node`
    await access(join(prebuilds, native))
    for (const file of await readdir(prebuilds)) {
      if (file.endsWith('.node') && file !== native) await rm(join(prebuilds, file))
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:HUAQING_.*|NODE_OPTIONS|NODE_PATH)$/iu.test(key)
    ))
    await execFileAsync(electronExecutable(project), [
      join(staging, 'dist', 'cli.js'), 'skills', 'export', 'oa-workflow-expense',
      '--target-dir', join(staging, 'oa-skills'), '--format', 'json', '--non-interactive'
    ], { cwd: staging, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000, windowsHide: true })
    await writeFile(join(staging, 'desktop-bundle.json'), `${JSON.stringify({
      ...lock, platform: process.platform, arch: process.arch
    }, null, 2)}\n`)
    if ((await readJson(lockPath)).sha256 !== lock.sha256) {
      throw new Error('Huaqing CLI: distribution lock changed during preparation; rebuild with the current lock')
    }
    await rm(output, { recursive: true, force: true })
    await rename(staging, output)
    console.log(`Prepared Huaqing CLI ${lock.version} for ${process.platform}/${process.arch}`)
  })
}

async function update(archive) {
  const bytes = await readFile(resolve(archive))
  const previous = await readJson(lockPath)
  await withStaging('.huaqing-cli-update-', async staging => {
    const version = await unpack(bytes, staging)
    const filename = archiveName(version)
    const sha256 = hash(bytes)
    if (version === previous.version && sha256 !== previous.sha256) {
      throw new Error('Huaqing CLI: a changed distribution requires a new upstream version')
    }
    const candidate = join(staging, filename)
    await writeFile(candidate, bytes)
    const destination = join(vendor, filename)
    // A visible version path always contains the complete, immutable archive.
    try {
      await link(candidate, destination)
    } catch (error) {
      if (error.code !== 'EEXIST' || hash(await readFile(destination)) !== sha256) throw error
    }
    const pendingLock = join(staging, 'lock.json')
    await writeFile(pendingLock, `${JSON.stringify({ source: previous.source, version, sha256 }, null, 2)}\n`)
    await rename(pendingLock, lockPath)
    if (previous.version !== version) await rm(join(vendor, archiveName(previous.version)), { force: true })
    console.log(`Pinned Huaqing CLI ${version} (${sha256})`)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 0) await prepare()
  else if (args.length === 2 && args[0] === '--update') await update(args[1])
  else throw new Error('Use npm run huaqing-cli:prepare or npm run huaqing-cli:update -- <upstream npm tarball>')
}
