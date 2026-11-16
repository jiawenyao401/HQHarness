const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { promisify, isDeepStrictEqual } = require('node:util')
const execFile = promisify(require('node:child_process').execFile)
const lock = require('../packages/huaqing-cli-dist/lock.json')

async function verifyPackagedHuaqingCli(resources, executable, { historical = false } = {}) {
  const bundle = path.join(resources, 'huaqing-cli')
  const metadata = JSON.parse(await fs.readFile(path.join(bundle, 'desktop-bundle.json'), 'utf8'))
  const expected = { ...lock, platform: process.platform, arch: process.arch }
  if (historical && typeof metadata.version === 'string' && /^[0-9a-f]{64}$/u.test(metadata.sha256)) {
    expected.version = metadata.version
    expected.sha256 = metadata.sha256
  }
  if (!isDeepStrictEqual(metadata, expected)) {
    throw new Error('Huaqing CLI: packaged version or target differs from the build lock')
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'huaqing CLI smoke '))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:HUAQING_.*|NAPI_RS_.*|NODE_OPTIONS|NODE_PATH)$/iu.test(key)
  ))
  try {
    await execFile(executable, [
      path.join(__dirname, 'huaqing-cli', 'smoke.mjs'), bundle, expected.version, expected.platform, expected.arch
    ], {
      cwd: scratch,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        HUAQING_CONFIG_HOME: path.join(scratch, 'config'),
        HUAQING_STATE_HOME: path.join(scratch, 'state')
      },
      windowsHide: true,
      timeout: 90_000
    })
    console.log(`Packaged Huaqing CLI ${expected.version}: skills, OA expense dry-run, SQLite persistence and keyring passed`)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

module.exports = verifyPackagedHuaqingCli

if (require.main === module) {
  verifyPackagedHuaqingCli(path.resolve(process.argv[2]), path.resolve(process.argv[3]), {
    historical: process.argv[4] === '--historical'
  }).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
