param(
  [string]$Version = "v2.12.0"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$serviceDir = Join-Path $root "service"
$target = Join-Path $serviceDir "FeishuCodexBridge.Service.exe"
New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null

$downloadUrl = "https://github.com/winsw/winsw/releases/download/$Version/WinSW-x64.exe"
Invoke-WebRequest -Uri $downloadUrl -OutFile $target
Write-Host "Downloaded service wrapper: $target"
Write-Host "Version: $Version"
