# Registers the AgentButtonPoller scheduled task (runs hidden at logon, restarts on failure)
# and starts it now. Run in Windows PowerShell. No admin needed.
$ErrorActionPreference = 'Stop'
$vbs = "C:\Users\Lloyd Gibbs\Claude Projects\agent-button\pc\run-poller.vbs"
if (-not (Test-Path $vbs)) { throw "run-poller.vbs not found at $vbs" }

$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
# At logon, then re-check every 5 minutes forever. The wrapper VBS refuses to start a
# second poller, so a re-check on a healthy PC is a no-op; on a dead one it is the restart
# nothing else was doing (see run-poller.vbs).
$trigger = New-ScheduledTaskTrigger -AtLogOn
$rep = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$rep.Duration = $null   # $null duration = repeat indefinitely; TimeSpan::MaxValue is rejected by the task XML
$trigger.Repetition = $rep
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'AgentButtonPoller' -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName 'AgentButtonPoller'
Write-Host 'AgentButtonPoller installed and started.'
