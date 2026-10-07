$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot ".runtime"

if (-not (Test-Path -LiteralPath $runtime)) {
  Write-Host "AI Teach-Up is not running." -ForegroundColor Yellow
  exit 0
}

New-Item -ItemType File -Force -Path (Join-Path $runtime "stopping.flag") | Out-Null

function Stop-SavedTree([string]$role) {
  $pidFile = Join-Path $runtime "$role.pid"
  if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
  $savedPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) { return $false }
  $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.ProcessName -ne "cmd") { return $false }
  & taskkill.exe /PID $savedPid /T /F 2>$null | Out-Null
  return $true
}

$serverStopped = Stop-SavedTree "server"
$tunnelStopped = Stop-SavedTree "tunnel"
Start-Sleep -Milliseconds 900

# Normally the console wrappers close by themselves after their child process
# exits. Close only the exact saved PowerShell wrappers if one is still alive.
foreach ($role in @("server", "tunnel")) {
  $consolePidFile = Join-Path $runtime "$role-console.pid"
  if (-not (Test-Path -LiteralPath $consolePidFile)) { continue }
  $consolePid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $consolePidFile -Raw).Trim(), [ref]$consolePid)) { continue }
  $consoleProcess = Get-Process -Id $consolePid -ErrorAction SilentlyContinue
  if ($null -ne $consoleProcess -and $consoleProcess.ProcessName -eq "powershell") {
    Stop-Process -Id $consolePid -Force
  }
}

foreach ($name in @("server.pid", "tunnel.pid", "server-console.pid", "tunnel-console.pid")) {
  Remove-Item -LiteralPath (Join-Path $runtime $name) -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath (Join-Path $runtime "stopping.flag") -Force -ErrorAction SilentlyContinue

if ($serverStopped -or $tunnelStopped) {
  Write-Host "AI Teach-Up server and public tunnel stopped." -ForegroundColor Green
} else {
  Write-Host "No running AI Teach-Up process was found." -ForegroundColor Yellow
}
