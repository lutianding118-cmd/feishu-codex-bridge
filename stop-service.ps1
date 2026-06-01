$ErrorActionPreference = "Stop"
$serviceExe = Join-Path $PSScriptRoot "service\FeishuCodexBridge.Service.exe"
if (-not (Test-Path $serviceExe)) { throw "Missing service wrapper: $serviceExe" }
& $serviceExe stop
Write-Host "Feishu Codex Bridge service stop command sent."
