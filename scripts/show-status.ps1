$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot ".runtime"

function Get-RoleStatus([string]$role) {
  $pidFile = Join-Path $runtime "$role.pid"
  if (-not (Test-Path -LiteralPath $pidFile)) { return $false }
  $savedPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) { return $false }
  $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
  return $null -ne $process -and $process.ProcessName -eq "cmd"
}

$serverRunning = Get-RoleStatus "server"
$tunnelRunning = Get-RoleStatus "tunnel"
$serverText = if ($serverRunning) { "RUNNING" } else { "STOPPED" }
$tunnelText = if ($tunnelRunning) { "RUNNING" } else { "STOPPED" }

Write-Host "AI Teach-Up status" -ForegroundColor Cyan
Write-Host "Server: $serverText"
Write-Host "Public tunnel: $tunnelText"

$tunnelLog = Join-Path $runtime "tunnel.log"
if ($tunnelRunning -and (Test-Path -LiteralPath $tunnelLog)) {
  $content = Get-Content -LiteralPath $tunnelLog -Raw
  $matches = [regex]::Matches($content, "https://[a-z0-9-]+\.trycloudflare\.com")
  if ($matches.Count -gt 0) {
    $url = $matches[$matches.Count - 1].Value
    Write-Host "Public URL: $url" -ForegroundColor Green
    Write-Host "Admin URL: $url/admin" -ForegroundColor Green
  } else {
    Write-Host "The public URL is still being created. Check again shortly." -ForegroundColor Yellow
  }
}

Write-Host "Local URL: http://localhost:3210"
