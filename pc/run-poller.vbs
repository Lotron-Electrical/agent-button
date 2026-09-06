' Launch the agent-button poller with no visible console window.
' Used by the AgentButtonPoller / AgentButtonPollerWatch scheduled tasks.
'
' 2026-08-27: this used to fire blind. Task Scheduler only ever saw wscript exit
' instantly (Run is async), so when the node process died -- as it did on
' 2026-08-26T05:50Z, silently, taking the phone app's SPAWN button with it -- the
' task's RestartCount never applied and nothing noticed for a day and a half.
' A watch task now re-runs this every 5 minutes; the guard below is what makes that
' safe: node starts only if no poller is already running, and stderr (where a crash
' trace goes) is kept instead of dropped on the floor.
'
' On Error Resume Next: this runs unattended, and a Windows Script Host ERROR DIALOG
' is a visible window, which is the one thing this wrapper must never produce.
On Error Resume Next

Set sh = CreateObject("WScript.Shell")
repo = "C:\Users\Lloyd Gibbs\Claude Projects\agent-button"
crash = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.agent-button-spawns\poller-crash.log"

' Already running? Do nothing.
Set wmi = GetObject("winmgmts:\.\root\cimv2")
If Err.Number = 0 Then
  Set procs = wmi.ExecQuery("Select CommandLine from Win32_Process where Name = 'node.exe'")
  For Each p In procs
    cl = ""
    cl = p.CommandLine
    If InStr(LCase(cl), "poller.js") > 0 Then WScript.Quit 0
  Next
End If
Err.Clear

sh.CurrentDirectory = repo
' cmd only exists to attach the stderr redirect; window style 0 keeps it invisible.
sh.Run "cmd /c node " & Chr(34) & repo & "\pc\poller.js" & Chr(34) & " >>" & Chr(34) & crash & Chr(34) & " 2>&1", 0, False
WScript.Quit 0
