$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $PSScriptRoot 'logs\server.pid'
try {
    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4317/api/shutdown' -Headers @{'X-Local-Request'='1'} -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
    Start-Sleep -Seconds 2
} catch {}
if (Test-Path -LiteralPath $taskPidFile) {
    $taskServerPid = [int](Get-Content -LiteralPath $taskPidFile)
    $taskServerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskServerPid"
    $taskExpected = Join-Path $PSScriptRoot 'src\server.js'
    if ($taskServerProcess -and $taskServerProcess.Name -eq 'node.exe' -and $taskServerProcess.CommandLine.Contains($taskExpected)) {
        Stop-Process -Id $taskServerPid
    }
}
