param(
  [switch]$NoInstall,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$root = $PSScriptRoot
$shortcutName = 'SangLive.lnk'
$desktopPaths = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  (Join-Path $env:USERPROFILE 'OneDrive\Desktop'),
  (Join-Path $env:PUBLIC 'Desktop')
) | Where-Object { $_ } | Select-Object -Unique
$launcherPath = Join-Path $root 'scripts\launch.ps1'
$iconPath = Join-Path $root 'public\sanglive.ico'

function Assert-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw 'Chưa có Node.js. Cài Node.js 20 LTS trước: https://nodejs.org/'
  }
}

function Create-Shortcut {
  param([string]$ShortcutPath)

  $shortcutDir = Split-Path -Parent $ShortcutPath
  if (-not (Test-Path $shortcutDir)) { New-Item -ItemType Directory -Force -Path $shortcutDir | Out-Null }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = 'powershell.exe'
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`""
  $shortcut.WorkingDirectory = $root
  if (Test-Path $iconPath) { $shortcut.IconLocation = $iconPath }
  $shortcut.Description = 'Start SangLive backend and open frontend'
  $shortcut.Save()
}

Set-Location $root
Assert-Node

if (-not $NoInstall) {
  npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install thất bại.' }
}

if (-not $NoShortcut) {
  foreach ($desktop in $desktopPaths) {
    if (-not $desktop) { continue }
    $shortcutPath = Join-Path $desktop $shortcutName
    try {
      Create-Shortcut -ShortcutPath $shortcutPath
      Write-Host "Đã tạo shortcut: $shortcutPath"
    } catch {
      Write-Warning "Không tạo được shortcut tại ${shortcutPath}: $($_.Exception.Message)"
    }
  }
}

Write-Host 'Cài đặt hoàn tất. Bấm shortcut SangLive trên Desktop để chạy.'
