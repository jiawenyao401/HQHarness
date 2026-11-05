param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, [Environment+SpecialFolderOption]::DoNotVerify)
if (-not [System.IO.Path]::IsPathFullyQualified($documents)) { throw 'Windows Documents path is unavailable.' }
$root = Join-Path $documents 'HuaqingDesktop'
if (Test-Path -LiteralPath $root) { throw "Expected a clean test profile. Directory already exists at $root" }
$workspace = Join-Path $root 'default-workspace'
$appDirectory = Join-Path $root 'app'
$sentinel = Join-Path $workspace 'keep.txt'
$marker = [guid]::NewGuid().ToString()
New-Item -ItemType Directory -Path $workspace -Force | Out-Null
Set-Content -LiteralPath $sentinel -Value $marker -NoNewline

function Invoke-TestInstaller([string]$arguments) {
  $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -PassThru
  if (-not $process.WaitForExit(300000)) { throw 'Installer timed out.' }
  return $process.ExitCode
}

function Assert-Workspace {
  if ((Get-Content -LiteralPath $sentinel -Raw) -cne $marker) { throw 'Existing workspace data changed.' }
}

foreach ($path in @($root, $workspace)) {
  # NSIS treats the rest of the command line after /D= as the path.
  if ((Invoke-TestInstaller "/S /currentuser /D=$path") -eq 0) {
    throw "Installer accepted the protected path $path"
  }
  Assert-Workspace
}

foreach ($phase in @('first install', 'same-path upgrade')) {
  if ((Invoke-TestInstaller '/S /currentuser') -ne 0) { throw "Failed $phase" }
  if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'HQHarness.exe') -PathType Leaf)) {
    throw "Missing executable in Documents/HuaqingDesktop/app after $phase"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $appDirectory 'resources/app.asar') -PathType Leaf)) {
    throw "Missing bundled runtime after $phase"
  }
  Assert-Workspace
}

$uninstaller = Join-Path $appDirectory 'Uninstall HQHarness.exe'
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -Wait -PassThru
if ($process.ExitCode -ne 0 -or (Test-Path -LiteralPath (Join-Path $appDirectory 'HQHarness.exe'))) {
  throw 'Silent uninstall did not remove the installed application.'
}
Assert-Workspace
Remove-Item -LiteralPath $sentinel
Remove-Item -LiteralPath $workspace
if (Test-Path -LiteralPath $appDirectory) { Remove-Item -LiteralPath $appDirectory }
Remove-Item -LiteralPath $root
Write-Host 'Verified Windows Documents default install, safe upgrade and workspace retention on uninstall.'
