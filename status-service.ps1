$ErrorActionPreference = "Stop"
$serviceExe = Join-Path $PSScriptRoot "service\FeishuCodexBridge.Service.exe"
if (-not (Test-Path $serviceExe)) { throw "Missing service wrapper: $serviceExe" }
& $serviceExe status
