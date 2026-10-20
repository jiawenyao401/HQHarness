import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, '.build', 'automation-consent-smoke.cjs')
await mkdir(path.dirname(output), { recursive: true })
await build({ entryPoints: [path.join(root, 'test/fixtures/automation-consent-smoke.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron', '@trycua/cua-driver'] })
const profile = await mkdtemp(path.join(tmpdir(), 'hq-consent-smoke-'))
const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron.exe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [output, `--user-data-dir=${profile}`], { env, stdio: 'inherit', windowsHide: false })
const timer = setTimeout(() => child.kill(), 30_000)
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  process.exitCode = typeof code === 'number' ? code : 1
} finally { clearTimeout(timer); await rm(profile, { recursive: true, force: true }) }
