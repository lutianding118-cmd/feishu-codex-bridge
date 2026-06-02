$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
$BridgeExe = Join-Path $Root "FeishuCodexBridge.exe"
$CodexExe = Join-Path $Root "codex-bin\codex.exe"
$EnvPath = Join-Path $Root ".env"
$HealthDir = Join-Path $Root "logs\health"
$HealthLog = Join-Path $HealthDir "health.log"
$RepairStamp = Join-Path $HealthDir "last-repair.txt"
$RepairOut = Join-Path $HealthDir "codex-repair.out.log"
$RepairErr = Join-Path $HealthDir "codex-repair.err.log"
$Port = 3457
$StaleRunMinutes = 20
$RepairCooldownMinutes = 60

New-Item -ItemType Directory -Force -Path $HealthDir | Out-Null

function Write-HealthLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $HealthLog -Value $line -Encoding UTF8
}

function Read-BridgeConfig {
  $config = @{}
  if (-not (Test-Path -LiteralPath $EnvPath)) { return $config }
  Get-Content -LiteralPath $EnvPath -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^([^#][^=]+)=(.*)$') {
      $config[$matches[1].Trim()] = $matches[2].Trim()
    }
  }
  return $config
}

function Get-BridgeProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like "$Root*"
  }
}

function Stop-Bridge {
  Write-HealthLog "Stopping bridge processes."
  Get-BridgeProcesses | Sort-Object ProcessId -Descending | ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    } catch {
      Write-HealthLog "Stop failed pid=$($_.ProcessId): $($_.Exception.Message)"
    }
  }
  Start-Sleep -Seconds 3
}

function Start-Bridge {
  Write-HealthLog "Starting bridge."
  if (-not (Test-Path -LiteralPath $BridgeExe)) {
    Write-HealthLog "Bridge exe missing: $BridgeExe"
    return
  }
  Start-Process -FilePath $BridgeExe -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 12
}

function Restart-Bridge {
  Stop-Bridge
  Start-Bridge
}

function Test-FeishuToken {
  $config = Read-BridgeConfig
  if (-not $config.FEISHU_APP_ID -or -not $config.FEISHU_APP_SECRET) {
    return "missing_feishu_credentials"
  }
  try {
    $body = @{ app_id = $config.FEISHU_APP_ID; app_secret = $config.FEISHU_APP_SECRET } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 15
    if ($resp.code -ne 0) { return "feishu_token_code_$($resp.code)_$($resp.msg)" }
    return $null
  } catch {
    return "feishu_token_error_$($_.Exception.Message)"
  }
}

function Get-RunningCodexRuns {
  $config = Read-BridgeConfig
  $code = $config.BRIDGE_AUTH_CODE
  if (-not $code) { $code = "123456" }
  try {
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/login" -Method Post -Body @{ code = $code } -WebSession $session -MaximumRedirection 0 -ErrorAction SilentlyContinue | Out-Null
    $runs = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/codex-runs" -WebSession $session -TimeoutSec 10
    return @($runs.runs | Where-Object { $_.status -eq "running" })
  } catch {
    Write-HealthLog "Cannot read codex-runs: $($_.Exception.Message)"
    return @()
  }
}

function Test-BridgeHealth {
  $errors = New-Object System.Collections.Generic.List[string]

  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 10
    if ($health.status -ne "ok") { $errors.Add("health_status_$($health.status)") }
    if ($health.codex -ne $true) { $errors.Add("codex_not_ready") }
  } catch {
    $errors.Add("health_unreachable_$($_.Exception.Message)")
  }

  $listen = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listen) {
    $errors.Add("port_not_listening")
  } else {
    $ws = Get-NetTCPConnection -State Established -OwningProcess $listen.OwningProcess -ErrorAction SilentlyContinue |
      Where-Object { $_.RemotePort -eq 443 } |
      Select-Object -First 1
    if (-not $ws) { $errors.Add("feishu_ws_not_established") }
  }

  $tokenError = Test-FeishuToken
  if ($tokenError) { $errors.Add($tokenError) }

  $now = Get-Date
  foreach ($run in Get-RunningCodexRuns) {
    $started = $null
    if ($run.startedAt) {
      try { $started = [DateTime]::Parse($run.startedAt) } catch { $started = $null }
    }
    if ($started -and (($now.ToUniversalTime() - $started.ToUniversalTime()).TotalMinutes -gt $StaleRunMinutes)) {
      $errors.Add("stale_codex_run_$($run.id)_over_${StaleRunMinutes}m")
    }
  }

  return $errors
}

function Should-RunRepair {
  if (-not (Test-Path -LiteralPath $RepairStamp)) { return $true }
  try {
    $last = [DateTime]::Parse((Get-Content -LiteralPath $RepairStamp -Encoding UTF8 | Select-Object -First 1))
    return ((Get-Date) - $last).TotalMinutes -ge $RepairCooldownMinutes
  } catch {
    return $true
  }
}

function Invoke-CodexRepair {
  if (-not (Test-Path -LiteralPath $CodexExe)) {
    Write-HealthLog "Codex repair skipped: codex.exe missing."
    return
  }
  if (-not (Should-RunRepair)) {
    Write-HealthLog "Codex repair skipped: cooldown active."
    return
  }

  (Get-Date).ToString("o") | Set-Content -LiteralPath $RepairStamp -Encoding UTF8
  $prompt = @(
    "Feishu Codex Bridge is still unhealthy after restart. Inspect and minimally repair this local project: $Root",
    "1. Check .env, src/server.ts, logs/health, logs/service, and .bridge-state.",
    "2. Verify port 3457, Feishu websocket connection, and Codex CLI execution.",
    "3. If code or config is wrong, make the smallest safe fix. Do not change Feishu App Secret. Do not delete user data.",
    "4. Run npm.cmd run build after changes.",
    "5. Summarize what changed and any remaining risk."
  ) -join [Environment]::NewLine

  Write-HealthLog "Starting Codex repair."
  try {
    $args = @("--dangerously-bypass-approvals-and-sandbox", "exec", "--skip-git-repo-check", $prompt)
    $process = Start-Process -FilePath $CodexExe -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $RepairOut -RedirectStandardError $RepairErr
    $deadline = (Get-Date).AddMinutes(10)
    while (-not $process.HasExited -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 5
      $process.Refresh()
    }
    if (-not $process.HasExited) {
      Write-HealthLog "Codex repair timed out; killing pid=$($process.Id)."
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    } else {
      Write-HealthLog "Codex repair exited code=$($process.ExitCode)."
    }
  } catch {
    Write-HealthLog "Codex repair failed: $($_.Exception.Message)"
  }
}

Write-HealthLog "Health check started."
$errors = Test-BridgeHealth
if ($errors.Count -eq 0) {
  Write-HealthLog "Healthy."
  exit 0
}

Write-HealthLog "Unhealthy: $($errors -join '; ')"
Restart-Bridge
$afterRestart = Test-BridgeHealth
if ($afterRestart.Count -eq 0) {
  Write-HealthLog "Recovered after restart."
  exit 0
}

Write-HealthLog "Still unhealthy after restart: $($afterRestart -join '; ')"
Invoke-CodexRepair
Restart-Bridge
$afterRepair = Test-BridgeHealth
if ($afterRepair.Count -eq 0) {
  Write-HealthLog "Recovered after Codex repair and restart."
  exit 0
}

Write-HealthLog "Still unhealthy after repair: $($afterRepair -join '; ')"
exit 2
