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
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HQNativeForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:HQ_WINDOW_FIXTURE_TITLE
$form.Width = 540; $form.Height = 300
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
$background = New-Object System.Windows.Forms.Button
$background.Text = 'Background'; $background.AccessibleName = 'Background'
$background.Left = 260; $background.Top = 80; $background.Width = 110
$list = New-Object System.Windows.Forms.ListView
$list.AccessibleName = 'Items'; $list.Left = 20; $list.Top = 130
$list.Width = 460; $list.Height = 90; $list.View = 'List'
$list.Activation = 'TwoClick'
$list.Items.Add('DoubleTarget') | Out-Null
$keeper = New-Object System.Windows.Forms.Form
$keeper.Text = $form.Text + ' Foreground keeper'
$keeper.Width = 220; $keeper.Height = 100
$keeper.StartPosition = 'Manual'
$keeper.Left = 20; $keeper.Top = 20
$script:clicks = 0
$script:backgroundClicks = 0
$script:doubleClicks = 0
$utf8 = New-Object System.Text.UTF8Encoding($false)
$background.Add_Click({
  $script:backgroundClicks++
  $result = @{ pid = $PID; clicks = $script:backgroundClicks; foreground = [HQNativeForeground]::GetForegroundWindow().ToInt64().ToString() } | ConvertTo-Json -Compress
  $destination = [System.IO.Path]::Combine($env:HQ_WINDOW_FIXTURE_DIRECTORY, 'background.json')
  [System.IO.File]::WriteAllText($destination + '.tmp', $result, $utf8)
  Move-Item -LiteralPath ($destination + '.tmp') -Destination $destination -Force
})
$list.Add_ItemActivate({
  $script:doubleClicks++
  $result = @{ pid = $PID; activations = $script:doubleClicks; selected = @($list.SelectedItems | ForEach-Object { $_.Text }) } | ConvertTo-Json -Compress
  $destination = [System.IO.Path]::Combine($env:HQ_WINDOW_FIXTURE_DIRECTORY, 'double.json')
  [System.IO.File]::WriteAllText($destination + '.tmp', $result, $utf8)
  Move-Item -LiteralPath ($destination + '.tmp') -Destination $destination -Force
})
$search.Add_Click({
  $script:clicks++
  $result = @{ pid = $PID; title = $form.Text; clicks = $script:clicks; value = $query.Text } | ConvertTo-Json -Compress
  $destination = [System.IO.Path]::Combine($env:HQ_WINDOW_FIXTURE_DIRECTORY, 'result.json')
  [System.IO.File]::WriteAllText($destination + '.tmp', $result, $utf8)
  Move-Item -LiteralPath ($destination + '.tmp') -Destination $destination -Force
  $done.Visible = $true
})
$form.Controls.AddRange([System.Windows.Forms.Control[]]@($query, $search, $done, $background, $list))
$form.Add_Shown({
  $keeper.Show(); $keeper.Activate()
  $ready = @{ pid = $PID; window = $form.Handle.ToInt64().ToString(); title = $form.Text; keeper = $keeper.Handle.ToInt64().ToString(); foreground = [HQNativeForeground]::GetForegroundWindow().ToInt64().ToString() } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText([System.IO.Path]::Combine($env:HQ_WINDOW_FIXTURE_DIRECTORY, 'ready.json'), $ready, $utf8)
})
[System.Windows.Forms.Application]::Run($form)
$keeper.Dispose()
$form.Dispose()
`
const script = path.join(directory, 'fixture.ps1')
await writeFile(script, powershell, 'utf8')
const env = { ...process.env, HQ_WINDOW_FIXTURE_DIRECTORY: directory, HQ_WINDOW_FIXTURE_TITLE: title }
delete env.ELECTRON_RUN_AS_NODE
// windowsHide also sets STARTUPINFO's SW_HIDE for the first GUI window. The
// WinForms fixture must be visible to native discovery, not only .NET's Shown
// event; hiding this child produces a ready HWND that Cua correctly filters out.
const fixture = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-File', script], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false })
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
