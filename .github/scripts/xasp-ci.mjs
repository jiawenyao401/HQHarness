import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const lockFile = new URL('../../scripts/xasp-runtime/lock.json', import.meta.url)
const exactRevision = /^[a-f0-9]{40}$/u

export function requirePrivateXaspRelease(env, brand, gh = args => execFileSync('gh', args, { encoding: 'utf8' })) {
  const repository = env.GITHUB_REPOSITORY
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !['signed', 'prerelease'].includes(env.RELEASE_MODE)) {
    throw new Error('XASP bundles require a manual signed or prerelease build.')
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '') || typeof brand.releaseRepository !== 'string'
    || brand.releaseRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('XASP releaseRepository must match the current GitHub repository.')
  }
  const destination = JSON.parse(gh(['api', `repos/${repository}`]))
  if (destination.private !== true || destination.visibility !== 'private'
    || destination.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('XASP release artifacts require the exact configured private repository.')
  }
}

export async function verifyWindowsSigningInput(resources, required) {
  const manifest = await readJson(join(resources, 'xasp-runtime', 'manifest.json')).catch(error => {
    // Existing unsigned artifacts can predate XASP.
    if (error.code === 'ENOENT' && !required) return { format: 1, enabled: false }
    throw error
  })
  if (manifest.format !== 1 || manifest.enabled !== required) {
    throw new Error('Unsigned Windows input does not match the requested XASP bundle state.')
  }
  if (required) {
    const { revision } = await readJson(lockFile)
    if (manifest.revision !== revision || manifest.platform !== 'win32' || manifest.arch !== 'x64') {
      throw new Error('Unsigned Windows XASP bundle does not match the locked revision and Windows x64 target.')
    }
  }
}

async function main(command, path, env) {
  switch (command) {
    case 'verify-private-release':
      requirePrivateXaspRelease(env, await readJson(new URL('../../brand.config.json', import.meta.url)))
      break
    case 'resolve-revision': {
      const hasToken = env.XASP_READ_TOKEN_CONFIGURED === 'true'
      const hasKey = env.XASP_READ_KEY_CONFIGURED === 'true'
      if (hasToken === hasKey) {
        throw new Error('Configure exactly one of XASP_CHECKOUT_KEY or XASP_CHECKOUT_TOKEN with read-only access to hqzyai/xasp.')
      }
      const { revision } = await readJson(lockFile)
      if (typeof revision !== 'string' || !exactRevision.test(revision)) {
        throw new Error('The XASP build lock must pin an exact commit.')
      }
      await appendFile(env.GITHUB_OUTPUT, `revision=${revision}\n`)
      break
    }
    case 'enable-bundle': {
      const source = resolve(env.GITHUB_WORKSPACE, '.build/xasp-source')
      const actual = execFileSync('git', ['-C', source, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim()
      if (!exactRevision.test(actual) || actual !== env.XASP_PIN) throw new Error('Private XASP checkout does not match its lock.')
      await appendFile(env.GITHUB_ENV, `XASP_SOURCE_ROOT=${source}\nXASP_REQUIRE_BUNDLE=1\n`)
      break
    }
    case 'verify-windows-signing-input':
      await verifyWindowsSigningInput(path, env.XASP_EXPECTED === '1')
      break
    default:
      throw new Error('Unknown XASP build gate.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2], process.argv[3], process.env)
}
