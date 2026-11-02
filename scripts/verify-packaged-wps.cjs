const fs = require('node:fs/promises')
const path = require('node:path')
const asar = require('@electron/asar')
const { isDeepStrictEqual } = require('node:util')

const SOURCE_ROOT = path.resolve(__dirname, '..', 'packages')
const SDK_VERSION = '2.2.0'
const WPS_FILES = [
  'package.json', 'index.js', 'protocol.js', 'client.js', 'THIRD-PARTY-NOTICES.txt',
  'addin/adapter.js', 'addin/index.html', 'addin/main.js', 'addin/manifest.xml', 'addin/ribbon.xml'
]

function fail(stage, message) {
  throw new Error(`[wps-package:${stage}] ${message}`)
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function archivePath(context) {
  if (!record(context) || !['darwin', 'mas', 'win32', 'linux'].includes(context.electronPlatformName)
    || typeof context.appOutDir !== 'string' || !path.isAbsolute(context.appOutDir)) {
    fail('context', 'An explicit electron platform and absolute appOutDir are required')
  }
  const product = context.packager?.appInfo?.productFilename
  if (typeof product !== 'string' || !product || product === '.' || product === '..' || /[\\/\0]/u.test(product)) {
    fail('context', 'Invalid productFilename')
  }
  return context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas'
    ? path.join(context.appOutDir, `${product}.app`, 'Contents', 'Resources', 'app.asar')
    : path.join(context.appOutDir, 'resources', 'app.asar')
}

function reader(archive) {
  function stat(relative, stage) {
    const segments = relative.split('/')
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\\0]/u.test(segment))) {
      fail(stage, 'Invalid archive-relative path')
    }
    let info
    for (let count = 1; count <= segments.length; count++) {
      const current = segments.slice(0, count).join('/')
      // ASAR 3.x traverses header directories using the host's path.sep.
      // Keep diagnostics/exports POSIX, but pass native paths to its API.
      try { info = asar.statFile(archive, path.join(...segments.slice(0, count)), false) } catch { fail(stage, `Missing ASAR input: ${current}`) }
      // No source checkout links, unpacked files, Profile or cwd resolution.
      if (info.link !== undefined || info.unpacked) fail(stage, `Input must be stored inside ASAR: ${current}`)
      if (count < segments.length && !record(info.files)) fail(stage, `Not an ASAR directory: ${current}`)
    }
    return info
  }
  function read(relative, stage) {
    const info = stat(relative, stage)
    if (typeof info.size !== 'number' || info.size <= 0) fail(stage, `Not a nonempty ASAR file: ${relative}`)
    try { return asar.extractFile(archive, path.join(...relative.split('/')), false) } catch { fail(stage, `Cannot read ASAR input: ${relative}`) }
  }
  function json(relative, stage) {
    let value
    try { value = JSON.parse(read(relative, stage).toString('utf8')) } catch (error) {
      if (error.message.startsWith('[wps-package:')) throw error
      fail(stage, `Invalid JSON: ${relative}`)
    }
    if (!record(value)) fail(stage, `Expected a manifest object: ${relative}`)
    return value
  }
  return { read, json }
}

async function verifySources(read, packageName, files) {
  for (const file of files) {
    const relative = `node_modules/${packageName}/${file}`
    let expected
    try { expected = await fs.readFile(path.join(SOURCE_ROOT, packageName, file)) } catch {
      fail('source', `Missing authoritative source: ${packageName}/${file}`)
    }
    if (!read(relative, 'resources').equals(expected)) fail('resources', `Stale packaged source: ${relative}`)
  }
}

