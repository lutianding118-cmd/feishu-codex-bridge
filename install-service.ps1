$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$serviceExe = Join-Path $root "service\FeishuCodexBridge.Service.exe"

if (-not (Test-Path $serviceExe)) {
  throw "Missing service wrapper. Run: .\scripts\prepare-service-wrapper.ps1"
}

& $serviceExe install
if ($LASTEXITCODE -ne 0) { throw "Service install failed." }

& $serviceExe start
if ($LASTEXITCODE -ne 0) { throw "Service start failed." }

Write-Host "Feishu Codex Bridge service installed and started."
Write-Host "Admin: http://127.0.0.1:3457"
Write-Host "Note: run the service as the Windows user that has logged in to Codex."
