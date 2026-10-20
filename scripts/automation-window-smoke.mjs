import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

if (process.platform !== 'win32') throw new Error('Native window UIA acceptance requires an interactive Windows desktop')
const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--electron')) throw new Error('Usage: node scripts/automation-window-smoke.mjs [--electron <absolute executable>]')
const electron = args[1] ?? path.join(root, 'node_modules/electron/dist/electron.exe')
if (!path.isAbsolute(electron)) throw new Error('The Electron executable must be an absolute path')
const output = path.join(root, '.build', 'automation-window-smoke.cjs')
await mkdir(path.dirname(output), { recursive: true })
await build({ entryPoints: [path.join(root, 'test/fixtures/automation-window-smoke.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron', '@trycua/cua-driver'] })
const directory = await mkdtemp(path.join(tmpdir(), 'hq-native-window-smoke-'))
const title = 'HQHarness Native UIA Fixture ' + randomUUID()
// This fixed, application-owned WinForms fixture is an independent oracle.
// Neither its PowerShell source nor its result files are product agent tools.
const powershell = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:HQ_WINDOW_FIXTURE_TITLE
$form.Width = 540; $form.Height = 240
$form.StartPosition = 'CenterScreen'
$query = New-Object System.Windows.Forms.TextBox
$query.AccessibleName = 'Query'; $query.Name = 'Query'
$query.Text = 'initial'; $query.Left = 20; $query.Top = 30; $query.Width = 460
$search = New-Object System.Windows.Forms.Button
$search.Text = 'Search'; $search.AccessibleName = 'Search'
$search.Left = 20; $search.Top = 80; $search.Width = 100
$done = New-Object System.Windows.Forms.Button
$done.Text = 'Done'; $done.AccessibleName = 'Done'
$done.Left = 140; $done.Top = 80; $done.Width = 100; $done.Visible = $false
$script:clicks = 0
$utf8 = New-Object System.Text.UTF8Encoding($false)
$search.Add_Click({
  $script:clicks++
  $result = @{ pid = $PID; title = $form.Text; clicks = $script:clicks; value = $query.Text } | ConvertTo-Json -Compress
  $destination = [System.IO.Path]::Combine($env:HQ_WINDOW_FIXTURE_DIRECTORY, 'result.json')
  [System.IO.File]::WriteAllText($destination + '.tmp', $result, $utf8)
  Move-Item -LiteralPath ($destination + '.tmp') -Destination $destination -Force
  $done.Visible = $true
})
$form.Controls.AddRange([System.Windows.Forms.Control[]]@($query, $search, $done))
$form.Add_Shown({
  $ready = @{ pid = $PID; window = $form.Handle.ToInt64().ToString(); title = $form.Text } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText([System.IO.Path]::Combine($env:HQ_WINDOW_FIXTURE_DIRECTORY, 'ready.json'), $ready, $utf8)
})
[System.Windows.Forms.Application]::Run($form)
$form.Dispose()
`
const script = path.join(directory, 'fixture.ps1')
await writeFile(script, powershell, 'utf8')
const env = { ...process.env, HQ_WINDOW_FIXTURE_DIRECTORY: directory, HQ_WINDOW_FIXTURE_TITLE: title }
delete env.ELECTRON_RUN_AS_NODE
const fixture = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-File', script], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
let fixtureError
let fixtureExited = false
let fixtureDiagnostics = ''
fixture.once('error', error => { fixtureError = error })
fixture.once('exit', () => { fixtureExited = true })
fixture.stderr.on('data', chunk => { fixtureDiagnostics = (fixtureDiagnostics + String(chunk)).slice(-8000) })
let controller
let timer
try {
  if (!fixture.pid) throw new Error('The native fixture process could not start')
  controller = spawn(electron, [output, `--user-data-dir=${path.join(directory, 'profile')}`], {
    env: { ...env, HQ_WINDOW_FIXTURE_PID: String(fixture.pid) }, stdio: 'inherit', windowsHide: false
  })
  timer = setTimeout(() => controller?.kill(), 75_000)
  const code = await new Promise((resolve, reject) => { controller.once('error', reject); controller.once('exit', resolve) })
  if (fixtureError) throw fixtureError
  if (code !== 0 && fixtureDiagnostics) process.stderr.write('Native fixture diagnostics: ' + fixtureDiagnostics + '\n')
  process.exitCode = typeof code === 'number' ? code : 1
} finally {
  clearTimeout(timer)
  if (!fixtureExited) {
    const exited = new Promise(resolve => fixture.once('exit', resolve))
    fixture.kill()
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
  }
  await rm(directory, { recursive: true, force: true })
}
