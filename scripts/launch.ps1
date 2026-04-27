param(
  [int]$Port = 4111,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$root = Split-Path -Parent $PSScriptRoot
$url = "http://localhost:$Port"
$env:PORT = [string]$Port

function Stop-XAliveListeners {
  param([int]$LocalPort)

  $connections = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
  if (-not $connections) { return }

  $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($processId in $pids) {
    try {
      $proc = Get-Process -Id $processId -ErrorAction Stop
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Write-Host "Stopped old backend PID $processId ($($proc.ProcessName))"
    } catch {
      Write-Warning "Could not stop PID ${processId}: $($_.Exception.Message)"
    }
  }
}

function Assert-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw 'Chưa có Node.js. Cài Node.js 20 LTS trước: https://nodejs.org/'
  }
}

function Test-BackendOnline {
  param([string]$StatusUrl)

  try {
    $response = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 2 -ErrorAction Stop
    return $null -ne $response
  } catch {
    return $false
  }
}

function Start-Backend {
  Write-Host "Starting XAlive Lite at $url"
  $nodeProcess = Start-Process -FilePath 'node' -ArgumentList @('server/index.js') -WorkingDirectory $root -WindowStyle Minimized -PassThru
  Start-Sleep -Seconds 2

  if ($nodeProcess.HasExited) {
    throw "Backend dừng ngay sau khi start. Exit code: $($nodeProcess.ExitCode)"
  }

  Write-Host "XAlive Lite is running. PID: $($nodeProcess.Id)"
}

function Open-Frontend {
  if (-not $NoBrowser) {
    Start-Process $url
  }
}

Set-Location $root
Assert-Node

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host 'Đang cài dependencies...'
  npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install thất bại.' }
}

if (Test-BackendOnline -StatusUrl "$url/api/status") {
  Write-Host "Backend already online at $url. Opening frontend only."
  Open-Frontend
  exit 0
}

Stop-XAliveListeners -LocalPort $Port
Start-Backend
Open-Frontend
