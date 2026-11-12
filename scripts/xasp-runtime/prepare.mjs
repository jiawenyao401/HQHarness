import { execFile as runFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { x as extractTar } from 'tar'
import { downloadAsset, officeTarget, unpackWheel } from '../office-runtime/prepare.mjs'

const execFile = promisify(runFile)
const project = resolve(import.meta.dirname, '../..')
// Wheel hashes are from the pinned XASP uv.lock, plus the PyPI wheels for the
// cross-platform pypdf text extractor and its optional AES backend.
const lock = JSON.parse(await readFile(new URL('./lock.json', import.meta.url), 'utf8'))
const travelSchemaPath = 'skill/oa/oa-travel-expense/references/travel-expense-schema.md'
const sourcePaths = [
  'apps/cli/src/oa_cli',
  'packages/sdk/src/oa_sdk',
  'skill/oa/oa-business-travel-application',
  'skill/oa/oa-home-travel-expense',
  'skill/oa/oa-reception-expense',
  'skill/oa/oa-travel-expense',
  'skill/common/oa-business-memory',
  'skill/common/oa-expense-common',
  'skill/common/oa-invoice',
  'skill/common/oa-onboarding',
  'skill/common/oa-person',
  'skill/common/oa-script-runtime',
  'skill/common/oa-shared',
  'skill/common/oa-workflow'
]

function hasOnlyFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => fields.includes(key))
}

function isSourceFlag(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** Allow only deployment metadata. Validate against the staged source, with no
 * raw input in diagnostic messages because the build environment may contain secrets.
 */
async function readTestBindings(raw, xasp) {
  const invalid = () => new Error('XASP_TEST_WORKFLOW_CONFIG contains invalid or unsupported OA TEST deployment metadata')
  let input
  try {
    if (raw && Buffer.byteLength(raw) > 4096) throw invalid()
    input = raw ? JSON.parse(raw) : {}
  } catch {
    throw invalid()
  }
  if (!hasOnlyFields(input, ['travelWorkflowBinding', 'homeInvoiceSourceFlag'])) throw invalid()
  const defaults = lock.testBindings
  const home = Object.hasOwn(input, 'homeInvoiceSourceFlag') ? input.homeInvoiceSourceFlag : defaults.homeInvoiceSourceFlag
  if (!isSourceFlag(home) || home === 0) throw invalid()
  const travel = Object.hasOwn(input, 'travelWorkflowBinding') ? input.travelWorkflowBinding : defaults.travelWorkflowBinding
  if (!hasOnlyFields(travel, ['workflowId', 'formId', 'schemaSha256', 'invoiceSourceFlag'])
    || (Object.hasOwn(travel, 'invoiceSourceFlag') && !isSourceFlag(travel.invoiceSourceFlag))) throw invalid()
  const schema = await readFile(join(xasp, travelSchemaPath))
  const block = /^```json\r?\n([\s\S]*?)^```$/m.exec(schema.toString('utf8'))
  if (!block) throw new Error('Pinned XASP travel schema has no JSON form identifiers')
  const { formId } = JSON.parse(block[1])
  const schemaSha256 = createHash('sha256').update(schema).digest('hex')
  // TEST workflow identity comes from separately reviewed xasp evidence.
  // The static schema's default workflow may refer to a different instance.
  const workflowId = defaults.travelWorkflowBinding.workflowId
  if (typeof formId !== 'string' || travel.workflowId !== workflowId
    || travel.formId !== formId || travel.schemaSha256 !== schemaSha256) {
    throw new Error('XASP_TEST_WORKFLOW_CONFIG travel binding does not match the locked TEST workflow and schema')
  }
  return {
    account: defaults.account, evidenceRevision: defaults.evidenceRevision, homeInvoiceSourceFlag: home,
    travelWorkflowBinding: {
      workflowId, formId, schemaSha256, invoiceSourceFlag: travel.invoiceSourceFlag ?? defaults.travelWorkflowBinding.invoiceSourceFlag
    }
  }
}

async function stagePinnedSource(sourceRoot, destination) {
  const git = (args, options = {}) => execFile('git', ['--no-replace-objects', '-C', sourceRoot, ...args], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  })
  const { stdout: tree } = await git(['ls-tree', '-rz', '--full-tree', lock.revision, '--', ...sourcePaths])
  const files = tree.split('\0').filter(Boolean).map(entry => {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t([\w./-]+\.(?:py|json|md|yaml))$/u.exec(entry)
    if (!match) throw new Error('XASP pinned source contains a non-regular file or unsupported source path')
    return { sha: match[1], path: match[2] }
  })
  for (const directory of sourcePaths) {
    if (!files.some(file => file.path.startsWith(`${directory}/`))) throw new Error(`Missing XASP source directory ${directory}`)
  }

  // Export the exact reviewed commit, regardless of the checkout's branch,
  // local modifications, untracked files, and credential files.
  const { stdout: archive } = await git(['archive', '--format=tar', lock.revision, '--', ...sourcePaths], { encoding: 'buffer' })
  await mkdir(destination)
  await pipeline(Readable.from(archive), extractTar({ cwd: destination, strict: true }))
  await Promise.all(files.map(async ({ sha, path }) => {
    const file = join(destination, path)
    if (!(await lstat(file)).isFile()) throw new Error(`Missing regular XASP source file ${path}`)
    const bytes = await readFile(file)
    const contentSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (contentSha !== sha) throw new Error(`XASP archive changed pinned source file ${path}`)
  }))
}

