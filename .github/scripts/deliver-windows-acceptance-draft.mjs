import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const runGh = args => execFileSync('gh', args, { encoding: 'utf8' })

export function requirePrivateDestination(env = process.env, gh = runGh) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.HQHARNESS_DRAFT_DELIVERY !== 'true') {
    throw new Error('Private draft delivery requires an explicit manual workflow dispatch.')
  }
  const repository = env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid GITHUB_REPOSITORY.')
  const destination = JSON.parse(gh(['api', `repos/${repository}`]))
  if (destination.private !== true || destination.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Acceptance installers may only be delivered to the current private repository.')
  }
  return repository
}

export async function deliverWindowsAcceptanceDraft(root, env = process.env, gh = runGh) {
  const repository = requirePrivateDestination(env, gh)
  const source = env.GITHUB_SHA
  if (!/^[a-f0-9]{40}$/i.test(source ?? '')) throw new Error('Expected the exact source commit SHA.')
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('Expected a unique workflow run ID and attempt.')
  }

  const manifestPath = path.join(root, 'dist/windows-acceptance.json')
  const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''))
  const installers = (await readdir(path.join(root, 'dist'))).filter(name => name.endsWith('-acceptance.exe'))
  if (installers.length !== 1 || manifest.file !== installers[0] ||
      !/^hqharness-[\w.+-]+-win-x64-acceptance\.exe$/.test(manifest.file ?? '')) {
    throw new Error('Expected exactly one Windows x64 acceptance installer matching the manifest.')
  }
  if (manifest.source !== source || manifest.signed !== false || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')) {
    throw new Error('Acceptance manifest must identify this source commit, unsigned installer and SHA-256.')
  }
  const installerPath = path.join(root, 'dist', manifest.file)
  const files = [installerPath, manifestPath,
    path.join(root, '.build/automation-acceptance/browser-local-execution.log'),
    path.join(root, '.build/automation-acceptance/windows-uia-local-execution.log')]
  const assets = await Promise.all(files.map(async file => {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size === 0) throw new Error(`Expected a nonempty regular delivery file: ${file}`)
    return { name: path.basename(file), size: stat.size }
  }))
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installerPath)) hash.update(chunk)
  if (hash.digest('hex') !== manifest.sha256) throw new Error('Installer SHA-256 does not match the acceptance manifest.')

  const tag = `acceptance-windows-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
  // No edit/publish path: every attempt creates a new private draft and retains
  // partial uploads on failure for diagnosis rather than replacing an old build.
  gh(['release', 'create', tag, ...files, '--repo', repository, '--target', source,
    '--draft', '--prerelease', '--title', `Windows acceptance ${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}`,
    '--notes', `Unsigned Windows acceptance installer from ${source}.\nSHA-256: ${manifest.sha256}\nPrivate delivery only. Do not publish this draft. Installed-app acceptance is still required.`])
  // The REST tag endpoint returns 404 for an unpublished draft. gh resolves its
  // pending tag too; then confirm the actual release and uploads by numeric ID.
  const { databaseId } = JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'databaseId']))
  if (!Number.isSafeInteger(databaseId) || databaseId <= 0) throw new Error('Expected a valid draft release ID.')
  const release = JSON.parse(gh(['api', `repos/${repository}/releases/${databaseId}`]))
  requirePrivateDestination(env, gh)
  if (release.id !== databaseId || release.draft !== true || release.prerelease !== true || release.tag_name !== tag || release.target_commitish !== source) {
    throw new Error('Delivery did not remain a private draft bound to the expected source commit.')
  }
  for (const expected of assets) {
    const uploaded = release.assets?.find(asset => asset.name === expected.name)
    if (uploaded?.state !== 'uploaded' || uploaded.size !== expected.size) {
      throw new Error(`Draft asset upload is incomplete: ${expected.name}`)
    }
  }
  return { repository, tag, releaseId: release.id, draft: true, source,
    file: manifest.file, sha256: manifest.sha256, url: release.html_url }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--check')) {
      console.log(`Verified private draft destination: ${requirePrivateDestination()}`)
    } else {
      const delivery = await deliverWindowsAcceptanceDraft(process.cwd())
      console.log(JSON.stringify(delivery, null, 2))
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY,
          `### Private Windows acceptance draft\n\n[Download installer, manifest and native logs](${delivery.url})\n\nSource: \`${delivery.source}\`\n\nSHA-256: \`${delivery.sha256}\`\n\nUnsigned; installed-app acceptance remains required. Keep this release in draft.\n`)
      }
    }
  } catch (error) {
    console.error(`Windows acceptance draft delivery failed: ${error.message}`)
    process.exitCode = 1
  }
}
