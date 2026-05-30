# Registers the AgentButtonPoller scheduled task (runs hidden at logon, restarts on failure)
# and starts it now. Run in Windows PowerShell. No admin needed.
$ErrorActionPreference = 'Stop'
$vbs = "C:\Users\Lloyd Gibbs\Claude Projects\agent-button\pc\run-poller.vbs"
if (-not (Test-Path $vbs)) { throw "run-poller.vbs not found at $vbs" }

$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'AgentButtonPoller' -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName 'AgentButtonPoller'
Write-Host 'AgentButtonPoller installed and started.'