/** Prepare resources for this platform using the existing native Office Python ABI. */
export async function prepareXaspRuntime({
  sourceRoot = process.env.XASP_SOURCE_ROOT,
  testWorkflowConfig = process.env.XASP_TEST_WORKFLOW_CONFIG,
  output = join(project, '.build/xasp-runtime'),
  cache = join(project, '.build/xasp-downloads'),
  officeRuntime = join(project, '.build/office-runtime/primary-runtime')
} = {}) {
  const target = officeTarget()
  await mkdir(dirname(output), { recursive: true })
  await rm(output, { recursive: true, force: true })
  if (!sourceRoot) {
    if (process.env.XASP_REQUIRE_BUNDLE === '1' || testWorkflowConfig) {
      throw new Error(`Set XASP_SOURCE_ROOT to a Git checkout containing XASP ${lock.revision}`)
    }
    await mkdir(output)
    await writeFile(join(output, 'manifest.json'), '{"format":1,"enabled":false}\n')
    return
  }
  const officeManifest = JSON.parse(await readFile(join(officeRuntime, 'runtime.json'), 'utf8'))
  if (officeManifest.platform !== process.platform || officeManifest.arch !== process.arch
    || !officeManifest.python.startsWith(`${lock.python}.`)) {
    throw new Error(`XASP runtime requires native Office Python ${lock.python} on ${target}`)
  }

  const staging = await mkdtemp(join(dirname(output), '.xasp-runtime-'))
  try {
    const xasp = join(staging, 'xasp')
    await stagePinnedSource(resolve(sourceRoot), xasp)
    const testBindings = await readTestBindings(testWorkflowConfig, xasp)
    // Apply only to the staged immutable revision. The checkout is read-only.
    await execFile('git', ['apply', '--no-index', fileURLToPath(new URL('./desktop-portability.patch', import.meta.url))], {
      cwd: xasp,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: staging },
      windowsHide: true,
      timeout: 30_000
    })
    await copyFile(new URL('./desktop_io.py', import.meta.url), join(xasp, 'apps/cli/src/oa_cli/_desktop_io.py'))
    const wheels = [...lock.wheels, ...lock.targets[target]]
    const sitePackages = join(staging, 'site-packages')
    const wheelFiles = await Promise.all(wheels.map(({ url, sha256 }) => downloadAsset(url, sha256, cache)))
    for (const archive of wheelFiles) await unpackWheel(archive, sitePackages)
    await copyFile(new URL('./worker.py', import.meta.url), join(staging, 'worker.py'))
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({
      format: 1,
      enabled: true,
      revision: lock.revision,
      platform: officeManifest.platform,
      arch: officeManifest.arch,
      python: officeManifest.python,
      testBindings,
      pythonPackages: Object.fromEntries(wheels.map(({ name, version }) => [name, version]))
    }, null, 2)}\n`)
    await rename(staging, output)
    console.log(`XASP runtime prepared: ${target}, revision ${lock.revision}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareXaspRuntime()
