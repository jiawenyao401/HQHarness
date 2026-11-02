import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Manual qualification only. Example manifest.json (prepare the DOCX separately):
// {"version":1,"fixtures":[{"type":"writer","file":"huaqing-wps-writer.docx",
//   "marker":"unique before text","replacement":"unique after text"}]}
// Optional spreadsheet: {type,file,sheet,range:"A1:B2",before:2x2,after:2x2}.
// Optional presentation: {type,file,slideId,shapeId,marker,replacement}.
// With --register, quit WPS first and approve the production native dialog.
// Then reopen WPS and open only the manifest's test files. Never auto-close WPS.
const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({ options: {
  'fixture-dir': { type: 'string' }, report: { type: 'string' }, register: { type: 'boolean', default: false },
  'timeout-ms': { type: 'string', default: '600000' }, 'build-only': { type: 'boolean', default: false }
} })
if (!values['fixture-dir'] || !path.isAbsolute(values['fixture-dir']) || !values.report || !path.isAbsolute(values.report)) {
  throw new Error('Usage: node scripts/wps-native-smoke.mjs --fixture-dir <absolute temporary fixture directory> --report <new absolute JSON path> [--register] [--timeout-ms 600000] [--build-only]')
}
if (values.report.split(/[\\/]/u).some(part => part.toLowerCase() === 'deliverables')) throw new Error('Write the native smoke report outside deliverables')
const timeoutMs = Number(values['timeout-ms'])
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('timeout-ms must be between 1000 and 600000')
const fixtureDir = await realpath(values['fixture-dir'])
const nativeTemp = await realpath(tmpdir())
const tempRoots = [nativeTemp, ...(process.platform === 'win32' ? [] : [await realpath('/tmp')])]
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
if (!tempRoots.some(temp => inside(temp, fixtureDir))) throw new Error('fixture-dir must be a dedicated subdirectory of the system temporary directory')
const directoryInfo = await lstat(values['fixture-dir'])
if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('fixture-dir must not be a symbolic link')
const manifestPath = path.join(fixtureDir, 'manifest.json')
const manifestInfo = await lstat(manifestPath)
if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 65_536) throw new Error('A regular manifest.json up to 64 KiB is required')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest?.version !== 1 || !Array.isArray(manifest.fixtures) || !manifest.fixtures.length) throw new Error('Expected manifest version 1 with explicit fixtures')
const report = path.join(await realpath(path.dirname(values.report)), path.basename(values.report))
try { await lstat(report); throw new Error('The report path already exists; select a new report file') } catch (error) { if (error.code !== 'ENOENT') throw error }

await mkdir(path.join(root, '.build'), { recursive: true })
const appDirectory = await mkdtemp(path.join(root, '.build', 'wps-native-smoke-'))
const output = path.join(appDirectory, 'main.cjs')
const userData = await mkdtemp(path.join(nativeTemp, 'huaqing-wps-native-profile-'))
// This isolated app consumes the production service and its real source assets.
// app.getAppPath() is the generated app directory, never the user's installation.
await mkdir(path.join(appDirectory, 'node_modules', 'hqharness-wps', 'addin'), { recursive: true })
for (const file of ['index.html', 'manifest.xml', 'ribbon.xml', 'adapter.js', 'main.js']) {
  await copyFile(path.join(root, 'packages', 'hqharness-wps', 'addin', file), path.join(appDirectory, 'node_modules', 'hqharness-wps', 'addin', file), constants.COPYFILE_EXCL)
}
await writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'huaqing-wps-native-smoke', version: '0.0.0', main: 'main.cjs' }) + '\n')
await build({ entryPoints: [path.join(root, 'test', 'fixtures', 'wps-native-smoke.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'bufferutil', 'utf-8-validate'], logLevel: 'warning' })
if (values['build-only']) {
  console.log(JSON.stringify({ status: 'built_not_run', appDirectory, userData, fixtureDir, report, registrationRequested: values.register }))
} else {
  const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  await access(electron, constants.X_OK)
  const env = { ...process.env, HQ_WPS_SMOKE_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [appDirectory, '--force-renderer-accessibility', '--fixture-dir', fixtureDir, '--report', report, '--timeout-ms', String(Math.max(1000, timeoutMs - 5000)), ...(values.register ? ['--register'] : [])]
  const child = spawn(electron, args, { cwd: root, env, stdio: 'inherit', windowsHide: false })
  // Only this test Electron process is stopped. WPS is never a child we kill.
  const timer = setTimeout(() => child.kill(), timeoutMs)
  try {
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
    process.exitCode = typeof code === 'number' ? code : 1
    try { await lstat(report) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await writeFile(report, JSON.stringify({ version: 1, status: 'failed', phase: 'electron_exited_without_report', exitCode: code, userData, fixtureDir, registrationRequested: values.register, registrationRemoved: false }) + '\n', { flag: 'wx', mode: 0o600 })
    }
  } finally {
    clearTimeout(timer)
    // User data and fixture files retain recovery evidence. Registration is
    // deliberately retained for the operator to inspect and explicitly remove.
    await rm(appDirectory, { recursive: true, force: true })
  }
}
