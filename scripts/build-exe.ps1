param(
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $root "tools\launcher\FeishuCodexBridgeLauncher.cs"
if (-not $OutputPath) {
  $OutputPath = Join-Path $root "FeishuCodexBridge.exe"
}

$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  throw "csc.exe was not found. Cannot build Windows launcher."
}

if (Test-Path $OutputPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item -LiteralPath $OutputPath -Destination "$OutputPath.bak-$stamp" -Force
}

& $csc /nologo /target:exe /platform:anycpu /optimize+ "/out:$OutputPath" $source
if ($LASTEXITCODE -ne 0) {
  throw "Launcher build failed."
}

Write-Host "Built: $OutputPath"
