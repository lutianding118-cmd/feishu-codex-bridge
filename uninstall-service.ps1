$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$serviceExe = Join-Path $root "service\FeishuCodexBridge.Service.exe"

if (-not (Test-Path $serviceExe)) {
  throw "Missing service wrapper: $serviceExe"
}

& $serviceExe stop
& $serviceExe uninstall
if ($LASTEXITCODE -ne 0) { throw "Service uninstall failed." }

Write-Host "Feishu Codex Bridge service uninstalled."
