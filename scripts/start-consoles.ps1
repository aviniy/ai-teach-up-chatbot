$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot ".runtime"
$runner = Join-Path $PSScriptRoot "run-console.ps1"
$toolsDirectory = Join-Path $projectRoot ".local-tools"
$cloudflared = Join-Path $toolsDirectory "cloudflared.exe"

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Remove-Item -LiteralPath (Join-Path $runtime "stopping.flag") -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $cloudflared)) {
  New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
  $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$architecture.exe"
  $downloadPath = Join-Path $toolsDirectory "cloudflared.download"

  Write-Host "Downloading cloudflared from the official GitHub release..." -ForegroundColor Cyan
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $downloadPath
    Move-Item -LiteralPath $downloadPath -Destination $cloudflared -Force
    & $cloudflared --version | Out-Host
  } catch {
    Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
    throw "Could not download cloudflared. Check the internet connection and try again."
  }
}

function Test-RoleRunning([string]$role) {
  $pidFile = Join-Path $runtime "$role.pid"
  if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
  $savedPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) { return $false }
  $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
  return $null -ne $process -and $process.ProcessName -eq "cmd"
}

function Start-Role([string]$role, [string]$label) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$runner`"",
    "-Role", $role
  )
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Normal | Out-Null
  Write-Host "$label console opened." -ForegroundColor Green
}

if (Test-RoleRunning "server") {
  Write-Host "The chatbot server is already running." -ForegroundColor Yellow
} else {
  Start-Role "server" "Server log"
}

Start-Sleep -Milliseconds 900

if (Test-RoleRunning "tunnel") {
  Write-Host "The public tunnel is already running." -ForegroundColor Yellow
} else {
  Start-Role "tunnel" "Public URL log"
}

Write-Host ""
Write-Host "Run AI-Teach-Up-STOP.bat to stop both processes." -ForegroundColor Cyan
