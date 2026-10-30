$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$taskNode = Get-Command node.exe -ErrorAction Stop
$taskMajor = [int]((& $taskNode.Source --version) -replace '^v(\d+).*','$1')
if ($taskMajor -lt 24) { throw 'Install Node.js 24 or newer, then run this file again.' }
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules\express'))) {
    & npm.cmd ci --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
$taskUrl = 'http://127.0.0.1:4317'
try { $taskExisting = Invoke-RestMethod -Uri ($taskUrl + '/api/state') -TimeoutSec 2 } catch { $taskExisting = $null }
if (-not $taskExisting.config) {
    $taskLogs = Join-Path $taskRoot 'logs'
    New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
    $taskServer = Join-Path $taskRoot 'src\server.js'
    $taskProcess = Start-Process -FilePath $taskNode.Source -ArgumentList @('"' + $taskServer + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLogs 'server.log') -RedirectStandardError (Join-Path $taskLogs 'server-error.log')
    Set-Content -LiteralPath (Join-Path $taskLogs 'server.pid') -Value $taskProcess.Id
    $taskReady = $false
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        Start-Sleep -Milliseconds 300
        try { Invoke-RestMethod -Uri ($taskUrl + '/api/state') -TimeoutSec 1 | Out-Null; $taskReady = $true; break } catch {}
    }
    if (-not $taskReady) { throw 'Panel did not start. See logs/server-error.log.' }
}
Start-Process $taskUrl
