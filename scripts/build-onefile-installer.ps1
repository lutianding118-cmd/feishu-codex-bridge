param(
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $root "dist"
$work = Join-Path $dist "onefile-work"
$payloadRoot = Join-Path $work "payload"
$payloadZip = Join-Path $work "FeishuCodexBridge-payload.zip"

if (-not $OutputPath) {
  $OutputPath = Join-Path $dist "FeishuCodexBridge-OneClick-Setup.exe"
}

if (Test-Path $work) {
  Remove-Item -LiteralPath $work -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$copyDirs = @(
  "codex-bin",
  "node_modules",
  "runtime",
  "scripts",
  "service",
  "src",
  "tools"
)

foreach ($dir in $copyDirs) {
  $source = Join-Path $root $dir
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $payloadRoot $dir) -Recurse -Force
  }
}

$copyFiles = @(
  "FeishuCodexBridge.exe",
  "package.json",
  "package-lock.json",
  "README-PORTABLE.txt",
  "README.md",
  "tsconfig.json",
  "install-service.ps1",
  "uninstall-service.ps1",
  "start-service.ps1",
  "stop-service.ps1",
  "status-service.ps1"
)

foreach ($file in $copyFiles) {
  $source = Join-Path $root $file
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $payloadRoot $file) -Force
  }
}

$envExample = Join-Path $root ".env.example"
if (Test-Path $envExample) {
  Copy-Item -LiteralPath $envExample -Destination (Join-Path $payloadRoot ".env") -Force
  Copy-Item -LiteralPath $envExample -Destination (Join-Path $payloadRoot ".env.example") -Force
}

Compress-Archive -Path (Join-Path $payloadRoot "*") -DestinationPath $payloadZip -CompressionLevel Optimal -Force

$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  throw "csc.exe was not found. Cannot build one-file installer."
}

$installerSource = Join-Path $root "tools\installer\OneClickInstaller.cs"
& $csc /nologo /target:exe /platform:anycpu /optimize+ `
  "/out:$OutputPath" `
  "/resource:$payloadZip,FeishuCodexBridgePayload" `
  /reference:System.IO.Compression.dll `
  /reference:System.IO.Compression.FileSystem.dll `
  $installerSource
if ($LASTEXITCODE -ne 0) {
  throw "One-file installer build failed."
}

Write-Host "Built one-file installer: $OutputPath"
Write-Host "Note: the package uses .env.example as .env, so recipients must fill Feishu settings themselves."