function exportTarget(packageRoot, target, mode) {
  if (typeof target !== 'string' || !target.startsWith('./') || /[\\\0*?#]/u.test(target)
    || target.slice(2).split('/').some(segment => !segment || segment === '.' || segment === '..' || segment === 'node_modules')
    || !target.endsWith(mode === 'import' ? '.mjs' : '.cjs')) {
    fail('sdk-exports', `Invalid ${mode} target in ${packageRoot}`)
  }
  return `${packageRoot}/${target.slice(2)}`
}

function sdkTargets(packageRoot, value, targets) {
  if (!record(value)) fail('sdk-exports', `Invalid conditional exports in ${packageRoot}`)
  if (Object.hasOwn(value, 'import') || Object.hasOwn(value, 'require')) {
    for (const mode of ['import', 'require']) {
      if (!record(value[mode])) fail('sdk-exports', `Missing ${mode} exports in ${packageRoot}`)
      targets.add(exportTarget(packageRoot, value[mode].default, mode))
    }
    return
  }
  const conditions = Object.values(value)
  if (!conditions.length) fail('sdk-exports', `Empty conditional exports in ${packageRoot}`)
  for (const condition of conditions) sdkTargets(packageRoot, condition, targets)
}

function verifySdk(read, json, name) {
  const packageRoot = `node_modules/@modelcontextprotocol/${name}`
  const manifest = json(`${packageRoot}/package.json`, 'sdk-manifest')
  if (manifest.name !== `@modelcontextprotocol/${name}` || manifest.version !== SDK_VERSION || manifest.type !== 'module') {
    fail('sdk-manifest', `Expected @modelcontextprotocol/${name}@${SDK_VERSION}`)
  }
  if (name !== 'core' && manifest.dependencies?.['@modelcontextprotocol/core'] !== SDK_VERSION) {
    fail('sdk-manifest', `Expected ${name} to declare core@${SDK_VERSION}`)
  }
  const subpaths = name === 'core' ? ['.', './internal'] : ['.', './stdio', './validators/ajv', './validators/cf-worker', './_shims']
  if (!record(manifest.exports) || !isDeepStrictEqual(Object.keys(manifest.exports).sort(), subpaths.sort())) {
    fail('sdk-exports', `Unexpected public exports for @modelcontextprotocol/${name}@${SDK_VERSION}`)
  }
  const targets = new Set()
  for (const value of Object.values(manifest.exports)) sdkTargets(packageRoot, value, targets)
  if (manifest.main !== './dist/index.cjs') fail('sdk-exports', `Invalid main in ${packageRoot}`)
  // The pinned SDK's generated modules use literal relative imports/requires.
  // Check their chunks too; do not execute code or resolve bare packages outside ASAR.
  const visited = new Set()
  for (const relative of targets) {
    if (visited.has(relative)) continue
    visited.add(relative)
    const source = read(relative, 'sdk-closure').toString('utf8')
    const imports = /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)|\b(?:from|import)\s*['"](\.[^'"]+)['"]/gu
    for (const match of source.matchAll(imports)) {
      const dependency = match[1] ?? match[2]
      if (/[\\\0?#]/u.test(dependency)) fail('sdk-closure', `Invalid relative module in ${relative}`)
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(relative), dependency))
      if (!next.startsWith(`${packageRoot}/`) || !/\.(?:cjs|mjs|js)$/u.test(next)) fail('sdk-closure', `Module leaves the SDK package: ${relative}`)
      targets.add(next)
    }
  }
}

/** Build-time content gate only; it does not activate WPS or verify document operations. */
async function verifyPackagedWps(context) {
  const archive = archivePath(context)
  let info
  try { info = await fs.lstat(archive) } catch { fail('archive', 'Missing app.asar in the explicit package output') }
  if (!info.isFile() || info.isSymbolicLink()) fail('archive', 'app.asar must be a regular file')
  asar.uncache(archive)
  try {
    const { read, json } = reader(archive)
    const wps = json('node_modules/hqharness-wps/package.json', 'wps-manifest')
    if (wps.name !== 'hqharness-wps' || wps.type !== 'module' || wps.main !== './index.js'
      || wps.exports?.['.'] !== './index.js' || wps.exports?.['./client'] !== './client.js'
      || wps.exports?.['./package.json'] !== './package.json'
      || !isDeepStrictEqual(wps.exports?.['./protocol'], { types: './protocol.d.ts', default: './protocol.js' })
      || !isDeepStrictEqual(wps.dsh?.client, { platform: 'web', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings-plugins'] })
      || wps.dependencies?.['@modelcontextprotocol/client'] !== SDK_VERSION) {
      fail('wps-manifest', 'WPS entry, public exports, dsh.client or declared SDK contract differs')
    }
    await verifySources(read, 'hqharness-wps', WPS_FILES)
    const dsh = json('node_modules/@deepseek-ai/dsh/package.json', 'installation')
    if (dsh.dependencies?.['hqharness-wps'] !== wps.version) fail('installation', 'Harness does not declare the packaged WPS plugin')
    const app = json('package.json', 'installation')
    for (const name of ['client', 'server']) {
      if (app.dependencies?.[`@modelcontextprotocol/${name}`] !== SDK_VERSION) fail('installation', `Desktop must declare @modelcontextprotocol/${name}@${SDK_VERSION}`)
    }
    const automation = json('node_modules/hqharness-automation/package.json', 'automation')
    if (automation.name !== 'hqharness-automation' || automation.exports?.['./wps-routing'] !== './wps-routing.js') {
      fail('automation', 'Missing public hqharness-automation/wps-routing export')
    }
    await verifySources(read, 'hqharness-automation', ['wps-routing.js'])
    for (const name of ['client', 'server', 'core']) verifySdk(read, json, name)
  } finally {
    asar.uncache(archive)
  }
}

module.exports = verifyPackagedWps
