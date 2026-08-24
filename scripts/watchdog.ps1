# Unattended watchdog for story build benchmark.
# ASCII-only: Windows PowerShell 5.1 reads .ps1 without BOM as ANSI; non-ASCII chars can corrupt parsing.
$ErrorActionPreference = "Continue"
$root = "D:\story-cli"
$pidFile = "$root\.story\logs\build\bench-run.pid"
$mainline = "$root\.story\logs\build\mainline.jsonl"
$wlog = "$root\.story\logs\build\watchdog.log"
$pidFileW = "$root\.story\logs\build\watchdog.pid"
$buildPidFile = "$root\.story\logs\build\bench-run.pid"
$logOut = "$root\.story\logs\build\bench-run.log"
$logErr = "$root\.story\logs\build\bench-run.err.log"
$tryCount = @{}
function Log($msg) {
  $line = "[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $msg
  Add-Content -Path $wlog -Value $line
}
function IsBuildRunning {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'dist/src/cli/index.js build' }
  return ($null -ne $p)
}
function LatestRunInfo {
  if (-not (Test-Path $mainline)) { return $null }
  # UTF8: mainline.jsonl contains Chinese; ANSI misread breaks JSON parsing and undercounts progress
  $lines = Get-Content $mainline -Encoding UTF8 -ErrorAction SilentlyContinue
  $lastRun = $null; $batches = @(); $endInfo = $null
  # Benchmark window: only count done batches produced by this grounding re-run
  $bookStart = '2026-08-23T02:37:00'
  foreach ($l in $lines) {
    if (-not $l) { continue }
    try { $o = $l | ConvertFrom-Json } catch { continue }
    if ($o.kind -eq 'run_start') {
      $lastRun = $o; $batches = @(); $endInfo = $null
    } elseif ($o.kind -eq 'batch') {
      if ($null -ne $lastRun) { $batches += $o }
      if ($o.status -eq 'done' -and $o.ts -ge $bookStart) {
        $parts = $o.range -split '-'
        $e = [int]$parts[$parts.Count - 1]
      }
    } elseif ($o.kind -eq 'run_end' -and $null -ne $lastRun) {
      $endInfo = $o
    }
  }
  return @{ run = $lastRun; batches = $batches; end = $endInfo }
}
function MaxDoneEndSince {
  param([string]$since)
  $maxE = 0
  # UTF8: see LatestRunInfo note
  $lines = Get-Content $mainline -Encoding UTF8 -ErrorAction SilentlyContinue
  foreach ($l in $lines) {
    if (-not $l) { continue }
    try { $o = $l | ConvertFrom-Json } catch { continue }
    if ($o.kind -eq 'batch' -and $o.status -eq 'done' -and $o.ts -ge $since) {
      $parts = $o.range -split '-'
      $e = [int]$parts[$parts.Count - 1]
      if ($e -gt $maxE) { $maxE = $e }
    }
  }
  return $maxE
}
Log "watchdog started"
# Single-instance guard via pid file: if the recorded watchdog pid is a live powershell running watchdog.ps1, exit.
if (Test-Path $pidFileW) {
  $saved = Get-Content $pidFileW -ErrorAction SilentlyContinue
  if ($saved) {
    $savedPid = [int]$saved
    if ($savedPid -ne $PID) {
      $live = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
      if ($live -and $live.Name -eq 'powershell.exe' -and $live.CommandLine -match 'watchdog\.ps1') {
        Log ("duplicate watchdog alive at pid " + $savedPid + ", exiting")
        exit 0
      }
    }
  }
}
Set-Content -Path $pidFileW -Value ("" + $PID)
while ($true) {
  Start-Sleep -Seconds 120
  if (IsBuildRunning) { continue }
  $info = LatestRunInfo
  $nextStart = 1
  $bs = 5
  $reason = "crash"
  $bookMax = MaxDoneEndSince '2026-08-23T02:37:00'
  if ($null -ne $info -and $null -ne $info.run) {
    $batches = $info.batches
    if ($batches.Count -gt 0) {
      $failedB = $batches | Where-Object { $_.status -eq 'failed' } | Select-Object -First 1
      if ($failedB) {
        $startN = [int](($failedB.range -split '-')[0])
        $nextStart = $startN
        $reason = "failed-batch " + $failedB.range
      } else {
        $lastDone = $batches | Where-Object { $_.status -eq 'done' } | Select-Object -Last 1
        if ($lastDone) {
          $nextStart = [int](($lastDone.range -split '-')[1]) + 1
          $reason = "resume after done " + $lastDone.range
        }
      }
    } else {
      # latest run has no batches and process is dead -> crash; resume after book progress (never rewind)
      $nextStart = $bookMax + 1
      $reason = "crash resume after bookMax=" + $bookMax
    }
  } else {
    $nextStart = $bookMax + 1
    $reason = "fresh resume after bookMax=" + $bookMax
  }
  # Never restart behind current book progress
  if ($nextStart -lt $bookMax + 1) { $nextStart = $bookMax + 1 }
  if ($nextStart -gt 1291) {
    if ($null -ne $info -and $null -ne $info.end -and $info.end.failed -eq 0) {
      Log "ALL DONE"
      Set-Content -Path "$root\.story\logs\build\watchdog-done.marker" -Value "done"
      exit 0
    }
    $nextStart = 1291
  }
  if ($tryCount.ContainsKey($nextStart)) { $tryCount[$nextStart]++ } else { $tryCount[$nextStart] = 1 }
  $tries = $tryCount[$nextStart]
  if ($tries -ge 6) {
    Log ("STUCK: from=" + $nextStart + " tries=" + $tries)
    Set-Content -Path "$root\.story\logs\build\watchdog-stuck.marker" -Value ("stuck at " + $nextStart)
    exit 2
  }
  if ($tries -ge 3) { $bs = 1 } elseif ($tries -ge 2) { $bs = 2 } else { $bs = 5 }
  Remove-Item $logOut, $logErr -ErrorAction SilentlyContinue
  $env:LLM_MAX_TOKENS = "24000"
  $pargs = @("dist/src/cli/index.js", "build", "--force", "--from-chapter", "$nextStart", "--batch-size", "$bs", "--retries", "4")
  $p = Start-Process -FilePath "node" -ArgumentList $pargs -WorkingDirectory $root -RedirectStandardOutput $logOut -RedirectStandardError $logErr -WindowStyle Hidden -PassThru
  $p.Id | Out-File $pidFile
  Log ("relaunch: from=" + $nextStart + " bs=" + $bs + " pid=" + $p.Id + " reason=" + $reason + " tries=" + $tries)
}