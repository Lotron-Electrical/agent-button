# close-tab-for-pid.ps1 — close the Windows Terminal TAB that hosts a given pid.
#
# Walks up the process tree from -TargetPid to the process whose parent is
# WindowsTerminal.exe (the tab-root), then taskkill /T /F it — tearing down the
# whole tab subtree (shell + claude + MCP children) so the tab closes. Used by the
# agent-button poller (solve-reap.js) to reap superseded solve-relay generations.
#
# SAFE BY DESIGN: only kills if a WindowsTerminal.exe ancestor is actually found.
# If the chain doesn't lead to WindowsTerminal (unexpected tree), it kills nothing.
# The WT default profile sets closeOnExit:"always", so killing the tab-root closes
# the tab cleanly (no "process exited" husk).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File close-tab-for-pid.ps1 -TargetPid 1234
#   powershell ... -File close-tab-for-pid.ps1 -TargetPid 1234 -DryRun   # report only, no kill
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [switch]$DryRun
)
$ErrorActionPreference = 'SilentlyContinue'

try { $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction Stop }
catch { Write-Output "pid $TargetPid not found (already gone)"; exit 0 }

$tabRoot = $null
$guard = 0
while ($cur -and $guard -lt 25) {
  $guard++
  $ppid = $cur.ParentProcessId
  if (-not $ppid) { break }
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$ppid" -ErrorAction SilentlyContinue
  if (-not $parent) { break }
  if ($parent.Name -eq 'WindowsTerminal.exe') { $tabRoot = $cur; break }
  $cur = $parent
}

if (-not $tabRoot) {
  Write-Output "no WindowsTerminal.exe ancestor for pid $TargetPid; closing nothing"
  exit 0
}

if ($DryRun) {
  Write-Output "WOULD close tab-root pid $($tabRoot.ProcessId) ($($tabRoot.Name)) hosting pid $TargetPid"
  exit 0
}

taskkill /PID $($tabRoot.ProcessId) /T /F | Out-Null
Write-Output "closed tab-root pid $($tabRoot.ProcessId) ($($tabRoot.Name)) for pid $TargetPid"
exit 0
