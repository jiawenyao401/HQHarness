import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--electron')) throw new Error('Usage: node scripts/automation-performance-smoke.mjs [--electron <absolute native executable>]')
const installed = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron.exe')
const electron = args[1] ?? installed
if (!path.isAbsolute(electron)) throw new Error('The Electron executable must be an absolute path')
const output = path.join(root, '.build', 'automation-performance-smoke.cjs')
await mkdir(path.dirname(output), { recursive: true })
await build({ entryPoints: [path.join(root, 'test/fixtures/automation-performance-smoke.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron', '@trycua/cua-driver'] })
const profile = await mkdtemp(path.join(tmpdir(), 'hq-performance-smoke-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// This is an application integration test against an isolated local web page;
// it does not access desktop applications or any installed HQHarness profile.
const child = spawn(electron, [output, `--user-data-dir=${profile}`, '--force-renderer-accessibility'], { env, stdio: 'inherit', windowsHide: false })
const timer = setTimeout(() => child.kill(), 60_000)
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  process.exitCode = typeof code === 'number' ? code : 1
} finally { clearTimeout(timer); await rm(profile, { recursive: true, force: true }) }
