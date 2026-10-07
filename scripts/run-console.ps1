param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("server", "tunnel")]
  [string]$Role
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot ".runtime"
$pidFile = Join-Path $runtime "$Role.pid"
$consolePidFile = Join-Path $runtime "$Role-console.pid"
$logFile = Join-Path $runtime "$Role.log"
$stoppingFlag = Join-Path $runtime "stopping.flag"

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Set-Content -LiteralPath $consolePidFile -Value $PID -Encoding ascii
Set-Content -LiteralPath $logFile -Value "" -Encoding utf8

if ($Role -eq "server") {
  $Host.UI.RawUI.WindowTitle = "AI Teach-Up - Server Log"
  $executable = (Get-Command node -ErrorAction Stop).Source
  $arguments = "server.mjs"
  $heading = "AI Teach-Up server"
} else {
  $Host.UI.RawUI.WindowTitle = "AI Teach-Up - Public URL"
  $executable = Join-Path $projectRoot ".local-tools\cloudflared.exe"
  $arguments = "tunnel --url http://localhost:3210 --no-autoupdate"
  $heading = "Cloudflare public tunnel"
}

Write-Host "[$heading]" -ForegroundColor Cyan
Write-Host "Log file: $logFile" -ForegroundColor DarkGray
if ($Role -eq "tunnel") {
  Write-Host "Share the generated https://...trycloudflare.com address." -ForegroundColor Yellow
}
Write-Host ""

# cmd.exe merges stderr into stdout. Reading the single stream synchronously is
# reliable in Windows PowerShell 5 and keeps both the window and log in sync.
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $env:ComSpec
$startInfo.Arguments = '/d /s /c ""' + $executable + '" ' + $arguments + ' 2>&1"'
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$exitCode = 1

try {
  if (-not $process.Start()) { throw "Could not start $heading." }
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

  while (-not $process.StandardOutput.EndOfStream) {
    $rawLine = $process.StandardOutput.ReadLine()
    if ($null -eq $rawLine) { continue }
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $rawLine"
    Write-Host $line
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
  }

  $process.WaitForExit()
  $exitCode = $process.ExitCode
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  Add-Content -LiteralPath $logFile -Value $_.Exception.Message -Encoding utf8
} finally {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $consolePidFile -Force -ErrorAction SilentlyContinue
  $process.Dispose()
}

if (-not (Test-Path -LiteralPath $stoppingFlag)) {
  Write-Host ""
  Write-Host "$heading stopped (exit code: $exitCode)." -ForegroundColor Red
  Read-Host "Press Enter to close this window"
}
