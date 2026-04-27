param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'SangLive')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$repoZip = 'https://github.com/thsangyk-oss/sanglive/archive/refs/heads/main.zip'
$tempRoot = Join-Path $env:TEMP ('sanglive-install-' + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'sanglive.zip'
$extractPath = Join-Path $tempRoot 'extract'

function Assert-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw 'Node.js is required. Install Node.js 20 LTS first: https://nodejs.org/'
  }
}

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

try {
  Assert-Node
  Write-Host "Downloading SangLive from $repoZip"
  Invoke-WebRequest -Uri $repoZip -OutFile $zipPath -UseBasicParsing

  Write-Host 'Extracting package...'
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  $sourceDir = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1
  if (-not $sourceDir) { throw 'Downloaded package is empty.' }

  Write-Host "Installing to $InstallDir"
  Copy-Item -Path (Join-Path $sourceDir.FullName '*') -Destination $InstallDir -Recurse -Force

  $installer = Join-Path $InstallDir 'install.ps1'
  if (-not (Test-Path $installer)) { throw 'install.ps1 not found after extraction.' }

  & powershell -NoProfile -ExecutionPolicy Bypass -File $installer
  if ($LASTEXITCODE -ne 0) { throw 'SangLive installer failed.' }

  Write-Host ''
  Write-Host 'Install complete.'
  Write-Host 'Use the Desktop shortcut named "SangLive" to start the app.'
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
