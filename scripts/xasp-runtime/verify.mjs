import { execFile as runFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(runFile)
const lock = JSON.parse(await readFile(new URL('./lock.json', import.meta.url), 'utf8'))

/** Verify installed resources with the target's bundled interpreter, offline. */
export async function verifyXaspRuntime(resources) {
  const payload = join(resources, 'xasp-runtime')
  const manifest = JSON.parse(await readFile(join(payload, 'manifest.json'), 'utf8'))
  if (manifest.format !== 1 || typeof manifest.enabled !== 'boolean') throw new Error('Invalid XASP runtime manifest')
  if (!manifest.enabled) {
    if (process.env.XASP_REQUIRE_BUNDLE === '1') throw new Error('Required XASP runtime is missing from the package')
    return
  }
  if (manifest.revision !== lock.revision || manifest.platform !== process.platform || manifest.arch !== process.arch
    || typeof manifest.python !== 'string' || !manifest.python.startsWith(`${lock.python}.`)) {
    throw new Error('XASP runtime revision, target or Python ABI mismatch')
  }
  const runtime = join(resources, 'office-runtime', 'primary-runtime')
  const python = join(runtime, 'dependencies', 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']))
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-xasp-smoke-'))
  try {
    const options = {
      cwd: scratch,
      timeout: 90_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }
    await execFile(python, ['-I', '-B', '-X', 'utf8', fileURLToPath(new URL('./smoke.py', import.meta.url)), payload, scratch], options)
    await execFile(python, ['-I', '-B', '-X', 'utf8', fileURLToPath(new URL('./test_worker.py', import.meta.url)), payload], options)
    console.log('Packaged XASP Python, OA skill checks, draft and recovery fixtures, journal locks and multipart transport passed')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/xasp-runtime/verify.mjs <resources>')
  await verifyXaspRuntime(resolve(process.argv[2]))
}
